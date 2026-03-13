// FILE: CodexService+RuntimeConfig.swift
// Purpose: Runtime model/reasoning/access preferences and model/list loading.
// Layer: Service
// Exports: CodexService runtime config APIs
// Depends on: CodexModelOption, CodexReasoningEffortOption, CodexAccessMode

import Foundation

extension CodexService {
    func listProviders() async throws {
        let response = try await sendRequest(method: "runtime/provider/list", params: nil)
        let resultObject = response.result?.objectValue
        let providerValues = resultObject?["providers"]?.arrayValue
            ?? resultObject?["items"]?.arrayValue
            ?? []
        let decodedProviders = providerValues.compactMap { decodeModel(CodexRuntimeProvider.self, from: $0) }
        availableProviders = decodedProviders.isEmpty ? [.codexDefault] : decodedProviders

        let availableIDs = Set(availableProviders.map(\.id))
        if !availableIDs.contains(selectedProviderID) {
            selectedProviderID = availableProviders.first?.id ?? "codex"
        }
        syncRuntimeSelectionContext()
    }

    // Sends one request while trying approvalPolicy enum variants for cross-version compatibility.
    func sendRequestWithApprovalPolicyFallback(
        method: String,
        baseParams: RPCObject,
        context: String
    ) async throws -> RPCMessage {
        let policies = selectedAccessMode.approvalPolicyCandidates
        var lastError: Error?

        for (index, policy) in policies.enumerated() {
            var params = baseParams
            params["approvalPolicy"] = .string(policy)

            do {
                return try await sendRequest(method: method, params: .object(params))
            } catch {
                lastError = error
                let hasMorePolicies = index < (policies.count - 1)
                if hasMorePolicies, shouldRetryWithApprovalPolicyFallback(error) {
                    debugRuntimeLog("\(method) \(context) fallback approvalPolicy=\(policy)")
                    continue
                }
                throw error
            }
        }

        throw lastError ?? CodexServiceError.invalidResponse("\(method) failed with unknown approvalPolicy error")
    }

    func listModels(provider: String? = nil) async throws {
        isLoadingModels = true
        defer { isLoadingModels = false }

        let resolvedProvider = runtimeProviderID(for: provider)
        do {
            let response = try await sendRequest(
                method: "model/list",
                params: .object([
                    "provider": .string(resolvedProvider),
                    "cursor": .null,
                    "limit": .integer(50),
                    "includeHidden": .bool(false),
                ])
            )

            guard let resultObject = response.result?.objectValue else {
                throw CodexServiceError.invalidResponse("model/list response missing payload")
            }

            let items =
                resultObject["items"]?.arrayValue
                ?? resultObject["data"]?.arrayValue
                ?? resultObject["models"]?.arrayValue
                ?? []

            let decodedModels = items.compactMap { decodeModel(CodexModelOption.self, from: $0) }
            availableModels = decodedModels
            modelsErrorMessage = nil
            normalizeRuntimeSelectionsAfterModelsUpdate(provider: resolvedProvider)

            debugRuntimeLog("model/list success count=\(decodedModels.count)")
        } catch {
            handleModelListFailure(error)
            throw error
        }
    }

    func setSelectedModelId(_ modelId: String?) {
        let normalized = modelId?.trimmingCharacters(in: .whitespacesAndNewlines)
        selectedModelId = (normalized?.isEmpty == false) ? normalized : nil
        normalizeRuntimeSelectionsAfterModelsUpdate()
    }

    func setSelectedReasoningEffort(_ effort: String?) {
        let normalized = effort?.trimmingCharacters(in: .whitespacesAndNewlines)
        selectedReasoningEffort = (normalized?.isEmpty == false) ? normalized : nil
        normalizeRuntimeSelectionsAfterModelsUpdate()
    }

    func setSelectedAccessMode(_ accessMode: CodexAccessMode) {
        selectedAccessMode = accessMode
        persistRuntimeSelections()
    }

    func setSelectedProviderID(_ providerID: String) {
        let normalized = runtimeProviderID(for: providerID)
        guard selectedProviderID != normalized else {
            syncRuntimeSelectionContext(for: normalized, refreshModels: isConnected)
            return
        }
        selectedProviderID = normalized
        syncRuntimeSelectionContext(for: normalized, refreshModels: isConnected)
    }

    func selectedModelOption() -> CodexModelOption? {
        selectedModelOption(from: availableModels)
    }

    func supportedReasoningEffortsForSelectedModel() -> [CodexReasoningEffortOption] {
        selectedModelOption()?.supportedReasoningEfforts ?? []
    }

    func selectedReasoningEffortForSelectedModel() -> String? {
        guard let model = selectedModelOption() else {
            return nil
        }

        let supported = Set(model.supportedReasoningEfforts.map { $0.reasoningEffort })
        guard !supported.isEmpty else {
            return nil
        }

        if let selected = selectedReasoningEffort,
           supported.contains(selected) {
            return selected
        }

        if let defaultEffort = model.defaultReasoningEffort,
           supported.contains(defaultEffort) {
            return defaultEffort
        }

        if supported.contains("medium") {
            return "medium"
        }

        return model.supportedReasoningEfforts.first?.reasoningEffort
    }

    func runtimeModelIdentifierForTurn() -> String? {
        selectedModelOption()?.model
    }

    func runtimeModelIdentifier(for providerID: String) -> String? {
        let resolvedProviderID = runtimeProviderID(for: providerID)
        let storedModelID = runtimeModelIdByProvider[resolvedProviderID]
            ?? defaults.string(forKey: runtimeModelDefaultsKey(resolvedProviderID))
        if let matchingModel = availableModels.first(where: {
            $0.id == storedModelID || $0.model == storedModelID
        }) {
            return matchingModel.model
        }
        return storedModelID?.trimmingCharacters(in: .whitespacesAndNewlines)
            ?? availableProviders.first(where: { $0.id == resolvedProviderID })?.defaultModelId
    }

    func currentRuntimeProviderID() -> String {
        if let activeThreadId,
           let thread = threads.first(where: { $0.id == activeThreadId }) {
            return runtimeProviderID(for: thread.provider)
        }
        return runtimeProviderID(for: selectedProviderID)
    }

    func runtimeProviderID(for providerID: String?) -> String {
        let normalized = providerID?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        if normalized == "claude" || normalized == "gemini" || normalized == "codex" {
            return normalized
        }
        return "codex"
    }

    func currentRuntimeProvider() -> CodexRuntimeProvider {
        let providerID = currentRuntimeProviderID()
        return availableProviders.first(where: { $0.id == providerID }) ?? .codexDefault
    }

    func selectedDefaultsProvider() -> CodexRuntimeProvider {
        let providerID = runtimeProviderID(for: selectedProviderID)
        return availableProviders.first(where: { $0.id == providerID }) ?? .codexDefault
    }

    func availableAccessModes(for providerID: String? = nil) -> [CodexAccessMode] {
        let runtimeProvider = availableProviders.first(where: { $0.id == runtimeProviderID(for: providerID) })
            ?? .codexDefault
        let allowedModeIDs = Set(runtimeProvider.accessModes.map(\.id))
        let filtered = CodexAccessMode.allCases.filter { allowedModeIDs.contains($0.rawValue) }
        return filtered.isEmpty ? CodexAccessMode.allCases : filtered
    }

    func syncRuntimeSelectionContext() {
        syncRuntimeSelectionContext(for: currentRuntimeProviderID(), refreshModels: isConnected)
    }

    func syncRuntimeSelectionContext(for providerID: String, refreshModels: Bool) {
        let resolvedProviderID = runtimeProviderID(for: providerID)
        let storedModel = runtimeModelIdByProvider[resolvedProviderID]
            ?? defaults.string(forKey: runtimeModelDefaultsKey(resolvedProviderID))
        selectedModelId = storedModel?.trimmingCharacters(in: .whitespacesAndNewlines)

        let storedReasoning = runtimeReasoningEffortByProvider[resolvedProviderID]
            ?? defaults.string(forKey: runtimeReasoningDefaultsKey(resolvedProviderID))
        selectedReasoningEffort = storedReasoning?.trimmingCharacters(in: .whitespacesAndNewlines)

        if let inMemoryAccess = runtimeAccessModeByProvider[resolvedProviderID] {
            selectedAccessMode = inMemoryAccess
        } else if let storedAccess = defaults.string(forKey: runtimeAccessDefaultsKey(resolvedProviderID)),
                  let parsedAccess = CodexAccessMode(rawValue: storedAccess) {
            selectedAccessMode = parsedAccess
        } else {
            selectedAccessMode = .onRequest
        }

        if refreshModels {
            Task { @MainActor [weak self] in
                guard let self else { return }
                try? await self.listModels(provider: resolvedProviderID)
            }
        }
    }

    func runtimeSandboxPolicyObject(for accessMode: CodexAccessMode) -> JSONValue {
        switch accessMode {
        case .onRequest:
            return .object([
                "type": .string("workspaceWrite"),
                "networkAccess": .bool(true),
            ])
        case .fullAccess:
            return .object([
                "type": .string("dangerFullAccess"),
            ])
        }
    }

    func shouldFallbackFromSandboxPolicy(_ error: Error) -> Bool {
        guard let serviceError = error as? CodexServiceError,
              case .rpcError(let rpcError) = serviceError else {
            return false
        }

        if rpcError.code != -32602 && rpcError.code != -32600 {
            return false
        }

        let loweredMessage = rpcError.message.lowercased()
        if loweredMessage.contains("thread not found") || loweredMessage.contains("unknown thread") {
            return false
        }

        return loweredMessage.contains("invalid params")
            || loweredMessage.contains("invalid param")
            || loweredMessage.contains("unknown field")
            || loweredMessage.contains("unexpected field")
            || loweredMessage.contains("unrecognized field")
            || loweredMessage.contains("failed to parse")
            || loweredMessage.contains("unsupported")
    }

    func sendRequestWithSandboxFallback(method: String, baseParams: RPCObject) async throws -> RPCMessage {
        var firstAttemptParams = baseParams
        firstAttemptParams["sandboxPolicy"] = runtimeSandboxPolicyObject(for: selectedAccessMode)

        do {
            debugRuntimeLog("\(method) using sandboxPolicy")
            return try await sendRequestWithApprovalPolicyFallback(
                method: method,
                baseParams: firstAttemptParams,
                context: "sandboxPolicy"
            )
        } catch {
            guard shouldFallbackFromSandboxPolicy(error) else {
                throw error
            }
        }

        var secondAttemptParams = baseParams
        secondAttemptParams["sandbox"] = .string(selectedAccessMode.sandboxLegacyValue)

        do {
            debugRuntimeLog("\(method) fallback using sandbox")
            return try await sendRequestWithApprovalPolicyFallback(
                method: method,
                baseParams: secondAttemptParams,
                context: "sandbox"
            )
        } catch {
            guard shouldFallbackFromSandboxPolicy(error) else {
                throw error
            }
        }

        var finalAttemptParams = baseParams
        debugRuntimeLog("\(method) fallback using minimal payload")
        return try await sendRequestWithApprovalPolicyFallback(
            method: method,
            baseParams: finalAttemptParams,
            context: "minimal"
        )
    }

    func handleModelListFailure(_ error: Error) {
        let message = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalized = message.isEmpty ? "Unable to load models" : message
        modelsErrorMessage = normalized
        debugRuntimeLog("model/list failed: \(normalized)")
    }

    func debugRuntimeLog(_ message: String) {
#if DEBUG
        print("[CodexRuntime] \(message)")
#endif
    }

    func shouldRetryWithApprovalPolicyFallback(_ error: Error) -> Bool {
        guard let serviceError = error as? CodexServiceError,
              case .rpcError(let rpcError) = serviceError else {
            return false
        }

        if rpcError.code != -32600 && rpcError.code != -32602 {
            return false
        }

        let message = rpcError.message.lowercased()
        return message.contains("approval")
            || message.contains("unknown variant")
            || message.contains("expected one of")
            || message.contains("onrequest")
            || message.contains("on-request")
    }
}

private extension CodexService {
    func normalizeRuntimeSelectionsAfterModelsUpdate(provider: String? = nil) {
        let providerID = runtimeProviderID(for: provider ?? currentRuntimeProviderID())
        guard !availableModels.isEmpty else {
            persistRuntimeSelections(providerID: providerID)
            return
        }

        let resolvedModel = selectedModelOption(from: availableModels) ?? fallbackModel(from: availableModels)
        selectedModelId = resolvedModel?.id

        if let resolvedModel {
            let supported = Set(resolvedModel.supportedReasoningEfforts.map { $0.reasoningEffort })
            if supported.isEmpty {
                selectedReasoningEffort = nil
            } else if let selectedReasoningEffort,
                      supported.contains(selectedReasoningEffort) {
                // Keep current reasoning.
            } else if let modelDefault = resolvedModel.defaultReasoningEffort,
                      supported.contains(modelDefault) {
                selectedReasoningEffort = modelDefault
            } else if supported.contains("medium") {
                selectedReasoningEffort = "medium"
            } else {
                selectedReasoningEffort = resolvedModel.supportedReasoningEfforts.first?.reasoningEffort
            }
        } else {
            selectedReasoningEffort = nil
        }

        persistRuntimeSelections(providerID: providerID)
    }

    func selectedModelOption(from models: [CodexModelOption]) -> CodexModelOption? {
        guard !models.isEmpty else {
            return nil
        }

        if let selectedModelId,
           let directMatch = models.first(where: { $0.id == selectedModelId || $0.model == selectedModelId }) {
            return directMatch
        }

        return nil
    }

    func fallbackModel(from models: [CodexModelOption]) -> CodexModelOption? {
        if let defaultModel = models.first(where: { $0.isDefault }) {
            return defaultModel
        }
        return models.first
    }

    func persistRuntimeSelectionsImpl(providerID: String? = nil) {
        let providerID = runtimeProviderID(for: providerID ?? currentRuntimeProviderID())
        defaults.set(selectedProviderID, forKey: Self.selectedProviderDefaultsKey)

        if let selectedModelId, !selectedModelId.isEmpty {
            runtimeModelIdByProvider[providerID] = selectedModelId
            defaults.set(selectedModelId, forKey: runtimeModelDefaultsKey(providerID))
        } else {
            runtimeModelIdByProvider.removeValue(forKey: providerID)
            defaults.removeObject(forKey: runtimeModelDefaultsKey(providerID))
        }

        if let selectedReasoningEffort, !selectedReasoningEffort.isEmpty {
            runtimeReasoningEffortByProvider[providerID] = selectedReasoningEffort
            defaults.set(selectedReasoningEffort, forKey: runtimeReasoningDefaultsKey(providerID))
        } else {
            runtimeReasoningEffortByProvider.removeValue(forKey: providerID)
            defaults.removeObject(forKey: runtimeReasoningDefaultsKey(providerID))
        }

        runtimeAccessModeByProvider[providerID] = selectedAccessMode
        defaults.set(selectedAccessMode.rawValue, forKey: runtimeAccessDefaultsKey(providerID))
    }

    func runtimeModelDefaultsKey(_ providerID: String) -> String {
        "runtime.\(providerID).selectedModelId"
    }

    func runtimeReasoningDefaultsKey(_ providerID: String) -> String {
        "runtime.\(providerID).selectedReasoningEffort"
    }

    func runtimeAccessDefaultsKey(_ providerID: String) -> String {
        "runtime.\(providerID).selectedAccessMode"
    }
}
