// FILE: CodeRoverService+ThreadsTurns.swift
// Purpose: Thread/turn operations exposed to the UI.
// Layer: Service
// Exports: CodeRoverService thread+turn APIs
// Depends on: ConversationThread, JSONValue

import Foundation

extension CodeRoverService {
    struct ThreadListPage {
        let threads: [ConversationThread]
        let nextCursor: JSONValue
        let hasMore: Bool
        let pageSize: Int
    }

    // Keeps sidebar/project loading focused on recent conversations without hiding
    // other active project groups when the latest chats all belong to one repo.
    var recentThreadListLimit: Int { 60 }

    func listThreads(limit: Int? = nil) async throws {
        isLoadingThreads = true
        defer { isLoadingThreads = false }

        let activeThreads: [ConversationThread]
        var archivedThreads: [ConversationThread] = []

        if let limit {
            let activePage = try await fetchServerThreadPage(limit: limit)
            activeThreads = activePage.threads
            activeThreadListNextCursor = activePage.nextCursor
            activeThreadListHasMore = activePage.hasMore

            do {
                archivedThreads = try await fetchServerThreads(limit: limit, archived: true)
            } catch {
                debugSyncLog("session/list archived fetch failed (non-fatal): \(error.localizedDescription)")
            }
        } else {
            activeThreads = try await fetchServerThreads()
            activeThreadListNextCursor = .null
            activeThreadListHasMore = false

            do {
                archivedThreads = try await fetchServerThreads(archived: true)
            } catch {
                debugSyncLog("session/list archived fetch failed (non-fatal): \(error.localizedDescription)")
            }
        }

        reconcileLocalThreadsWithServer(activeThreads, serverArchivedThreads: archivedThreads)

        if activeThreadId == nil {
            activeThreadId = threads.first(where: { $0.syncState == .live })?.id
        }
    }

    // Starts a new thread and stores it in local state.
    func startThread(preferredProjectPath: String? = nil, provider: String? = nil) async throws -> ConversationThread {
        let normalizedPreferredProjectPath = ConversationThreadStartProjectBinding.normalizedProjectPath(preferredProjectPath)
        let resolvedProvider = runtimeProviderID(for: provider ?? selectedProviderID)
        let response = try await sendRequest(
            method: "session/new",
            params: .object([
                "cwd": normalizedPreferredProjectPath.map(JSONValue.string) ?? .null,
                "_meta": .object([
                    "coderover": .object([
                        "agentId": .string(resolvedProvider),
                    ]),
                ]),
            ])
        )
        guard let resultObject = response.result?.objectValue,
              let sessionId = normalizedIdentifier(resultObject["sessionId"]?.stringValue) else {
            throw CodeRoverServiceError.invalidResponse("session/new response missing sessionId")
        }

        var thread = ConversationThread(
            id: sessionId,
            cwd: normalizedPreferredProjectPath,
            provider: resolvedProvider,
            capabilities: availableProviders.first(where: { $0.id == resolvedProvider })?.supports ?? .codexDefault
        )
        upsertThread(thread)
        thread = applyAcpSessionState(
            sessionId: sessionId,
            stateObject: resultObject,
            preferredProjectPath: normalizedPreferredProjectPath,
            providerHint: resolvedProvider
        )
        upsertThread(thread)
        resumedThreadIDs.insert(thread.id)
        activeThreadId = thread.id
        return thread
    }

    // Sends user input as a new turn against an existing (or newly created) thread.
    func startTurn(
        userInput: String,
        threadId: String?,
        attachments: [ImageAttachment] = [],
        skillMentions: [TurnSkillMention] = [],
        shouldAppendUserMessage: Bool = true,
        collaborationMode: CollaborationModeModeKind? = nil
    ) async throws {
        let trimmedInput = userInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedInput.isEmpty || !attachments.isEmpty else {
            throw CodeRoverServiceError.invalidInput("User input and images cannot both be empty")
        }

        let initialThreadId = try await resolveThreadID(threadId)

        do {
            try await sendTurnStart(
                trimmedInput,
                attachments: attachments,
                skillMentions: skillMentions,
                to: initialThreadId,
                shouldAppendUserMessage: shouldAppendUserMessage,
                collaborationMode: collaborationMode
            )
        } catch {
            if shouldTreatAsThreadNotFound(error) {
                // If the active send explicitly says "thread not found", treat it as authoritative.
                if shouldAppendUserMessage {
                    removeLatestFailedUserMessage(
                        threadId: initialThreadId,
                        matchingText: trimmedInput,
                        matchingAttachments: attachments
                    )
                }
                handleMissingThread(initialThreadId)

                let continuationThread = try await createContinuationThread(from: initialThreadId)
                try await sendTurnStart(
                    trimmedInput,
                    attachments: attachments,
                    skillMentions: skillMentions,
                    to: continuationThread.id,
                    shouldAppendUserMessage: shouldAppendUserMessage,
                    collaborationMode: collaborationMode
                )
                activeThreadId = continuationThread.id
                lastErrorMessage = nil
                return
            }
            throw error
        }

        activeThreadId = initialThreadId
    }

    func startReview(
        threadId: String,
        target: CodeRoverReviewTarget?,
        baseBranch: String? = nil
    ) async throws {
        _ = target
        _ = baseBranch
        _ = threadId
        throw CodeRoverServiceError.invalidInput("Code review is not available in ACP-native iOS yet.")
    }

    func refreshContextWindowUsage(threadId: String) async {
        let trimmedThreadID = threadId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedThreadID.isEmpty else { return }
        guard runtimeProviderID(for: threads.first(where: { $0.id == trimmedThreadID })?.provider) == "codex" else {
            return
        }

        var params: RPCObject = ["sessionId": .string(trimmedThreadID)]
        if let turnId = activeTurnIdByThread[trimmedThreadID]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !turnId.isEmpty {
            params["turnId"] = .string(turnId)
        }

        do {
            let response = try await sendRequest(method: "_coderover/context_window/read", params: .object(params))
            guard let resultObject = response.result?.objectValue,
                  let usageObject = resultObject["usage"]?.objectValue,
                  let usage = extractContextWindowUsage(from: usageObject) else {
                return
            }
            contextWindowUsageByThread[trimmedThreadID] = usage
        } catch {
            debugSyncLog("thread/contextWindow/read failed (non-fatal): \(error.localizedDescription)")
        }
    }

    // Requests context compaction for a thread.
    func compactContext(threadId: String) async throws {
        _ = threadId
        throw CodeRoverServiceError.invalidInput("Context compaction is not available in ACP-native iOS yet.")
    }

    // Requests interruption for the active turn.
    func interruptTurn(turnId: String?, threadId: String? = nil) async throws {
        let normalizedThreadID = normalizedInterruptIdentifier(threadId)
            ?? normalizedInterruptIdentifier(activeThreadId)
        let resolvedThreadID = normalizedThreadID
            ?? normalizedInterruptIdentifier(turnId).flatMap { threadIdByTurnID[$0] }
        guard let resolvedThreadID else {
            throw CodeRoverServiceError.invalidInput("session/cancel requires a threadId")
        }

        do {
            try await sendInterruptRequest(turnId: turnId ?? "", threadId: resolvedThreadID, useSnakeCaseParams: false)
        } catch {
            lastErrorMessage = userFacingTurnErrorMessage(from: error)
            throw error
        }
    }

    // Queries server-side fuzzy file search using stable RPC (non-experimental).
    func fuzzyFileSearch(
        query: String,
        roots: [String],
        cancellationToken: String?
    ) async throws -> [FuzzyFileMatch] {
        _ = query
        _ = roots
        _ = cancellationToken
        return []
    }

    // Loads available skills for one or more roots with shape-fallback compatibility.
    func listSkills(
        cwds: [String]?,
        forceReload: Bool = false
    ) async throws -> [SkillMetadata] {
        _ = cwds
        _ = forceReload
        return []
    }

    // Accepts the latest pending approval request.
    func approvePendingRequest(forSession: Bool = false) async throws {
        guard let request = pendingApproval else {
            throw CodeRoverServiceError.noPendingApproval
        }

        let optionId = (forSession && request.method == "session/request_permission/execute")
            ? "allow_always"
            : "allow_once"
        try await sendResponse(
            id: request.requestID,
            result: .object([
                "outcome": .object([
                    "optionId": .string(optionId),
                ]),
            ])
        )
        pendingApproval = nil
    }

    // Declines the latest pending approval request.
    func declinePendingRequest() async throws {
        guard let request = pendingApproval else {
            throw CodeRoverServiceError.noPendingApproval
        }

        try await sendResponse(
            id: request.requestID,
            result: .object([
                "outcome": .object([
                    "optionId": .string("reject_once"),
                ]),
            ])
        )
        pendingApproval = nil
    }

    // Responds to `_coderover/session/request_input` using the ACP answer envelope.
    func respondToStructuredUserInput(
        requestID: JSONValue,
        answersByQuestionID: [String: [String]]
    ) async throws {
        try await sendResponse(
            id: requestID,
            result: .object([
                "answers": .object(buildStructuredUserInputACPAnswers(answersByQuestionID: answersByQuestionID)),
            ])
        )
    }

    func buildStructuredUserInputACPAnswers(
        answersByQuestionID: [String: [String]]
    ) -> RPCObject {
        answersByQuestionID.reduce(into: RPCObject()) { result, entry in
            let filteredAnswers = entry.value
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
            result[entry.key] = .object([
                "answers": .array(filteredAnswers.map(JSONValue.string)),
            ])
        }
    }

}

enum ConversationThreadStartProjectBinding {
    // Normalizes project paths before sending them to thread/start.
    static func normalizedProjectPath(_ rawValue: String?) -> String? {
        guard let rawValue else {
            return nil
        }

        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return nil
        }

        if trimmed == "/" {
            return trimmed
        }

        var normalized = trimmed
        while normalized.hasSuffix("/") {
            normalized.removeLast()
        }

        return normalized.isEmpty ? "/" : normalized
    }

    static func makeThreadStartParams(
        modelIdentifier: String?,
        preferredProjectPath: String?,
        provider: String?
    ) -> RPCObject {
        var params: RPCObject = [:]

        if let modelIdentifier {
            params["model"] = .string(modelIdentifier)
        }

        if let provider {
            params["provider"] = .string(provider)
        }

        if let preferredProjectPath {
            params["cwd"] = .string(preferredProjectPath)
        }

        return params
    }

    // Preserves project grouping even when older servers omit cwd in thread/start result.
    static func applyPreferredProjectFallback(to thread: ConversationThread, preferredProjectPath: String?) -> ConversationThread {
        guard thread.normalizedProjectPath == nil,
              let preferredProjectPath else {
            return thread
        }

        var patchedThread = thread
        patchedThread.cwd = preferredProjectPath
        return patchedThread
    }
}

extension CodeRoverService {
    func fetchServerThreadPage(
        limit: Int? = nil,
        archived: Bool = false,
        cursor: JSONValue = .null
    ) async throws -> ThreadListPage {
        var params: RPCObject = ["cursor": cursor]
        if let limit {
            params["limit"] = .integer(limit)
        }
        if archived {
            params["_meta"] = .object([
                "coderover": .object([
                    "archived": .bool(true),
                ]),
            ])
        }

        let response = try await sendRequest(method: "session/list", params: .object(params))

        guard let resultObject = response.result?.objectValue else {
            throw CodeRoverServiceError.invalidResponse("session/list response missing payload")
        }

        let page =
            resultObject["sessions"]?.arrayValue
            ?? resultObject["items"]?.arrayValue
        guard let page else {
            throw CodeRoverServiceError.invalidResponse("session/list response missing sessions array")
        }

        let nextCursor = nextThreadListCursor(from: resultObject)
        return ThreadListPage(
            threads: page.compactMap(decodeAcpSessionInfo),
            nextCursor: nextCursor,
            hasMore: threadListCursorExists(nextCursor),
            pageSize: page.count
        )
    }

    func fetchServerThreads(limit: Int? = nil, archived: Bool = false) async throws -> [ConversationThread] {
        var allThreads: [ConversationThread] = []
        var nextCursor: JSONValue = .null
        var hasRequestedFirstPage = false

        repeat {
            let page = try await fetchServerThreadPage(limit: limit, archived: archived, cursor: nextCursor)
            allThreads.append(contentsOf: page.threads)
            nextCursor = page.nextCursor
            hasRequestedFirstPage = true
        } while shouldContinueThreadListPagination(
            nextCursor: nextCursor,
            limit: limit,
            hasRequestedFirstPage: hasRequestedFirstPage
        )

        return allThreads
    }

    private func nextThreadListCursor(from resultObject: RPCObject) -> JSONValue {
        if let nextCursor = resultObject["nextCursor"] {
            return nextCursor
        }
        if let nextCursor = resultObject["next_cursor"] {
            return nextCursor
        }
        return .null
    }

    func threadListCursorExists(_ cursor: JSONValue) -> Bool {
        switch cursor {
        case .null:
            return false
        case let .string(value):
            return !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        default:
            return true
        }
    }

    func loadMoreThreadsForProject(projectKey: String, minimumVisibleCount: Int) async throws {
        guard activeThreadListHasMore else { return }

        var currentProjectCount = threads.filter { $0.syncState != .archivedLocal && $0.projectKey == projectKey }.count
        while currentProjectCount < minimumVisibleCount, activeThreadListHasMore {
            let nextPage = try await fetchServerThreadPage(limit: recentThreadListLimit, cursor: activeThreadListNextCursor)
            activeThreadListNextCursor = nextPage.nextCursor
            activeThreadListHasMore = nextPage.hasMore
            reconcileLocalThreadsWithServer(nextPage.threads)
            currentProjectCount = threads.filter { $0.syncState != .archivedLocal && $0.projectKey == projectKey }.count
        }
    }

    // Paginates until the server reports no cursor or the caller requested a capped page.
    private func shouldContinueThreadListPagination(
        nextCursor: JSONValue,
        limit: Int?,
        hasRequestedFirstPage: Bool
    ) -> Bool {
        guard hasRequestedFirstPage, limit == nil else {
            return false
        }

        switch nextCursor {
        case .null:
            return false
        case let .string(value):
            return !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        default:
            return true
        }
    }

    func createContinuationThread(from archivedThreadId: String) async throws -> ConversationThread {
        let archivedThread = threads.first(where: { $0.id == archivedThreadId })
        let continuationThread = try await startThread(
            preferredProjectPath: archivedThread?.normalizedProjectPath,
            provider: archivedThread?.provider
        )
        appendSystemMessage(
            threadId: continuationThread.id,
            text: "Continued from archived thread `\(archivedThreadId)`"
        )
        return continuationThread
    }

    @discardableResult
    func hydrateThreadTranscript(threadId: String, forceReload: Bool = false) async throws -> ConversationThread? {
        guard !threadId.isEmpty else {
            return nil
        }

        if !forceReload, hydratedThreadIDs.contains(threadId) {
            return threads.first(where: { $0.id == threadId })
        }

        resetTranscriptHydrationState(for: threadId)
        let response = try await sendRequest(
            method: "session/load",
            params: .object([
                "sessionId": .string(threadId),
            ])
        )

        guard let resultObject = response.result?.objectValue else {
            hydratedThreadIDs.insert(threadId)
            resumedThreadIDs.insert(threadId)
            return threads.first(where: { $0.id == threadId })
        }

        let hydratedThread = applyAcpSessionState(sessionId: threadId, stateObject: resultObject)
        hydratedThreadIDs.insert(threadId)
        resumedThreadIDs.insert(threadId)
        return hydratedThread
    }

    @discardableResult
    func ensureThreadResumed(threadId: String, force: Bool = false) async throws -> ConversationThread? {
        guard !threadId.isEmpty else {
            return nil
        }

        resumedThreadIDs.insert(threadId)
        _ = force
        return threads.first(where: { $0.id == threadId })
    }

    func isThreadMissingOnServer(_ threadId: String) async -> Bool {
        do {
            _ = try await sendRequest(method: "session/load", params: .object([
                "sessionId": .string(threadId),
            ]))
            return false
        } catch {
            return shouldTreatAsThreadNotFound(error)
        }
    }

    // Rebuilds active turn/running state from server truth after reconnect/background transitions.
    // Returns false when the snapshot could not be refreshed, so callers can fall back to history sync.
    func refreshInFlightTurnState(threadId: String) async -> Bool {
        let normalizedThreadID = normalizedInterruptIdentifier(threadId)
        guard let normalizedThreadID,
              isConnected,
              isInitialized else {
            return false
        }

        return threadHasActiveOrRunningTurn(normalizedThreadID)
    }

    func sendTurnStart(
        _ userInput: String,
        attachments: [ImageAttachment] = [],
        skillMentions: [TurnSkillMention] = [],
        to threadId: String,
        shouldAppendUserMessage: Bool = true,
        collaborationMode: CollaborationModeModeKind? = nil
    ) async throws {
        let pendingMessageId = shouldAppendUserMessage
            ? appendUserMessage(threadId: threadId, text: userInput, attachments: attachments)
            : ""
        activeThreadId = threadId
        markThreadAsRunning(threadId)
        protectedRunningFallbackThreadIDs.insert(threadId)
        beginForegroundAggressivePolling(threadId: threadId)

        let threadCapabilities = threads.first(where: { $0.id == threadId })?.capabilities
            ?? currentRuntimeProvider().supports
        let effectiveCollaborationMode = (supportsTurnCollaborationMode && threadCapabilities.planMode)
            ? collaborationMode
            : nil

        do {
            try await syncACPSessionConfiguration(
                threadId: threadId,
                collaborationMode: effectiveCollaborationMode
            )
            let requestParams = try buildTurnStartRequestParams(
                threadId: threadId,
                userInput: userInput,
                attachments: attachments,
                messageId: pendingMessageId
            )
            let response = try await sendRequest(
                method: "session/prompt",
                params: .object(requestParams)
            )
            handleSuccessfulTurnStartResponse(
                response,
                pendingMessageId: pendingMessageId,
                threadId: threadId
            )
        } catch {
            try handleTurnStartFailure(
                error,
                pendingMessageId: pendingMessageId,
                threadId: threadId
            )
        }
    }

    // Steers an active turn using the same payload contract as session/prompt.
    func steerTurn(
        userInput: String,
        threadId: String,
        expectedTurnId: String?,
        attachments: [ImageAttachment] = [],
        skillMentions: [TurnSkillMention] = [],
        shouldAppendUserMessage: Bool = true
    ) async throws {
        _ = userInput
        _ = threadId
        _ = expectedTurnId
        _ = attachments
        _ = skillMentions
        _ = shouldAppendUserMessage
        throw CodeRoverServiceError.invalidInput("Steering is not available in ACP-native iOS yet.")
    }

    func userFacingTurnErrorMessage(from error: Error) -> String {
        if let serviceError = error as? CodeRoverServiceError {
            switch serviceError {
            case .rpcError(let rpcError):
                let trimmed = rpcError.message.trimmingCharacters(in: .whitespacesAndNewlines)
                return trimmed.isEmpty ? serviceError.localizedDescription : trimmed
            default:
                let trimmed = serviceError.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
                return trimmed.isEmpty ? "Error while sending message" : trimmed
            }
        }

        let trimmed = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "Error while sending message" : trimmed
    }

    // Builds ACP session/prompt params for one user turn.
    func buildTurnStartRequestParams(
        threadId: String,
        userInput: String,
        attachments: [ImageAttachment],
        messageId: String
    ) throws -> RPCObject {
        var params: RPCObject = [
            "sessionId": .string(threadId),
            "prompt": .array(buildACPPromptBlocks(userInput: userInput, attachments: attachments)),
        ]
        if !messageId.isEmpty {
            params["messageId"] = .string(messageId)
        }
        return params
    }

    // Applies common failure bookkeeping for session/prompt primary and fallback attempts.
    func handleTurnStartFailure(
        _ error: Error,
        pendingMessageId: String,
        threadId: String
    ) throws {
        endForegroundAggressivePolling(threadId: threadId)
        markMessageDeliveryState(threadId: threadId, messageId: pendingMessageId, state: .failed)
        runningThreadIDs.remove(threadId)
        protectedRunningFallbackThreadIDs.remove(threadId)
        if shouldTreatAsThreadNotFound(error) {
            throw error
        }

        let errorMessage = userFacingTurnErrorMessage(from: error)
        lastErrorMessage = errorMessage
        appendSystemMessage(threadId: threadId, text: "Send error: \(errorMessage)")
        throw error
    }

    // Handles successful session/prompt bookkeeping for both primary and fallback payload schemas.
    func handleSuccessfulTurnStartResponse(
        _ response: RPCMessage,
        pendingMessageId: String,
        threadId: String
    ) {
        beginForegroundAggressivePolling(threadId: threadId)
        let turnID = extractTurnID(from: response.result)
        let resolvedTurnID = turnID ?? activeTurnIdByThread[threadId]
        let fallbackTurnID = resolvedTurnID == nil ? ensurePendingFallbackTurnIfNeeded(threadId: threadId) : nil
        let deliveryTurnID = resolvedTurnID ?? fallbackTurnID
        let deliveryState: ChatMessageDeliveryState = (resolvedTurnID == nil) ? .pending : .confirmed
        markMessageDeliveryState(
            threadId: threadId,
            messageId: pendingMessageId,
            state: deliveryState,
            turnId: deliveryTurnID
        )

        if let turnID = resolvedTurnID {
            activeTurnId = turnID
            activeTurnIdByThread[threadId] = turnID
            threadIdByTurnID[turnID] = threadId
            pendingRealtimeSeededTurnIDByThread[threadId] = turnID
            protectedRunningFallbackThreadIDs.remove(threadId)
            beginAssistantMessage(threadId: threadId, turnId: turnID)
        } else if let fallbackTurnID {
            debugRuntimeLog("session/prompt response missing turnId thread=\(threadId) fallbackTurn=\(fallbackTurnID)")
        }

        if let index = threads.firstIndex(where: { $0.id == threadId }) {
            threads[index].updatedAt = Date()
            threads[index].syncState = .live
            threads = sortThreads(threads)
        }

        requestImmediateSync(threadId: threadId)
    }

    func ensurePendingFallbackTurnIfNeeded(threadId: String) -> String {
        if let activeTurnId = activeTurnIdByThread[threadId],
           !activeTurnId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return activeTurnId
        }

        let fallbackTurnID = pendingFallbackTurnID(for: threadId)
        activeTurnId = fallbackTurnID
        activeTurnIdByThread[threadId] = fallbackTurnID
        threadIdByTurnID[fallbackTurnID] = threadId
        pendingRealtimeSeededTurnIDByThread[threadId] = fallbackTurnID
        protectedRunningFallbackThreadIDs.insert(threadId)
        beginAssistantMessage(threadId: threadId, turnId: fallbackTurnID)
        return fallbackTurnID
    }

    func rebindPendingFallbackTurnIfNeeded(threadId: String, to realTurnID: String) {
        guard let fallbackTurnID = activeTurnIdByThread[threadId],
              isPendingFallbackTurnID(fallbackTurnID),
              fallbackTurnID != realTurnID else {
            return
        }

        var didMutateMessages = false
        if var threadMessages = messagesByThread[threadId] {
            for index in threadMessages.indices {
                if threadMessages[index].turnId == fallbackTurnID {
                    threadMessages[index].turnId = realTurnID
                    didMutateMessages = true
                }

                if let itemId = threadMessages[index].itemId,
                   let reboundItemId = reboundFallbackStreamingItemID(itemId, from: fallbackTurnID, to: realTurnID) {
                    threadMessages[index].itemId = reboundItemId
                    didMutateMessages = true
                }
            }

            if didMutateMessages {
                messagesByThread[threadId] = threadMessages
            }
        }

        let oldTurnStreamingKey = "\(threadId)|\(fallbackTurnID)"
        let newTurnStreamingKey = "\(threadId)|\(realTurnID)"
        if !streamingAssistantMessageByTurnID.isEmpty {
            var reboundStreamingAssistantMessages: [String: String] = [:]
            reboundStreamingAssistantMessages.reserveCapacity(streamingAssistantMessageByTurnID.count)
            for (key, value) in streamingAssistantMessageByTurnID {
                if key == oldTurnStreamingKey {
                    reboundStreamingAssistantMessages[newTurnStreamingKey] = value
                } else if key.hasPrefix(oldTurnStreamingKey + "|item:") {
                    let suffix = String(key.dropFirst(oldTurnStreamingKey.count))
                    reboundStreamingAssistantMessages[newTurnStreamingKey + suffix] = value
                } else {
                    reboundStreamingAssistantMessages[key] = value
                }
            }
            streamingAssistantMessageByTurnID = reboundStreamingAssistantMessages
        }

        if !streamingSystemMessageByItemID.isEmpty {
            var reboundStreamingSystemMessages: [String: String] = [:]
            reboundStreamingSystemMessages.reserveCapacity(streamingSystemMessageByItemID.count)
            for (key, value) in streamingSystemMessageByItemID {
                let prefix = "\(threadId)|item:"
                if key.hasPrefix(prefix) {
                    let itemId = String(key.dropFirst(prefix.count))
                    if let reboundItemId = reboundFallbackStreamingItemID(itemId, from: fallbackTurnID, to: realTurnID) {
                        reboundStreamingSystemMessages["\(threadId)|item:\(reboundItemId)"] = value
                        continue
                    }
                }
                reboundStreamingSystemMessages[key] = value
            }
            streamingSystemMessageByItemID = reboundStreamingSystemMessages
        }

        threadIdByTurnID.removeValue(forKey: fallbackTurnID)
        threadIdByTurnID[realTurnID] = threadId
        if pendingRealtimeSeededTurnIDByThread[threadId] == fallbackTurnID {
            pendingRealtimeSeededTurnIDByThread[threadId] = realTurnID
        }
        if activeTurnId == fallbackTurnID {
            activeTurnId = realTurnID
        }
        activeTurnIdByThread[threadId] = realTurnID

        if didMutateMessages {
            persistMessages()
            updateCurrentOutput(for: threadId)
        }

        debugRuntimeLog("turn fallback rebound thread=\(threadId) from=\(fallbackTurnID) to=\(realTurnID)")
    }

    func pendingFallbackTurnID(for threadId: String) -> String {
        "__pending_turn__:\(threadId)"
    }

    func isPendingFallbackTurnID(_ turnId: String?) -> Bool {
        guard let turnId else { return false }
        return turnId.hasPrefix("__pending_turn__:")
    }

    func reboundFallbackStreamingItemID(_ itemId: String, from oldTurnID: String, to newTurnID: String) -> String? {
        for kind in [
            ChatMessageKind.chat,
            .thinking,
            .fileChange,
            .commandExecution,
            .plan,
            .userInputPrompt,
        ] {
            let oldSyntheticItemID = "turn:\(oldTurnID)|kind:\(kind.rawValue)"
            guard itemId == oldSyntheticItemID else {
                continue
            }
            return "turn:\(newTurnID)|kind:\(kind.rawValue)"
        }

        return nil
    }

    // Applies steer failure bookkeeping for optimistic user rows without adding an extra system error card.
    func handleSteerFailure(
        _ error: Error,
        pendingMessageId: String,
        threadId: String
    ) {
        markMessageDeliveryState(threadId: threadId, messageId: pendingMessageId, state: .failed)
        lastErrorMessage = userFacingTurnErrorMessage(from: error)
    }

    // Sends turn interruption request with camelCase or snake_case param keys for compatibility.
    func sendInterruptRequest(
        turnId: String,
        threadId: String?,
        useSnakeCaseParams: Bool
    ) async throws {
        let resolvedThreadID = normalizedInterruptIdentifier(threadId)
            ?? threadIdByTurnID[turnId]
        guard let resolvedThreadID else {
            throw CodeRoverServiceError.invalidInput("session/cancel requires a threadId")
        }
        try await sendNotification(
            method: "session/cancel",
            params: .object([
                "sessionId": .string(resolvedThreadID),
            ])
        )
    }

    // Normalizes ids coming from UI/runtime state before RPC usage.
    func normalizedInterruptIdentifier(_ rawValue: String?) -> String? {
        guard let rawValue else { return nil }
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    // Resolves the currently running turn id from local ACP session state.
    func resolveInFlightTurnID(threadId: String) async throws -> String? {
        if let turnId = activeTurnIdByThread[threadId] {
            return turnId
        }

        _ = try await ensureThreadResumed(threadId: threadId, force: true)
        return activeTurnIdByThread[threadId]
    }

    // Retries after refreshing turn id when local activeTurn cache is stale.
    func shouldRetryInterruptWithRefreshedTurnID(_ error: Error) -> Bool {
        guard let serviceError = error as? CodeRoverServiceError,
              case .rpcError(let rpcError) = serviceError else {
            return false
        }

        let message = rpcError.message.lowercased()
        let hints = [
            "turn not found",
            "no active turn",
            "not in progress",
            "not running",
            "already completed",
            "already finished",
            "invalid turn",
            "no such turn",
            "not active",
            "does not exist",
            "cannot interrupt"
        ]
        return hints.contains { message.contains($0) }
    }

}
