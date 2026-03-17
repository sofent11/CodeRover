// FILE: CodeRoverService+AcpAdapter.swift
// Purpose: ACP-native session mapping, prompt encoding, and inbound update helpers.
// Layer: Service support
// Exports: CodeRoverService ACP helpers
// Depends on: CodeRoverService state, RPCMessage, JSONValue

import Foundation

private let acpHistoryFormatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
}()

extension CodeRoverService {
    func syncACPSessionConfiguration(
        threadId: String,
        collaborationMode: CollaborationModeModeKind?
    ) async throws {
        let sessionId = normalizedIdentifier(threadId) ?? threadId
        let modeId = collaborationMode?.rawValue ?? CollaborationModeModeKind.default.rawValue
        _ = try await sendRequest(
            method: "session/set_mode",
            params: .object([
                "sessionId": .string(sessionId),
                "modeId": .string(modeId),
            ])
        )

        if let modelId = runtimeModelIdentifierForTurn() {
            _ = try await sendRequest(
                method: "session/set_model",
                params: .object([
                    "sessionId": .string(sessionId),
                    "modelId": .string(modelId),
                ])
            )
        }

        let accessModeValue = selectedAccessMode == .fullAccess ? "full-access" : "on-request"
        _ = try await sendRequest(
            method: "session/set_config_option",
            params: .object([
                "sessionId": .string(sessionId),
                "configId": .string("access_mode"),
                "value": .string(accessModeValue),
            ])
        )

        if let effort = selectedReasoningEffortForSelectedModel() {
            _ = try await sendRequest(
                method: "session/set_config_option",
                params: .object([
                    "sessionId": .string(sessionId),
                    "configId": .string("reasoning_effort"),
                    "value": .string(effort),
                ])
            )
        }
    }

    func buildACPPromptBlocks(
        userInput: String,
        attachments: [ImageAttachment]
    ) -> [JSONValue] {
        var promptBlocks: [JSONValue] = []

        for attachment in attachments {
            guard let payloadDataURL = attachment.payloadDataURL,
                  let imageBlock = buildACPImageBlock(from: payloadDataURL) else {
                continue
            }
            promptBlocks.append(imageBlock)
        }

        let trimmedText = userInput.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedText.isEmpty {
            promptBlocks.append(
                .object([
                    "type": .string("text"),
                    "text": .string(trimmedText),
                ])
            )
        }

        return promptBlocks
    }

    func decodeAcpProviders(from result: JSONValue?) -> [RuntimeProvider] {
        let items = result?.objectValue?["agents"]?.arrayValue ?? []
        return items.compactMap { value in
            guard let object = value.objectValue else {
                return nil
            }

            let id = normalizedIdentifier(object["id"]?.stringValue) ?? "codex"
            let title = normalizedIdentifier(object["name"]?.stringValue) ?? id.capitalized
            let coderoverMeta = object["_meta"]?.objectValue?["coderover"]?.objectValue
            let capabilities = coderoverMeta?["supports"].flatMap { decodeModel(RuntimeCapabilities.self, from: $0) }
                ?? availableProviders.first(where: { $0.id == id })?.supports
                ?? .codexDefault
            let defaultModelId = normalizedIdentifier(coderoverMeta?["defaultModelId"]?.stringValue)

            return RuntimeProvider(
                id: id,
                title: title,
                supports: capabilities,
                accessModes: defaultRuntimeAccessModes(),
                defaultModelId: defaultModelId
            )
        }
    }

    func decodeAcpModelOptions(from result: JSONValue?) -> [ModelOption] {
        let object = result?.objectValue
        let items = object?["items"]?.arrayValue ?? object?["models"]?.arrayValue ?? []

        return items.compactMap { value in
            if let object = value.objectValue,
               let coderoverRecord = object["_meta"]?.objectValue?["coderover"]?.objectValue,
               let decoded = decodeModel(ModelOption.self, from: .object(coderoverRecord)) {
                return decoded
            }

            guard let object = value.objectValue else {
                return nil
            }

            let modelId = normalizedIdentifier(object["modelId"]?.stringValue)
                ?? normalizedIdentifier(object["id"]?.stringValue)
                ?? normalizedIdentifier(object["model"]?.stringValue)
                ?? "model"
            let displayName = normalizedIdentifier(object["name"]?.stringValue)
                ?? normalizedIdentifier(object["displayName"]?.stringValue)
                ?? modelId
            let description = normalizedIdentifier(object["description"]?.stringValue) ?? ""
            let currentDefault = object["isDefault"]?.boolValue ?? false

            return ModelOption(
                id: modelId,
                model: modelId,
                displayName: displayName,
                description: description,
                isDefault: currentDefault,
                supportedReasoningEfforts: defaultReasoningEfforts(),
                defaultReasoningEffort: defaultReasoningEfforts().first?.reasoningEffort
            )
        }
    }

    func decodeAcpSessionInfo(from value: JSONValue) -> ConversationThread? {
        guard let object = value.objectValue else {
            return nil
        }

        let sessionId = normalizedIdentifier(object["sessionId"]?.stringValue)
            ?? normalizedIdentifier(object["id"]?.stringValue)
        guard let sessionId else {
            return nil
        }

        let coderoverMeta = object["_meta"]?.objectValue?["coderover"]?.objectValue
        let provider = normalizedIdentifier(coderoverMeta?["agentId"]?.stringValue) ?? "codex"
        let title = normalizedIdentifier(object["title"]?.stringValue)
        let updatedAt = object["updatedAt"]?.stringValue.flatMap(parseACPISO8601Date)
        let archived = object["archived"]?.boolValue
            ?? coderoverMeta?["archived"]?.boolValue
            ?? false
        let capabilities = coderoverMeta?["capabilities"].flatMap { decodeModel(RuntimeCapabilities.self, from: $0) }
            ?? availableProviders.first(where: { $0.id == provider })?.supports
            ?? .codexDefault

        var metadata: [String: JSONValue] = [:]
        if let providerTitle = availableProviders.first(where: { $0.id == provider })?.title {
            metadata["providerTitle"] = .string(providerTitle)
        }

        return ConversationThread(
            id: sessionId,
            title: title,
            name: title,
            preview: normalizedIdentifier(coderoverMeta?["preview"]?.stringValue),
            createdAt: nil,
            updatedAt: updatedAt,
            cwd: normalizedIdentifier(object["cwd"]?.stringValue),
            provider: provider,
            providerSessionId: normalizedIdentifier(coderoverMeta?["providerSessionId"]?.stringValue),
            capabilities: capabilities,
            metadata: metadata.isEmpty ? nil : metadata,
            syncState: archived ? .archivedLocal : .live
        )
    }

    @discardableResult
    func applyAcpSessionState(
        sessionId: String,
        stateObject: RPCObject,
        preferredProjectPath: String? = nil,
        title: String? = nil,
        providerHint: String? = nil
    ) -> ConversationThread {
        let coderoverMeta = stateObject["_meta"]?.objectValue?["coderover"]?.objectValue
        let provider = normalizedIdentifier(coderoverMeta?["agentId"]?.stringValue)
            ?? normalizedIdentifier(providerHint)
            ?? threads.first(where: { $0.id == sessionId })?.provider
            ?? "codex"
        let existingThread = threads.first(where: { $0.id == sessionId })
        let modes = stateObject["modes"]?.objectValue
        let availableModes = modes?["availableModes"]?.arrayValue ?? []
        let supportsPlan = availableModes.contains { modeValue in
            normalizedIdentifier(modeValue.objectValue?["id"]?.stringValue) == CollaborationModeModeKind.plan.rawValue
        }
        let baseCapabilities = existingThread?.capabilities
            ?? availableProviders.first(where: { $0.id == provider })?.supports
            ?? .codexDefault
        let capabilities = RuntimeCapabilities(
            planMode: supportsPlan || baseCapabilities.planMode,
            structuredUserInput: baseCapabilities.structuredUserInput,
            inlineApproval: baseCapabilities.inlineApproval,
            turnSteer: false,
            reasoningOptions: baseCapabilities.reasoningOptions,
            desktopRefresh: baseCapabilities.desktopRefresh,
            desktopRestart: baseCapabilities.desktopRestart
        )

        let resolvedTitle = normalizedIdentifier(title)
            ?? existingThread?.title
            ?? existingThread?.name
        let resolvedCwd = preferredProjectPath
            ?? existingThread?.cwd

        let currentModelId = normalizedIdentifier(
            stateObject["models"]?.objectValue?["currentModelId"]?.stringValue
        )
        let currentModeId = normalizedIdentifier(modes?["currentModeId"]?.stringValue)

        var metadata = existingThread?.metadata ?? [:]
        if let providerTitle = availableProviders.first(where: { $0.id == provider })?.title {
            metadata["providerTitle"] = .string(providerTitle)
        }
        if let currentModelId {
            metadata["currentModelId"] = .string(currentModelId)
        }
        if let currentModeId {
            metadata["currentModeId"] = .string(currentModeId)
        }

        let thread = ConversationThread(
            id: sessionId,
            title: resolvedTitle,
            name: resolvedTitle,
            preview: existingThread?.preview,
            createdAt: existingThread?.createdAt,
            updatedAt: existingThread?.updatedAt ?? Date(),
            cwd: resolvedCwd,
            provider: provider,
            providerSessionId: existingThread?.providerSessionId,
            capabilities: capabilities,
            metadata: metadata.isEmpty ? nil : metadata,
            syncState: existingThread?.syncState ?? .live
        )
        upsertThread(thread)
        return thread
    }

    func handleACPSessionUpdate(_ paramsObject: IncomingParamsObject?) {
        guard let paramsObject,
              let sessionId = normalizedIdentifier(paramsObject["sessionId"]?.stringValue),
              let updateObject = paramsObject["update"]?.objectValue,
              let updateType = normalizedIdentifier(updateObject["sessionUpdate"]?.stringValue) else {
            return
        }

        switch updateType {
        case "session_info_update":
            handleACPSessionInfoUpdate(sessionId: sessionId, updateObject: updateObject)

        case "user_message_chunk":
            upsertACPMessageChunk(
                sessionId: sessionId,
                updateObject: updateObject,
                role: .user,
                kind: .chat,
                defaultStreaming: false
            )

        case "agent_message_chunk":
            upsertACPMessageChunk(
                sessionId: sessionId,
                updateObject: updateObject,
                role: .assistant,
                kind: .chat,
                defaultStreaming: true
            )

        case "agent_thought_chunk":
            upsertACPMessageChunk(
                sessionId: sessionId,
                updateObject: updateObject,
                role: .system,
                kind: .thinking,
                defaultStreaming: true
            )

        case "plan":
            upsertACPPlanUpdate(sessionId: sessionId, updateObject: updateObject)

        case "tool_call", "tool_call_update":
            upsertACPToolCall(sessionId: sessionId, updateObject: updateObject)

        case "usage_update":
            handleACPUsageUpdate(sessionId: sessionId, updateObject: updateObject)

        case "current_mode_update":
            _ = applyAcpSessionState(sessionId: sessionId, stateObject: ["modes": .object(updateObject)])

        case "config_option_update":
            _ = applyAcpSessionState(sessionId: sessionId, stateObject: ["configOptions": updateObject["configOptions"] ?? .array([])])

        default:
            return
        }
    }

    func handleACPRequestPermission(requestID: JSONValue, paramsObject: IncomingParamsObject?) {
        guard let paramsObject,
              let sessionId = normalizedIdentifier(paramsObject["sessionId"]?.stringValue) else {
            return
        }

        let toolCall = paramsObject["toolCall"]?.objectValue
        let title = toolCall?["title"]?.stringValue
        let kind = normalizedIdentifier(toolCall?["kind"]?.stringValue)
        let rawInput = toolCall?["rawInput"]?.objectValue
        let command = rawInput?["command"]?.stringValue
        let reason = rawInput?["reason"]?.stringValue
        let method = kind == "execute"
            ? "session/request_permission/execute"
            : "session/request_permission/edit"

        let request = CodeRoverApprovalRequest(
            id: idKey(from: requestID),
            requestID: requestID,
            method: method,
            command: command ?? title,
            reason: reason,
            threadId: sessionId,
            turnId: extractAcpTurnId(from: toolCall?["_meta"]?.objectValue?["coderover"]?.objectValue),
            params: .object(paramsObject)
        )

        if selectedAccessMode == .fullAccess {
            Task { @MainActor [weak self] in
                guard let self else { return }
                do {
                    try await sendResponse(
                        id: requestID,
                        result: .object([
                            "outcome": .object([
                                "optionId": .string("allow_always"),
                            ]),
                        ])
                    )
                } catch {
                    pendingApproval = request
                }
            }
            return
        }

        pendingApproval = request
    }

    func handleACPStructuredInputRequest(requestID: JSONValue, paramsObject: IncomingParamsObject?) {
        guard let paramsObject,
              let sessionId = normalizedIdentifier(paramsObject["sessionId"]?.stringValue) else {
            return
        }

        let questions = decodeACPStructuredUserInputQuestions(from: paramsObject["questions"])
        guard !questions.isEmpty else {
            return
        }

        let requestMeta = paramsObject["_meta"]?.objectValue?["coderover"]?.objectValue
        let turnId = extractAcpTurnId(from: requestMeta) ?? activeTurnIdByThread[sessionId]
        let itemId = normalizedIdentifier(requestMeta?["itemId"]?.stringValue) ?? "request-\(idKey(from: requestID))"

        if let turnId {
            threadIdByTurnID[turnId] = sessionId
        }

        upsertStructuredUserInputPrompt(
            threadId: sessionId,
            turnId: turnId ?? activeTurnIdByThread[sessionId],
            itemId: itemId,
            request: CodeRoverStructuredUserInputRequest(
                requestID: requestID,
                questions: questions
            )
        )

        notifyStructuredUserInputIfNeeded(
            threadId: sessionId,
            turnId: turnId,
            requestID: requestID
        )
    }

    func handleACPSessionInfoUpdate(sessionId: String, updateObject: RPCObject) {
        let coderoverMeta = updateObject["_meta"]?.objectValue?["coderover"]?.objectValue
        let agentId = normalizedIdentifier(coderoverMeta?["agentId"]?.stringValue)
            ?? threads.first(where: { $0.id == sessionId })?.provider
            ?? "codex"
        let title = normalizedIdentifier(updateObject["title"]?.stringValue)
        let cwd = normalizedIdentifier(updateObject["cwd"]?.stringValue)
            ?? normalizedIdentifier(coderoverMeta?["cwd"]?.stringValue)
        let updatedAt = updateObject["updatedAt"]?.stringValue.flatMap(parseACPISO8601Date)
        let archived = updateObject["archived"]?.boolValue
            ?? coderoverMeta?["archived"]?.boolValue

        var thread = threads.first(where: { $0.id == sessionId }) ?? ConversationThread(id: sessionId, provider: agentId)
        if let title {
            thread.title = title
            thread.name = title
        }
        if let cwd {
            thread.cwd = cwd
        }
        if let updatedAt {
            thread.updatedAt = updatedAt
        } else if thread.updatedAt == nil {
            thread.updatedAt = Date()
        }
        thread.provider = agentId
        if let archived {
            thread.syncState = archived ? .archivedLocal : .live
        }
        if thread.capabilities == nil {
            thread.capabilities = availableProviders.first(where: { $0.id == agentId })?.supports ?? .codexDefault
        }
        upsertThread(thread)

        let runState = normalizedIdentifier(coderoverMeta?["runState"]?.stringValue)
        let turnId = extractAcpTurnId(from: coderoverMeta) ?? activeTurnIdByThread[sessionId]
        let errorMessage = normalizedIdentifier(coderoverMeta?["errorMessage"]?.stringValue)

        guard let runState else {
            return
        }

        switch runState {
        case "running":
            var lifecycleParams: IncomingParamsObject = [
                "threadId": .string(sessionId),
                "status": .string(runState),
            ]
            if let turnId {
                lifecycleParams["turnId"] = .string(turnId)
            }
            handleTurnStarted(lifecycleParams)

        case "completed", "failed", "stopped", "cancelled":
            var lifecycleParams: IncomingParamsObject = [
                "threadId": .string(sessionId),
                "status": .string(runState == "cancelled" ? "stopped" : runState),
            ]
            if let turnId {
                lifecycleParams["turnId"] = .string(turnId)
            }
            if let errorMessage {
                lifecycleParams["error"] = .object([
                    "message": .string(errorMessage),
                ])
                lifecycleParams["errorMessage"] = .string(errorMessage)
            }
            handleTurnCompleted(lifecycleParams)

        default:
            return
        }
    }

    func upsertACPMessageChunk(
        sessionId: String,
        updateObject: RPCObject,
        role: ChatMessageRole,
        kind: ChatMessageKind,
        defaultStreaming: Bool
    ) {
        let coderoverMeta = updateObject["_meta"]?.objectValue?["coderover"]?.objectValue
        let messageId = normalizedIdentifier(updateObject["messageId"]?.stringValue)
            ?? normalizedIdentifier(coderoverMeta?["itemId"]?.stringValue)
        guard let messageId else {
            return
        }

        let turnId = extractAcpTurnId(from: coderoverMeta) ?? activeTurnIdByThread[sessionId]
        if let turnId {
            threadIdByTurnID[turnId] = sessionId
        }

        let text = extractACPText(from: updateObject["content"])
        let attachments = extractACPAttachments(from: updateObject["content"])
        let existing = threadTimelineStateByThread[sessionId]?.message(for: messageId)
            ?? messagesByThread[sessionId]?.first(where: { $0.id == messageId })
        let mergedText = mergeAssistantDelta(existingText: existing?.text ?? "", incomingDelta: text)

        var message = existing ?? ChatMessage(
            id: messageId,
            threadId: sessionId,
            role: role,
            kind: kind,
            text: mergedText,
            turnId: turnId,
            itemId: messageId,
            isStreaming: defaultStreaming,
            deliveryState: .confirmed,
            attachments: attachments,
            orderIndex: MessageOrderCounter.next()
        )
        message.role = role
        message.kind = kind
        message.turnId = turnId ?? message.turnId
        message.itemId = messageId
        message.deliveryState = .confirmed
        message.isStreaming = defaultStreaming
        if !text.isEmpty {
            message.text = mergedText
        }
        if !attachments.isEmpty {
            let existingAttachments = Set(message.attachments)
            message.attachments = message.attachments + attachments.filter { !existingAttachments.contains($0) }
        }

        _ = upsertThreadTimelineMessage(message)
        persistMessages()
        updateCurrentOutput(for: sessionId)
    }

    func upsertACPPlanUpdate(sessionId: String, updateObject: RPCObject) {
        let coderoverMeta = updateObject["_meta"]?.objectValue?["coderover"]?.objectValue
        let itemId = normalizedIdentifier(coderoverMeta?["itemId"]?.stringValue) ?? "plan-\(sessionId)"
        let turnId = extractAcpTurnId(from: coderoverMeta) ?? activeTurnIdByThread[sessionId]
        let explanation = normalizedIdentifier(coderoverMeta?["explanation"]?.stringValue)
        let entries = updateObject["entries"]?.arrayValue ?? []
        let steps = entries.compactMap { entry -> CodeRoverPlanStep? in
            guard let object = entry.objectValue else {
                return nil
            }

            let step = normalizedIdentifier(object["content"]?.stringValue)
                ?? normalizedIdentifier(object["step"]?.stringValue)
            let rawStatus = normalizedIdentifier(object["status"]?.stringValue)
            guard let step,
                  let rawStatus,
                  let status = CodeRoverPlanStepStatus(rawValue: rawStatus) else {
                return nil
            }

            return CodeRoverPlanStep(step: step, status: status)
        }
        let planState = CodeRoverPlanState(explanation: explanation, steps: steps)
        let existing = threadTimelineStateByThread[sessionId]?.message(for: itemId)
        var message = existing ?? ChatMessage(
            id: itemId,
            threadId: sessionId,
            role: .system,
            kind: .plan,
            text: explanation ?? "Planning...",
            turnId: turnId,
            itemId: itemId,
            isStreaming: true,
            deliveryState: .confirmed,
            planState: planState,
            orderIndex: MessageOrderCounter.next()
        )
        message.text = explanation ?? message.text
        message.turnId = turnId ?? message.turnId
        message.planState = planState
        message.isStreaming = true
        _ = upsertThreadTimelineMessage(message)
        persistMessages()
        updateCurrentOutput(for: sessionId)
    }

    func upsertACPToolCall(sessionId: String, updateObject: RPCObject) {
        let coderoverMeta = updateObject["_meta"]?.objectValue?["coderover"]?.objectValue
        let itemId = normalizedIdentifier(updateObject["toolCallId"]?.stringValue)
            ?? normalizedIdentifier(coderoverMeta?["itemId"]?.stringValue)
        guard let itemId else {
            return
        }

        let turnId = extractAcpTurnId(from: coderoverMeta) ?? activeTurnIdByThread[sessionId]
        let toolKind = normalizedIdentifier(updateObject["kind"]?.stringValue)
        let messageKind: ChatMessageKind = toolKind == "execute" ? .commandExecution : .fileChange
        let status = normalizedIdentifier(updateObject["status"]?.stringValue) ?? "in_progress"
        let text = extractACPText(from: updateObject["content"])
        let existing = threadTimelineStateByThread[sessionId]?.message(for: itemId)
        let mergedText = mergeAssistantDelta(existingText: existing?.text ?? "", incomingDelta: text)

        var message = existing ?? ChatMessage(
            id: itemId,
            threadId: sessionId,
            role: .system,
            kind: messageKind,
            text: mergedText,
            turnId: turnId,
            itemId: itemId,
            isStreaming: status == "in_progress",
            deliveryState: .confirmed,
            orderIndex: MessageOrderCounter.next()
        )
        message.kind = messageKind
        message.role = .system
        message.turnId = turnId ?? message.turnId
        message.itemId = itemId
        if !text.isEmpty {
            message.text = mergedText
        }
        message.isStreaming = status == "in_progress"
        _ = upsertThreadTimelineMessage(message)

        if messageKind == .commandExecution {
            var details = commandExecutionDetailsByItemID[itemId] ?? CommandExecutionDetails(
                fullCommand: normalizedIdentifier(updateObject["rawInput"]?.objectValue?["command"]?.stringValue)
                    ?? normalizedIdentifier(updateObject["title"]?.stringValue)
                    ?? "command",
                cwd: normalizedIdentifier(updateObject["rawInput"]?.objectValue?["cwd"]?.stringValue),
                exitCode: nil,
                durationMs: nil,
                outputTail: ""
            )
            if let command = normalizedIdentifier(updateObject["rawInput"]?.objectValue?["command"]?.stringValue) {
                details.fullCommand = command
            }
            if let cwd = normalizedIdentifier(updateObject["rawInput"]?.objectValue?["cwd"]?.stringValue) {
                details.cwd = cwd
            }
            details.exitCode = updateObject["rawOutput"]?.objectValue?["exitCode"]?.intValue ?? details.exitCode
            details.durationMs = updateObject["rawOutput"]?.objectValue?["durationMs"]?.intValue ?? details.durationMs
            if !text.isEmpty {
                details.appendOutput(text)
            }
            commandExecutionDetailsByItemID[itemId] = details
        }

        persistMessages()
        updateCurrentOutput(for: sessionId)
    }

    func handleACPUsageUpdate(sessionId: String, updateObject: RPCObject) {
        let usageObject = updateObject["usage"]?.objectValue
        guard let usage = extractContextWindowUsage(from: usageObject) else {
            return
        }
        contextWindowUsageByThread[sessionId] = usage
    }

    func extractACPText(from value: JSONValue?) -> String {
        if let object = value?.objectValue,
           object["type"]?.stringValue == "text" {
            return object["text"]?.stringValue ?? ""
        }

        let contentItems = value?.arrayValue ?? []
        var parts: [String] = []
        for item in contentItems {
            guard let object = item.objectValue else { continue }
            if let content = object["content"]?.objectValue,
               content["type"]?.stringValue == "text",
               let text = content["text"]?.stringValue,
               !text.isEmpty {
                parts.append(text)
            } else if let content = object["content"]?.stringValue,
                      !content.isEmpty {
                parts.append(content)
            }
        }
        return parts.joined()
    }

    func extractACPAttachments(from value: JSONValue?) -> [ImageAttachment] {
        var attachments: [ImageAttachment] = []
        let items = value?.arrayValue ?? []
        for item in items {
            guard let object = item.objectValue else { continue }
            let content = object["content"]?.objectValue ?? object
            guard content["type"]?.stringValue == "image" else { continue }
            let data = content["data"]?.stringValue
            let mimeType = content["mimeType"]?.stringValue ?? "image/jpeg"
            let payloadDataURL = data.map { "data:\(mimeType);base64,\($0)" }
            attachments.append(
                ImageAttachment(
                    thumbnailBase64JPEG: "",
                    payloadDataURL: payloadDataURL,
                    sourceURL: content["uri"]?.stringValue
                )
            )
        }
        return attachments
    }

    func extractAcpTurnId(from coderoverMeta: RPCObject?) -> String? {
        normalizedIdentifier(coderoverMeta?["turnId"]?.stringValue)
    }

    func parseACPISO8601Date(_ value: String) -> Date? {
        acpHistoryFormatter.date(from: value)
    }

    func decodeACPStructuredUserInputQuestions(from value: JSONValue?) -> [CodeRoverStructuredUserInputQuestion] {
        let items = value?.arrayValue ?? []
        return items.compactMap { value in
            guard let object = value.objectValue,
                  let id = normalizedIdentifier(object["id"]?.stringValue),
                  let header = normalizedIdentifier(object["header"]?.stringValue) ?? object["header"]?.stringValue,
                  let question = normalizedIdentifier(object["question"]?.stringValue) ?? object["question"]?.stringValue else {
                return nil
            }

            let options = (object["options"]?.arrayValue ?? []).compactMap { optionValue -> CodeRoverStructuredUserInputOption? in
                guard let optionObject = optionValue.objectValue,
                      let label = normalizedIdentifier(optionObject["label"]?.stringValue),
                      let description = normalizedIdentifier(optionObject["description"]?.stringValue)
                        ?? optionObject["description"]?.stringValue else {
                    return nil
                }
                return CodeRoverStructuredUserInputOption(label: label, description: description)
            }

            return CodeRoverStructuredUserInputQuestion(
                id: id,
                header: header,
                question: question,
                isOther: object["isOther"]?.boolValue ?? false,
                isSecret: object["isSecret"]?.boolValue ?? false,
                options: options
            )
        }
    }
}

private extension CodeRoverService {
    func defaultRuntimeAccessModes() -> [RuntimeAccessModeOption] {
        [
            RuntimeAccessModeOption(id: "on-request", title: "On-Request"),
            RuntimeAccessModeOption(id: "full-access", title: "Full access"),
        ]
    }

    func defaultReasoningEfforts() -> [ReasoningEffortOption] {
        [
            ReasoningEffortOption(reasoningEffort: "low", description: "Low"),
            ReasoningEffortOption(reasoningEffort: "medium", description: "Medium"),
            ReasoningEffortOption(reasoningEffort: "high", description: "High"),
        ]
    }

    func buildACPImageBlock(from rawValue: String) -> JSONValue? {
        guard let parsed = parseACPDataURL(rawValue) else {
            return nil
        }

        return .object([
            "type": .string("image"),
            "data": .string(parsed.data),
            "mimeType": .string(parsed.mimeType),
        ])
    }

    func parseACPDataURL(_ value: String) -> (mimeType: String, data: String)? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("data:"),
              let commaIndex = trimmed.firstIndex(of: ",") else {
            return nil
        }

        let header = String(trimmed[..<commaIndex])
        let data = String(trimmed[trimmed.index(after: commaIndex)...])
        guard !data.isEmpty else {
            return nil
        }

        let headerParts = header.dropFirst("data:".count).split(separator: ";", omittingEmptySubsequences: false)
        let mimeType = headerParts.first.map(String.init).flatMap(normalizedIdentifier) ?? "image/jpeg"
        return (mimeType: mimeType, data: data)
    }
}
