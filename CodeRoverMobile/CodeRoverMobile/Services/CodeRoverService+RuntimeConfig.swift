// FILE: CodeRoverService+RuntimeConfig.swift
// Purpose: Runtime model/reasoning/access preferences and model/list loading.
// Layer: Service
// Exports: CodeRoverService runtime config APIs
// Depends on: ModelOption, ReasoningEffortOption, AccessMode

import Foundation

extension CodeRoverService {
    func listProviders() async throws {
        let response = try await sendRequest(method: "_coderover/agent/list", params: nil)
        let decodedProviders = decodeAcpProviders(from: response.result)
        availableProviders = decodedProviders.isEmpty ? [.codexDefault] : decodedProviders

        let availableIDs = Set(availableProviders.map(\.id))
        if !availableIDs.contains(selectedProviderID) {
            selectedProviderID = availableProviders.first?.id ?? "codex"
        }
        syncRuntimeSelectionContext()
    }

    func listModels(provider: String? = nil) async throws {
        let resolvedProvider = runtimeProviderID(for: provider)
        if isLoadingModels, loadingModelsProviderID == resolvedProvider {
            return
        }

        isLoadingModels = true
        loadingModelsProviderID = resolvedProvider
        defer {
            isLoadingModels = false
            loadingModelsProviderID = nil
        }
        do {
            let response = try await sendRequest(
                method: "_coderover/model/list",
                params: .object([
                    "_meta": .object([
                        "coderover": .object([
                            "agentId": .string(resolvedProvider),
                        ]),
                    ]),
                ])
            )

            let decodedModels = decodeAcpModelOptions(from: response.result)
            availableModels = decodedModels
            loadedModelsProviderID = resolvedProvider
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

    func setSelectedAccessMode(_ accessMode: AccessMode) {
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

    func selectedModelOption() -> ModelOption? {
        selectedModelOption(from: availableModels)
    }

    func supportedReasoningEffortsForSelectedModel() -> [ReasoningEffortOption] {
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

    func currentRuntimeProvider() -> RuntimeProvider {
        let providerID = currentRuntimeProviderID()
        return availableProviders.first(where: { $0.id == providerID }) ?? .codexDefault
    }

    func selectedDefaultsProvider() -> RuntimeProvider {
        let providerID = runtimeProviderID(for: selectedProviderID)
        return availableProviders.first(where: { $0.id == providerID }) ?? .codexDefault
    }

    func availableAccessModes(for providerID: String? = nil) -> [AccessMode] {
        let runtimeProvider = availableProviders.first(where: { $0.id == runtimeProviderID(for: providerID) })
            ?? .codexDefault
        let allowedModeIDs = Set(runtimeProvider.accessModes.map(\.id))
        let filtered = AccessMode.allCases.filter { allowedModeIDs.contains($0.rawValue) }
        return filtered.isEmpty ? AccessMode.allCases : filtered
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
                  let parsedAccess = AccessMode(rawValue: storedAccess) {
            selectedAccessMode = parsedAccess
        } else {
            selectedAccessMode = .onRequest
        }

        if refreshModels, loadedModelsProviderID != resolvedProviderID {
            Task { @MainActor [weak self] in
                guard let self else { return }
                try? await self.listModels(provider: resolvedProviderID)
            }
        }
    }

    func handleModelListFailure(_ error: Error) {
        let message = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalized = message.isEmpty ? "Unable to load models" : message
        modelsErrorMessage = normalized
        debugRuntimeLog("model/list failed: \(normalized)")
    }

    func debugRuntimeLog(_ message: String) {
        coderoverDiagnosticLog("CodeRoverRuntime", message)
    }
}

private extension CodeRoverService {
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

    func selectedModelOption(from models: [ModelOption]) -> ModelOption? {
        guard !models.isEmpty else {
            return nil
        }

        if let selectedModelId,
           let directMatch = models.first(where: { $0.id == selectedModelId || $0.model == selectedModelId }) {
            return directMatch
        }

        return nil
    }

    func fallbackModel(from models: [ModelOption]) -> ModelOption? {
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
