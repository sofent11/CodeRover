// FILE: CodeRoverService+Incoming.swift
// Purpose: Inbound message decoding and event routing.
// Layer: Service
// Exports: CodeRoverService inbound handlers
// Depends on: RPCMessage

import Foundation

typealias IncomingParamsObject = [String: JSONValue]

private enum CanonicalTimelineEventKind {
    case started
    case textUpdated
    case completed
}

extension CodeRoverService {
    func processIncomingText(_ text: String) {
        guard let payloadData = text.data(using: .utf8) else {
            return
        }

        do {
            let message = try decoder.decode(RPCMessage.self, from: payloadData)
            handleIncomingRPCMessage(message)
        } catch {
            debugRuntimeLog("rpc decode failed bytes=\(text.count) prefix=\(String(text.prefix(180)))")
            lastErrorMessage = "Unable to decode server payload"
        }
    }

    func handleIncomingRPCMessage(_ message: RPCMessage) {
        debugRuntimeLog("rpc <- \(summarizeIncomingRPCMessage(message))")
        if let method = message.method {
            let normalizedMethod = normalizedIncomingMethodName(method)
            if let requestID = message.id {
                handleServerRequest(method: normalizedMethod, requestID: requestID, params: message.params)
            } else {
                handleNotification(method: normalizedMethod, params: message.params)
            }
            return
        }

        guard let responseID = message.id else {
            return
        }

        let requestKey = idKey(from: responseID)
        let requestContext = pendingRequestContexts[requestKey]
        guard let continuation = pendingRequests.removeValue(forKey: requestKey) else {
            return
        }
        pendingRequestTimeoutTasks.removeValue(forKey: requestKey)?.cancel()
        pendingRequestContexts.removeValue(forKey: requestKey)
        debugRuntimeLog(
            "rpc response <- id=\(shortIncomingJSONValue(responseID)) request=\(requestContext?.method ?? "unknown") "
            + "thread=\(requestContext?.threadId ?? "none") error=\(message.error != nil)"
        )

        if let rpcError = message.error {
            continuation.resume(throwing: CodeRoverServiceError.rpcError(rpcError))
        } else {
            if lastErrorMessage == "The Mac bridge did not respond in time. Reconnect and try again." {
                lastErrorMessage = nil
            }
            continuation.resume(returning: message)
        }
    }

    // Handles server-initiated RPC requests like approval prompts.
    func handleServerRequest(method: String, requestID: JSONValue, params: JSONValue?) {
        if method == "item/tool/requestUserInput" {
            handleStructuredUserInputRequest(
                requestID: requestID,
                paramsObject: params?.objectValue
            )
            return
        }

        if method == "item/commandExecution/requestApproval"
            || method == "item/fileChange/requestApproval"
            || method.hasSuffix("requestApproval") {
            let paramsObject = params?.objectValue
            let request = CodeRoverApprovalRequest(
                id: idKey(from: requestID),
                requestID: requestID,
                method: method,
                command: paramsObject?["command"]?.stringValue,
                reason: paramsObject?["reason"]?.stringValue,
                threadId: paramsObject?["threadId"]?.stringValue,
                turnId: paramsObject?["turnId"]?.stringValue,
                params: params
            )

            if selectedAccessMode == .fullAccess {
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    do {
                        debugRuntimeLog("auto-approve triggered method=\(method)")
                        try await sendResponse(
                            id: requestID,
                            result: .string("accept")
                        )
                    } catch {
                        debugRuntimeLog("auto-approve failed method=\(method): \(error.localizedDescription)")
                        enqueuePendingApproval(request)
                    }
                }
                return
            }

            enqueuePendingApproval(request)
            return
        }

        switch method {
        default:
            Task { [requestID] in
                try? await sendErrorResponse(
                    id: requestID,
                    code: -32601,
                    message: "Unsupported request method: \(method)"
                )
            }
        }
    }

    // Handles stream notifications to keep UI state in sync.
    func handleNotification(method: String, params: JSONValue?) {
        let paramsObject = params?.objectValue
        debugRuntimeLog("notify <- \(summarizeIncomingNotification(method: method, paramsObject: paramsObject))")

        switch method {
        case "thread/started":
            handleThreadStarted(paramsObject)

        case "thread/name/updated":
            handleThreadNameUpdated(paramsObject)

        case "thread/status/changed":
            handleThreadStatusChanged(paramsObject)

        case "thread/history/changed":
            handleThreadHistoryChanged(paramsObject)

        case "timeline/turnUpdated":
            handleCanonicalTimelineTurnUpdated(paramsObject)

        case "timeline/itemStarted":
            handleCanonicalTimelineItemEvent(paramsObject, eventKind: .started)

        case "timeline/itemTextUpdated":
            handleCanonicalTimelineItemEvent(paramsObject, eventKind: .textUpdated)

        case "timeline/itemCompleted":
            handleCanonicalTimelineItemEvent(paramsObject, eventKind: .completed)

        case "thread/tokenUsage/updated":
            handleThreadTokenUsageUpdated(paramsObject)

        case "account/rateLimits/updated":
            handleRateLimitsUpdated(paramsObject)

        case "error", "turn/failed":
            handleErrorNotification(paramsObject)

        case "serverRequest/resolved":
            handleServerRequestResolved(paramsObject)

        default:
            return
        }
    }

    private func handleThreadStarted(_ paramsObject: IncomingParamsObject?) {
        guard let paramsObject,
              let threadValue = paramsObject["thread"],
              let thread = decodeModel(ConversationThread.self, from: threadValue) else {
            return
        }

        upsertThread(thread, treatAsServerState: true)
        if activeThreadId == nil {
            activeThreadId = thread.id
        }
        requestImmediateSync(threadId: thread.id)
    }

    // Mirrors desktop behavior: when server pushes a thread rename, update local
    // title immediately instead of waiting for the next thread/list refresh.
    private func handleThreadNameUpdated(_ paramsObject: IncomingParamsObject?) {
        guard let paramsObject else {
            return
        }

        guard let threadId = extractThreadID(from: paramsObject)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !threadId.isEmpty else {
            return
        }

        let eventObject = envelopeEventObject(from: paramsObject)
        let renameKeys = ["threadName", "thread_name", "name", "title"]
        let hasExplicitRenameField = hasAnyValue(in: paramsObject, keys: renameKeys)
            || hasAnyValue(in: eventObject, keys: renameKeys)
        let threadName = firstStringValue(in: paramsObject, keys: renameKeys)
            ?? firstStringValue(in: eventObject, keys: renameKeys)
        let normalizedThreadName = normalizedIdentifier(threadName)

        if let normalizedThreadName, !normalizedThreadName.isEmpty {
            if let existingIndex = threads.firstIndex(where: { $0.id == threadId }) {
                threads[existingIndex].title = normalizedThreadName
                threads[existingIndex].name = normalizedThreadName
            } else {
                threads.append(
                    ConversationThread(
                        id: threadId,
                        title: normalizedThreadName,
                        name: normalizedThreadName
                    )
                )
            }
            threads = sortThreads(threads)
            requestImmediateSync(threadId: threadId)
            return
        }

        // If server explicitly sends an empty/null name, clear local custom title.
        guard hasExplicitRenameField,
              let existingIndex = threads.firstIndex(where: { $0.id == threadId }) else {
            return
        }

        threads[existingIndex].title = nil
        threads[existingIndex].name = nil
        threads = sortThreads(threads)
        requestImmediateSync(threadId: threadId)
    }

    private func handleTurnStarted(_ paramsObject: IncomingParamsObject?) {
        let threadId = resolveThreadID(from: paramsObject)
        let turnID = extractTurnIDForTurnLifecycleEvent(from: paramsObject)
        debugRuntimeLog("turn started thread=\(threadId ?? "none") turn=\(turnID ?? "none")")

        if let threadId {
            markThreadAsRunning(threadId)
            beginForegroundAggressivePolling(threadId: threadId)
            completePendingTurnStartIfNeeded(threadId: threadId, turnId: turnID)
        }

        if let threadId, let turnID {
            rebindPendingFallbackTurnIfNeeded(threadId: threadId, to: turnID)
            activeTurnIdByThread[threadId] = turnID
            threadIdByTurnID[turnID] = threadId
            pendingRealtimeSeededTurnIDByThread[threadId] = turnID
            protectedRunningFallbackThreadIDs.remove(threadId)
            confirmLatestPendingUserMessage(threadId: threadId, turnId: turnID)
            // Do NOT create the assistant placeholder here.
            // It will be created lazily by ensureStreamingAssistantMessage()
            // when the first agent message delta arrives. Creating it here
            // gives it an orderIndex lower than thinking/reasoning messages
            // that arrive before the actual response, causing wrong visual order.
        } else if let threadId {
            protectedRunningFallbackThreadIDs.insert(threadId)
        }

        if let turnID {
            activeTurnId = turnID
        }

        requestImmediateSync(threadId: threadId ?? activeThreadId)
    }

    private func handleTurnCompleted(_ paramsObject: IncomingParamsObject?) {
        let completedTurnID = extractTurnIDForTurnLifecycleEvent(from: paramsObject)
        let turnFailureMessage = parseTurnFailureMessage(from: paramsObject)

        if let threadId = resolveThreadID(from: paramsObject, turnIdHint: completedTurnID) {
            debugRuntimeLog(
                "turn completed thread=\(threadId) turn=\(completedTurnID ?? activeTurnIdByThread[threadId] ?? "none") "
                + "failure=\(turnFailureMessage != nil)"
            )
            if let completedTurnID {
                confirmLatestPendingUserMessage(threadId: threadId, turnId: completedTurnID)
            }
            let resolvedTurnID = completedTurnID ?? activeTurnIdByThread[threadId]
            let terminalState = parseTurnTerminalState(
                from: paramsObject,
                turnFailureMessage: turnFailureMessage
            )
            let hasPendingStructuredInput = hasPendingStructuredUserInputPrompt(
                threadId: threadId,
                turnId: resolvedTurnID
            )
            recordTurnTerminalState(threadId: threadId, turnId: resolvedTurnID, state: terminalState)
            noteTurnFinished(turnId: resolvedTurnID)
            markTurnCompleted(threadId: threadId, turnId: resolvedTurnID)
            if terminalState == .completed, !hasPendingStructuredInput {
                markReadyIfUnread(threadId: threadId)
                notifyRunCompletionIfNeeded(threadId: threadId, turnId: resolvedTurnID, result: .completed)
            } else if terminalState == .failed {
                markFailedIfUnread(threadId: threadId)
                notifyRunCompletionIfNeeded(threadId: threadId, turnId: resolvedTurnID, result: .failed)
            }
            requestImmediateSync(threadId: threadId)

            guard let turnFailureMessage else {
                return
            }

            lastErrorMessage = turnFailureMessage
            appendSystemMessage(
                threadId: threadId,
                text: "Turn error: \(turnFailureMessage)",
                turnId: completedTurnID
            )
            return
        }

        debugRuntimeLog("turn completed unresolved turn=\(completedTurnID ?? "none") failure=\(turnFailureMessage != nil)")
        finalizeAllStreamingState()

        guard let turnFailureMessage else {
            return
        }
        lastErrorMessage = turnFailureMessage
    }

    private func handleCanonicalTimelineTurnUpdated(_ paramsObject: IncomingParamsObject?) {
        guard let paramsObject else { return }
        let normalizedState = paramsObject["state"]?.stringValue?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        if normalizedState == "running" {
            handleTurnStarted(paramsObject)
            return
        }

        var syntheticParams = paramsObject
        if let normalizedState, !normalizedState.isEmpty, syntheticParams["status"] == nil {
            syntheticParams["status"] = .string(normalizedState)
        }
        handleTurnCompleted(syntheticParams)
    }

    private func handleCanonicalTimelineItemEvent(
        _ paramsObject: IncomingParamsObject?,
        eventKind: CanonicalTimelineEventKind
    ) {
        guard let paramsObject else { return }
        guard let threadId = resolveThreadID(from: paramsObject, turnIdHint: extractTurnID(from: paramsObject)) else {
            return
        }

        let timelineItemId = normalizedIdentifier(
            paramsObject["timelineItemId"]?.stringValue
                ?? paramsObject["timeline_item_id"]?.stringValue
                ?? paramsObject["itemId"]?.stringValue
                ?? paramsObject["item_id"]?.stringValue
                ?? paramsObject["id"]?.stringValue
        )
        guard let timelineItemId else {
            return
        }

        let turnId = extractTurnID(from: paramsObject) ?? activeTurnIdByThread[threadId]
        if let turnId {
            threadIdByTurnID[turnId] = threadId
        }
        markThreadAsRunning(threadId)

        let role = canonicalTimelineRole(from: paramsObject["role"]?.stringValue)
        let kind = canonicalTimelineKind(from: paramsObject["kind"]?.stringValue)
        let textMode = canonicalTimelineTextMode(from: paramsObject["textMode"]?.stringValue)
        let subagentAction = kind == .subagentAction ? decodeSubagentActionItem(from: paramsObject) : nil
        let incomingText = {
            if let subagentAction {
                return subagentAction.summaryText
            }
            return paramsObject["text"]?.stringValue ?? ""
        }()
        let providerItemId = normalizedIdentifier(
            paramsObject["providerItemId"]?.stringValue
                ?? paramsObject["provider_item_id"]?.stringValue
        )
        let timelineOrdinal = paramsObject["ordinal"]?.intValue
        let timelineStatus = normalizedIdentifier(paramsObject["status"]?.stringValue)
        let isStreaming = canonicalTimelineIsStreaming(status: timelineStatus, eventKind: eventKind)
        let planState = paramsObject["planState"].flatMap { decodeModel(CodeRoverPlanState.self, from: $0) }

        if kind == .commandExecution {
            upsertCanonicalCommandExecutionDetails(
                itemId: timelineItemId,
                paramsObject: paramsObject,
                isCompleted: eventKind == .completed
            )
        }

        if isStreaming {
            finalizeSupersededCanonicalStreamingMessages(
                threadId: threadId,
                turnId: turnId,
                keeping: timelineItemId
            )
        }

        upsertCanonicalTimelineMessage(
            threadId: threadId,
            turnId: turnId,
            timelineItemId: timelineItemId,
            providerItemId: providerItemId,
            role: role,
            kind: kind,
            incomingText: incomingText,
            textMode: textMode,
            isStreaming: isStreaming,
            timelineOrdinal: timelineOrdinal,
            timelineStatus: timelineStatus,
            planState: planState,
            subagentAction: subagentAction
        )
    }

    private func handleErrorNotification(_ paramsObject: IncomingParamsObject?) {
        if shouldRetryTurnError(from: paramsObject) {
            return
        }

        let eventObject = envelopeEventObject(from: paramsObject)
        let paramsErrorObject = paramsObject?["error"]?.objectValue
        let eventErrorObject = eventObject?["error"]?.objectValue
        let nestedEventObject = paramsObject?["event"]?.objectValue
        let errorMessage = firstNonEmptyString([
            firstStringValue(in: paramsObject, keys: ["message"]),
            firstStringValue(in: paramsErrorObject, keys: ["message"]),
            firstStringValue(in: eventObject, keys: ["message"]),
            firstStringValue(in: eventErrorObject, keys: ["message"]),
            firstStringValue(in: nestedEventObject, keys: ["message"]),
        ]) ?? "Server error"
        lastErrorMessage = errorMessage

        let turnId = extractTurnID(from: paramsObject)
        if let threadId = resolveThreadID(from: paramsObject, turnIdHint: turnId) {
            let resolvedTurnID = turnId ?? activeTurnIdByThread[threadId]
            debugRuntimeLog("turn error thread=\(threadId) turn=\(resolvedTurnID ?? "none") message=\(errorMessage)")
            appendSystemMessage(threadId: threadId, text: "Error: \(errorMessage)", turnId: turnId)
            recordTurnTerminalState(threadId: threadId, turnId: resolvedTurnID, state: .failed)
            noteTurnFinished(turnId: resolvedTurnID)
            markTurnCompleted(threadId: threadId, turnId: resolvedTurnID)
            markFailedIfUnread(threadId: threadId)
            notifyRunCompletionIfNeeded(threadId: threadId, turnId: resolvedTurnID, result: .failed)
        } else {
            debugRuntimeLog("turn error unresolved turn=\(turnId ?? "none") message=\(errorMessage)")
            finalizeAllStreamingState()
        }
    }

    private func handleThreadTokenUsageUpdated(_ paramsObject: IncomingParamsObject?) {
        guard let threadId = extractThreadID(from: paramsObject), !threadId.isEmpty else {
            return
        }

        let eventObject = envelopeEventObject(from: paramsObject)
        let usageObject = paramsObject?["usage"]?.objectValue
            ?? eventObject?["usage"]?.objectValue
            ?? paramsObject

        guard let usage = extractContextWindowUsage(from: usageObject) else { return }
        contextWindowUsageByThread[threadId] = usage
    }

    private func handleThreadStatusChanged(_ paramsObject: IncomingParamsObject?) {
        guard let threadId = extractThreadID(from: paramsObject), !threadId.isEmpty else {
            return
        }

        let eventObject = envelopeEventObject(from: paramsObject)
        let nestedEventObject = paramsObject?["event"]?.objectValue
        let statusObject = paramsObject?["status"]?.objectValue
            ?? eventObject?["status"]?.objectValue
            ?? nestedEventObject?["status"]?.objectValue

        let rawStatusType = firstNonEmptyString([
            firstStringValue(in: statusObject, keys: ["type", "statusType", "status_type"]),
            firstStringValue(in: paramsObject, keys: ["status"]),
            firstStringValue(in: eventObject, keys: ["status"]),
            firstStringValue(in: nestedEventObject, keys: ["status"]),
        ]) ?? ""

        let normalizedStatusType = normalizeThreadStatusType(rawStatusType)

        if normalizedStatusType == "active"
            || normalizedStatusType == "running"
            || normalizedStatusType == "processing"
            || normalizedStatusType == "inprogress"
            || normalizedStatusType == "started"
            || normalizedStatusType == "pending" {
            markThreadAsRunning(threadId)
            beginForegroundAggressivePolling(threadId: threadId)
            requestImmediateSync(threadId: threadId)
            return
        }

        if normalizedStatusType == "idle"
            || normalizedStatusType == "notloaded"
            || normalizedStatusType == "completed"
            || normalizedStatusType == "done"
            || normalizedStatusType == "finished"
            || normalizedStatusType == "stopped"
            || normalizedStatusType == "systemerror" {
            // Keep only the protected fallback alive until a real turn lifecycle event lands.
            if activeTurnIdByThread[threadId] != nil
                || protectedRunningFallbackThreadIDs.contains(threadId)
                || hasStreamingMessage(in: threadId) {
                requestImmediateSync(threadId: threadId)
                return
            }

            let activeTurnIdForThread = activeTurnIdByThread[threadId]
            let terminalState = threadTerminalState(from: normalizedStatusType)
            if let terminalState {
                recordTurnTerminalState(
                    threadId: threadId,
                    turnId: activeTurnIdForThread,
                    state: terminalState
                )
                noteTurnFinished(turnId: activeTurnIdForThread)
                if let completionResult = runCompletionResult(for: terminalState),
                   !hasPendingStructuredUserInputPrompt(
                        threadId: threadId,
                        turnId: activeTurnIdForThread
                   ) {
                    notifyRunCompletionIfNeeded(
                        threadId: threadId,
                        turnId: activeTurnIdForThread,
                        result: completionResult
                    )
                }
            }
            markTurnCompleted(threadId: threadId, turnId: activeTurnIdForThread)
            runningThreadIDs.remove(threadId)

            if normalizedStatusType.contains("error") {
                markFailedIfUnread(threadId: threadId)
            }
            requestImmediateSync(threadId: threadId)
        }
    }

    private func handleThreadHistoryChanged(_ paramsObject: IncomingParamsObject?) {
        let threadId = extractThreadID(from: paramsObject)
            ?? activeThreadId

        guard let threadId,
              activeThreadId == threadId else {
            return
        }

        let sourceMethod = firstStringValue(in: paramsObject, keys: ["sourceMethod", "rawMethod"]) ?? "unknown"
        if sourceMethod == "thread/read" {
            debugRuntimeLog(
                "thread history changed refresh thread=\(threadId) "
                + "source=\(sourceMethod) mode=tail"
            )
            scheduleThreadHistoryCatchUp(threadId: threadId)
            return
        }

        let eventObject = envelopeEventObject(from: paramsObject)
        let advancedRealtimeCursor = handleRealtimeHistoryEvent(
            threadId: threadId,
            turnId: extractTurnID(from: paramsObject),
            itemId: extractItemID(from: paramsObject, eventObject: eventObject),
            previousItemId: extractPreviousItemID(
                from: paramsObject,
                eventObject: eventObject
            ),
            cursor: extractCursorString(
                from: paramsObject,
                eventObject: eventObject
            ),
            previousCursor: extractPreviousCursorString(
                from: paramsObject,
                eventObject: eventObject
            )
        )
        guard !advancedRealtimeCursor else {
            debugRuntimeLog(
                "thread history changed ignored thread=\(threadId) action=advance "
                + "source=\(sourceMethod)"
            )
            return
        }

        debugRuntimeLog(
            "thread history changed refresh thread=\(threadId) "
            + "source=\(sourceMethod)"
        )
        scheduleThreadHistoryCatchUp(threadId: threadId)
    }

    // Parses the real terminal outcome so UI can distinguish completion from interruption.
    private func parseTurnTerminalState(
        from paramsObject: IncomingParamsObject?,
        turnFailureMessage: String?
    ) -> CodeRoverTurnTerminalState {
        if turnFailureMessage != nil {
            return .failed
        }

        let eventObject = envelopeEventObject(from: paramsObject)
        let turnObject = paramsObject?["turn"]?.objectValue
        let statusObject = turnObject?["status"]?.objectValue
            ?? paramsObject?["status"]?.objectValue
            ?? eventObject?["status"]?.objectValue

        let rawStatus = firstNonEmptyString([
            firstStringValue(in: turnObject, keys: ["status"]),
            firstStringValue(in: paramsObject, keys: ["status"]),
            firstStringValue(in: eventObject, keys: ["status"]),
            firstStringValue(in: statusObject, keys: ["type", "statusType", "status_type"]),
        ]) ?? ""

        let normalizedStatus = normalizeThreadStatusType(rawStatus)
        if normalizedStatus.contains("cancel")
            || normalizedStatus.contains("abort")
            || normalizedStatus.contains("interrupt")
            || normalizedStatus.contains("stopped") {
            return .stopped
        }
        if normalizedStatus.contains("fail")
            || normalizedStatus.contains("error") {
            return .failed
        }
        return .completed
    }

    // Maps terminal runtime states onto the smaller notification vocabulary.
    private func runCompletionResult(for state: CodeRoverTurnTerminalState) -> CodeRoverRunCompletionResult? {
        switch state {
        case .completed:
            .completed
        case .failed:
            .failed
        case .stopped:
            nil
        }
    }

    private func parseTurnFailureMessage(from paramsObject: IncomingParamsObject?) -> String? {
        let turnObject = paramsObject?["turn"]?.objectValue
        let status = turnObject?["status"]?.stringValue
            ?? paramsObject?["status"]?.stringValue

        guard status == "failed" else {
            return nil
        }

        return turnObject?["error"]?.objectValue?["message"]?.stringValue
            ?? paramsObject?["error"]?.objectValue?["message"]?.stringValue
            ?? paramsObject?["errorMessage"]?.stringValue
            ?? "Turn failed with no details"
    }

    private func canonicalTimelineRole(from rawValue: String?) -> ChatMessageRole {
        switch rawValue?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "user":
            return .user
        case "assistant":
            return .assistant
        default:
            return .system
        }
    }

    private func canonicalTimelineKind(from rawValue: String?) -> ChatMessageKind {
        switch rawValue?.trimmingCharacters(in: .whitespacesAndNewlines) {
        case "thinking":
            return .thinking
        case "fileChange":
            return .fileChange
        case "commandExecution":
            return .commandExecution
        case "plan":
            return .plan
        case "subagentAction":
            return .subagentAction
        case "userInputPrompt":
            return .userInputPrompt
        default:
            return .chat
        }
    }

    private func canonicalTimelineTextMode(from rawValue: String?) -> String {
        let normalized = rawValue?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return normalized == "append" ? "append" : "replace"
    }

    private func canonicalTimelineIsStreaming(
        status: String?,
        eventKind: CanonicalTimelineEventKind
    ) -> Bool {
        if eventKind == .completed {
            return false
        }
        guard let status else {
            return true
        }
        let normalized = status.lowercased()
        return normalized != "completed"
            && normalized != "failed"
            && normalized != "stopped"
    }

    private func upsertCanonicalCommandExecutionDetails(
        itemId: String,
        paramsObject: IncomingParamsObject,
        isCompleted: Bool
    ) {
        let command = normalizedIdentifier(paramsObject["command"]?.stringValue) ?? "command"
        if var existing = commandExecutionDetailsByItemID[itemId] {
            existing.fullCommand = command
            existing.cwd = normalizedIdentifier(paramsObject["cwd"]?.stringValue) ?? existing.cwd
            existing.exitCode = paramsObject["exitCode"]?.intValue ?? existing.exitCode
            existing.durationMs = paramsObject["durationMs"]?.intValue ?? existing.durationMs
            commandExecutionDetailsByItemID[itemId] = existing
            return
        }

        commandExecutionDetailsByItemID[itemId] = CommandExecutionDetails(
            fullCommand: command,
            cwd: normalizedIdentifier(paramsObject["cwd"]?.stringValue),
            exitCode: paramsObject["exitCode"]?.intValue,
            durationMs: paramsObject["durationMs"]?.intValue,
            outputTail: isCompleted ? "" : ""
        )
    }

    private func upsertCanonicalTimelineMessage(
        threadId: String,
        turnId: String?,
        timelineItemId: String,
        providerItemId: String?,
        role: ChatMessageRole,
        kind: ChatMessageKind,
        incomingText: String,
        textMode: String,
        isStreaming: Bool,
        timelineOrdinal: Int?,
        timelineStatus: String?,
        planState: CodeRoverPlanState?,
        subagentAction: CodeRoverSubagentAction?
    ) {
        let normalizedText = incomingText
        let existingCanonicalMessage = threadTimelineStateByThread[threadId]?.message(for: timelineItemId)
            ?? messagesByThread[threadId]?.first(where: { $0.id == timelineItemId })

        let existingText = existingCanonicalMessage?.text ?? ""
        let nextText: String
        if textMode == "append" {
            nextText = mergeAssistantDelta(existingText: existingText, incomingDelta: normalizedText)
        } else if normalizedText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            nextText = existingText
        } else {
            nextText = normalizedText
        }

        var message = existingCanonicalMessage ?? ChatMessage(
            id: timelineItemId,
            threadId: threadId,
            role: role,
            kind: kind,
            text: nextText,
            turnId: turnId,
            itemId: timelineItemId,
            isStreaming: isStreaming,
            deliveryState: .confirmed,
            attachments: [],
            planState: planState,
            subagentAction: subagentAction,
            providerItemId: providerItemId,
            timelineOrdinal: timelineOrdinal,
            timelineStatus: timelineStatus,
            orderIndex: timelineOrdinal
        )
        message.role = role
        message.kind = kind
        message.text = nextText
        message.turnId = turnId ?? message.turnId
        message.itemId = timelineItemId
        message.providerItemId = providerItemId ?? message.providerItemId
        message.timelineOrdinal = timelineOrdinal ?? message.timelineOrdinal
        message.timelineStatus = timelineStatus ?? message.timelineStatus
        message.planState = planState ?? message.planState
        message.subagentAction = subagentAction ?? message.subagentAction
        message.isStreaming = isStreaming
        message.deliveryState = .confirmed
        if let timelineOrdinal {
            message.orderIndex = timelineOrdinal
        }

        if let subagentAction {
            registerSubagentThreads(action: subagentAction, parentThreadId: threadId)
        }

        _ = upsertThreadTimelineMessage(message)
        persistMessages()
        updateCurrentOutput(for: threadId)
    }

    private func finalizeSupersededCanonicalStreamingMessages(
        threadId: String,
        turnId: String?,
        keeping timelineItemId: String
    ) {
        guard let normalizedTurnId = normalizedIdentifier(turnId) else {
            return
        }

        let overlayMessages = (messagesByThread[threadId] ?? []).filter { !Self.isCanonicalTimelineMessage($0) }
        var state = threadTimelineStateByThread[threadId]
            ?? ThreadTimelineState(
                messages: (messagesByThread[threadId] ?? []).filter { Self.isCanonicalTimelineMessage($0) }
            )
        let candidateIDs = state.renderedMessages().compactMap { message -> String? in
            guard message.id != timelineItemId,
                  message.turnId == normalizedTurnId,
                  message.isStreaming,
                  shouldFinalizeSupersededCanonicalStreamingMessage(message) else {
                return nil
            }
            return message.id
        }

        guard !candidateIDs.isEmpty else {
            return
        }

        for candidateID in candidateIDs {
            guard var candidate = state.message(for: candidateID) else {
                continue
            }
            candidate.isStreaming = false
            state.upsert(candidate)
        }

        threadTimelineStateByThread[threadId] = state
        messagesByThread[threadId] = Self.mergeRenderedTimelineMessages(
            state.renderedMessages(),
            overlayMessages: overlayMessages
        )
    }

    private func shouldFinalizeSupersededCanonicalStreamingMessage(_ message: ChatMessage) -> Bool {
        if message.role == .assistant {
            return true
        }

        switch message.kind {
        case .thinking, .plan, .subagentAction, .chat:
            return true
        case .fileChange, .commandExecution, .userInputPrompt:
            return false
        }
    }

    private func extractItemID(
        from paramsObject: IncomingParamsObject?,
        eventObject: IncomingParamsObject?,
        itemObject: IncomingParamsObject? = nil
    ) -> String? {
        if let itemId = itemObject?["timelineItemId"]?.stringValue, !itemId.isEmpty { return itemId }
        if let itemId = itemObject?["timeline_item_id"]?.stringValue, !itemId.isEmpty { return itemId }
        if let itemId = itemObject?["id"]?.stringValue, !itemId.isEmpty { return itemId }
        if let itemId = itemObject?["call_id"]?.stringValue, !itemId.isEmpty { return itemId }
        if let itemId = itemObject?["callId"]?.stringValue, !itemId.isEmpty { return itemId }
        if let itemId = paramsObject?["timelineItemId"]?.stringValue, !itemId.isEmpty { return itemId }
        if let itemId = paramsObject?["timeline_item_id"]?.stringValue, !itemId.isEmpty { return itemId }
        if let itemId = paramsObject?["itemId"]?.stringValue, !itemId.isEmpty { return itemId }
        if let itemId = paramsObject?["item_id"]?.stringValue, !itemId.isEmpty { return itemId }
        if let itemId = paramsObject?["call_id"]?.stringValue, !itemId.isEmpty { return itemId }
        if let itemId = paramsObject?["callId"]?.stringValue, !itemId.isEmpty { return itemId }
        if let itemId = paramsObject?["id"]?.stringValue, !itemId.isEmpty { return itemId }
        if let itemId = paramsObject?["item"]?.objectValue?["id"]?.stringValue, !itemId.isEmpty { return itemId }
        if let itemId = eventObject?["timelineItemId"]?.stringValue, !itemId.isEmpty { return itemId }
        if let itemId = eventObject?["timeline_item_id"]?.stringValue, !itemId.isEmpty { return itemId }
        if let itemId = eventObject?["itemId"]?.stringValue, !itemId.isEmpty { return itemId }
        if let itemId = eventObject?["item_id"]?.stringValue, !itemId.isEmpty { return itemId }
        if let itemId = eventObject?["call_id"]?.stringValue, !itemId.isEmpty { return itemId }
        if let itemId = eventObject?["callId"]?.stringValue, !itemId.isEmpty { return itemId }
        if let itemId = eventObject?["item"]?.objectValue?["id"]?.stringValue, !itemId.isEmpty { return itemId }
        return nil
    }

    func extractPreviousItemID(
        from paramsObject: IncomingParamsObject?,
        eventObject: IncomingParamsObject?,
        itemObject: IncomingParamsObject? = nil
    ) -> String? {
        let candidates: [String?] = [
            itemObject?["previousItemId"]?.stringValue,
            itemObject?["previous_item_id"]?.stringValue,
            itemObject?["previousItemID"]?.stringValue,
            paramsObject?["previousItemId"]?.stringValue,
            paramsObject?["previous_item_id"]?.stringValue,
            paramsObject?["previousItemID"]?.stringValue,
            paramsObject?["previousItem"]?.objectValue?["id"]?.stringValue,
            paramsObject?["previous_item"]?.objectValue?["id"]?.stringValue,
            eventObject?["previousItemId"]?.stringValue,
            eventObject?["previous_item_id"]?.stringValue,
            eventObject?["previousItemID"]?.stringValue,
            eventObject?["previousItem"]?.objectValue?["id"]?.stringValue,
            eventObject?["previous_item"]?.objectValue?["id"]?.stringValue,
            paramsObject?["item"]?.objectValue?["previousItemId"]?.stringValue,
            paramsObject?["item"]?.objectValue?["previous_item_id"]?.stringValue,
            eventObject?["item"]?.objectValue?["previousItemId"]?.stringValue,
            eventObject?["item"]?.objectValue?["previous_item_id"]?.stringValue,
        ]

        for candidate in candidates {
            if let normalized = normalizedIdentifier(candidate) {
                return normalized
            }
        }
        return nil
    }

    func extractCursorString(
        from paramsObject: IncomingParamsObject?,
        eventObject: IncomingParamsObject?,
        itemObject: IncomingParamsObject? = nil
    ) -> String? {
        let candidates: [String?] = [
            itemObject?["cursor"]?.stringValue,
            itemObject?["itemCursor"]?.stringValue,
            itemObject?["item_cursor"]?.stringValue,
            paramsObject?["cursor"]?.stringValue,
            paramsObject?["itemCursor"]?.stringValue,
            paramsObject?["item_cursor"]?.stringValue,
            paramsObject?["item"]?.objectValue?["cursor"]?.stringValue,
            eventObject?["cursor"]?.stringValue,
            eventObject?["itemCursor"]?.stringValue,
            eventObject?["item_cursor"]?.stringValue,
            eventObject?["item"]?.objectValue?["cursor"]?.stringValue,
        ]

        for candidate in candidates {
            let trimmed = candidate?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !trimmed.isEmpty {
                return trimmed
            }
        }
        return nil
    }

    func extractPreviousCursorString(
        from paramsObject: IncomingParamsObject?,
        eventObject: IncomingParamsObject?,
        itemObject: IncomingParamsObject? = nil
    ) -> String? {
        let candidates: [String?] = [
            itemObject?["previousCursor"]?.stringValue,
            itemObject?["previous_cursor"]?.stringValue,
            itemObject?["previousItemCursor"]?.stringValue,
            itemObject?["previous_item_cursor"]?.stringValue,
            paramsObject?["previousCursor"]?.stringValue,
            paramsObject?["previous_cursor"]?.stringValue,
            paramsObject?["previousItemCursor"]?.stringValue,
            paramsObject?["previous_item_cursor"]?.stringValue,
            paramsObject?["item"]?.objectValue?["previousCursor"]?.stringValue,
            paramsObject?["item"]?.objectValue?["previous_cursor"]?.stringValue,
            eventObject?["previousCursor"]?.stringValue,
            eventObject?["previous_cursor"]?.stringValue,
            eventObject?["previousItemCursor"]?.stringValue,
            eventObject?["previous_item_cursor"]?.stringValue,
            eventObject?["item"]?.objectValue?["previousCursor"]?.stringValue,
            eventObject?["item"]?.objectValue?["previous_cursor"]?.stringValue,
        ]

        for candidate in candidates {
            let trimmed = candidate?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !trimmed.isEmpty {
                return trimmed
            }
        }
        return nil
    }

    @discardableResult
    func handleRealtimeHistoryEvent(
        threadId: String,
        itemId: String?,
        paramsObject: IncomingParamsObject?,
        eventObject: IncomingParamsObject?,
        itemObject: IncomingParamsObject? = nil
    ) -> Bool {
        handleRealtimeHistoryEvent(
            threadId: threadId,
            turnId: extractTurnID(from: paramsObject) ?? activeTurnIdByThread[threadId],
            itemId: itemId,
            previousItemId: extractPreviousItemID(
                from: paramsObject,
                eventObject: eventObject,
                itemObject: itemObject
            ),
            cursor: extractCursorString(
                from: paramsObject,
                eventObject: eventObject,
                itemObject: itemObject
            ),
            previousCursor: extractPreviousCursorString(
                from: paramsObject,
                eventObject: eventObject,
                itemObject: itemObject
            )
        )
    }

    func extractThreadID(from paramsObject: IncomingParamsObject?) -> String? {
        guard let paramsObject else { return nil }

        if let threadId = normalizedIdentifier(paramsObject["threadId"]?.stringValue) { return threadId }
        if let threadId = normalizedIdentifier(paramsObject["thread_id"]?.stringValue) { return threadId }
        if let threadId = normalizedIdentifier(paramsObject["conversationId"]?.stringValue) { return threadId }
        if let threadId = normalizedIdentifier(paramsObject["conversation_id"]?.stringValue) { return threadId }
        if let threadId = normalizedIdentifier(paramsObject["thread"]?.objectValue?["id"]?.stringValue) { return threadId }
        if let threadId = normalizedIdentifier(paramsObject["turn"]?.objectValue?["threadId"]?.stringValue) { return threadId }
        if let threadId = normalizedIdentifier(paramsObject["turn"]?.objectValue?["thread_id"]?.stringValue) { return threadId }
        if let threadId = normalizedIdentifier(paramsObject["item"]?.objectValue?["threadId"]?.stringValue) { return threadId }
        if let threadId = normalizedIdentifier(paramsObject["item"]?.objectValue?["thread_id"]?.stringValue) { return threadId }

        let eventObject = envelopeEventObject(from: paramsObject)
        if let threadId = normalizedIdentifier(eventObject?["threadId"]?.stringValue) { return threadId }
        if let threadId = normalizedIdentifier(eventObject?["thread_id"]?.stringValue) { return threadId }
        if let threadId = normalizedIdentifier(eventObject?["conversationId"]?.stringValue) { return threadId }
        if let threadId = normalizedIdentifier(eventObject?["conversation_id"]?.stringValue) { return threadId }
        if let threadId = normalizedIdentifier(eventObject?["thread"]?.objectValue?["id"]?.stringValue) { return threadId }
        if let threadId = normalizedIdentifier(eventObject?["turn"]?.objectValue?["threadId"]?.stringValue) { return threadId }
        if let threadId = normalizedIdentifier(eventObject?["turn"]?.objectValue?["thread_id"]?.stringValue) { return threadId }
        if let threadId = normalizedIdentifier(eventObject?["item"]?.objectValue?["threadId"]?.stringValue) { return threadId }
        if let threadId = normalizedIdentifier(eventObject?["item"]?.objectValue?["thread_id"]?.stringValue) { return threadId }

        guard let eventObject = paramsObject["event"]?.objectValue else { return nil }
        if let threadId = normalizedIdentifier(eventObject["threadId"]?.stringValue) { return threadId }
        if let threadId = normalizedIdentifier(eventObject["thread_id"]?.stringValue) { return threadId }
        if let threadId = normalizedIdentifier(eventObject["conversationId"]?.stringValue) { return threadId }
        if let threadId = normalizedIdentifier(eventObject["conversation_id"]?.stringValue) { return threadId }
        if let threadId = normalizedIdentifier(eventObject["thread"]?.objectValue?["id"]?.stringValue) { return threadId }
        if let threadId = normalizedIdentifier(eventObject["turn"]?.objectValue?["threadId"]?.stringValue) { return threadId }
        if let threadId = normalizedIdentifier(eventObject["turn"]?.objectValue?["thread_id"]?.stringValue) { return threadId }

        return nil
    }

    func extractTurnID(from paramsObject: IncomingParamsObject?) -> String? {
        guard let paramsObject else { return nil }

        if let turnId = extractTurnID(from: paramsObject["turn"]) { return turnId }
        if let turnId = normalizedIdentifier(paramsObject["turnId"]?.stringValue) { return turnId }
        if let turnId = normalizedIdentifier(paramsObject["turn_id"]?.stringValue) { return turnId }
        if let turnId = normalizedIdentifier(paramsObject["item"]?.objectValue?["turnId"]?.stringValue) { return turnId }
        if let turnId = normalizedIdentifier(paramsObject["item"]?.objectValue?["turn_id"]?.stringValue) { return turnId }

        let eventObject = envelopeEventObject(from: paramsObject)
        if let turnId = normalizedIdentifier(eventObject?["turnId"]?.stringValue) { return turnId }
        if let turnId = normalizedIdentifier(eventObject?["turn_id"]?.stringValue) { return turnId }
        if let turnId = extractTurnID(from: eventObject?["turn"]) { return turnId }
        if let turnId = normalizedIdentifier(eventObject?["item"]?.objectValue?["turnId"]?.stringValue) { return turnId }
        if let turnId = normalizedIdentifier(eventObject?["item"]?.objectValue?["turn_id"]?.stringValue) { return turnId }

        guard let eventObject = paramsObject["event"]?.objectValue else { return nil }
        if let turnId = normalizedIdentifier(eventObject["turnId"]?.stringValue) { return turnId }
        if let turnId = normalizedIdentifier(eventObject["turn_id"]?.stringValue) { return turnId }
        if let turnId = extractTurnID(from: eventObject["turn"]) { return turnId }

        return nil
    }

    func envelopeEventObject(from paramsObject: IncomingParamsObject?) -> IncomingParamsObject? {
        paramsObject?["msg"]?.objectValue ?? paramsObject?["event"]?.objectValue
    }

    // Turn lifecycle notifications sometimes carry the turn id as top-level `id`.
    // Accept that shape only for turn/started and turn/completed handling.
    private func extractTurnIDForTurnLifecycleEvent(from paramsObject: IncomingParamsObject?) -> String? {
        if let turnID = extractTurnID(from: paramsObject) {
            return turnID
        }

        let eventObject = envelopeEventObject(from: paramsObject)
        let nestedEventObject = paramsObject?["event"]?.objectValue
        return normalizedIdentifier(
            paramsObject?["id"]?.stringValue
                ?? eventObject?["id"]?.stringValue
                ?? nestedEventObject?["id"]?.stringValue
        )
    }

    private func shouldRetryTurnError(from paramsObject: IncomingParamsObject?) -> Bool {
        let eventObject = envelopeEventObject(from: paramsObject)

        let candidates: [JSONValue?] = [
            paramsObject?["willRetry"],
            paramsObject?["will_retry"],
            eventObject?["willRetry"],
            eventObject?["will_retry"],
            paramsObject?["event"]?.objectValue?["willRetry"],
            paramsObject?["event"]?.objectValue?["will_retry"],
        ]

        for candidate in candidates {
            if let parsed = parseBooleanFlag(candidate) {
                return parsed
            }
        }
        return false
    }

    private func parseBooleanFlag(_ value: JSONValue?) -> Bool? {
        guard let value else { return nil }

        if let boolValue = value.boolValue {
            return boolValue
        }

        guard let text = value.stringValue?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased() else {
            return nil
        }

        if text == "true" || text == "1" || text == "yes" {
            return true
        }
        if text == "false" || text == "0" || text == "no" {
            return false
        }

        return nil
    }

    func normalizedIdentifier(_ candidate: String?) -> String? {
        guard let candidate else {
            return nil
        }

        let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    func summarizeIncomingRPCMessage(_ message: RPCMessage) -> String {
        if let method = message.method {
            let normalizedMethod = normalizedIncomingMethodName(method)
            if let requestID = message.id {
                return "request method=\(normalizedMethod) id=\(shortIncomingJSONValue(requestID)) "
                    + summarizeIncomingNotification(method: normalizedMethod, paramsObject: message.params?.objectValue)
            }
            return "notification \(summarizeIncomingNotification(method: normalizedMethod, paramsObject: message.params?.objectValue))"
        }

        if let responseID = message.id {
            return "response id=\(shortIncomingJSONValue(responseID)) error=\(message.error != nil)"
        }

        return "message=unknown"
    }

    func summarizeIncomingNotification(
        method: String,
        paramsObject: IncomingParamsObject?
    ) -> String {
        let eventObject = envelopeEventObject(from: paramsObject)
        let threadId = extractThreadID(from: paramsObject)
            ?? extractThreadID(from: eventObject)
        let turnId = extractTurnID(from: paramsObject)
        let itemId = extractItemID(from: paramsObject, eventObject: eventObject)
        let cursor = extractCursorString(from: paramsObject, eventObject: eventObject)
        let previousCursor = extractPreviousCursorString(
            from: paramsObject,
            eventObject: eventObject
        )
        var parts = ["method=\(method)"]
        if let threadId {
            parts.append("thread=\(threadId)")
        }
        if let turnId {
            parts.append("turn=\(turnId)")
        }
        if let itemId {
            parts.append("item=\(itemId)")
        }
        if let cursor {
            parts.append("cursor=\(cursor)")
        }
        if let previousCursor {
            parts.append("previousCursor=\(previousCursor)")
        }
        return parts.joined(separator: " ")
    }

    func shortIncomingJSONValue(_ value: JSONValue) -> String {
        if let stringValue = value.stringValue {
            return String(stringValue.prefix(12))
        }
        if let integerValue = value.intValue {
            return String(integerValue)
        }
        if let doubleValue = value.doubleValue {
            return String(doubleValue)
        }
        if let boolValue = value.boolValue {
            return String(boolValue)
        }
        return "json"
    }

    private func hasStreamingMessage(in threadId: String) -> Bool {
        (messagesByThread[threadId] ?? []).contains(where: { $0.isStreaming })
    }

    func resolveThreadID(
        from paramsObject: IncomingParamsObject?,
        turnIdHint: String? = nil
    ) -> String? {
        if let threadId = extractThreadID(from: paramsObject), !threadId.isEmpty {
            if let turnId = turnIdHint ?? extractTurnID(from: paramsObject) {
                threadIdByTurnID[turnId] = threadId
            }
            debugRuntimeLog("resolveThreadID source=explicit thread=\(threadId) turnHint=\(turnIdHint ?? "none")")
            return threadId
        }

        if let turnId = turnIdHint ?? extractTurnID(from: paramsObject),
           let mappedThreadId = threadIdByTurnID[turnId] {
            debugRuntimeLog("resolveThreadID source=turn-map thread=\(mappedThreadId) turn=\(turnId)")
            return mappedThreadId
        }

        if let activeThreadId,
           threads.first(where: { $0.id == activeThreadId })?.provider == "codex" {
            if activeTurnIdByThread.isEmpty || activeTurnIdByThread.count == 1 {
                debugRuntimeLog("resolveThreadID source=active-codex-thread thread=\(activeThreadId) activeTurns=\(activeTurnIdByThread.count)")
                return activeThreadId
            }
        }

        // Conservative fallback: infer only when there is a single unambiguous thread context.
        if activeTurnIdByThread.count == 1,
           let soleRunningThreadId = activeTurnIdByThread.keys.first {
            debugRuntimeLog("resolveThreadID source=sole-running-thread thread=\(soleRunningThreadId)")
            return soleRunningThreadId
        }
        if threads.count == 1, let soleThreadId = threads.first?.id {
            debugRuntimeLog("resolveThreadID source=sole-thread thread=\(soleThreadId)")
            return soleThreadId
        }
        if threads.isEmpty,
           messagesByThread.keys.count <= 1,
           let activeThreadId {
            debugRuntimeLog("resolveThreadID source=active-thread-empty-list thread=\(activeThreadId)")
            return activeThreadId
        }

        debugRuntimeLog(
            "resolveThreadID failed turnHint=\(turnIdHint ?? "none") activeThread=\(activeThreadId ?? "none") "
            + "activeTurns=\(activeTurnIdByThread.count) threads=\(threads.count) messageThreads=\(messagesByThread.keys.count)"
        )
        return nil
    }

    func extractIncomingMessageText(from itemObject: [String: JSONValue]) -> String {
        let contentItems = itemObject["content"]?.arrayValue ?? []
        var parts: [String] = []

        for content in contentItems {
            guard let object = content.objectValue else { continue }
            let contentType = object["type"]?.stringValue?.lowercased()
            let isTextType = contentType == nil
                || contentType == "text"
                || contentType == "input_text"
                || contentType == "output_text"
                || contentType == "message"
            if contentType == "skill" {
                let skillID = object["id"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
                let skillName = object["name"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
                let resolved = (skillID?.isEmpty == false) ? skillID : skillName
                if let resolved, !resolved.isEmpty {
                    parts.append("$\(resolved)")
                }
                continue
            }

            guard isTextType else { continue }

            if let text = object["text"]?.stringValue, !text.isEmpty {
                parts.append(text)
                continue
            }

            if let delta = object["delta"]?.stringValue, !delta.isEmpty {
                parts.append(delta)
                continue
            }

            if let nestedText = object["data"]?.objectValue?["text"]?.stringValue,
               !nestedText.isEmpty {
                parts.append(nestedText)
            }
        }

        let joined = parts.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        if !joined.isEmpty {
            return joined
        }

        if let directText = itemObject["text"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
           !directText.isEmpty {
            return directText
        }

        if let messageText = itemObject["message"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
           !messageText.isEmpty {
            return messageText
        }

        return ""
    }
}

private extension CodeRoverService {
    func enqueuePendingApproval(_ request: CodeRoverApprovalRequest) {
        if pendingApprovals.contains(where: { $0.id == request.id }) {
            return
        }
        pendingApprovals.append(request)
    }
}
