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

    private struct ReviewStartRequest {
        let promptText: String
        let target: CodeRoverReviewTarget
        let baseBranch: String?
    }

    // Keeps sidebar/project loading focused on recent conversations without hiding
    // other active project groups when the latest chats all belong to one repo.
    var recentThreadListLimit: Int { 60 }

    func listThreads(limit: Int? = nil) async throws {
        isLoadingThreads = true
        defer { isLoadingThreads = false }

        let effectiveLimit = limit ?? recentThreadListLimit
        let activePage = try await fetchServerThreadPage(limit: effectiveLimit)
        let activeThreads = activePage.threads
        activeThreadListNextCursor = activePage.nextCursor
        activeThreadListHasMore = activePage.hasMore

        var archivedThreads: [ConversationThread] = []
        do {
            archivedThreads = try await fetchServerThreads(limit: effectiveLimit, archived: true)
        } catch {
            debugSyncLog("thread/list archived fetch failed (non-fatal): \(error.localizedDescription)")
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
        let params = ConversationThreadStartProjectBinding.makeThreadStartParams(
            modelIdentifier: runtimeModelIdentifier(for: resolvedProvider),
            preferredProjectPath: normalizedPreferredProjectPath,
            provider: resolvedProvider
        )
        let response = try await sendRequestWithSandboxFallback(method: "thread/start", baseParams: params)

        guard let result = response.result,
              let resultObject = result.objectValue,
              let threadValue = resultObject["thread"],
              let decodedThread = decodeModel(ConversationThread.self, from: threadValue) else {
            throw CodeRoverServiceError.invalidResponse("thread/start response missing thread")
        }

        let thread = ConversationThreadStartProjectBinding.applyPreferredProjectFallback(
            to: decodedThread,
            preferredProjectPath: normalizedPreferredProjectPath
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
            try await ensureThreadResumed(threadId: initialThreadId)
        } catch {
            if shouldTreatAsThreadNotFound(error) {
                handleMissingThread(initialThreadId)

                let continuationThread = try await createContinuationThread(from: initialThreadId)
                try await ensureThreadResumed(threadId: continuationThread.id)
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
        }

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
                // If turn/start explicitly says "thread not found", treat it as authoritative.
                // Some server states can make thread/read flaky, so we avoid blocking on a second check.
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
        guard let target else {
            throw CodeRoverServiceError.invalidInput("Choose a review target first.")
        }

        let request = ReviewStartRequest(
            promptText: reviewPromptText(target: target, baseBranch: baseBranch),
            target: target,
            baseBranch: baseBranch
        )
        let initialThreadId = try await resolveThreadID(threadId)

        do {
            try await ensureThreadResumed(threadId: initialThreadId)
        } catch {
            if shouldTreatAsThreadNotFound(error) {
                let resolvedThreadId = try await continueReviewStart(
                    request,
                    fromMissingThreadId: initialThreadId,
                    removePendingUserMessage: false
                )
                activeThreadId = resolvedThreadId
                return
            }
        }

        do {
            try await sendReviewStart(request, to: initialThreadId)
        } catch {
            if shouldTreatAsThreadNotFound(error) {
                let resolvedThreadId = try await continueReviewStart(
                    request,
                    fromMissingThreadId: initialThreadId,
                    removePendingUserMessage: true
                )
                activeThreadId = resolvedThreadId
                return
            }
            throw error
        }

        activeThreadId = initialThreadId
    }

    func refreshContextWindowUsage(threadId: String) async {
        let trimmedThreadID = threadId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedThreadID.isEmpty else { return }
        guard runtimeProviderID(for: threads.first(where: { $0.id == trimmedThreadID })?.provider) == "codex" else {
            return
        }

        var params: RPCObject = ["threadId": .string(trimmedThreadID)]
        if let turnId = activeTurnIdByThread[trimmedThreadID]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !turnId.isEmpty {
            params["turnId"] = .string(turnId)
        }

        do {
            let response = try await sendRequest(method: "thread/contextWindow/read", params: .object(params))
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

    func refreshRateLimits() async {
        guard currentRuntimeProviderID() == "codex" else {
            rateLimitBuckets = []
            rateLimitsErrorMessage = nil
            return
        }

        isLoadingRateLimits = true
        defer { isLoadingRateLimits = false }

        do {
            let response = try await fetchRateLimitsWithCompatRetry()
            guard let resultObject = response.result?.objectValue else {
                throw CodeRoverServiceError.invalidResponse("account/rateLimits/read response missing payload")
            }

            applyRateLimitsPayload(resultObject, mergeWithExisting: false)
            rateLimitsErrorMessage = nil
        } catch {
            rateLimitBuckets = []
            let message = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
            rateLimitsErrorMessage = message.isEmpty ? "Unable to load rate limits" : message
        }
    }

    func handleRateLimitsUpdated(_ paramsObject: IncomingParamsObject?) {
        guard let paramsObject else { return }
        applyRateLimitsPayload(paramsObject, mergeWithExisting: true)
        rateLimitsErrorMessage = nil
    }

    // Requests context compaction for a thread.
    func compactContext(threadId: String) async throws {
        let params: RPCObject = ["threadId": .string(threadId)]
        _ = try await sendRequest(method: "thread/compact/start", params: .object(params))
    }

    // Requests interruption for the active turn.
    func interruptTurn(turnId: String?, threadId: String? = nil) async throws {
        let normalizedThreadID = normalizedInterruptIdentifier(threadId)
            ?? normalizedInterruptIdentifier(activeThreadId)

        var normalizedTurnID = normalizedInterruptIdentifier(turnId)
        if normalizedTurnID == nil,
           let normalizedThreadID {
            normalizedTurnID = normalizedInterruptIdentifier(activeTurnIdByThread[normalizedThreadID])
        }
        if normalizedTurnID == nil {
            normalizedTurnID = normalizedInterruptIdentifier(activeTurnId)
        }
        if normalizedTurnID == nil,
           let normalizedThreadID {
            normalizedTurnID = try await resolveInFlightTurnID(threadId: normalizedThreadID)
        }

        guard let normalizedTurnID else {
            throw CodeRoverServiceError.invalidInput("turn/interrupt requires a non-empty turnId")
        }

        let resolvedThreadID = normalizedThreadID
            ?? threadIdByTurnID[normalizedTurnID]
            ?? normalizedInterruptIdentifier(activeThreadId)
        if let resolvedThreadID {
            threadIdByTurnID[normalizedTurnID] = resolvedThreadID
        }

        do {
            try await sendInterruptRequest(
                turnId: normalizedTurnID,
                threadId: resolvedThreadID,
                useSnakeCaseParams: false
            )
            return
        } catch {
            var finalError: Error = error

            if shouldRetryInterruptWithSnakeCaseParams(error) {
                do {
                    try await sendInterruptRequest(
                        turnId: normalizedTurnID,
                        threadId: resolvedThreadID,
                        useSnakeCaseParams: true
                    )
                    return
                } catch {
                    finalError = error
                }
            }

            if let resolvedThreadID,
               shouldRetryInterruptWithRefreshedTurnID(finalError),
               let refreshedTurnID = try await resolveInFlightTurnID(threadId: resolvedThreadID),
               refreshedTurnID != normalizedTurnID {
                do {
                    try await sendInterruptRequest(
                        turnId: refreshedTurnID,
                        threadId: resolvedThreadID,
                        useSnakeCaseParams: false
                    )
                    activeTurnIdByThread[resolvedThreadID] = refreshedTurnID
                    threadIdByTurnID[refreshedTurnID] = resolvedThreadID
                    return
                } catch {
                    finalError = error
                    if shouldRetryInterruptWithSnakeCaseParams(error) {
                        do {
                            try await sendInterruptRequest(
                                turnId: refreshedTurnID,
                                threadId: resolvedThreadID,
                                useSnakeCaseParams: true
                            )
                            activeTurnIdByThread[resolvedThreadID] = refreshedTurnID
                            threadIdByTurnID[refreshedTurnID] = resolvedThreadID
                            return
                        } catch {
                            finalError = error
                        }
                    }
                }
            }

            lastErrorMessage = userFacingTurnErrorMessage(from: finalError)
            throw finalError
        }
    }

    // Queries server-side fuzzy file search using stable RPC (non-experimental).
    func fuzzyFileSearch(
        query: String,
        roots: [String],
        cancellationToken: String?
    ) async throws -> [FuzzyFileMatch] {
        let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedQuery.isEmpty else {
            return []
        }

        let normalizedRoots = roots
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        guard !normalizedRoots.isEmpty else {
            return []
        }

        let normalizedToken = cancellationToken?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let tokenValue = (normalizedToken?.isEmpty == false) ? normalizedToken : nil

        let params: JSONValue = .object([
            "query": .string(normalizedQuery),
            "roots": .array(normalizedRoots.map { .string($0) }),
            "cancellationToken": tokenValue.map(JSONValue.string) ?? .null,
        ])

        let response = try await sendRequest(method: "fuzzyFileSearch", params: params)

        guard let decodedFiles = decodeFuzzyFileMatches(from: response.result) else {
            throw CodeRoverServiceError.invalidResponse("fuzzyFileSearch response missing result.files")
        }

        return decodedFiles.map { match in
            let normalizedPath = normalizeFuzzyFilePath(path: match.path, root: match.root)
            return FuzzyFileMatch(
                root: match.root,
                path: normalizedPath,
                fileName: match.fileName,
                score: match.score,
                indices: match.indices
            )
        }
    }

    // Loads available skills for one or more roots with shape-fallback compatibility.
    func listSkills(
        cwds: [String]?,
        forceReload: Bool = false
    ) async throws -> [SkillMetadata] {
        let normalizedCwds = (cwds ?? [])
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        var paramsObject: RPCObject = [:]
        if !normalizedCwds.isEmpty {
            paramsObject["cwds"] = .array(normalizedCwds.map { .string($0) })
        }
        if forceReload {
            paramsObject["forceReload"] = .bool(true)
        }

        let response: RPCMessage
        do {
            response = try await sendRequest(method: "skills/list", params: .object(paramsObject))
        } catch {
            guard !normalizedCwds.isEmpty,
                  shouldRetrySkillsListWithCwdFallback(error) else {
                throw error
            }

            var fallbackParams: RPCObject = ["cwd": .string(normalizedCwds[0])]
            if forceReload {
                fallbackParams["forceReload"] = .bool(true)
            }
            response = try await sendRequest(method: "skills/list", params: .object(fallbackParams))
        }

        guard let decodedSkills = decodeSkillMetadata(from: response.result) else {
            throw CodeRoverServiceError.invalidResponse("skills/list response missing result.data[].skills")
        }

        let dedupedByName = Dictionary(grouping: decodedSkills) { $0.normalizedName }
            .compactMap { _, bucket -> SkillMetadata? in
                bucket.first(where: { $0.enabled }) ?? bucket.first
            }
            .filter { !$0.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        return dedupedByName
    }

    // Accepts the latest pending approval request.
    func approvePendingRequest(forSession: Bool = false) async throws {
        guard let request = pendingApproval else {
            throw CodeRoverServiceError.noPendingApproval
        }

        let normalizedMethod = request.method.trimmingCharacters(in: .whitespacesAndNewlines)
        let isCommandApproval = normalizedMethod == "item/commandExecution/requestApproval"
            || normalizedMethod == "item/command_execution/request_approval"
        let decision = (forSession && isCommandApproval) ? "acceptForSession" : "accept"

        try await sendResponse(id: request.requestID, result: .string(decision))
        pendingApprovals.removeFirst()
    }

    // Declines the latest pending approval request.
    func declinePendingRequest() async throws {
        guard let request = pendingApproval else {
            throw CodeRoverServiceError.noPendingApproval
        }

        try await sendResponse(id: request.requestID, result: .string("decline"))
        pendingApprovals.removeFirst()
    }

    // Responds to item/tool/requestUserInput using the exact app-server answer envelope.
    func respondToStructuredUserInput(
        requestID: JSONValue,
        answersByQuestionID: [String: [String]]
    ) async throws {
        try await sendResponse(
            id: requestID,
            result: buildStructuredUserInputResponse(answersByQuestionID: answersByQuestionID)
        )
    }

    func buildStructuredUserInputResponse(
        answersByQuestionID: [String: [String]]
    ) -> JSONValue {
        let answersObject = answersByQuestionID.reduce(into: RPCObject()) { result, entry in
            let filteredAnswers = entry.value
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
            result[entry.key] = .object([
                "answers": .array(filteredAnswers.map(JSONValue.string)),
            ])
        }

        return .object([
            "answers": .object(answersObject),
        ])
    }

    private func continueReviewStart(
        _ request: ReviewStartRequest,
        fromMissingThreadId missingThreadId: String,
        removePendingUserMessage: Bool
    ) async throws -> String {
        if removePendingUserMessage {
            removeLatestFailedUserMessage(
                threadId: missingThreadId,
                matchingText: request.promptText,
                matchingAttachments: []
            )
        }
        handleMissingThread(missingThreadId)

        let continuationThread = try await createContinuationThread(from: missingThreadId)
        try await ensureThreadResumed(threadId: continuationThread.id)
        try await sendReviewStart(request, to: continuationThread.id)
        lastErrorMessage = nil
        return continuationThread.id
    }

    private func sendReviewStart(
        _ request: ReviewStartRequest,
        to threadId: String
    ) async throws {
        let pendingMessageId = appendUserMessage(
            threadId: threadId,
            text: request.promptText
        )
        activeThreadId = threadId
        markThreadAsRunning(threadId)
        protectedRunningFallbackThreadIDs.insert(threadId)

        do {
            let requestParams = try buildReviewStartParams(
                threadId: threadId,
                target: request.target,
                baseBranch: request.baseBranch
            )
            let response = try await sendRequestWithSandboxFallback(
                method: "review/start",
                baseParams: requestParams
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

    private func buildReviewStartParams(
        threadId: String,
        target: CodeRoverReviewTarget,
        baseBranch: String?
    ) throws -> RPCObject {
        let targetObject: RPCObject

        switch target {
        case .uncommittedChanges:
            targetObject = [
                "type": .string("uncommittedChanges"),
            ]
        case .baseBranch:
            let normalizedBaseBranch = baseBranch?.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let resolvedBaseBranch = normalizedBaseBranch,
                  !resolvedBaseBranch.isEmpty else {
                throw CodeRoverServiceError.invalidInput("Choose a base branch before starting this review.")
            }
            targetObject = [
                "type": .string("baseBranch"),
                "branch": .string(resolvedBaseBranch),
            ]
        }

        return [
            "threadId": .string(threadId),
            "delivery": .string("inline"),
            "target": .object(targetObject),
        ]
    }

    private func reviewPromptText(target: CodeRoverReviewTarget, baseBranch: String?) -> String {
        switch target {
        case .uncommittedChanges:
            return "Review current changes"
        case .baseBranch:
            let trimmedBaseBranch = baseBranch?.trimmingCharacters(in: .whitespacesAndNewlines)
            if let trimmedBaseBranch, !trimmedBaseBranch.isEmpty {
                return "Review against base branch \(trimmedBaseBranch)"
            }
            return "Review against base branch"
        }
    }

    private func fetchRateLimitsWithCompatRetry() async throws -> RPCMessage {
        do {
            return try await sendRequest(method: "account/rateLimits/read", params: .null)
        } catch {
            guard shouldRetryRateLimitsWithEmptyParams(error) else {
                throw error
            }
        }

        return try await sendRequest(method: "account/rateLimits/read", params: .object([:]))
    }

    private func applyRateLimitsPayload(
        _ payloadObject: IncomingParamsObject,
        mergeWithExisting: Bool
    ) {
        let decodedBuckets = decodeRateLimitBuckets(from: payloadObject)
        let resolvedBuckets = mergeWithExisting
            ? mergeRateLimitBuckets(existing: rateLimitBuckets, incoming: decodedBuckets)
            : decodedBuckets

        rateLimitBuckets = resolvedBuckets.sorted { lhs, rhs in
            if lhs.sortDurationMins == rhs.sortDurationMins {
                return lhs.displayLabel.localizedCaseInsensitiveCompare(rhs.displayLabel) == .orderedAscending
            }
            return lhs.sortDurationMins < rhs.sortDurationMins
        }
    }

    private func decodeRateLimitBuckets(from payloadObject: IncomingParamsObject) -> [CodeRoverRateLimitBucket] {
        if let keyedBuckets = payloadObject["rateLimitsByLimitId"]?.objectValue
            ?? payloadObject["rate_limits_by_limit_id"]?.objectValue {
            return keyedBuckets.compactMap { limitId, value in
                decodeRateLimitBucket(limitId: limitId, value: value)
            }
        }

        if let nestedBuckets = payloadObject["rateLimits"]?.objectValue
            ?? payloadObject["rate_limits"]?.objectValue {
            if containsDirectRateLimitWindows(nestedBuckets) {
                return decodeDirectRateLimitBuckets(from: nestedBuckets)
            }

            if let decodedBucket = decodeRateLimitBucket(limitId: nil, value: .object(nestedBuckets)) {
                return [decodedBucket]
            }
        }

        if let nestedResult = payloadObject["result"]?.objectValue {
            return decodeRateLimitBuckets(from: nestedResult)
        }

        if containsDirectRateLimitWindows(payloadObject) {
            return decodeDirectRateLimitBuckets(from: payloadObject)
        }

        return []
    }

    private func decodeRateLimitBucket(
        limitId explicitLimitId: String?,
        value: JSONValue
    ) -> CodeRoverRateLimitBucket? {
        guard let object = value.objectValue else { return nil }

        let limitId = firstNonEmptyString([
            explicitLimitId,
            firstStringValue(in: object, keys: ["limitId", "limit_id", "id"]),
        ]) ?? UUID().uuidString

        let primary = decodeRateLimitWindow(value: object["primary"] ?? object["primary_window"])
        let secondary = decodeRateLimitWindow(value: object["secondary"] ?? object["secondary_window"])

        guard primary != nil || secondary != nil else { return nil }

        return CodeRoverRateLimitBucket(
            limitId: limitId,
            limitName: firstStringValue(in: object, keys: ["limitName", "limit_name", "name"]),
            primary: primary,
            secondary: secondary
        )
    }

    private func decodeDirectRateLimitBuckets(from object: IncomingParamsObject) -> [CodeRoverRateLimitBucket] {
        var buckets: [CodeRoverRateLimitBucket] = []

        if let primary = decodeRateLimitWindow(value: object["primary"] ?? object["primary_window"]) {
            buckets.append(
                CodeRoverRateLimitBucket(
                    limitId: "primary",
                    limitName: firstStringValue(in: object, keys: ["limitName", "limit_name", "name"]),
                    primary: primary,
                    secondary: nil
                )
            )
        }

        if let secondary = decodeRateLimitWindow(value: object["secondary"] ?? object["secondary_window"]) {
            buckets.append(
                CodeRoverRateLimitBucket(
                    limitId: "secondary",
                    limitName: firstStringValue(in: object, keys: ["secondaryName", "secondary_name"]),
                    primary: secondary,
                    secondary: nil
                )
            )
        }

        return buckets
    }

    private func decodeRateLimitWindow(value: JSONValue?) -> CodeRoverRateLimitWindow? {
        guard let object = value?.objectValue else { return nil }

        let usedPercent = firstIntValue(in: object, keys: ["usedPercent", "used_percent"]) ?? 0
        let windowDurationMins = firstIntValue(
            in: object,
            keys: ["windowDurationMins", "window_duration_mins", "windowMinutes", "window_minutes"]
        )

        let resetDate: Date?
        if let rawResetsAt = object["resetsAt"]?.doubleValue
            ?? object["resets_at"]?.doubleValue
            ?? object["resetAt"]?.doubleValue
            ?? object["reset_at"]?.doubleValue {
            let secondsValue = rawResetsAt > 10_000_000_000 ? rawResetsAt / 1000 : rawResetsAt
            resetDate = Date(timeIntervalSince1970: secondsValue)
        } else if let rawResetsAtString = firstStringValue(
            in: object,
            keys: ["resetsAt", "resets_at", "resetAt", "reset_at"]
        ) {
            resetDate = ISO8601DateFormatter().date(from: rawResetsAtString)
        } else {
            resetDate = nil
        }

        return CodeRoverRateLimitWindow(
            usedPercent: usedPercent,
            windowDurationMins: windowDurationMins,
            resetsAt: resetDate
        )
    }

    private func containsDirectRateLimitWindows(_ object: IncomingParamsObject) -> Bool {
        object["primary"] != nil
            || object["secondary"] != nil
            || object["primary_window"] != nil
            || object["secondary_window"] != nil
    }

    private func mergeRateLimitBuckets(
        existing: [CodeRoverRateLimitBucket],
        incoming: [CodeRoverRateLimitBucket]
    ) -> [CodeRoverRateLimitBucket] {
        guard !existing.isEmpty else { return incoming }
        guard !incoming.isEmpty else { return existing }

        var mergedById = Dictionary(uniqueKeysWithValues: existing.map { ($0.limitId, $0) })
        for bucket in incoming {
            if let current = mergedById[bucket.limitId] {
                mergedById[bucket.limitId] = CodeRoverRateLimitBucket(
                    limitId: bucket.limitId,
                    limitName: bucket.limitName ?? current.limitName,
                    primary: bucket.primary ?? current.primary,
                    secondary: bucket.secondary ?? current.secondary
                )
            } else {
                mergedById[bucket.limitId] = bucket
            }
        }

        return Array(mergedById.values)
    }

    private func shouldRetryRateLimitsWithEmptyParams(_ error: Error) -> Bool {
        guard let serviceError = error as? CodeRoverServiceError,
              case .rpcError(let rpcError) = serviceError else {
            return false
        }

        guard rpcError.code == -32602 || rpcError.code == -32600 else {
            return false
        }

        let lowered = rpcError.message.lowercased()
        return lowered.contains("invalid params")
            || lowered.contains("invalid param")
            || lowered.contains("failed to parse")
            || lowered.contains("expected")
            || lowered.contains("missing field `params`")
            || lowered.contains("missing field params")
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
        var params: RPCObject = [
            "sourceKinds": .array(threadListSourceKinds.map(JSONValue.string)),
            "cursor": cursor,
        ]
        if let limit {
            params["limit"] = .integer(limit)
        }
        if archived {
            params["archived"] = .bool(true)
        }

        let response = try await sendRequest(method: "thread/list", params: .object(params))

        guard let resultObject = response.result?.objectValue else {
            throw CodeRoverServiceError.invalidResponse("thread/list response missing payload")
        }

        let page =
            resultObject["data"]?.arrayValue
            ?? resultObject["items"]?.arrayValue
            ?? resultObject["threads"]?.arrayValue
        guard let page else {
            throw CodeRoverServiceError.invalidResponse("thread/list response missing data array")
        }

        let nextCursor = nextThreadListCursor(from: resultObject)
        return ThreadListPage(
            threads: page.compactMap { decodeModel(ConversationThread.self, from: $0) },
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

    // Requests all user-facing thread sources instead of relying on the server default.
    private var threadListSourceKinds: [String] {
        [
            "cli",
            "vscode",
            "appServer",
            "exec",
            "unknown",
        ]
    }

    // Accepts both modern and legacy cursor field names from thread/list responses.
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
    func ensureThreadResumed(
        threadId: String,
        force: Bool = false,
        preferredProjectPath: String? = nil,
        modelIdentifierOverride: String? = nil
    ) async throws -> ConversationThread? {
        guard !threadId.isEmpty else {
            return nil
        }

        let hasLocalMessages = !(messagesByThread[threadId] ?? []).isEmpty
        if force {
            forcedResumeEscalationThreadIDs.insert(threadId)
        }
        if !force, resumedThreadIDs.contains(threadId), hasLocalMessages {
            return thread(for: threadId)
        }

        let requestedSignature = CodeRoverThreadResumeRequestSignature(
            projectPath: ConversationThreadStartProjectBinding.normalizedProjectPath(preferredProjectPath)
                ?? thread(for: threadId)?.gitWorkingDirectory,
            modelIdentifier: modelIdentifierOverride ?? runtimeModelIdentifierForTurn()
        )
        let refreshGeneration = currentPerThreadRefreshGeneration(for: threadId)
        if let existingTask = threadResumeTaskByThreadID[threadId] {
            if threadResumeRequestSignatureByThreadID[threadId] == requestedSignature {
                return try await existingTask.value
            }

            _ = try await existingTask.value
            return try await ensureThreadResumed(
                threadId: threadId,
                force: force,
                preferredProjectPath: preferredProjectPath,
                modelIdentifierOverride: modelIdentifierOverride
            )
        }

        let task = Task<ConversationThread?, Error> { @MainActor in
            defer {
                if isPerThreadRefreshCurrent(for: threadId, generation: refreshGeneration) {
                    threadResumeTaskByThreadID.removeValue(forKey: threadId)
                    threadResumeRequestSignatureByThreadID.removeValue(forKey: threadId)
                    forcedResumeEscalationThreadIDs.remove(threadId)
                }
            }

            var params: RPCObject = [
                "threadId": .string(threadId),
            ]
            if let workingDirectory = requestedSignature.projectPath {
                params["cwd"] = .string(workingDirectory)
            }
            if let modelIdentifier = requestedSignature.modelIdentifier {
                params["model"] = .string(modelIdentifier)
            }

            let response = try await sendRequestWithSandboxFallback(method: "thread/resume", baseParams: params)
            guard !Task.isCancelled,
                  isPerThreadRefreshCurrent(for: threadId, generation: refreshGeneration) else {
                throw CancellationError()
            }

            guard let resultObject = response.result?.objectValue else {
                resumedThreadIDs.insert(threadId)
                return nil
            }

            let syncMetadata = decodeThreadSyncMetadata(from: resultObject)
            guard acceptThreadSyncMetadata(
                threadId: threadId,
                syncEpoch: syncMetadata.syncEpoch,
                sourceKind: syncMetadata.sourceKind,
                generation: refreshGeneration
            ) else {
                throw CancellationError()
            }

            var resumedThread: ConversationThread?
            if let threadValue = resultObject["thread"],
               let decodedThreadValue = decodeModel(ConversationThread.self, from: threadValue) {
                var decodedThread = ConversationThreadStartProjectBinding.applyPreferredProjectFallback(
                    to: decodedThreadValue,
                    preferredProjectPath: ConversationThreadStartProjectBinding.normalizedProjectPath(preferredProjectPath)
                )
                decodedThread.syncState = .live
                upsertThread(decodedThread, treatAsServerState: true)
                resumedThread = decodedThread

                if let threadObject = threadValue.objectValue {
                    applyTerminalStatesFromThreadRead(threadId: threadId, threadObject: threadObject)
                    let historyMessages = decodeMessagesFromThreadRead(threadId: threadId, threadObject: threadObject)
                    if !historyMessages.isEmpty {
                        let activeThreadIDs = Set(activeTurnIdByThread.keys)
                        let runningIDs = runningThreadIDs
                        let existingMessages = messagesByThread[threadId] ?? []
                        let merged = mergeCanonicalHistoryIntoTimelineState(
                            threadId: threadId,
                            historyMessages: historyMessages,
                            mode: nil,
                            activeThreadIDs: activeThreadIDs,
                            runningThreadIDs: runningIDs
                        )
                        guard !Task.isCancelled,
                              isPerThreadRefreshCurrent(for: threadId, generation: refreshGeneration) else {
                            throw CancellationError()
                        }

                        let shouldForceMerge = force || forcedResumeEscalationThreadIDs.contains(threadId)
                        if (shouldForceMerge || !threadHasActiveOrRunningTurn(threadId) || existingMessages.isEmpty)
                            && merged != existingMessages {
                            coderoverDiagnosticLog(
                                "CodeRoverThreads",
                                "ensureThreadResumed mergedHistory thread=\(threadId) existing=\(existingMessages.count) decoded=\(historyMessages.count) merged=\(merged.count)"
                            )
                            persistMessages()
                            updateCurrentOutput(for: threadId)
                        }

                        if runtimeProviderID(for: decodedThread.provider) == "codex",
                           normalizedHistoryCursor(historyStateByThread[threadId]?.newestCursor) == nil {
                            resumeSeededHistoryThreadIDs.insert(threadId)
                        }

                        if (shouldForceMerge || threadHasActiveOrRunningTurn(threadId))
                            && runtimeProviderID(for: decodedThread.provider) == "codex" {
                            markThreadNeedingCanonicalHistoryReconcile(threadId)
                        } else if !threadHasActiveOrRunningTurn(threadId) {
                            markThreadCanonicalHistoryReconciled(threadId)
                        }
                    }
                }
            } else if let index = threadIndex(for: threadId) {
                threads[index].syncState = .live
            }

            guard !Task.isCancelled,
                  isPerThreadRefreshCurrent(for: threadId, generation: refreshGeneration) else {
                throw CancellationError()
            }
            resumedThreadIDs.insert(threadId)
            return resumedThread
        }

        threadResumeTaskByThreadID[threadId] = task
        threadResumeRequestSignatureByThreadID[threadId] = requestedSignature
        return try await task.value
    }

    func isThreadMissingOnServer(_ threadId: String) async -> Bool {
        let params: JSONValue = .object([
            "threadId": .string(threadId),
            "includeTurns": .bool(false),
        ])

        do {
            _ = try await sendRequest(method: "thread/read", params: params)
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

        let refreshGeneration = currentPerThreadRefreshGeneration(for: normalizedThreadID)
        if let existingTask = turnStateRefreshTaskByThreadID[normalizedThreadID] {
            return await existingTask.value
        }

        let task = Task<Bool, Never> { @MainActor in
            defer {
                if isPerThreadRefreshCurrent(for: normalizedThreadID, generation: refreshGeneration) {
                    turnStateRefreshTaskByThreadID.removeValue(forKey: normalizedThreadID)
                }
            }

            do {
                let snapshot = try await readThreadTurnStateSnapshot(threadId: normalizedThreadID)
                guard !Task.isCancelled,
                      isPerThreadRefreshCurrent(for: normalizedThreadID, generation: refreshGeneration) else {
                    return false
                }

                if let runningTurnID = snapshot.interruptibleTurnID {
                    markThreadAsRunning(normalizedThreadID)
                    protectedRunningFallbackThreadIDs.remove(normalizedThreadID)
                    activeTurnIdByThread[normalizedThreadID] = runningTurnID
                    threadIdByTurnID[runningTurnID] = normalizedThreadID
                    activeTurnId = runningTurnID
                    return true
                }

                if snapshot.hasInterruptibleTurnWithoutID {
                    markThreadAsRunning(normalizedThreadID)
                    protectedRunningFallbackThreadIDs.insert(normalizedThreadID)
                } else {
                    runningThreadIDs.remove(normalizedThreadID)
                    protectedRunningFallbackThreadIDs.remove(normalizedThreadID)
                }

                if let existingTurnID = activeTurnIdByThread.removeValue(forKey: normalizedThreadID) {
                    if threadIdByTurnID[existingTurnID] == normalizedThreadID {
                        threadIdByTurnID.removeValue(forKey: existingTurnID)
                    }
                    if activeTurnId == existingTurnID {
                        activeTurnId = nil
                    }
                }
                if !snapshot.hasInterruptibleTurnWithoutID {
                    scheduleCanonicalHistoryReconcileIfNeeded(for: normalizedThreadID)
                }
                return true
            } catch {
                debugSyncLog("in-flight turn refresh failed thread=\(normalizedThreadID): \(error.localizedDescription)")
                return false
            }
        }

        turnStateRefreshTaskByThreadID[normalizedThreadID] = task
        return await task.value
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

        var includeStructuredSkillItems = supportsStructuredSkillInput && !skillMentions.isEmpty
        var imageURLKey = "url"
        let threadCapabilities = threads.first(where: { $0.id == threadId })?.capabilities
            ?? currentRuntimeProvider().supports
        let runtimeSupportsPlanMode = supportsTurnCollaborationMode && threadCapabilities.planMode
        var effectiveCollaborationMode = runtimeSupportsPlanMode ? collaborationMode : nil
        var didDowngradePlanModeForRuntime = collaborationMode != nil && effectiveCollaborationMode == nil

        while true {
            do {
                let requestParams = try buildTurnStartRequestParams(
                    threadId: threadId,
                    userInput: userInput,
                    attachments: attachments,
                    skillMentions: skillMentions,
                    imageURLKey: imageURLKey,
                    includeStructuredSkillItems: includeStructuredSkillItems,
                    collaborationMode: effectiveCollaborationMode
                )
                let response = try await sendRequestWithSandboxFallback(
                    method: "turn/start",
                    baseParams: requestParams
                )
                handleSuccessfulTurnStartResponse(
                    response,
                    pendingMessageId: pendingMessageId,
                    threadId: threadId
                )
                if didDowngradePlanModeForRuntime {
                    appendSystemMessage(
                        threadId: threadId,
                        text: "Plan mode is not supported by this runtime. Sent as a normal turn instead."
                    )
                }
                return
            } catch {
                if includeStructuredSkillItems,
                   shouldRetryTurnStartWithoutSkillItems(error) {
                    // Disable structured skill input for this runtime after first incompatibility signal.
                    supportsStructuredSkillInput = false
                    includeStructuredSkillItems = false
                    continue
                }

                if imageURLKey == "url",
                   !attachments.isEmpty,
                   shouldRetryTurnStartWithImageURLField(error) {
                    imageURLKey = "image_url"
                    continue
                }

                if effectiveCollaborationMode != nil,
                   shouldRetryTurnStartWithoutCollaborationMode(error) {
                    // Remember the runtime limitation so future plan-mode sends skip the rejected field.
                    supportsTurnCollaborationMode = false
                    effectiveCollaborationMode = nil
                    didDowngradePlanModeForRuntime = true
                    continue
                }

                try handleTurnStartFailure(
                    error,
                    pendingMessageId: pendingMessageId,
                    threadId: threadId
                )
                return
            }
        }
    }

    // Steers an active turn using the same mixed input-item encoding as turn/start.
    func steerTurn(
        userInput: String,
        threadId: String,
        expectedTurnId: String?,
        attachments: [ImageAttachment] = [],
        skillMentions: [TurnSkillMention] = [],
        shouldAppendUserMessage: Bool = true
    ) async throws {
        let normalizedThreadID = normalizedInterruptIdentifier(threadId) ?? threadId
        let pendingMessageId = shouldAppendUserMessage
            ? appendUserMessage(threadId: normalizedThreadID, text: userInput, attachments: attachments)
            : ""
        let threadCapabilities = threads.first(where: { $0.id == normalizedThreadID })?.capabilities
            ?? currentRuntimeProvider().supports
        guard threadCapabilities.turnSteer else {
            let error = CodeRoverServiceError.invalidInput("Steering is not supported for this runtime")
            handleSteerFailure(error, pendingMessageId: pendingMessageId, threadId: normalizedThreadID)
            throw error
        }
        var resolvedExpectedTurnID = normalizedInterruptIdentifier(expectedTurnId)
        if resolvedExpectedTurnID == nil {
            do {
                resolvedExpectedTurnID = try await resolveInFlightTurnID(threadId: normalizedThreadID)
            } catch {
                handleSteerFailure(error, pendingMessageId: pendingMessageId, threadId: normalizedThreadID)
                throw error
            }
        }

        guard let initialTurnID = resolvedExpectedTurnID else {
            let error = CodeRoverServiceError.invalidInput("No active turn available to steer")
            handleSteerFailure(error, pendingMessageId: pendingMessageId, threadId: normalizedThreadID)
            throw error
        }

        var includeStructuredSkillItems = supportsStructuredSkillInput && !skillMentions.isEmpty
        var imageURLKey = "url"
        var currentExpectedTurnID = initialTurnID
        var didRetryWithRefreshedTurnID = false

        while true {
            let params: RPCObject = [
                "threadId": .string(normalizedThreadID),
                "expectedTurnId": .string(currentExpectedTurnID),
                "input": .array(
                    makeTurnInputPayload(
                        userInput: userInput,
                        attachments: attachments,
                        imageURLKey: imageURLKey,
                        skillMentions: skillMentions,
                        includeStructuredSkillItems: includeStructuredSkillItems
                    )
                ),
            ]

            do {
                let response = try await sendRequest(method: "turn/steer", params: .object(params))
                let resolvedTurnID = extractTurnID(from: response.result) ?? currentExpectedTurnID
                markMessageDeliveryState(
                    threadId: normalizedThreadID,
                    messageId: pendingMessageId,
                    state: .confirmed,
                    turnId: resolvedTurnID
                )
                activeTurnId = resolvedTurnID
                activeTurnIdByThread[normalizedThreadID] = resolvedTurnID
                threadIdByTurnID[resolvedTurnID] = normalizedThreadID
                markThreadAsRunning(normalizedThreadID)
                protectedRunningFallbackThreadIDs.remove(normalizedThreadID)
                return
            } catch {
                if includeStructuredSkillItems,
                   shouldRetryTurnStartWithoutSkillItems(error) {
                    supportsStructuredSkillInput = false
                    includeStructuredSkillItems = false
                    continue
                }

                if imageURLKey == "url",
                   !attachments.isEmpty,
                   shouldRetryTurnStartWithImageURLField(error) {
                    imageURLKey = "image_url"
                    continue
                }

                if !didRetryWithRefreshedTurnID,
                   shouldRetrySteerWithRefreshedTurnID(error) {
                    do {
                        if let refreshedTurnID = try await resolveInFlightTurnID(threadId: normalizedThreadID),
                           refreshedTurnID != currentExpectedTurnID {
                            didRetryWithRefreshedTurnID = true
                            currentExpectedTurnID = refreshedTurnID
                            activeTurnId = refreshedTurnID
                            activeTurnIdByThread[normalizedThreadID] = refreshedTurnID
                            threadIdByTurnID[refreshedTurnID] = normalizedThreadID
                            continue
                        }
                    } catch {
                        handleSteerFailure(error, pendingMessageId: pendingMessageId, threadId: normalizedThreadID)
                        throw error
                    }
                }

                handleSteerFailure(error, pendingMessageId: pendingMessageId, threadId: normalizedThreadID)
                throw error
            }
        }
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

    // Normalizes outgoing turn input so we can support mixed text + image messages.
    func makeTurnInputPayload(
        userInput: String,
        attachments: [ImageAttachment],
        imageURLKey: String,
        skillMentions: [TurnSkillMention] = [],
        includeStructuredSkillItems: Bool = true
    ) -> [JSONValue] {
        var inputItems: [JSONValue] = []

        for attachment in attachments {
            guard let payloadDataURL = attachment.payloadDataURL,
                  !payloadDataURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                continue
            }

            inputItems.append(
                .object([
                    "type": .string("image"),
                    imageURLKey: .string(payloadDataURL),
                ])
            )
        }

        let trimmedText = userInput.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedText.isEmpty {
            inputItems.append(
                .object([
                    "type": .string("text"),
                    "text": .string(trimmedText),
                ])
            )
        }

        if includeStructuredSkillItems {
            for mention in skillMentions {
                let normalizedSkillID = mention.id.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !normalizedSkillID.isEmpty else {
                    continue
                }

                var payload: RPCObject = [
                    "type": .string("skill"),
                    "id": .string(normalizedSkillID),
                ]

                if let name = mention.name?.trimmingCharacters(in: .whitespacesAndNewlines),
                   !name.isEmpty {
                    payload["name"] = .string(name)
                }

                if let path = mention.path?.trimmingCharacters(in: .whitespacesAndNewlines),
                   !path.isEmpty {
                    payload["path"] = .string(path)
                }

                inputItems.append(.object(payload))
            }
        }

        return inputItems
    }

    // Builds turn/start params so retries can switch only the input-item encoding.
    func buildTurnStartRequestParams(
        threadId: String,
        userInput: String,
        attachments: [ImageAttachment],
        skillMentions: [TurnSkillMention],
        imageURLKey: String,
        includeStructuredSkillItems: Bool,
        collaborationMode: CollaborationModeModeKind?
    ) throws -> RPCObject {
        var params: RPCObject = [
            "threadId": .string(threadId),
            "input": .array(
                makeTurnInputPayload(
                    userInput: userInput,
                    attachments: attachments,
                    imageURLKey: imageURLKey,
                    skillMentions: skillMentions,
                    includeStructuredSkillItems: includeStructuredSkillItems
                )
            ),
        ]
        // Keep the legacy top-level fields populated so plan-mode turns still honor
        // the user's selected model on runtimes that do not read collaboration settings.
        if let modelIdentifier = runtimeModelIdentifierForTurn() {
            params["model"] = .string(modelIdentifier)
        }
        if let effort = selectedReasoningEffortForSelectedModel() {
            params["effort"] = .string(effort)
        }
        if let collaborationModePayload = try buildCollaborationModePayload(for: collaborationMode) {
            params["collaborationMode"] = collaborationModePayload
        }
        return params
    }

    // Encodes collaborationMode while allowing the selected mode to supply built-in instructions.
    func buildCollaborationModePayload(for mode: CollaborationModeModeKind?) throws -> JSONValue? {
        guard let mode else {
            return nil
        }

        let resolvedModel = runtimeModelIdentifierForTurn()
            ?? selectedModelOption()?.model
            ?? availableModels.first?.model
            ?? selectedModelId
        guard let resolvedModel,
              !resolvedModel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw CodeRoverServiceError.invalidResponse(
                "Plan mode requires an available model before starting a plan turn."
            )
        }

        return .object([
            "mode": .string(mode.rawValue),
            "settings": .object([
                "model": .string(resolvedModel),
                "reasoning_effort": selectedReasoningEffortForSelectedModel().map(JSONValue.string) ?? .null,
                "developer_instructions": .null,
            ]),
        ])
    }

    // Applies common failure bookkeeping for turn/start primary and fallback attempts.
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

    // Handles successful turn/start bookkeeping for both primary and fallback payload schemas.
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
            debugRuntimeLog("turn/start response missing turnId thread=\(threadId) fallbackTurn=\(fallbackTurnID)")
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

    // Some server versions expect `image_url` instead of `url` for image items.
    func shouldRetryTurnStartWithImageURLField(_ error: Error) -> Bool {
        guard let serviceError = error as? CodeRoverServiceError,
              case .rpcError(let rpcError) = serviceError else {
            return false
        }

        let message = rpcError.message.lowercased()
        guard message.contains("image_url") else {
            return false
        }

        return message.contains("missing")
            || message.contains("unknown field")
            || message.contains("expected")
            || message.contains("invalid")
    }

    // Detects legacy servers that reject input items with `type: "skill"`.
    func shouldRetryTurnStartWithoutSkillItems(_ error: Error) -> Bool {
        guard let serviceError = error as? CodeRoverServiceError,
              case .rpcError(let rpcError) = serviceError else {
            return false
        }

        let message = rpcError.message.lowercased()
        guard message.contains("skill") else {
            return false
        }

        return message.contains("unknown")
            || message.contains("unsupported")
            || message.contains("invalid")
            || message.contains("expected")
            || message.contains("unrecognized")
            || message.contains("type")
            || message.contains("field")
    }

    // Detects runtimes that reject plan-mode `collaborationMode` without `experimentalApi`.
    func shouldRetryTurnStartWithoutCollaborationMode(_ error: Error) -> Bool {
        guard let serviceError = error as? CodeRoverServiceError,
              case .rpcError(let rpcError) = serviceError else {
            return false
        }

        let message = rpcError.message.lowercased()
        guard message.contains("collaborationmode") || message.contains("collaboration_mode") else {
            return false
        }

        return message.contains("experimentalapi")
            || message.contains("unsupported")
            || message.contains("unknown")
            || message.contains("unexpected")
            || message.contains("unrecognized")
            || message.contains("invalid")
            || message.contains("field")
            || message.contains("mode")
    }

    // Parses `result.files` so tests can validate decoding without transport wiring.
    func decodeFuzzyFileMatches(from result: JSONValue?) -> [FuzzyFileMatch]? {
        guard let resultObject = result?.objectValue,
              let filesValue = resultObject["files"] else {
            return nil
        }

        return decodeModel([FuzzyFileMatch].self, from: filesValue)
    }

    // Parses skills/list payloads from both bucketed and flat server response shapes.
    func decodeSkillMetadata(from result: JSONValue?) -> [SkillMetadata]? {
        guard let resultObject = result?.objectValue else {
            return nil
        }

        var collectedSkills: [SkillMetadata] = []
        var hasSkillContainer = false

        if let dataItems = resultObject["data"]?.arrayValue {
            hasSkillContainer = true
            for item in dataItems {
                guard let itemObject = item.objectValue else {
                    continue
                }
                if let skillsValue = itemObject["skills"],
                   let decodedSkills = decodeModel([SkillMetadata].self, from: skillsValue) {
                    collectedSkills.append(contentsOf: decodedSkills)
                }
            }

            if collectedSkills.isEmpty,
               let decodedSkills = decodeModel([SkillMetadata].self, from: .array(dataItems)) {
                collectedSkills.append(contentsOf: decodedSkills)
            }
        }

        if collectedSkills.isEmpty,
           let skillsValue = resultObject["skills"],
           let decodedSkills = decodeModel([SkillMetadata].self, from: skillsValue) {
            hasSkillContainer = true
            collectedSkills.append(contentsOf: decodedSkills)
        } else if resultObject["skills"] != nil {
            hasSkillContainer = true
        }

        return hasSkillContainer ? collectedSkills : nil
    }

    func shouldRetrySkillsListWithCwdFallback(_ error: Error) -> Bool {
        guard let serviceError = error as? CodeRoverServiceError,
              case .rpcError(let rpcError) = serviceError else {
            return false
        }

        guard rpcError.code == -32600 || rpcError.code == -32602 else {
            return false
        }

        let message = rpcError.message.lowercased()
        return message.contains("invalid")
            || message.contains("unknown field")
            || message.contains("unrecognized field")
            || message.contains("missing field")
            || message.contains("expected")
            || message.contains("cwds")
    }

    // Sends turn interruption request with camelCase or snake_case param keys for compatibility.
    func sendInterruptRequest(
        turnId: String,
        threadId: String?,
        useSnakeCaseParams: Bool
    ) async throws {
        var params: RPCObject = [:]
        params[useSnakeCaseParams ? "turn_id" : "turnId"] = .string(turnId)
        if let threadId {
            params[useSnakeCaseParams ? "thread_id" : "threadId"] = .string(threadId)
        }
        _ = try await sendRequest(method: "turn/interrupt", params: .object(params))
    }

    // Normalizes ids coming from UI/runtime state before RPC usage.
    func normalizedInterruptIdentifier(_ rawValue: String?) -> String? {
        guard let rawValue else { return nil }
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    // Resolves the currently running turn id from thread/read when local state becomes stale.
    func resolveInFlightTurnID(threadId: String) async throws -> String? {
        let snapshot = try await readThreadTurnStateSnapshot(threadId: threadId)
        return snapshot.interruptibleTurnID ?? snapshot.latestTurnID
    }

    // Parses turn status values from thread/read turn objects.
    func normalizedInterruptTurnStatus(from turnObject: [String: JSONValue]) -> String? {
        let status = turnObject["status"]?.stringValue
            ?? turnObject["turnStatus"]?.stringValue
            ?? turnObject["turn_status"]?.stringValue

        guard let status else { return nil }

        let trimmed = status.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        return trimmed
            .replacingOccurrences(of: "_", with: "")
            .replacingOccurrences(of: "-", with: "")
            .lowercased()
    }

    // Marks statuses that can still accept turn/interrupt.
    func isInterruptibleTurnStatus(_ normalizedStatus: String?) -> Bool {
        guard let normalizedStatus else {
            return true
        }

        if normalizedStatus.contains("inprogress")
            || normalizedStatus.contains("running")
            || normalizedStatus.contains("pending")
            || normalizedStatus.contains("started") {
            return true
        }

        if normalizedStatus.contains("complete")
            || normalizedStatus.contains("failed")
            || normalizedStatus.contains("error")
            || normalizedStatus.contains("interrupt")
            || normalizedStatus.contains("cancel")
            || normalizedStatus.contains("stopped") {
            return false
        }

        return true
    }

    // Retries with snake_case params for strict or legacy server parsers.
    func shouldRetryInterruptWithSnakeCaseParams(_ error: Error) -> Bool {
        guard let serviceError = error as? CodeRoverServiceError,
              case .rpcError(let rpcError) = serviceError else {
            return false
        }

        guard rpcError.code == -32600 || rpcError.code == -32602 else {
            return false
        }

        let message = rpcError.message.lowercased()
        let hints = ["turnid", "threadid", "turn_id", "thread_id", "unknown field", "missing field", "invalid"]
        return hints.contains { message.contains($0) }
    }

    // Reads thread/read(includeTurns=true) and extracts both running and latest turn metadata.
    func readThreadTurnStateSnapshot(threadId: String) async throws -> (
        interruptibleTurnID: String?,
        hasInterruptibleTurnWithoutID: Bool,
        latestTurnID: String?
    ) {
        let params: JSONValue = .object([
            "threadId": .string(threadId),
            "includeTurns": .bool(true),
        ])

        let response = try await sendRequest(method: "thread/read", params: params)
        guard let threadObject = response.result?.objectValue?["thread"]?.objectValue else {
            return (nil, false, nil)
        }

        let turnObjects = threadObject["turns"]?.arrayValue?.compactMap { $0.objectValue } ?? []
        guard let latestTurnObject = turnObjects.last else {
            return (nil, false, nil)
        }

        let latestTurnID = normalizedInterruptIdentifier(
            latestTurnObject["id"]?.stringValue
                ?? latestTurnObject["turnId"]?.stringValue
                ?? latestTurnObject["turn_id"]?.stringValue
        )
        let latestStatus = normalizedInterruptTurnStatus(from: latestTurnObject)

        // Missing status should stay permissive so incomplete payloads do not clear live UI state.
        guard isInterruptibleTurnStatus(latestStatus) else {
            return (nil, false, latestTurnID)
        }

        if let latestTurnID {
            return (latestTurnID, false, latestTurnID)
        }

        return (nil, true, latestTurnID)
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

    // Retries steer once after refreshing the active turn id when the server rejects the precondition.
    func shouldRetrySteerWithRefreshedTurnID(_ error: Error) -> Bool {
        shouldRetryInterruptWithRefreshedTurnID(error)
    }

    // Converts absolute match paths to root-relative output when older servers return full paths.
    func normalizeFuzzyFilePath(path: String, root: String) -> String {
        let trimmedPath = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedPath.isEmpty else {
            return path
        }

        let normalizedRoot = normalizedFuzzyRootPath(root)
        guard !normalizedRoot.isEmpty else {
            return trimmedPath
        }

        if normalizedRoot == "/" {
            return trimmedPath.hasPrefix("/") ? String(trimmedPath.dropFirst()) : trimmedPath
        }

        let rootPrefix = normalizedRoot.hasSuffix("/") ? normalizedRoot : "\(normalizedRoot)/"
        if trimmedPath.hasPrefix(rootPrefix) {
            return String(trimmedPath.dropFirst(rootPrefix.count))
        }

        return trimmedPath
    }

    private func normalizedFuzzyRootPath(_ root: String) -> String {
        var normalized = root.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else {
            return ""
        }

        if normalized == "/" {
            return normalized
        }

        while normalized.hasSuffix("/") {
            normalized.removeLast()
        }

        return normalized.isEmpty ? "/" : normalized
    }
}
