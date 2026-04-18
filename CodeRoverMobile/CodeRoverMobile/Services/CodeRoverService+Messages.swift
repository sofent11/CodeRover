// FILE: CodeRoverService+Messages.swift
// Purpose: Owns per-thread message timelines, streaming merge logic, and persistence.
// Layer: Service
// Exports: CodeRoverService message APIs
// Depends on: ChatMessage, JSONValue

import Foundation

extension CodeRoverService {
    // Returns the full persisted timeline for a single thread.
    func messages(for threadId: String) -> [ChatMessage] {
        let dict = messagesByThread
        return dict[threadId] ?? []
    }

    // Returns a lightweight per-thread revision token for any message timeline mutation.
    func messageRevision(for threadId: String) -> Int {
        let dict = messageRevisionByThread
        return dict[threadId] ?? 0
    }

    // Refreshes the derived output cache and bumps the thread timeline revision.
    func updateCurrentOutput(for threadId: String) {
        publishThreadMessagesMutationIfNeeded(for: threadId)

        let messageCount = messagesByThread[threadId]?.count ?? 0
        let revision = messageRevisionByThread[threadId] ?? 0
        coderoverDiagnosticLog(
            "CodeRoverMessages",
            "updateCurrentOutput thread=\(threadId) messages=\(messageCount) revision=\(revision) activeThread=\(activeThreadId ?? "nil")"
        )

        guard activeThreadId == threadId else {
            return
        }

        let latestAssistantText = messagesByThread[threadId]?
            .reversed()
            .first(where: { $0.role == .assistant && !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })?
            .text ?? ""

        currentOutput = latestAssistantText
    }

    // Returns the currently running turn id for a specific thread, if any.
    func activeTurnID(for threadId: String) -> String? {
        activeTurnIdByThread[threadId]
    }

    // Returns the latest real terminal outcome seen for a thread.
    func latestTurnTerminalState(for threadId: String) -> CodeRoverTurnTerminalState? {
        latestTurnTerminalStateByThread[threadId]
    }

    // Returns the terminal outcome for a specific turn when known.
    func turnTerminalState(for turnId: String?) -> CodeRoverTurnTerminalState? {
        guard let turnId else { return nil }
        return terminalStateByTurnID[turnId]
    }

    // Returns turn ids that ended via interruption so copy actions can stay hidden.
    func stoppedTurnIDs(for threadId: String) -> Set<String> {
        Set(
            messages(for: threadId)
                .compactMap(\.turnId)
                .filter { terminalStateByTurnID[$0] == .stopped }
        )
    }

    // Returns the sidebar run badge state for a thread with deterministic priority.
    func threadRunBadgeState(for threadId: String) -> ConversationThreadRunBadgeState? {
        if runningThreadIDs.contains(threadId)
            || activeTurnIdByThread[threadId] != nil {
            return .running
        }
        if failedThreadIDs.contains(threadId) {
            return .failed
        }
        if readyThreadIDs.contains(threadId) {
            return .ready
        }
        return nil
    }

    // Clears "ready/failed" badges when the user has opened a thread.
    func markThreadAsViewed(_ threadId: String) {
        clearRunningThreadWatch(threadId)
        clearOutcomeBadge(for: threadId)
    }

    // Marks thread as actively running while ensuring stale outcomes are cleared.
    func markThreadAsRunning(_ threadId: String) {
        runningThreadIDs.insert(threadId)
        latestTurnTerminalStateByThread.removeValue(forKey: threadId)
        clearOutcomeBadge(for: threadId)
        updateBackgroundRunGraceTask()
    }

    // Removes outcome badges while preserving the active-running state.
    func clearOutcomeBadge(for threadId: String) {
        readyThreadIDs.remove(threadId)
        failedThreadIDs.remove(threadId)
    }

    // Marks a thread as ready only when the user is not already viewing it.
    func markReadyIfUnread(threadId: String) {
        clearRunningThreadWatch(threadId)
        clearOutcomeBadge(for: threadId)
        guard activeThreadId != threadId else {
            return
        }
        readyThreadIDs.insert(threadId)
    }

    // Marks a thread as failed only when the user is not already viewing it.
    func markFailedIfUnread(threadId: String) {
        clearRunningThreadWatch(threadId)
        clearOutcomeBadge(for: threadId)
        guard activeThreadId != threadId else {
            return
        }
        failedThreadIDs.insert(threadId)
    }

    // Promotes a thread to the post-run sidebar state from an external completion signal.
    func applyRunCompletionBadgeState(threadId: String, result: CodeRoverRunCompletionResult) {
        switch result {
        case .completed:
            markReadyIfUnread(threadId: threadId)
        case .failed:
            markFailedIfUnread(threadId: threadId)
        }
    }

    func hasPendingStructuredUserInputPrompt(threadId: String, turnId: String? = nil) -> Bool {
        let normalizedTurnId = normalizedIdentifier(turnId)
        return messages(for: threadId).contains { message in
            guard message.kind == .userInputPrompt else {
                return false
            }

            if let normalizedTurnId {
                return normalizedIdentifier(message.turnId) == normalizedTurnId
            }

            return true
        }
    }

    // Records the final run outcome so UI can distinguish completed vs interrupted turns.
    func recordTurnTerminalState(
        threadId: String,
        turnId: String?,
        state: CodeRoverTurnTerminalState
    ) {
        latestTurnTerminalStateByThread[threadId] = state
        if let turnId {
            terminalStateByTurnID[turnId] = state
        }
    }

    // Sets the active thread and lazily hydrates old messages from server history.
    func prepareThreadForDisplay(threadId: String) async {
        activeThreadId = threadId
        markThreadAsViewed(threadId)
        updateCurrentOutput(for: threadId)

        guard isConnected else {
            return
        }

        do {
            try await loadThreadHistoryIfNeeded(threadId: threadId)
        } catch {
            if shouldTreatAsThreadNotFound(error) {
                handleMissingThread(threadId)
                return
            }
        }
        guard !Task.isCancelled else { return }

        requestImmediateSync(threadId: threadId)
    }

    // Starts a short-lived watch for a running thread that just went off-screen.
    func watchRunningThreadIfNeeded(_ threadId: String?, ttl: TimeInterval = 30) {
        guard let threadId = normalizedInterruptIdentifier(threadId),
              threadId != activeThreadId,
              threadHasActiveOrRunningTurn(threadId) else {
            return
        }

        runningThreadWatchByID[threadId] = CodeRoverRunningThreadWatch(
            threadId: threadId,
            expiresAt: Date().addingTimeInterval(ttl)
        )
    }

    func clearRunningThreadWatch(_ threadId: String?) {
        guard let threadId = normalizedInterruptIdentifier(threadId) else {
            return
        }
        runningThreadWatchByID.removeValue(forKey: threadId)
    }

    // Keeps a just-left running thread observable for a short time without polling everything.
    func handleDisplayedThreadChange(from previousThreadId: String?, to nextThreadId: String?) {
        let normalizedPrevious = normalizedInterruptIdentifier(previousThreadId)
        let normalizedNext = normalizedInterruptIdentifier(nextThreadId)

        guard normalizedPrevious != normalizedNext else {
            return
        }

        watchRunningThreadIfNeeded(normalizedPrevious)
        clearRunningThreadWatch(normalizedNext)
    }

    // Hydrates the visible transcript using ACP `session/load` replay instead of legacy paging.
    func loadThreadHistoryIfNeeded(threadId: String, forceRefresh: Bool = false) async throws {
        guard isConnected, isInitialized else { return }
        guard !loadingThreadIDs.contains(threadId) else { return }
        guard forceRefresh || !hydratedThreadIDs.contains(threadId) else { return }

        loadingThreadIDs.insert(threadId)
        defer { loadingThreadIDs.remove(threadId) }

        do {
            _ = try await hydrateThreadTranscript(threadId: threadId, forceReload: forceRefresh)
        } catch let error as CodeRoverServiceError {
            if case .rpcError(let rpcError) = error, rpcError.code == -32600 {
                hydratedThreadIDs.insert(threadId)
                return
            }
            throw error
        }

        hydratedThreadIDs.insert(threadId)
        updateCurrentOutput(for: threadId)
    }

    func loadOlderThreadHistoryIfNeeded(threadId: String) async throws {
        _ = threadId
    }

    func scheduleThreadHistoryCatchUp(threadId: String) {
        guard isConnected, isInitialized, activeThreadId == threadId else { return }
        Task { @MainActor [weak self] in
            try? await self?.loadThreadHistoryIfNeeded(threadId: threadId, forceRefresh: true)
        }
    }

    @discardableResult
    func handleRealtimeHistoryEvent(
        threadId: String,
        turnId: String?,
        itemId: String?,
        previousItemId: String?,
        cursor: String?,
        previousCursor: String?
    ) -> Bool {
        _ = turnId
        _ = itemId
        _ = previousItemId
        _ = cursor
        _ = previousCursor
        scheduleThreadHistoryCatchUp(threadId: threadId)
        return false
    }

    func resetTranscriptHydrationState(for threadId: String) {
        let overlayMessages = (messagesByThread[threadId] ?? []).filter { !Self.isCanonicalTimelineMessage($0) }
        let canonicalItemIDs = Set(
            (messagesByThread[threadId] ?? [])
                .filter(Self.isCanonicalTimelineMessage)
                .compactMap(\.itemId)
        )

        for itemId in canonicalItemIDs {
            commandExecutionDetailsByItemID.removeValue(forKey: itemId)
        }

        threadTimelineStateByThread[threadId] = ThreadTimelineState()
        messagesByThread[threadId] = overlayMessages
        streamingAssistantMessageByTurnID = streamingAssistantMessageByTurnID.filter { key, _ in
            !key.hasPrefix("\(threadId)|")
        }
        streamingSystemMessageByItemID = streamingSystemMessageByItemID.filter { key, _ in
            !key.hasPrefix("\(threadId)|item:")
        }
        publishThreadMessagesMutationIfNeeded(for: threadId)
    }

    func extractContextWindowUsage(from usageObject: [String: JSONValue]?) -> ContextWindowUsage? {
        let tokensUsed = firstIntValue(
            in: usageObject,
            keys: ["tokensUsed", "tokens_used", "totalTokens", "total_tokens", "input_tokens"]
        ) ?? 0

        let tokenLimit = firstIntValue(
            in: usageObject,
            keys: ["tokenLimit", "token_limit", "maxTokens", "max_tokens", "contextWindow", "context_window"]
        ) ?? 0

        guard tokenLimit > 0 else { return nil }

        return ContextWindowUsage(
            tokensUsed: tokensUsed,
            tokenLimit: tokenLimit
        )
    }

    // Appends a user message immediately so UI feels instant before server events arrive.
    @discardableResult
    func appendUserMessage(
        threadId: String,
        text: String,
        turnId: String? = nil,
        attachments: [ImageAttachment] = []
    ) -> String {
        let trimmedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedText.isEmpty || !attachments.isEmpty else {
            return ""
        }

        let message = ChatMessage(
            threadId: threadId,
            role: .user,
            text: trimmedText,
            turnId: turnId,
            isStreaming: false,
            deliveryState: .pending,
            attachments: attachments
        )
        appendMessage(message)
        return message.id
    }

    // Appends a system message in the current thread timeline.
    func appendSystemMessage(
        threadId: String,
        text: String,
        turnId: String? = nil,
        itemId: String? = nil,
        kind: ChatMessageKind = .chat,
        isStreaming: Bool = false
    ) {
        let trimmedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedText.isEmpty || isStreaming else {
            return
        }
        let resolvedTurnId = turnId ?? activeTurnIdByThread[threadId]

        if kind == .fileChange,
           let resolvedTurnId, !resolvedTurnId.isEmpty,
           var threadMessages = messagesByThread[threadId] {
            let incomingPathKeys = normalizedFileChangePathKeys(from: trimmedText)
            let isSnapshotPayload = isFileChangeSnapshotPayload(trimmedText)

            var targetIndex: Int?
            if !incomingPathKeys.isEmpty {
                targetIndex = threadMessages.indices.reversed().first(where: { index in
                    let candidate = threadMessages[index]
                    guard candidate.role == .system,
                          candidate.kind == .fileChange,
                          candidate.turnId == resolvedTurnId else {
                        return false
                    }
                    let candidatePathKeys = normalizedFileChangePathKeys(from: candidate.text)
                    return !candidatePathKeys.isDisjoint(with: incomingPathKeys)
                })
            } else if isSnapshotPayload,
                      let existingID = uniqueFileChangeMessageIDForTurn(
                          threadId: threadId,
                          turnId: resolvedTurnId
                      ) {
                targetIndex = threadMessages.firstIndex(where: { $0.id == existingID })
            }

            if targetIndex == nil {
                targetIndex = threadMessages.indices.reversed().first(where: { index in
                    let candidate = threadMessages[index]
                    return candidate.role == .system
                        && candidate.kind == .fileChange
                        && candidate.turnId == resolvedTurnId
                        && candidate.text.trimmingCharacters(in: .whitespacesAndNewlines) == trimmedText
                })
            }

            if let targetIndex {
                let existingText = threadMessages[targetIndex].text
                let nextText: String
                if isSnapshotPayload {
                    nextText = trimmedText
                } else {
                    nextText = mergeAssistantDelta(existingText: existingText, incomingDelta: trimmedText)
                }
                threadMessages[targetIndex].text = nextText
                threadMessages[targetIndex].isStreaming = isStreaming
                threadMessages[targetIndex].turnId = resolvedTurnId
                if threadMessages[targetIndex].itemId == nil {
                    threadMessages[targetIndex].itemId = itemId
                }
                let keepID = threadMessages[targetIndex].id
                pruneDuplicateSystemRows(
                    in: &threadMessages,
                    keepIndex: targetIndex,
                    kind: .fileChange,
                    turnId: resolvedTurnId,
                    fileChangePathKeys: incomingPathKeys
                )
                if let refreshedIndex = threadMessages.indices.first(where: { threadMessages[$0].id == keepID }) {
                    threadMessages[refreshedIndex].orderIndex = MessageOrderCounter.next()
                }
                threadMessages.sort(by: { $0.orderIndex < $1.orderIndex })
                messagesByThread[threadId] = threadMessages
                persistMessages()
                updateCurrentOutput(for: threadId)
                return
            }
        }

        appendMessage(
            ChatMessage(
                threadId: threadId,
                role: .system,
                kind: kind,
                text: trimmedText,
                turnId: resolvedTurnId,
                itemId: itemId,
                isStreaming: isStreaming,
                deliveryState: .confirmed
            )
        )
    }

    // Upserts the inline plan card so streamed deltas and final plan text stay on one row.
    func upsertPlanMessage(
        threadId: String,
        turnId: String?,
        itemId: String?,
        text: String? = nil,
        explanation: String? = nil,
        steps: [CodeRoverPlanStep]? = nil,
        isStreaming: Bool
    ) {
        if let itemId, !itemId.isEmpty {
            upsertStreamingSystemItemMessage(
                threadId: threadId,
                turnId: turnId,
                itemId: itemId,
                kind: .plan,
                text: text ?? "",
                isStreaming: isStreaming
            )
        } else if let turnId, !turnId.isEmpty {
            upsertStreamingSystemTurnMessage(
                threadId: threadId,
                turnId: turnId,
                kind: .plan,
                text: text ?? "",
                isStreaming: isStreaming
            )
        } else {
            appendSystemMessage(
                threadId: threadId,
                text: text ?? "",
                turnId: turnId,
                itemId: itemId,
                kind: .plan,
                isStreaming: isStreaming
            )
        }

        guard let messageIndex = findLatestPlanMessageIndex(
            threadId: threadId,
            turnId: turnId,
            itemId: itemId
        ) else {
            return
        }

        var planState = messagesByThread[threadId]?[messageIndex].planState ?? CodeRoverPlanState()
        if let explanation {
            let trimmedExplanation = explanation.trimmingCharacters(in: .whitespacesAndNewlines)
            planState.explanation = trimmedExplanation.isEmpty ? nil : trimmedExplanation
        }
        if let steps {
            planState.steps = steps
        }
        messagesByThread[threadId]?[messageIndex].planState = planState
        persistMessages()
        updateCurrentOutput(for: threadId)
    }

    // Adds or refreshes an inline structured question card for plan mode clarification requests.
    func upsertStructuredUserInputPrompt(
        threadId: String,
        turnId: String?,
        itemId: String,
        request: CodeRoverStructuredUserInputRequest
    ) {
        let fallbackText = request.questions
            .map { question in
                let header = question.header.trimmingCharacters(in: .whitespacesAndNewlines)
                let prompt = question.question.trimmingCharacters(in: .whitespacesAndNewlines)
                if header.isEmpty {
                    return prompt
                }
                return "\(header)\n\(prompt)"
            }
            .joined(separator: "\n\n")

        if let existingIndex = messagesByThread[threadId]?.indices.reversed().first(where: { index in
            let candidate = messagesByThread[threadId]?[index]
            return candidate?.role == .system
                && candidate?.kind == .userInputPrompt
                && candidate?.structuredUserInputRequest?.requestID == request.requestID
        }) {
            messagesByThread[threadId]?[existingIndex].text = fallbackText
            messagesByThread[threadId]?[existingIndex].turnId = turnId ?? messagesByThread[threadId]?[existingIndex].turnId
            messagesByThread[threadId]?[existingIndex].itemId = itemId
            messagesByThread[threadId]?[existingIndex].structuredUserInputRequest = request
            persistMessages()
            updateCurrentOutput(for: threadId)
            return
        }

        appendMessage(
            ChatMessage(
                threadId: threadId,
                role: .system,
                kind: .userInputPrompt,
                text: fallbackText,
                turnId: turnId,
                itemId: itemId,
                structuredUserInputRequest: request
            )
        )
    }

    // Removes resolved inline prompt cards once the server confirms the request lifecycle ended.
    func removeStructuredUserInputPrompt(requestID: JSONValue, threadIdHint: String? = nil) {
        let threadIDs = threadIdHint.map { [$0] } ?? Array(messagesByThread.keys)
        var didMutate = false

        for threadId in threadIDs {
            guard var threadMessages = messagesByThread[threadId] else {
                continue
            }

            let previousCount = threadMessages.count
            threadMessages.removeAll { message in
                message.kind == .userInputPrompt
                    && message.structuredUserInputRequest?.requestID == requestID
            }

            if threadMessages.count != previousCount {
                messagesByThread[threadId] = threadMessages
                didMutate = true
            }
        }

        guard didMutate else {
            return
        }

        persistMessages()
        if let activeThreadId {
            updateCurrentOutput(for: activeThreadId)
        }
    }

    // Persists a hidden push-reset marker across all threads bound to the same repo.
    func appendHiddenPushResetMarkers(
        threadId: String,
        workingDirectory: String?,
        branch: String,
        remote: String?
    ) {
        let normalizedThreadID = threadId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedThreadID.isEmpty else {
            return
        }

        let normalizedWorkingDirectory = normalizeWorkingDirectoryForPushReset(workingDirectory)
        let relatedThreadIDs: [String]
        if let normalizedWorkingDirectory {
            relatedThreadIDs = threads
                .filter { normalizeWorkingDirectoryForPushReset($0.gitWorkingDirectory) == normalizedWorkingDirectory }
                .map(\.id)
        } else {
            relatedThreadIDs = []
        }

        let targetThreadIDs = Set(relatedThreadIDs + [normalizedThreadID])
        for targetThreadID in targetThreadIDs {
            appendSystemMessage(
                threadId: targetThreadID,
                text: TurnSessionDiffResetMarker.text(branch: branch, remote: remote),
                itemId: TurnSessionDiffResetMarker.manualPushItemID
            )
        }
    }

    // Appends one concise activity line into the active thinking row for a turn.
    func appendThinkingActivityLine(
        threadId: String,
        turnId: String?,
        line: String
    ) {
        let trimmedLine = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedLine.isEmpty else {
            return
        }
        let isTurnActive = isTurnActiveForThinkingActivity(threadId: threadId, turnId: turnId)

        let existingMessages = messagesByThread[threadId] ?? []
        let targetIndex = thinkingActivityTargetIndex(
            in: existingMessages,
            turnId: turnId
        )

        // Late activity lines can arrive after turn/completed without turnId.
        // If there is no existing thinking row to merge into, ignore them instead
        // of creating a new trailing thinking block below the final assistant reply.
        let hasExplicitTurnId = turnId?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
        if !isTurnActive, targetIndex == nil, !hasExplicitTurnId {
            return
        }

        if let targetIndex {
            var threadMessages = existingMessages
            let existingText = threadMessages[targetIndex].text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !containsCaseInsensitiveLine(trimmedLine, in: existingText) else {
                return
            }

            let updatedText = existingText.isEmpty
                ? trimmedLine
                : "\(existingText)\n\(trimmedLine)"
            threadMessages[targetIndex].text = updatedText
            threadMessages[targetIndex].isStreaming = threadMessages[targetIndex].isStreaming || isTurnActive
            if threadMessages[targetIndex].turnId == nil, let turnId, !turnId.isEmpty {
                threadMessages[targetIndex].turnId = turnId
            }
            messagesByThread[threadId] = threadMessages
            persistMessages()
            updateCurrentOutput(for: threadId)
            return
        }

        appendSystemMessage(
            threadId: threadId,
            text: trimmedLine,
            turnId: turnId,
            kind: .thinking,
            isStreaming: isTurnActive
        )
    }

    private func normalizeWorkingDirectoryForPushReset(_ rawValue: String?) -> String? {
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

    // Creates/updates a streaming system item message (thinking/fileChange/commandExecution).
    func upsertStreamingSystemItemMessage(
        threadId: String,
        turnId: String?,
        itemId: String,
        kind: ChatMessageKind,
        text: String,
        isStreaming: Bool
    ) {
        let resolvedTurnId = turnId ?? activeTurnIdByThread[threadId]
        let key = streamingItemMessageKey(threadId: threadId, itemId: itemId)
        let syntheticItemId = resolvedTurnId.map { syntheticStreamingItemId(turnId: $0, kind: kind) }
        let syntheticKey = syntheticItemId.map { streamingItemMessageKey(threadId: threadId, itemId: $0) }
        let incomingFileChangePathKeys = kind == .fileChange
            ? normalizedFileChangePathKeys(from: text)
            : Set<String>()
        let incomingCommandKey = kind == .commandExecution
            ? commandExecutionPreviewKey(from: text)
            : nil
        let messageID: String?
        if let existingMessageID = streamingSystemMessageByItemID[key] {
            messageID = existingMessageID
        } else if let syntheticKey,
                  let migratedMessageID = streamingSystemMessageByItemID[syntheticKey] {
            // Rebind the synthetic turn key to the real item id once the server starts sending it.
            streamingSystemMessageByItemID[key] = migratedMessageID
            streamingSystemMessageByItemID.removeValue(forKey: syntheticKey)
            messageID = migratedMessageID
        } else if kind == .commandExecution,
                  let resolvedTurnId, !resolvedTurnId.isEmpty,
                  let incomingCommandKey,
                  let existingMessageID = messagesByThread[threadId]?.reversed().first(where: { candidate in
                      guard candidate.role == .system,
                            candidate.kind == .commandExecution,
                            candidate.turnId == resolvedTurnId,
                            let candidateKey = commandExecutionPreviewKey(from: candidate.text) else {
                          return false
                      }
                      return candidateKey == incomingCommandKey
                  })?.id {
            streamingSystemMessageByItemID[key] = existingMessageID
            if let syntheticKey {
                streamingSystemMessageByItemID[syntheticKey] = existingMessageID
            }
            messageID = existingMessageID
        } else if kind == .fileChange,
                  let resolvedTurnId, !resolvedTurnId.isEmpty,
                  !incomingFileChangePathKeys.isEmpty,
                  let existingMessageID = messagesByThread[threadId]?.reversed().first(where: { candidate in
                      guard candidate.role == .system,
                            candidate.kind == .fileChange,
                            candidate.turnId == resolvedTurnId else {
                          return false
                      }
                      let candidateKeys = normalizedFileChangePathKeys(from: candidate.text)
                      return !candidateKeys.isDisjoint(with: incomingFileChangePathKeys)
                  })?.id {
            // Some runtimes emit multiple file-change item ids for the same file in one turn.
            // Rebind them to one UI row keyed by path to avoid duplicate "Edited/Diff/Push" cards.
            streamingSystemMessageByItemID[key] = existingMessageID
            if let syntheticKey {
                streamingSystemMessageByItemID[syntheticKey] = existingMessageID
            }
            messageID = existingMessageID
        } else if kind == .fileChange,
                  let resolvedTurnId, !resolvedTurnId.isEmpty,
                  incomingFileChangePathKeys.isEmpty,
                  isFileChangeSnapshotPayload(text),
                  let existingMessageID = uniqueFileChangeMessageIDForTurn(
                      threadId: threadId,
                      turnId: resolvedTurnId
                  ) {
            // Fallback: if payload has no extractable path and there's only one file-change row
            // in this turn, treat it as the same row instead of creating duplicates.
            streamingSystemMessageByItemID[key] = existingMessageID
            if let syntheticKey {
                streamingSystemMessageByItemID[syntheticKey] = existingMessageID
            }
            messageID = existingMessageID
        } else {
            messageID = nil
        }

        if let messageID,
           let index = findMessageIndex(threadId: threadId, messageId: messageID) {
            let incoming = text
            let incomingTrimmed = incoming.trimmingCharacters(in: .whitespacesAndNewlines)
            if !incomingTrimmed.isEmpty {
                let existing = messagesByThread[threadId]?[index].text ?? ""
                let existingTrimmed = existing.trimmingCharacters(in: .whitespacesAndNewlines)
                if kind == .commandExecution {
                    // Command status rows are snapshots ("running" -> "completed"), not deltas.
                    messagesByThread[threadId]?[index].text = incomingTrimmed
                } else {
                    let isFileChangeSnapshot = kind == .fileChange
                        && isFileChangeSnapshotPayload(incomingTrimmed)
                    if isStreamingPlaceholder(incomingTrimmed, for: kind)
                        && !existingTrimmed.isEmpty
                        && !isStreamingPlaceholder(existingTrimmed, for: kind) {
                        // Ignore completion placeholders when we already have real streamed content.
                    } else if isStreamingPlaceholder(existingTrimmed, for: kind) {
                        // Replace placeholder labels ("Thinking...") with real content.
                        messagesByThread[threadId]?[index].text = incoming
                    } else if !isStreaming || isFileChangeSnapshot {
                        // Completed item payloads are authoritative snapshots; replace streamed deltas.
                        messagesByThread[threadId]?[index].text = incoming
                    } else {
                        let merged = mergeAssistantDelta(existingText: existing, incomingDelta: incoming)
                        messagesByThread[threadId]?[index].text = merged
                    }
                }
            }

            messagesByThread[threadId]?[index].kind = kind
            messagesByThread[threadId]?[index].isStreaming = isStreaming
            if let resolvedTurnId, messagesByThread[threadId]?[index].turnId == nil {
                messagesByThread[threadId]?[index].turnId = resolvedTurnId
            }
            if let syntheticItemId,
               messagesByThread[threadId]?[index].itemId == syntheticItemId {
                messagesByThread[threadId]?[index].itemId = itemId
            } else if messagesByThread[threadId]?[index].itemId == nil {
                messagesByThread[threadId]?[index].itemId = itemId
            }
            if var threadMessages = messagesByThread[threadId],
               let refreshedIndex = threadMessages.indices.first(where: { threadMessages[$0].id == messageID }) {
                let keepID = threadMessages[refreshedIndex].id
                if let resolvedTurnId {
                    if kind == .fileChange {
                        pruneDuplicateSystemRows(
                            in: &threadMessages,
                            keepIndex: refreshedIndex,
                            kind: .fileChange,
                            turnId: resolvedTurnId,
                            fileChangePathKeys: incomingFileChangePathKeys
                        )
                    } else if kind == .commandExecution,
                              let incomingCommandKey {
                        pruneDuplicateSystemRows(
                            in: &threadMessages,
                            keepIndex: refreshedIndex,
                            kind: .commandExecution,
                            turnId: resolvedTurnId,
                            commandKey: incomingCommandKey
                        )
                    }
                }
                if let finalIndex = threadMessages.indices.first(where: { threadMessages[$0].id == keepID }) {
                    threadMessages[finalIndex].orderIndex = MessageOrderCounter.next()
                }
                threadMessages.sort(by: { $0.orderIndex < $1.orderIndex })
                messagesByThread[threadId] = threadMessages
            }
            persistMessages()
            updateCurrentOutput(for: threadId)
            return
        }

        let initialText = text
        let initialTrimmed = initialText.trimmingCharacters(in: .whitespacesAndNewlines)
        let fallbackText: String
        if !initialTrimmed.isEmpty {
            fallbackText = initialText
        } else {
            fallbackText = streamingPlaceholderText(for: kind)
        }

        let message = ChatMessage(
            id: itemId,
            threadId: threadId,
            role: .system,
            kind: kind,
            text: fallbackText,
            turnId: resolvedTurnId,
            itemId: itemId,
            isStreaming: isStreaming,
            deliveryState: .confirmed
        )

        streamingSystemMessageByItemID[key] = message.id
        appendMessage(message)
    }

    private func normalizedFileChangePathKeys(from text: String) -> Set<String> {
        let inlineTotalsRegex = try? NSRegularExpression(
            pattern: #"\s*[+\u{FF0B}]\s*\d+\s*[-\u{2212}\u{2013}\u{2014}\u{FE63}\u{FF0D}]\s*\d+\s*$"#
        )
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var keys: Set<String> = []

        for line in lines {
            var trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { continue }
            if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") || trimmed.hasPrefix("• ") {
                trimmed = String(trimmed.dropFirst(2)).trimmingCharacters(in: .whitespacesAndNewlines)
            }

            if trimmed.lowercased().hasPrefix("path:") {
                let rawPath = trimmed.dropFirst("Path:".count).trimmingCharacters(in: .whitespacesAndNewlines)
                keys.formUnion(normalizedFileChangePathAliases(from: rawPath))
                continue
            }

            if trimmed.hasPrefix("+++ ") || trimmed.hasPrefix("--- ") {
                let rawPath = String(trimmed.dropFirst(4)).trimmingCharacters(in: .whitespacesAndNewlines)
                keys.formUnion(normalizedFileChangePathAliases(from: rawPath))
                continue
            }

            if trimmed.hasPrefix("diff --git ") {
                let components = trimmed.split(separator: " ", omittingEmptySubsequences: true)
                if components.count >= 4 {
                    keys.formUnion(normalizedFileChangePathAliases(from: String(components[3])))
                }
                continue
            }

            let lowercased = trimmed.lowercased()
            let actionVerbs = [
                "edited ",
                "updated ",
                "added ",
                "created ",
                "deleted ",
                "removed ",
                "renamed ",
                "moved ",
            ]
            if let verb = actionVerbs.first(where: { lowercased.hasPrefix($0) }) {
                var rawPath = String(trimmed.dropFirst(verb.count))
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if let inlineTotalsRegex {
                    let range = NSRange(location: 0, length: (rawPath as NSString).length)
                    rawPath = inlineTotalsRegex.stringByReplacingMatches(
                        in: rawPath,
                        range: range,
                        withTemplate: ""
                    ).trimmingCharacters(in: .whitespacesAndNewlines)
                }
                keys.formUnion(normalizedFileChangePathAliases(from: rawPath))
            }
        }

        return keys
    }

    private func normalizedFileChangePathAliases(from rawPath: String) -> Set<String> {
        guard let normalized = normalizeFileChangePathKey(rawPath) else {
            return Set<String>()
        }

        var aliases: Set<String> = [normalized]
        let components = normalized.split(separator: "/", omittingEmptySubsequences: true)
        if let workspaceIndex = components.firstIndex(where: { $0 == "workspace" }),
           components.count > workspaceIndex + 2 {
            let relative = components[(workspaceIndex + 2)...].joined(separator: "/")
            if !relative.isEmpty {
                aliases.insert(relative)
            }
        }
        return aliases
    }

    private func normalizeFileChangePathKey(_ rawPath: String) -> String? {
        var normalized = rawPath.trimmingCharacters(in: .whitespacesAndNewlines)
        if normalized.isEmpty { return nil }
        if normalized == "/dev/null" { return nil }

        normalized = normalized.replacingOccurrences(of: "`", with: "")
        normalized = normalized.replacingOccurrences(of: "\"", with: "")
        normalized = normalized.replacingOccurrences(of: "'", with: "")
        if normalized.hasPrefix("("), normalized.hasSuffix(")"), normalized.count > 2 {
            normalized = String(normalized.dropFirst().dropLast())
        }

        if normalized.hasPrefix("a/") || normalized.hasPrefix("b/") {
            normalized = String(normalized.dropFirst(2))
        }
        if normalized.hasPrefix("./") {
            normalized = String(normalized.dropFirst(2))
        }
        if let range = normalized.range(
            of: #":\d+(?::\d+)?$"#,
            options: .regularExpression
        ) {
            normalized.removeSubrange(range)
        }

        while let last = normalized.last, ",.;".contains(last) {
            normalized.removeLast()
        }

        normalized = normalized.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return nil }
        return normalized.lowercased()
    }

    private func commandExecutionPreviewKey(from text: String) -> String? {
        let tokens = text.split(whereSeparator: \.isWhitespace).map(String.init)
        guard tokens.count >= 2 else {
            return nil
        }
        let phase = tokens[0].lowercased()
        guard phase == "running"
            || phase == "completed"
            || phase == "failed"
            || phase == "stopped" else {
            return nil
        }
        let command = tokens.dropFirst().joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        return command.isEmpty ? nil : command
    }

    private func isFileChangeSnapshotPayload(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }

        let lowered = trimmed.lowercased()
        if lowered.hasPrefix("status:") {
            return true
        }

        let lines = trimmed.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var hasPath = false
        var hasKind = false
        var hasTotals = false
        var hasDiffFence = false
        var hasDiffHeader = false

        for line in lines {
            let candidate = line.trimmingCharacters(in: .whitespacesAndNewlines)
            let lower = candidate.lowercased()
            if lower.hasPrefix("path:") { hasPath = true }
            if lower.hasPrefix("kind:") { hasKind = true }
            if lower.hasPrefix("totals:") { hasTotals = true }
            if candidate.hasPrefix("```diff") || candidate == "```" { hasDiffFence = true }
            if candidate.hasPrefix("diff --git ")
                || candidate.hasPrefix("+++ ")
                || candidate.hasPrefix("--- ")
                || candidate.hasPrefix("@@ ") {
                hasDiffHeader = true
            }
        }

        if hasPath && hasKind {
            return true
        }
        if hasPath && (hasTotals || hasDiffFence || hasDiffHeader) {
            return true
        }
        if hasDiffFence && hasDiffHeader {
            return true
        }

        return false
    }

    private func uniqueFileChangeMessageIDForTurn(threadId: String, turnId: String) -> String? {
        let candidates = (messagesByThread[threadId] ?? []).filter { candidate in
            candidate.role == .system
                && candidate.kind == .fileChange
                && candidate.turnId == turnId
        }
        guard candidates.count == 1 else {
            return nil
        }
        return candidates[0].id
    }

    private func pruneDuplicateSystemRows(
        in threadMessages: inout [ChatMessage],
        keepIndex: Int,
        kind: ChatMessageKind,
        turnId: String,
        fileChangePathKeys: Set<String> = Set<String>(),
        commandKey: String? = nil
    ) {
        guard threadMessages.indices.contains(keepIndex) else { return }
        let keepID = threadMessages[keepIndex].id
        let keepText = threadMessages[keepIndex].text.trimmingCharacters(in: .whitespacesAndNewlines)

        threadMessages.removeAll { candidate in
            guard candidate.id != keepID,
                  candidate.role == .system,
                  candidate.kind == kind,
                  candidate.turnId == turnId else {
                return false
            }

            if kind == .fileChange {
                if !fileChangePathKeys.isEmpty {
                    let candidateKeys = normalizedFileChangePathKeys(from: candidate.text)
                    return !candidateKeys.isDisjoint(with: fileChangePathKeys)
                }
                return candidate.text.trimmingCharacters(in: .whitespacesAndNewlines) == keepText
            }

            if kind == .commandExecution, let commandKey {
                return commandExecutionPreviewKey(from: candidate.text) == commandKey
            }

            return false
        }
    }

    // Appends deltas to an existing system item message.
    func appendStreamingSystemItemDelta(
        threadId: String,
        turnId: String?,
        itemId: String,
        kind: ChatMessageKind,
        delta: String
    ) {
        // Preserve token-leading spaces from server deltas (for example Markdown words split by stream).
        guard !delta.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return
        }

        upsertStreamingSystemItemMessage(
            threadId: threadId,
            turnId: turnId,
            itemId: itemId,
            kind: kind,
            text: delta,
            isStreaming: true
        )
    }

    // Merges a late reasoning delta into an existing thinking row without reopening streaming state.
    // Returns true when a matching row was found and updated.
    func mergeLateReasoningDeltaIfPossible(
        threadId: String,
        turnId: String?,
        itemId: String?,
        delta: String
    ) -> Bool {
        let trimmedDelta = delta.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedDelta.isEmpty,
              var threadMessages = messagesByThread[threadId] else {
            return false
        }

        let normalizedTurnId = turnId?.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedItemId = itemId?.trimmingCharacters(in: .whitespacesAndNewlines)

        let targetIndex: Int? = {
            if let normalizedItemId, !normalizedItemId.isEmpty {
                if let index = threadMessages.indices.reversed().first(where: { index in
                    let candidate = threadMessages[index]
                    return candidate.role == .system
                        && candidate.kind == .thinking
                        && candidate.itemId == normalizedItemId
                }) {
                    return index
                }
            }

            if let normalizedTurnId, !normalizedTurnId.isEmpty {
                return threadMessages.indices.reversed().first(where: { index in
                    let candidate = threadMessages[index]
                    return candidate.role == .system
                        && candidate.kind == .thinking
                        && candidate.turnId == normalizedTurnId
                })
            }

            return nil
        }()

        guard let targetIndex else {
            return false
        }

        let existingText = threadMessages[targetIndex].text
        threadMessages[targetIndex].text = mergeAssistantDelta(
            existingText: existingText,
            incomingDelta: delta
        )
        threadMessages[targetIndex].isStreaming = false
        if threadMessages[targetIndex].turnId == nil,
           let normalizedTurnId, !normalizedTurnId.isEmpty {
            threadMessages[targetIndex].turnId = normalizedTurnId
        }
        if threadMessages[targetIndex].itemId == nil,
           let normalizedItemId, !normalizedItemId.isEmpty {
            threadMessages[targetIndex].itemId = normalizedItemId
        }

        messagesByThread[threadId] = threadMessages
        persistMessages()
        updateCurrentOutput(for: threadId)
        return true
    }

    // Uses a stable synthetic item id when server deltas miss itemId.
    func appendStreamingSystemTurnDelta(
        threadId: String,
        turnId: String,
        kind: ChatMessageKind,
        delta: String
    ) {
        appendStreamingSystemItemDelta(
            threadId: threadId,
            turnId: turnId,
            itemId: syntheticStreamingItemId(turnId: turnId, kind: kind),
            kind: kind,
            delta: delta
        )
    }

    // Upserts synthetic turn-based stream entries when no itemId exists.
    func upsertStreamingSystemTurnMessage(
        threadId: String,
        turnId: String,
        kind: ChatMessageKind,
        text: String,
        isStreaming: Bool
    ) {
        upsertStreamingSystemItemMessage(
            threadId: threadId,
            turnId: turnId,
            itemId: syntheticStreamingItemId(turnId: turnId, kind: kind),
            kind: kind,
            text: text,
            isStreaming: isStreaming
        )
    }

    // Finalizes a system item message when the item completes.
    func completeStreamingSystemItemMessage(
        threadId: String,
        turnId: String?,
        itemId: String,
        kind: ChatMessageKind,
        text: String?
    ) {
        let key = streamingItemMessageKey(threadId: threadId, itemId: itemId)
        upsertStreamingSystemItemMessage(
            threadId: threadId,
            turnId: turnId,
            itemId: itemId,
            kind: kind,
            text: text ?? "",
            isStreaming: false
        )

        if let messageID = streamingSystemMessageByItemID[key],
           let index = findMessageIndex(threadId: threadId, messageId: messageID) {
            messagesByThread[threadId]?[index].isStreaming = false
            messagesByThread[threadId]?[index].kind = kind
            persistMessages()
            updateCurrentOutput(for: threadId)
        }

        streamingSystemMessageByItemID.removeValue(forKey: key)
    }

    // Completes synthetic turn-based stream entries when no itemId exists.
    func completeStreamingSystemTurnMessage(
        threadId: String,
        turnId: String,
        kind: ChatMessageKind,
        text: String?
    ) {
        completeStreamingSystemItemMessage(
            threadId: threadId,
            turnId: turnId,
            itemId: syntheticStreamingItemId(turnId: turnId, kind: kind),
            kind: kind,
            text: text
        )
    }

    // Creates a streaming assistant placeholder for a turn/item if missing.
    func beginAssistantMessage(threadId: String, turnId: String, itemId: String? = nil) {
        let turnStreamingKey = streamingMessageKey(threadId: threadId, turnId: turnId)
        let normalizedItemId = normalizedStreamingItemID(itemId)
        let itemStreamingKey = normalizedItemId.map {
            assistantStreamingMessageKey(threadId: threadId, turnId: turnId, itemId: $0)
        }

        if let itemStreamingKey,
           let messageID = streamingAssistantMessageByTurnID[itemStreamingKey],
           findMessageIndex(threadId: threadId, messageId: messageID) != nil {
            streamingAssistantMessageByTurnID[turnStreamingKey] = messageID
            return
        }

        if let messageID = streamingAssistantMessageByTurnID[turnStreamingKey],
           let messageIndex = findMessageIndex(threadId: threadId, messageId: messageID) {
            if let normalizedItemId {
                let existingItemId = normalizedStreamingItemID(messagesByThread[threadId]?[messageIndex].itemId)
                if existingItemId == nil {
                    messagesByThread[threadId]?[messageIndex].itemId = normalizedItemId
                    if let itemStreamingKey {
                        streamingAssistantMessageByTurnID[itemStreamingKey] = messageID
                    }
                    persistMessages()
                    updateCurrentOutput(for: threadId)
                    return
                }
                if existingItemId == normalizedItemId {
                    if let itemStreamingKey {
                        streamingAssistantMessageByTurnID[itemStreamingKey] = messageID
                    }
                    return
                }

                // New assistant item started inside the same turn: preserve the previous bubble.
                messagesByThread[threadId]?[messageIndex].isStreaming = false
                streamingAssistantMessageByTurnID.removeValue(forKey: turnStreamingKey)
                persistMessages()
                updateCurrentOutput(for: threadId)
            } else {
                return
            }
        } else {
            streamingAssistantMessageByTurnID.removeValue(forKey: turnStreamingKey)
        }

        let message = ChatMessage(
            id: normalizedItemId ?? UUID().uuidString,
            threadId: threadId,
            role: .assistant,
            text: "",
            turnId: turnId,
            itemId: normalizedItemId,
            isStreaming: true
        )

        threadIdByTurnID[turnId] = threadId
        streamingAssistantMessageByTurnID[turnStreamingKey] = message.id
        if let itemStreamingKey {
            streamingAssistantMessageByTurnID[itemStreamingKey] = message.id
        }
        appendMessage(message)
    }

    // Streams assistant delta chunks into the message linked to a turn.
    func appendAssistantDelta(threadId: String, turnId: String, itemId: String?, delta: String) {
        guard !delta.isEmpty else {
            return
        }

        let messageID = ensureStreamingAssistantMessage(threadId: threadId, turnId: turnId, itemId: itemId)
        guard let messageID,
              let messageIndex = findMessageIndex(threadId: threadId, messageId: messageID) else {
            return
        }

        let currentText = messagesByThread[threadId]?[messageIndex].text ?? ""
        messagesByThread[threadId]?[messageIndex].text = mergeAssistantDelta(
            existingText: currentText,
            incomingDelta: delta
        )
        messagesByThread[threadId]?[messageIndex].isStreaming = true
        if messagesByThread[threadId]?[messageIndex].itemId == nil, let itemId {
            messagesByThread[threadId]?[messageIndex].itemId = itemId
        }

        persistMessages()
        updateCurrentOutput(for: threadId)
    }

    // Finalizes assistant text when item/completed carries the canonical message body.
    func completeAssistantMessage(threadId: String, turnId: String?, itemId: String?, text: String) {
        let trimmedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedText.isEmpty else {
            return
        }

        let resolvedTurnId = turnId ?? activeTurnIdByThread[threadId]
        let now = Date()
        var resolvedAssistantMessageId: String?

        if resolvedTurnId == nil, itemId == nil,
           let fingerprint = assistantCompletionFingerprintByThread[threadId],
           fingerprint.text == trimmedText,
           now.timeIntervalSince(fingerprint.timestamp) <= 45 {
            return
        }

        if let resolvedTurnId,
           let messageID = ensureStreamingAssistantMessage(threadId: threadId, turnId: resolvedTurnId, itemId: itemId),
           let messageIndex = findMessageIndex(threadId: threadId, messageId: messageID) {
            let existingText = messagesByThread[threadId]?[messageIndex].text ?? ""

            if existingText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                messagesByThread[threadId]?[messageIndex].text = trimmedText
            } else if existingText != trimmedText {
                messagesByThread[threadId]?[messageIndex].text = trimmedText
            }

            messagesByThread[threadId]?[messageIndex].isStreaming = false
            if messagesByThread[threadId]?[messageIndex].itemId == nil, let itemId {
                messagesByThread[threadId]?[messageIndex].itemId = itemId
            }
            if messagesByThread[threadId]?[messageIndex].turnId == nil {
                messagesByThread[threadId]?[messageIndex].turnId = resolvedTurnId
            }
            resolvedAssistantMessageId = messagesByThread[threadId]?[messageIndex].id
        } else {
            if let itemId,
               let existingItemIndex = messagesByThread[threadId]?.lastIndex(where: { candidate in
                   candidate.role == .assistant && candidate.itemId == itemId
               }) {
                messagesByThread[threadId]?[existingItemIndex].text = trimmedText
                messagesByThread[threadId]?[existingItemIndex].isStreaming = false
                if messagesByThread[threadId]?[existingItemIndex].turnId == nil {
                    messagesByThread[threadId]?[existingItemIndex].turnId = resolvedTurnId
                }
                resolvedAssistantMessageId = messagesByThread[threadId]?[existingItemIndex].id
            } else if let duplicateIndex = messagesByThread[threadId]?.lastIndex(where: { candidate in
                candidate.role == .assistant
                    && Self.normalizedMessageText(candidate.text) == trimmedText
                    && (
                        candidate.isStreaming
                            || (resolvedTurnId != nil && candidate.turnId == resolvedTurnId)
                            || (itemId != nil && candidate.itemId == itemId)
                    )
            }) {
                // Drop duplicated completion payloads that carry the same final assistant text.
                messagesByThread[threadId]?[duplicateIndex].isStreaming = false
                if messagesByThread[threadId]?[duplicateIndex].itemId == nil, let itemId {
                    messagesByThread[threadId]?[duplicateIndex].itemId = itemId
                }
                if messagesByThread[threadId]?[duplicateIndex].turnId == nil {
                    messagesByThread[threadId]?[duplicateIndex].turnId = resolvedTurnId
                }
                resolvedAssistantMessageId = messagesByThread[threadId]?[duplicateIndex].id
            } else {
                let newMessage = ChatMessage(
                    id: itemId ?? UUID().uuidString,
                    threadId: threadId,
                    role: .assistant,
                    text: trimmedText,
                    turnId: resolvedTurnId,
                    itemId: itemId,
                    isStreaming: false,
                    deliveryState: .confirmed
                )
                appendMessage(newMessage)
                resolvedAssistantMessageId = newMessage.id
            }
        }

        assistantCompletionFingerprintByThread[threadId] = (text: trimmedText, timestamp: now)

        persistMessages()
        if let resolvedAssistantMessageId {
            noteAssistantMessage(
                threadId: threadId,
                turnId: resolvedTurnId,
                assistantMessageId: resolvedAssistantMessageId
            )
        }
        updateCurrentOutput(for: threadId)
    }

    func markMessageDeliveryState(
        threadId: String,
        messageId: String,
        state: ChatMessageDeliveryState,
        turnId: String? = nil
    ) {
        guard !messageId.isEmpty,
              let messageIndex = findMessageIndex(threadId: threadId, messageId: messageId) else {
            return
        }

        messagesByThread[threadId]?[messageIndex].deliveryState = state
        if let turnId, messagesByThread[threadId]?[messageIndex].turnId == nil {
            messagesByThread[threadId]?[messageIndex].turnId = turnId
        }
        persistMessages()
        updateCurrentOutput(for: threadId)
    }

    func confirmLatestPendingUserMessage(threadId: String, turnId: String) {
        guard !turnId.isEmpty,
              var threadMessages = messagesByThread[threadId] else {
            return
        }

        guard let index = threadMessages.indices.reversed().first(where: { idx in
            let candidate = threadMessages[idx]
            return candidate.role == .user
                && candidate.deliveryState == .pending
                && (candidate.turnId == nil || candidate.turnId == turnId)
        }) else {
            return
        }

        threadMessages[index].deliveryState = .confirmed
        threadMessages[index].turnId = turnId
        messagesByThread[threadId] = threadMessages
        persistMessages()
        updateCurrentOutput(for: threadId)
    }

    func removeLatestFailedUserMessage(
        threadId: String,
        matchingText: String,
        matchingAttachments: [ImageAttachment] = []
    ) {
        let normalizedText = matchingText.trimmingCharacters(in: .whitespacesAndNewlines)
        let matchingAttachmentSignature = matchingAttachments
            .map { $0.payloadDataURL ?? $0.sourceURL ?? $0.thumbnailBase64JPEG }
            .joined(separator: "|")

        guard (!normalizedText.isEmpty || !matchingAttachmentSignature.isEmpty),
              var threadMessages = messagesByThread[threadId] else {
            return
        }

        guard let index = threadMessages.indices.reversed().first(where: { index in
            let message = threadMessages[index]
            let messageAttachmentSignature = message.attachments
                .map { $0.payloadDataURL ?? $0.sourceURL ?? $0.thumbnailBase64JPEG }
                .joined(separator: "|")
            let matchesText = normalizedText.isEmpty
                || message.text.trimmingCharacters(in: .whitespacesAndNewlines) == normalizedText
            let matchesAttachments = matchingAttachmentSignature.isEmpty
                || messageAttachmentSignature == matchingAttachmentSignature
            return message.role == .user
                && message.deliveryState == .failed
                && matchesText
                && matchesAttachments
        }) else {
            return
        }

        threadMessages.remove(at: index)
        messagesByThread[threadId] = threadMessages
        persistMessages()
        updateCurrentOutput(for: threadId)
    }

    // Marks streaming assistant state complete once turn/completed arrives.
    func markTurnCompleted(threadId: String, turnId: String?) {
        runningThreadIDs.remove(threadId)
        protectedRunningFallbackThreadIDs.remove(threadId)
        endForegroundAggressivePolling(threadId: threadId)
        clearRunningThreadWatch(threadId)
        let resolvedTurnId = turnId ?? activeTurnIdByThread[threadId]
        if let normalizedTurnId = normalizedIdentifier(resolvedTurnId),
           pendingRealtimeSeededTurnIDByThread[threadId] == normalizedTurnId {
            pendingRealtimeSeededTurnIDByThread.removeValue(forKey: threadId)
        } else if resolvedTurnId == nil {
            pendingRealtimeSeededTurnIDByThread.removeValue(forKey: threadId)
        }

        if let resolvedTurnId {
            let turnStreamingKey = streamingMessageKey(threadId: threadId, turnId: resolvedTurnId)
            let itemStreamingPrefix = "\(turnStreamingKey)|item:"
            let keysToClear = streamingAssistantMessageByTurnID.keys.filter { key in
                key == turnStreamingKey || key.hasPrefix(itemStreamingPrefix)
            }

            var closedMessageIDs: Set<String> = []
            for key in keysToClear {
                guard let messageID = streamingAssistantMessageByTurnID.removeValue(forKey: key) else {
                    continue
                }
                guard closedMessageIDs.insert(messageID).inserted else {
                    continue
                }
                if let messageIndex = findMessageIndex(threadId: threadId, messageId: messageID) {
                    messagesByThread[threadId]?[messageIndex].isStreaming = false
                }
            }
        }

        if let resolvedTurnId,
           activeTurnIdByThread[threadId] == resolvedTurnId {
            activeTurnIdByThread[threadId] = nil
        } else if resolvedTurnId == nil {
            activeTurnIdByThread[threadId] = nil
        }

        if let resolvedTurnId,
           activeTurnId == resolvedTurnId {
            activeTurnId = nil
        }

        updateBackgroundRunGraceTask()

        // Some servers never emit explicit item/completed for reasoning/fileChange.
        // Close both turn-bound and orphan system stream rows, but keep reasoning content visible.
        if var threadMessages = messagesByThread[threadId] {
            if finalizeMessagesForCompletedTurn(&threadMessages, resolvedTurnId: resolvedTurnId) {
                messagesByThread[threadId] = threadMessages
            }
        }

        if var timelineState = threadTimelineStateByThread[threadId] {
            var canonicalMessages = timelineState.renderedMessages()
            if finalizeMessagesForCompletedTurn(&canonicalMessages, resolvedTurnId: resolvedTurnId) {
                timelineState.replaceAll(with: canonicalMessages)
                threadTimelineStateByThread[threadId] = timelineState
                messagesByThread[threadId] = Self.mergeRenderedTimelineMessages(
                    timelineState.renderedMessages(),
                    overlayMessages: (messagesByThread[threadId] ?? []).filter { !Self.isCanonicalTimelineMessage($0) }
                )
            }
        }

        streamingSystemMessageByItemID = streamingSystemMessageByItemID.filter { _, messageId in
            guard let index = findMessageIndex(threadId: threadId, messageId: messageId),
                  let message = messagesByThread[threadId]?[index] else {
                return false
            }
            guard message.role == .system else {
                return true
            }
            if message.kind == .thinking {
                return false
            }
            if let resolvedTurnId {
                return message.turnId != resolvedTurnId
            }
            return !message.isStreaming
        }

        // Keep turn->thread mapping after completion to support late-arriving
        // notifications (e.g. turn/diff/updated emitted right after turn/completed).
        persistMessages()
        updateCurrentOutput(for: threadId)
    }

    // Converts all pending streaming bubbles to completed state after transport failures.
    func finalizeAllStreamingState() {
        var didMutate = false

        for threadId in messagesByThread.keys {
            guard var threadMessages = messagesByThread[threadId] else { continue }

            var localChanged = false
            for index in threadMessages.indices where threadMessages[index].isStreaming {
                threadMessages[index].isStreaming = false
                localChanged = true
            }

            if localChanged {
                messagesByThread[threadId] = threadMessages
                didMutate = true
            }
        }

        activeTurnId = nil
        activeTurnIdByThread.removeAll()
        runningThreadIDs.removeAll()
        protectedRunningFallbackThreadIDs.removeAll()
        pendingRealtimeSeededTurnIDByThread.removeAll()
        foregroundAggressivePollingDeadlineByThread.removeAll()
        streamingAssistantMessageByTurnID.removeAll()
        streamingSystemMessageByItemID.removeAll()
        threadIdByTurnID.removeAll()

        if didMutate {
            messagePersistence.save(messagesByThread: messagesByThread)
            if let activeThreadId {
                updateCurrentOutput(for: activeThreadId)
            }
        }
    }

    func effectiveStreamingState(threadId: String, turnId: String?, requestedStreaming: Bool) -> Bool {
        guard requestedStreaming else {
            return false
        }

        if turnTerminalState(for: turnId) != nil {
            return false
        }

        if normalizedIdentifier(turnId) == nil,
           activeTurnIdByThread[threadId] == nil,
           latestTurnTerminalState(for: threadId) != nil {
            return false
        }

        return true
    }

    private func finalizeMessagesForCompletedTurn(_ messages: inout [ChatMessage], resolvedTurnId: String?) -> Bool {
        var didMutate = false

        for index in messages.indices where messages[index].isStreaming {
            guard messageBelongsToCompletedTurn(messages[index], resolvedTurnId: resolvedTurnId) else {
                continue
            }
            messages[index].isStreaming = false
            didMutate = true
        }

        let priorCount = messages.count
        if let resolvedTurnId {
            messages.removeAll {
                $0.role == .system
                    && $0.kind == .thinking
                    && ($0.turnId == resolvedTurnId || $0.turnId == nil)
                    && shouldPruneThinkingRowAfterTurnCompletion($0)
            }
        } else {
            messages.removeAll {
                $0.role == .system
                    && $0.kind == .thinking
                    && shouldPruneThinkingRowAfterTurnCompletion($0)
            }
        }

        return didMutate || messages.count != priorCount
    }

    private func messageBelongsToCompletedTurn(_ message: ChatMessage, resolvedTurnId: String?) -> Bool {
        if let resolvedTurnId {
            if message.turnId == resolvedTurnId {
                return true
            }
            return message.role != .user && message.turnId == nil
        }

        return message.role != .user
    }
}

extension CodeRoverService {
    func persistMessages() {
        let snapshot = messagesByThread
        messagePersistenceDebounceTask?.cancel()
        messagePersistenceDebounceTask = Task.detached { [messagePersistence] in
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard !Task.isCancelled else { return }
            messagePersistence.save(messagesByThread: snapshot)
        }
    }
}

// ─── Private helpers ──────────────────────────────────────────

extension CodeRoverService {
    func messagePublicationSignature(for threadId: String) -> Int {
        var hasher = Hasher()
        hasher.combine(threadId)
        hasher.combine(messagesByThread[threadId] ?? [])
        return hasher.finalize()
    }

    func publishThreadMessagesMutationIfNeeded(for threadId: String) {
        let signature = messagePublicationSignature(for: threadId)
        let didChange = lastPublishedMessageSignatureByThread[threadId] != signature
        publishThreadMessagesMutation(for: threadId)
        guard didChange else {
            return
        }

        lastPublishedMessageSignatureByThread[threadId] = signature
        noteMessagesChanged(for: threadId)
    }

    // Reassigns one thread timeline back through the top-level dictionary so Observation
    // reliably publishes in-place element edits (for example streaming text deltas).
    func publishThreadMessagesMutation(for threadId: String) {
        guard let threadMessages = messagesByThread[threadId] else {
            return
        }

        var nextMessagesByThread = messagesByThread
        nextMessagesByThread[threadId] = Array(threadMessages)
        messagesByThread = nextMessagesByThread
    }

    // Bumps a thread-local revision whenever its message timeline changes.
    func noteMessagesChanged(for threadId: String) {
        var nextRevisions = messageRevisionByThread
        nextRevisions[threadId, default: 0] &+= 1
        messageRevisionByThread = nextRevisions

        coderoverDiagnosticLog(
            "CodeRoverMessages",
            "noteMessagesChanged thread=\(threadId) revision=\(nextRevisions[threadId] ?? 0)"
        )
    }

    // Late activity notifications can arrive after turn/completed.
    // Keep thinking rows in streaming mode only while the turn is still active.
    func isTurnActiveForThinkingActivity(threadId: String, turnId: String?) -> Bool {
        if let turnId, !turnId.isEmpty {
            if activeTurnIdByThread[threadId] == turnId {
                return true
            }
            return activeTurnIdByThread[threadId] == nil && runningThreadIDs.contains(threadId)
        }
        return activeTurnIdByThread[threadId] != nil || runningThreadIDs.contains(threadId)
    }

    func thinkingActivityTargetIndex(in messages: [ChatMessage], turnId: String?) -> Int? {
        messages.indices.reversed().first { index in
            let candidate = messages[index]
            guard candidate.role == .system, candidate.kind == .thinking else {
                return false
            }

            if let turnId, !turnId.isEmpty {
                return candidate.turnId == turnId || candidate.turnId == nil
            }

            return candidate.isStreaming
        }
    }

    // Avoids temporary array allocations from split/map when deduping activity lines.
    func containsCaseInsensitiveLine(_ candidateLine: String, in text: String) -> Bool {
        var found = false
        text.enumerateLines { line, stop in
            if line
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .caseInsensitiveCompare(candidateLine) == .orderedSame {
                found = true
                stop = true
            }
        }
        return found
    }

    func appendMessage(_ message: ChatMessage) {
        if message.isStreaming {
            // Keep sidebar run state independent from timeline scanning cost.
            markThreadAsRunning(message.threadId)
        }
        if let existingIndex = messagesByThread[message.threadId]?.firstIndex(where: { $0.id == message.id }) {
            messagesByThread[message.threadId]?[existingIndex] = message
            messagesByThread[message.threadId]?.sort(by: { $0.orderIndex < $1.orderIndex })
            persistMessages()
            updateCurrentOutput(for: message.threadId)
            return
        }
        messagesByThread[message.threadId, default: []].append(message)
        messagesByThread[message.threadId]?.sort(by: { $0.orderIndex < $1.orderIndex })
        persistMessages()
        updateCurrentOutput(for: message.threadId)
    }

    func findMessageIndex(threadId: String, messageId: String) -> Int? {
        messagesByThread[threadId]?.firstIndex(where: { $0.id == messageId })
    }

    func findLatestPlanMessageIndex(threadId: String, turnId: String?, itemId: String?) -> Int? {
        if let itemId, !itemId.isEmpty {
            if let directIndex = messagesByThread[threadId]?.indices.reversed().first(where: { index in
                let candidate = messagesByThread[threadId]?[index]
                return candidate?.role == .system
                    && candidate?.kind == .plan
                    && candidate?.itemId == itemId
            }) {
                return directIndex
            }
        }

        if let turnId, !turnId.isEmpty {
            return messagesByThread[threadId]?.indices.reversed().first(where: { index in
                let candidate = messagesByThread[threadId]?[index]
                return candidate?.role == .system
                    && candidate?.kind == .plan
                    && candidate?.turnId == turnId
            })
        }

        return messagesByThread[threadId]?.indices.reversed().first(where: { index in
            let candidate = messagesByThread[threadId]?[index]
            return candidate?.role == .system && candidate?.kind == .plan
        })
    }

    func ensureStreamingAssistantMessage(threadId: String, turnId: String, itemId: String?) -> String? {
        let turnStreamingKey = streamingMessageKey(threadId: threadId, turnId: turnId)
        let normalizedItemId = normalizedStreamingItemID(itemId)
        let itemStreamingKey = normalizedItemId.map {
            assistantStreamingMessageKey(threadId: threadId, turnId: turnId, itemId: $0)
        }

        if let itemStreamingKey,
           let messageID = streamingAssistantMessageByTurnID[itemStreamingKey],
           findMessageIndex(threadId: threadId, messageId: messageID) != nil {
            streamingAssistantMessageByTurnID[turnStreamingKey] = messageID
            return messageID
        }

        if let turnMessageID = streamingAssistantMessageByTurnID[turnStreamingKey],
           let messageIndex = findMessageIndex(threadId: threadId, messageId: turnMessageID) {
            if let normalizedItemId {
                let existingItemId = normalizedStreamingItemID(messagesByThread[threadId]?[messageIndex].itemId)

                if existingItemId == nil {
                    messagesByThread[threadId]?[messageIndex].itemId = normalizedItemId
                    if let itemStreamingKey {
                        streamingAssistantMessageByTurnID[itemStreamingKey] = turnMessageID
                    }
                    persistMessages()
                    updateCurrentOutput(for: threadId)
                    return turnMessageID
                }

                if existingItemId == normalizedItemId {
                    if let itemStreamingKey {
                        streamingAssistantMessageByTurnID[itemStreamingKey] = turnMessageID
                    }
                    return turnMessageID
                }

                // New assistant item in the same turn: close previous row and start a new bubble.
                messagesByThread[threadId]?[messageIndex].isStreaming = false
                streamingAssistantMessageByTurnID.removeValue(forKey: turnStreamingKey)
                persistMessages()
                updateCurrentOutput(for: threadId)

                beginAssistantMessage(threadId: threadId, turnId: turnId, itemId: normalizedItemId)
                if let itemStreamingKey,
                   let messageID = streamingAssistantMessageByTurnID[itemStreamingKey] {
                    streamingAssistantMessageByTurnID[turnStreamingKey] = messageID
                    return messageID
                }
                return streamingAssistantMessageByTurnID[turnStreamingKey]
            }

            return turnMessageID
        } else {
            streamingAssistantMessageByTurnID.removeValue(forKey: turnStreamingKey)
        }

        beginAssistantMessage(threadId: threadId, turnId: turnId, itemId: normalizedItemId)
        if let itemStreamingKey,
           let messageID = streamingAssistantMessageByTurnID[itemStreamingKey] {
            streamingAssistantMessageByTurnID[turnStreamingKey] = messageID
            return messageID
        }
        return streamingAssistantMessageByTurnID[turnStreamingKey]
    }

    func streamingMessageKey(threadId: String, turnId: String) -> String {
        "\(threadId)|\(turnId)"
    }

    func assistantStreamingMessageKey(threadId: String, turnId: String, itemId: String) -> String {
        "\(streamingMessageKey(threadId: threadId, turnId: turnId))|item:\(itemId)"
    }

    func streamingItemMessageKey(threadId: String, itemId: String) -> String {
        "\(threadId)|item:\(itemId)"
    }

    func normalizedStreamingItemID(_ rawValue: String?) -> String? {
        guard let rawValue else {
            return nil
        }

        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    func syntheticStreamingItemId(turnId: String, kind: ChatMessageKind) -> String {
        "turn:\(turnId)|kind:\(kind.rawValue)"
    }

    func streamingPlaceholderText(for kind: ChatMessageKind) -> String {
        switch kind {
        case .thinking:
            return "Thinking..."
        case .fileChange:
            return "Applying file changes..."
        case .commandExecution:
            return "Running command"
        case .plan:
            return "Planning..."
        case .userInputPrompt:
            return "Waiting for input..."
        case .chat:
            return "Updating..."
        }
    }

    func isStreamingPlaceholder(_ text: String, for kind: ChatMessageKind) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
            .caseInsensitiveCompare(streamingPlaceholderText(for: kind)) == .orderedSame
    }

    // Prunes only empty/placeholder thinking rows, preserving real reasoning text.
    func shouldPruneThinkingRowAfterTurnCompletion(_ message: ChatMessage) -> Bool {
        let trimmedText = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedText.isEmpty else {
            return true
        }

        if isStreamingPlaceholder(trimmedText, for: .thinking) {
            return true
        }

        let withoutPrefix = trimmedText.replacingOccurrences(
            of: #"(?is)^\s*thinking(?:\.\.\.)?\s*"#,
            with: "",
            options: .regularExpression
        )
        return withoutPrefix.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    // Supports both incremental deltas ("+ token") and cumulative snapshots
    // ("full content so far"), while discarding duplicate chunks.
    func mergeAssistantDelta(existingText: String, incomingDelta: String) -> String {
        if existingText.isEmpty {
            return incomingDelta
        }

        if incomingDelta == existingText {
            return existingText
        }

        if existingText.hasSuffix(incomingDelta) {
            return existingText
        }

        if incomingDelta.count > existingText.count, incomingDelta.hasPrefix(existingText) {
            return incomingDelta
        }

        if existingText.count > incomingDelta.count, existingText.hasPrefix(incomingDelta) {
            return existingText
        }

        let maxOverlap = min(existingText.count, incomingDelta.count)
        if maxOverlap > 0 {
            for overlap in stride(from: maxOverlap, through: 1, by: -1) {
                if existingText.suffix(overlap) == incomingDelta.prefix(overlap) {
                    return existingText + incomingDelta.dropFirst(overlap)
                }
            }
        }

        return existingText + incomingDelta
    }

}

private let iso8601HistoryAnchorFormatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
}()
