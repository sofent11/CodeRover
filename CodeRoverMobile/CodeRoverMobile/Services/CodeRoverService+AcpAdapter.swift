// FILE: CodeRoverService+AcpAdapter.swift
// Purpose: Translates legacy service RPC usage onto ACP session APIs and `_coderover/*` extensions.
// Layer: Service adapter
// Exports: CodeRoverService ACP request/response + inbound update helpers
// Depends on: CodeRoverService state, RPCMessage, JSONValue

import Foundation

private let acpHistoryFormatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
}()

struct ACPWireRequest {
    let method: String
    let params: JSONValue?
}

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

    func translateLegacyRequestToACP(method: String, params: JSONValue?) -> ACPWireRequest {
        let paramsObject = params?.objectValue ?? [:]

        if method == "runtime/provider/list" {
            return ACPWireRequest(method: "_coderover/agent/list", params: params)
        }

        if method == "model/list" {
            return ACPWireRequest(method: "_coderover/model/list", params: translateProviderSelectorParams(paramsObject))
        }

        if method == "skills/list" {
            return ACPWireRequest(method: "_coderover/skills/list", params: params)
        }

        if method == "fuzzyFileSearch" {
            return ACPWireRequest(method: "_coderover/fuzzy_file_search", params: params)
        }

        if method.hasPrefix("git/") {
            return ACPWireRequest(
                method: "_coderover/\(method)",
                params: params
            )
        }

        if method.hasPrefix("workspace/") {
            return ACPWireRequest(
                method: "_coderover/\(method)",
                params: params
            )
        }

        if method.hasPrefix("desktop/") {
            return ACPWireRequest(
                method: "_coderover/\(method)",
                params: params
            )
        }

        if method == "thread/contextWindow/read" {
            return ACPWireRequest(
                method: "_coderover/context_window/read",
                params: .object([
                    "sessionId": paramsObject["threadId"] ?? paramsObject["thread_id"] ?? .null,
                    "turnId": paramsObject["turnId"] ?? paramsObject["turn_id"] ?? .null,
                ])
            )
        }

        if method == "thread/list" {
            var acpParams = paramsObject
            if let archived = paramsObject["archived"] {
                acpParams["_meta"] = .object([
                    "coderover": .object([
                        "archived": archived,
                    ]),
                ])
                acpParams.removeValue(forKey: "archived")
            }
            return ACPWireRequest(method: "session/list", params: .object(acpParams))
        }

        if method == "thread/start" {
            let provider = paramsObject["provider"]?.stringValue ?? selectedProviderID
            var metaCoderover: RPCObject = [
                "agentId": .string(runtimeProviderID(for: provider)),
            ]
            if let model = paramsObject["model"]?.stringValue,
               !model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                metaCoderover["model"] = .string(model)
            }
            var acpParams: RPCObject = [
                "_meta": .object([
                    "coderover": .object(metaCoderover),
                ]),
            ]
            if let cwd = paramsObject["cwd"] ?? paramsObject["currentWorkingDirectory"] {
                acpParams["cwd"] = cwd
            }
            if let model = paramsObject["model"] {
                acpParams["modelId"] = model
            }
            return ACPWireRequest(method: "session/new", params: .object(acpParams))
        }

        if method == "thread/resume" {
            let sessionId = paramsObject["threadId"] ?? paramsObject["thread_id"] ?? .null
            let threadID = paramsObject["threadId"]?.stringValue ?? paramsObject["thread_id"]?.stringValue
            let shouldWarmResume = shouldPreferACPWarmResume(threadId: threadID)
            return ACPWireRequest(
                method: shouldWarmResume ? "session/resume" : "session/load",
                params: .object([
                    "sessionId": sessionId,
                    "modelId": paramsObject["model"] ?? .null,
                ])
            )
        }

        if method == "thread/read" {
            let sessionId = paramsObject["threadId"] ?? paramsObject["thread_id"] ?? .null
            let includeTurns = paramsObject["includeTurns"]?.boolValue ?? true
            let historyMode = paramsObject["history"]?.objectValue?["mode"]?.stringValue
            let wireMethod =
                (!includeTurns && historyMode == nil)
                ? "session/resume"
                : "session/load"
            return ACPWireRequest(
                method: wireMethod,
                params: .object([
                    "sessionId": sessionId,
                ])
            )
        }

        if method == "turn/start" || method == "turn/steer" {
            let sessionId = paramsObject["threadId"] ?? paramsObject["thread_id"] ?? .null
            let promptBlocks = translateLegacyInputItemsToAcpPrompt(paramsObject["input"]?.arrayValue ?? [])
            var acpParams: RPCObject = [
                "sessionId": sessionId,
                "prompt": .array(promptBlocks),
            ]
            if let messageId = paramsObject["messageId"] {
                acpParams["messageId"] = messageId
            }
            if let model = paramsObject["model"] {
                acpParams["modelId"] = model
            }
            if let effort = paramsObject["effort"] {
                acpParams["_meta"] = .object([
                    "coderover": .object([
                        "reasoningEffort": effort,
                    ]),
                ])
            }
            return ACPWireRequest(method: "session/prompt", params: .object(acpParams))
        }

        if method == "thread/name/set" {
            return ACPWireRequest(
                method: "_coderover/session/set_title",
                params: .object([
                    "sessionId": paramsObject["threadId"] ?? paramsObject["thread_id"] ?? .null,
                    "title": paramsObject["name"] ?? .null,
                ])
            )
        }

        if method == "thread/archive" || method == "thread/unarchive" {
            return ACPWireRequest(
                method: method == "thread/archive"
                    ? "_coderover/session/archive"
                    : "_coderover/session/unarchive",
                params: .object([
                    "sessionId": paramsObject["threadId"] ?? paramsObject["thread_id"] ?? .null,
                ])
            )
        }

        return ACPWireRequest(method: method, params: params)
    }

    func translateACPResponseIfNeeded(
        originalMethod: String,
        originalParams: JSONValue?,
        response: RPCMessage
    ) -> RPCMessage {
        guard response.error == nil else {
            return response
        }

        switch originalMethod {
        case "runtime/provider/list":
            return RPCMessage(
                id: response.id,
                result: .object([
                    "providers": .array(buildLegacyProviders(from: response.result)),
                ]),
                includeJSONRPC: false
            )

        case "model/list":
            return RPCMessage(
                id: response.id,
                result: .object([
                    "items": .array(buildLegacyModelItems(from: response.result)),
                ]),
                includeJSONRPC: false
            )

        case "thread/list":
            return RPCMessage(
                id: response.id,
                result: .object(buildLegacyThreadListResult(from: response.result)),
                includeJSONRPC: false
            )

        case "thread/start":
            if let resultObject = response.result?.objectValue,
               let threadValue = buildLegacyThreadSummary(from: resultObject) {
                return RPCMessage(
                    id: response.id,
                    result: .object([
                        "thread": threadValue,
                    ]),
                    includeJSONRPC: false
                )
            }
            return response

        case "thread/read", "thread/resume":
            guard let paramsObject = originalParams?.objectValue,
                  let threadId = normalizedIdentifier(
                    paramsObject["threadId"]?.stringValue ?? paramsObject["thread_id"]?.stringValue
                  ) else {
                return response
            }
            let includeTurns = paramsObject["includeTurns"]?.boolValue ?? true
            let threadValue = buildSyntheticLegacyThreadValue(threadId: threadId, includeTurns: includeTurns)
            return RPCMessage(
                id: response.id,
                result: .object([
                    "thread": threadValue,
                    "historyWindow": .object([
                        "hasOlder": .bool(false),
                        "hasNewer": .bool(false),
                    ]),
                ]),
                includeJSONRPC: false
            )

        case "turn/start", "turn/steer":
            let paramsObject = originalParams?.objectValue
            let threadId = normalizedIdentifier(
                paramsObject?["threadId"]?.stringValue ?? paramsObject?["thread_id"]?.stringValue
            )
            var resultObject: RPCObject = [:]
            if let threadId {
                resultObject["threadId"] = .string(threadId)
                if let turnId = activeTurnIdByThread[threadId] {
                    resultObject["turnId"] = .string(turnId)
                }
            }
            return RPCMessage(id: response.id, result: .object(resultObject), includeJSONRPC: false)

        default:
            return response
        }
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
}

private extension CodeRoverService {
    func translateProviderSelectorParams(_ paramsObject: RPCObject) -> JSONValue {
        guard let provider = paramsObject["provider"] else {
            return .object(paramsObject)
        }
        var translated = paramsObject
        translated["_meta"] = .object([
            "coderover": .object([
                "agentId": provider,
            ]),
        ])
        return .object(translated)
    }

    func shouldPreferACPWarmResume(threadId: String?) -> Bool {
        guard let threadId else { return false }
        let hasMessages = !(messagesByThread[threadId] ?? []).isEmpty
        return resumedThreadIDs.contains(threadId) && hydratedThreadIDs.contains(threadId) && hasMessages
    }

    func translateLegacyInputItemsToAcpPrompt(_ items: [JSONValue]) -> [JSONValue] {
        items.compactMap { item in
            guard let object = item.objectValue,
                  let type = normalizedIdentifier(object["type"]?.stringValue) else {
                return nil
            }

            switch type {
            case "text":
                guard let text = normalizedIdentifier(object["text"]?.stringValue) else { return nil }
                return .object([
                    "type": .string("text"),
                    "text": .string(text),
                ])

            case "image":
                guard let rawValue = object["url"]?.stringValue ?? object["image_url"]?.stringValue,
                      let imageBlock = buildACPImageBlock(from: rawValue) else {
                    return nil
                }
                return imageBlock

            case "skill":
                let id = normalizedIdentifier(object["id"]?.stringValue) ?? "skill"
                let name = normalizedIdentifier(object["name"]?.stringValue) ?? id
                let uri = normalizedIdentifier(object["path"]?.stringValue) ?? "skill://\(id)"
                return .object([
                    "type": .string("resource_link"),
                    "uri": .string(uri),
                    "name": .string(name),
                    "title": .string(name),
                    "_meta": .object([
                        "coderover": .object([
                            "inputType": .string("skill"),
                            "id": .string(id),
                            "path": .string(uri),
                        ]),
                    ]),
                ])

            default:
                return nil
            }
        }
    }

    func buildACPImageBlock(from rawValue: String) -> JSONValue? {
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return nil
        }

        if let (mimeType, data) = parseDataURL(trimmed) {
            return .object([
                "type": .string("image"),
                "data": .string(data),
                "mimeType": .string(mimeType),
            ])
        }

        return .object([
            "type": .string("resource_link"),
            "uri": .string(trimmed),
            "name": .string((trimmed as NSString).lastPathComponent.isEmpty ? trimmed : (trimmed as NSString).lastPathComponent),
            "title": .string(trimmed),
            "_meta": .object([
                "coderover": .object([
                    "inputType": .string("local_image"),
                    "path": .string(trimmed),
                ]),
            ]),
        ])
    }

    func parseDataURL(_ value: String) -> (mimeType: String, data: String)? {
        guard value.hasPrefix("data:"),
              let separator = value.range(of: ";base64,") else {
            return nil
        }

        let mimeStart = value.index(value.startIndex, offsetBy: 5)
        let mimeType = String(value[mimeStart..<separator.lowerBound])
        let dataStart = separator.upperBound
        let data = String(value[dataStart...])
        guard !mimeType.isEmpty, !data.isEmpty else {
            return nil
        }
        return (mimeType, data)
    }

    func buildLegacyProviders(from result: JSONValue?) -> [JSONValue] {
        let items = result?.objectValue?["agents"]?.arrayValue ?? []
        return items.compactMap { value in
            guard let object = value.objectValue else { return nil }
            let coderoverMeta = object["_meta"]?.objectValue?["coderover"]?.objectValue
            let supports = coderoverMeta?["supports"] ?? .object([:])
            return .object([
                "id": object["id"] ?? .string("codex"),
                "title": object["name"] ?? object["title"] ?? .string("Codex"),
                "supports": supports,
                "accessModes": .array([
                    .object(["id": .string("on-request"), "title": .string("On-Request")]),
                    .object(["id": .string("full-access"), "title": .string("Full access")]),
                ]),
                "defaultModelId": coderoverMeta?["defaultModelId"] ?? .null,
            ])
        }
    }

    func buildLegacyModelItems(from result: JSONValue?) -> [JSONValue] {
        result?.objectValue?["items"]?.arrayValue
            ?? result?.objectValue?["models"]?.arrayValue
            ?? []
    }

    func buildLegacyThreadListResult(from result: JSONValue?) -> RPCObject {
        let sessions = result?.objectValue?["sessions"]?.arrayValue ?? []
        let threads = sessions.compactMap { value -> JSONValue? in
            guard let object = value.objectValue else { return nil }
            return buildLegacyThreadSummary(from: object)
        }
        var payload: RPCObject = [
            "data": .array(threads),
        ]
        if let nextCursor = result?.objectValue?["nextCursor"] {
            payload["nextCursor"] = nextCursor
        }
        return payload
    }

    func buildLegacyThreadSummary(from sessionObject: RPCObject) -> JSONValue? {
        let sessionId = normalizedIdentifier(sessionObject["sessionId"]?.stringValue)
        guard let sessionId else { return nil }

        let coderoverMeta = sessionObject["_meta"]?.objectValue?["coderover"]?.objectValue
        var threadObject: RPCObject = [
            "id": .string(sessionId),
            "provider": coderoverMeta?["agentId"] ?? .string("codex"),
        ]
        if let title = normalizedIdentifier(sessionObject["title"]?.stringValue) {
            threadObject["title"] = .string(title)
            threadObject["name"] = .string(title)
        }
        if let cwd = sessionObject["cwd"] {
            threadObject["cwd"] = cwd
        }
        if let updatedAt = sessionObject["updatedAt"] {
            threadObject["updatedAt"] = updatedAt
        }
        if let preview = coderoverMeta?["preview"] {
            threadObject["preview"] = preview
        }
        if let capabilities = coderoverMeta?["capabilities"] {
            threadObject["capabilities"] = capabilities
        }
        if let providerSessionId = coderoverMeta?["providerSessionId"] {
            threadObject["providerSessionId"] = providerSessionId
        }
        return .object(threadObject)
    }

    func buildSyntheticLegacyThreadValue(threadId: String, includeTurns: Bool) -> JSONValue {
        let existingThread = threads.first(where: { $0.id == threadId })
        var threadObject: RPCObject = [
            "id": .string(threadId),
            "provider": .string(existingThread?.provider ?? "codex"),
        ]

        if let displayTitle = normalizedIdentifier(existingThread?.name ?? existingThread?.title) {
            threadObject["title"] = .string(displayTitle)
            threadObject["name"] = .string(displayTitle)
        }
        if let cwd = normalizedIdentifier(existingThread?.cwd) {
            threadObject["cwd"] = .string(cwd)
        }
        if let preview = normalizedIdentifier(existingThread?.preview) {
            threadObject["preview"] = .string(preview)
        }
        if let updatedAt = existingThread?.updatedAt ?? existingThread?.createdAt {
            threadObject["updatedAt"] = .string(acpHistoryFormatter.string(from: updatedAt))
        }
        if let usage = contextWindowUsageByThread[threadId] {
            threadObject["usage"] = .object([
                "tokensUsed": .integer(usage.tokensUsed),
                "tokenLimit": .integer(usage.tokenLimit),
            ])
        }
        if includeTurns {
            threadObject["turns"] = .array(buildSyntheticLegacyTurns(threadId: threadId))
        }

        return .object(threadObject)
    }

    func buildSyntheticLegacyTurns(threadId: String) -> [JSONValue] {
        let canonicalMessages = messages(for: threadId)
            .filter { $0.deliveryState == .confirmed }

        let grouped = Dictionary(grouping: canonicalMessages) { normalizedIdentifier($0.turnId) ?? "__no_turn__" }
        let sortedGroups = grouped.values.sorted { lhs, rhs in
            let lhsOrder = lhs.map { $0.timelineOrdinal ?? $0.orderIndex }.min() ?? Int.max
            let rhsOrder = rhs.map { $0.timelineOrdinal ?? $0.orderIndex }.min() ?? Int.max
            if lhsOrder != rhsOrder {
                return lhsOrder < rhsOrder
            }
            let lhsDate = lhs.map(\.createdAt).min() ?? .distantPast
            let rhsDate = rhs.map(\.createdAt).min() ?? .distantPast
            return lhsDate < rhsDate
        }

        var turns: [JSONValue] = sortedGroups.map { messages in
            let sortedMessages = messages.sorted { lhs, rhs in
                let lhsOrder = lhs.timelineOrdinal ?? lhs.orderIndex
                let rhsOrder = rhs.timelineOrdinal ?? rhs.orderIndex
                if lhsOrder != rhsOrder {
                    return lhsOrder < rhsOrder
                }
                if lhs.createdAt != rhs.createdAt {
                    return lhs.createdAt < rhs.createdAt
                }
                return lhs.id < rhs.id
            }

            let turnId = sortedMessages.compactMap { normalizedIdentifier($0.turnId) }.first
            let createdAt = sortedMessages.map(\.createdAt).min() ?? Date()
            let turnStatus = syntheticTurnStatus(threadId: threadId, turnId: turnId)
            return .object([
                "id": turnId.map(JSONValue.string) ?? .null,
                "createdAt": .string(acpHistoryFormatter.string(from: createdAt)),
                "status": .string(turnStatus),
                "items": .array(sortedMessages.compactMap { buildSyntheticLegacyItem(from: $0) }),
            ])
        }

        if turns.isEmpty, protectedRunningFallbackThreadIDs.contains(threadId) || runningThreadIDs.contains(threadId) {
            turns.append(
                .object([
                    "status": .string("running"),
                    "items": .array([]),
                ])
            )
        }

        return turns
    }

    func syntheticTurnStatus(threadId: String, turnId: String?) -> String {
        if let turnId,
           activeTurnIdByThread[threadId] == turnId,
           threadHasActiveOrRunningTurn(threadId) {
            return "running"
        }
        if turnId == nil,
           protectedRunningFallbackThreadIDs.contains(threadId) || runningThreadIDs.contains(threadId) {
            return "running"
        }
        if let turnId,
           let terminalState = terminalStateByTurnID[turnId] {
            return terminalState.rawValue
        }
        if let terminalState = latestTurnTerminalStateByThread[threadId] {
            return terminalState.rawValue
        }
        return "completed"
    }

    func buildSyntheticLegacyItem(from message: ChatMessage) -> JSONValue? {
        var item: RPCObject = [
            "id": .string(message.id),
            "status": .string(message.timelineStatus ?? (message.isStreaming ? "running" : "completed")),
        ]

        if let ordinal = message.timelineOrdinal {
            item["ordinal"] = .integer(ordinal)
        }

        switch message.kind {
        case .thinking:
            item["type"] = .string("reasoning")
            item["text"] = .string(message.text)

        case .fileChange:
            item["type"] = .string("file_change")
            item["text"] = .string(message.text)

        case .commandExecution:
            item["type"] = .string("command_execution")
            item["text"] = .string(message.text)
            if let details = message.itemId.flatMap({ commandExecutionDetailsByItemID[$0] }) {
                item["command"] = .string(details.fullCommand)
                if let cwd = normalizedIdentifier(details.cwd) {
                    item["cwd"] = .string(cwd)
                }
                if let exitCode = details.exitCode {
                    item["exitCode"] = .integer(exitCode)
                }
                if let durationMs = details.durationMs {
                    item["durationMs"] = .integer(durationMs)
                }
            }

        case .plan:
            item["type"] = .string("plan")
            item["text"] = .string(message.text)
            if let planState = message.planState {
                if let explanation = normalizedIdentifier(planState.explanation) {
                    item["explanation"] = .string(explanation)
                    item["summary"] = .string(explanation)
                }
                item["plan"] = .array(planState.steps.map { step in
                    .object([
                        "step": .string(step.step),
                        "status": .string(step.status.rawValue),
                    ])
                })
            }

        case .userInputPrompt:
            return nil

        case .chat:
            item["type"] = .string(message.role == .user ? "user_message" : "agent_message")
            if !message.text.isEmpty {
                item["text"] = .string(message.text)
            }
            if !message.attachments.isEmpty {
                item["content"] = .array(message.attachments.compactMap { attachment in
                    let source = attachment.payloadDataURL ?? attachment.sourceURL
                    guard let source,
                          !source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                        return nil
                    }
                    return .object([
                        "type": .string("image"),
                        "url": .string(source),
                    ])
                })
            }
            item["role"] = .string(message.role.rawValue)
        }

        item["createdAt"] = .string(acpHistoryFormatter.string(from: message.createdAt))
        return .object(item)
    }

    func handleACPSessionInfoUpdate(sessionId: String, updateObject: RPCObject) {
        let coderoverMeta = updateObject["_meta"]?.objectValue?["coderover"]?.objectValue
        let agentId = normalizedIdentifier(coderoverMeta?["agentId"]?.stringValue) ?? threads.first(where: { $0.id == sessionId })?.provider ?? "codex"
        let title = normalizedIdentifier(updateObject["title"]?.stringValue)
        let cwd = normalizedIdentifier(updateObject["cwd"]?.stringValue)
        let updatedAt = updateObject["updatedAt"]?.stringValue.flatMap(parseACPISO8601Date)

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
        upsertThread(thread)

        let runState = normalizedIdentifier(updateObject["runState"]?.stringValue)
            ?? normalizedIdentifier(coderoverMeta?["runState"]?.stringValue)
        let turnId = extractAcpTurnId(from: coderoverMeta) ?? activeTurnIdByThread[sessionId]
        let errorMessage = normalizedIdentifier(updateObject["errorMessage"]?.stringValue)
            ?? normalizedIdentifier(coderoverMeta?["errorMessage"]?.stringValue)

        guard let runState else {
            return
        }

        var lifecycleParams: IncomingParamsObject = [
            "threadId": .string(sessionId),
            "status": .string(runState),
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

        if runState == "running" {
            handleTurnStarted(lifecycleParams)
        } else {
            handleTurnCompleted(lifecycleParams)
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
            guard let object = entry.objectValue,
                  let step = normalizedIdentifier(object["step"]?.stringValue),
                  let rawStatus = normalizedIdentifier(object["status"]?.stringValue) else {
                return nil
            }
            guard let status = CodeRoverPlanStepStatus(rawValue: rawStatus) else {
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
