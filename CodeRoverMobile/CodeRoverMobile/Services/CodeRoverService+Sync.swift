// FILE: CodeRoverService+Sync.swift
// Purpose: Event-driven sync entry points and server-authoritative thread reconciliation.
// Layer: Service
// Exports: CodeRoverService sync APIs
// Depends on: ConversationThread, CodeRoverServiceError

import Foundation
import UIKit

private let activeThreadSyncIntervalNs: UInt64 = 3_000_000_000
private let threadListSyncIntervalNs: UInt64 = 12_000_000_000
private let runningWatchSyncIntervalNs: UInt64 = 5_000_000_000

extension CodeRoverService {
    func startSyncLoop() {
        guard canRunRealtimeSyncLoop else {
            stopSyncLoop()
            return
        }

        stopSyncLoop()
        debugSyncLog("sync loop start mode=event-driven")
        requestImmediateSync(threadId: activeThreadId)

        threadListSyncTask = Task { @MainActor [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: threadListSyncIntervalNs)
                guard self.canRunRealtimeSyncLoop else { break }
                await self.syncThreadsList()
            }
        }

        activeThreadSyncTask = Task { @MainActor [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: activeThreadSyncIntervalNs)
                guard self.canRunRealtimeSyncLoop else { break }
                guard let threadId = self.activeThreadId else { continue }
                await self.syncActiveThreadState(threadId: threadId)
            }
        }

        runningThreadWatchSyncTask = Task { @MainActor [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: runningWatchSyncIntervalNs)
                guard self.canRunRealtimeSyncLoop else { break }
                await self.refreshInactiveRunningBadgeThreads()
            }
        }
    }

    func stopSyncLoop() {
        threadListSyncTask?.cancel()
        threadListSyncTask = nil

        activeThreadSyncTask?.cancel()
        activeThreadSyncTask = nil

        runningThreadWatchSyncTask?.cancel()
        runningThreadWatchSyncTask = nil
    }

    func setForegroundState(_ isForeground: Bool) {
        guard isAppInForeground != isForeground else {
            return
        }

        isAppInForeground = isForeground
        if isForeground {
            _ = reloadSavedBridgePairingsFromSecureStoreIfNeeded()
            if isConnected && isInitialized {
                startSyncLoop()
                requestImmediateSync(threadId: activeThreadId)
            } else {
                stopSyncLoop()
            }
        } else {
            if isConnected && isInitialized {
                startSyncLoop()
                requestImmediateSync(threadId: activeThreadId)
            } else {
                stopSyncLoop()
            }
        }
        updateBackgroundRunGraceTask()
    }

    func requestImmediateSync(threadId: String? = nil) {
        guard canRunRealtimeSyncLoop else {
            debugSyncLog("requestImmediateSync skipped thread=\(threadId ?? activeThreadId ?? "none") canRun=false")
            return
        }

        debugSyncLog("requestImmediateSync thread=\(threadId ?? activeThreadId ?? "none")")

        Task { @MainActor [weak self] in
            guard let self else { return }
            await self.syncThreadsList()
            await self.refreshInactiveRunningBadgeThreads()
            if let threadId = threadId ?? self.activeThreadId {
                await self.syncActiveThreadState(threadId: threadId)
            }
        }
    }

    // Gives the visible Codex thread a short-lived catch-up window so reopen/manual
    // refresh paths can recover live output that is only present in resume snapshots.
    func primeDisplayedCodexThreadCatchUp(threadId: String, ttl: TimeInterval = 30) {
        guard activeThreadId == threadId,
              runtimeProviderID(for: threads.first(where: { $0.id == threadId })?.provider) == "codex" else {
            return
        }

        beginForegroundAggressivePolling(threadId: threadId, ttl: ttl)
    }

    func requestPrioritizedThreadSync(threadId: String) {
        primeDisplayedCodexThreadCatchUp(threadId: threadId)
        requestImmediateSync(threadId: threadId)
    }

    func syncThreadsList() async {
        guard isConnected, isInitialized else {
            return
        }

        do {
            let activePage = try await fetchServerThreadPage(limit: recentThreadListLimit)
            let activeThreads = activePage.threads
            activeThreadListNextCursor = activePage.nextCursor
            activeThreadListHasMore = activePage.hasMore

            // Also fetch server-archived threads so they survive app restarts.
            var archivedThreads: [ConversationThread] = []
            do {
                archivedThreads = try await fetchServerThreads(limit: recentThreadListLimit, archived: true)
            } catch {
                debugSyncLog("thread/list archived fetch failed (non-fatal): \(error.localizedDescription)")
            }

            reconcileLocalThreadsWithServer(activeThreads, serverArchivedThreads: archivedThreads)
            debugSyncLog("sync thread/list active=\(activeThreads.count) archived=\(archivedThreads.count) local=\(threads.count)")
        } catch {
            presentConnectionErrorIfNeeded(error)
        }
    }

    func syncThreadHistory(threadId: String, force: Bool = false) async {
        guard isConnected, isInitialized else {
            return
        }

        if threads.first(where: { $0.id == threadId })?.syncState == .archivedLocal {
            return
        }

        do {
            try await loadThreadHistoryIfNeeded(threadId: threadId, forceRefresh: force)
        } catch {
            if shouldTreatAsThreadNotFound(error) {
                // Do not archive on background sync alone.
                // Some servers can temporarily fail thread/read for fresh or stale listeners.
                // We archive only after an explicit turn/start send failure confirms missing thread.
                debugSyncLog("sync thread/read reported missing thread=\(threadId); waiting for send-time confirmation")
                return
            }
            if isHistoryRequestTimeoutError(error) {
                debugSyncLog("sync thread/read timed out thread=\(threadId); keeping connection alive")
                return
            }
            presentConnectionErrorIfNeeded(error)
        }
    }

    func reconcileLocalThreadsWithServer(
        _ serverThreads: [ConversationThread],
        serverArchivedThreads: [ConversationThread] = []
    ) {
        let localByID = Dictionary(uniqueKeysWithValues: threads.map { ($0.id, $0) })
        let persistedArchivedIDs = locallyArchivedThreadIDs
        let persistedDeletedIDs = locallyDeletedThreadIDs
        let serverArchivedIDs = Set(serverArchivedThreads.map(\.id))

        var merged: [String: ConversationThread] = [:]
        var invalidatedManagedHistoryThreadIDs: [String] = []

        // Merge active server threads.
        for serverThread in serverThreads {
            if persistedDeletedIDs.contains(serverThread.id) {
                continue
            }

            var liveThread = serverThread

            if let localThread = localByID[liveThread.id] {
                if shouldInvalidateManagedHistory(localThread: localThread, serverThread: serverThread) {
                    invalidateCachedHistory(for: liveThread.id)
                    invalidatedManagedHistoryThreadIDs.append(liveThread.id)
                }
                liveThread.syncState = localThread.syncState
                if liveThread.title == nil { liveThread.title = localThread.title }
                if liveThread.name == nil { liveThread.name = localThread.name }
                if liveThread.preview == nil { liveThread.preview = localThread.preview }
                if liveThread.createdAt == nil { liveThread.createdAt = localThread.createdAt }
                if liveThread.updatedAt == nil { liveThread.updatedAt = localThread.updatedAt }
                if liveThread.cwd == nil { liveThread.cwd = localThread.cwd }
                liveThread.metadata = mergedThreadMetadata(
                    serverMetadata: liveThread.metadata,
                    localMetadata: localThread.metadata
                )
            } else if persistedArchivedIDs.contains(liveThread.id) {
                liveThread.syncState = .archivedLocal
            } else {
                liveThread.syncState = .live
            }

            merged[liveThread.id] = liveThread
        }

        // Merge server-archived threads (from thread/list?archived=true).
        for serverThread in serverArchivedThreads {
            if persistedDeletedIDs.contains(serverThread.id) {
                continue
            }
            guard merged[serverThread.id] == nil else {
                continue
            }

            var archivedThread = serverThread
            archivedThread.syncState = .archivedLocal

            if let localThread = localByID[archivedThread.id] {
                if shouldInvalidateManagedHistory(localThread: localThread, serverThread: serverThread) {
                    invalidateCachedHistory(for: archivedThread.id)
                    invalidatedManagedHistoryThreadIDs.append(archivedThread.id)
                }
                if archivedThread.title == nil { archivedThread.title = localThread.title }
                if archivedThread.name == nil { archivedThread.name = localThread.name }
                if archivedThread.preview == nil { archivedThread.preview = localThread.preview }
                if archivedThread.createdAt == nil { archivedThread.createdAt = localThread.createdAt }
                if archivedThread.updatedAt == nil { archivedThread.updatedAt = localThread.updatedAt }
                if archivedThread.cwd == nil { archivedThread.cwd = localThread.cwd }
                archivedThread.metadata = mergedThreadMetadata(
                    serverMetadata: archivedThread.metadata,
                    localMetadata: localThread.metadata
                )
            }

            // Persist the archived state so it survives future reconciliations.
            addLocallyArchivedThreadID(archivedThread.id)
            merged[archivedThread.id] = archivedThread
        }

        // Keep local-only threads as-is; a missing entry in thread/list can be
        // caused by server-side pagination or temporary visibility mismatch.
        // We archive only on explicit "thread not found" from thread/read/turn/start.
        for localThread in threads where merged[localThread.id] == nil {
            if persistedDeletedIDs.contains(localThread.id) {
                continue
            }
            merged[localThread.id] = localThread
        }

        threads = sortThreads(Array(merged.values))

        if !invalidatedManagedHistoryThreadIDs.isEmpty {
            messagePersistence.save(
                messagesByThread: messagesByThread,
                historyStateByThread: historyStateByThread
            )
            debugSyncLog(
                "invalidated managed history cache threads=\(invalidatedManagedHistoryThreadIDs.joined(separator: ","))"
            )
        }

        if activeThreadId == nil {
            activeThreadId = threads.first(where: { $0.syncState == .live })?.id
        }
    }

    private func shouldInvalidateManagedHistory(
        localThread: ConversationThread,
        serverThread: ConversationThread
    ) -> Bool {
        let provider = serverThread.provider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard provider != "codex" else {
            return false
        }

        switch (localThread.updatedAt, serverThread.updatedAt) {
        case let (localDate?, serverDate?):
            return serverDate > localDate
        case (nil, .some):
            return true
        default:
            return false
        }
    }

    private func invalidateCachedHistory(for threadId: String) {
        cancelPerThreadRefreshWork(for: threadId)
        hydratedThreadIDs.remove(threadId)
        loadingThreadIDs.remove(threadId)
        resumedThreadIDs.remove(threadId)
        threadsWithPendingRemoteHistoryChange.remove(threadId)
        resumeSeededHistoryThreadIDs.remove(threadId)
        historyStateByThread.removeValue(forKey: threadId)
    }

    func handleMissingThread(_ threadId: String) {
        cancelPerThreadRefreshWork(for: threadId)
        runningThreadIDs.remove(threadId)
        protectedRunningFallbackThreadIDs.remove(threadId)
        clearOutcomeBadge(for: threadId)

        if let index = threads.firstIndex(where: { $0.id == threadId }) {
            threads[index].syncState = .archivedLocal
        } else {
            threads.append(ConversationThread(id: threadId, title: "Conversation", syncState: .archivedLocal))
            threads = sortThreads(threads)
        }

        hydratedThreadIDs.remove(threadId)
        loadingThreadIDs.remove(threadId)
        resumedThreadIDs.remove(threadId)
        threadsWithPendingRemoteHistoryChange.remove(threadId)
        resumeSeededHistoryThreadIDs.remove(threadId)
        lastPublishedMessageSignatureByThread.removeValue(forKey: threadId)
        foregroundAggressivePollingDeadlineByThread.removeValue(forKey: threadId)
        streamingSystemMessageByItemID = streamingSystemMessageByItemID.filter { key, _ in
            !key.hasPrefix("\(threadId)|item:")
        }

        if let turnId = activeTurnIdByThread.removeValue(forKey: threadId) {
            threadIdByTurnID.removeValue(forKey: turnId)
            if activeTurnId == turnId {
                activeTurnId = nil
            }
        }
        threadIdByTurnID = threadIdByTurnID.filter { $0.value != threadId }

        if var messages = messagesByThread[threadId] {
            var didMutate = false
            for index in messages.indices where messages[index].isStreaming {
                messages[index].isStreaming = false
                didMutate = true
            }
            if didMutate {
                messagesByThread[threadId] = messages
                persistMessages()
                updateCurrentOutput(for: threadId)
            }
        }

        debugSyncLog("thread archived locally: \(threadId)")
    }

    func archiveThread(_ threadId: String) {
        cancelPerThreadRefreshWork(for: threadId)
        runningThreadIDs.remove(threadId)
        protectedRunningFallbackThreadIDs.remove(threadId)
        clearOutcomeBadge(for: threadId)

        if let index = threads.firstIndex(where: { $0.id == threadId }) {
            threads[index].syncState = .archivedLocal
        }

        hydratedThreadIDs.remove(threadId)
        resumedThreadIDs.remove(threadId)
        threadsWithPendingRemoteHistoryChange.remove(threadId)
        resumeSeededHistoryThreadIDs.remove(threadId)
        foregroundAggressivePollingDeadlineByThread.removeValue(forKey: threadId)

        if let turnId = activeTurnIdByThread.removeValue(forKey: threadId) {
            threadIdByTurnID.removeValue(forKey: turnId)
            if activeTurnId == turnId { activeTurnId = nil }
        }
        threadIdByTurnID = threadIdByTurnID.filter { $0.value != threadId }

        addLocallyArchivedThreadID(threadId)
        debugSyncLog("thread archived by user: \(threadId)")
        sendThreadArchiveRPC(threadId: threadId, unarchive: false)
    }

    // Archives every active thread in a sidebar project group so the folder disappears from the live list.
    func archiveThreadGroup(threadIDs: [String]) -> [String] {
        let uniqueThreadIDs = Array(Set(threadIDs)).sorted()
        for threadID in uniqueThreadIDs {
            archiveThread(threadID)
        }

        debugSyncLog("thread group archived by user: count=\(uniqueThreadIDs.count)")
        return uniqueThreadIDs
    }

    func unarchiveThread(_ threadId: String) {
        if let index = threads.firstIndex(where: { $0.id == threadId }) {
            threads[index].syncState = .live
        }
        removeLocallyArchivedThreadID(threadId)
        debugSyncLog("thread unarchived by user: \(threadId)")
        sendThreadArchiveRPC(threadId: threadId, unarchive: true)
    }

    func deleteThread(_ threadId: String) {
        // Single-thread delete stays optimistic locally, then best-effort archives remotely.
        removeThreadLocally(threadId, persistAsDeleted: true)
        debugSyncLog("thread deleted by user: \(threadId)")
        sendThreadArchiveRPC(threadId: threadId, unarchive: false)
    }

    func renameThread(_ threadId: String, name: String) {
        // Optimistic local update.
        if let index = threads.firstIndex(where: { $0.id == threadId }) {
            threads[index].name = name
            threads[index].title = name
        }
        debugSyncLog("thread renamed by user: \(threadId) → \(name)")
        sendThreadNameSetRPC(threadId: threadId, name: name)
    }

    private func sendThreadNameSetRPC(threadId: String, name: String) {
        guard isConnected, webSocketConnection != nil else { return }
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                _ = try await self.sendRequest(
                    method: "thread/name/set",
                    params: .object([
                        "thread_id": .string(threadId),
                        "name": .string(name),
                    ])
                )
                self.debugSyncLog("thread/name/set RPC success: \(threadId)")
            } catch {
                self.debugSyncLog("thread/name/set RPC failed (non-fatal): \(error.localizedDescription)")
            }
        }
    }

    // Removes every thread in a sidebar group without issuing per-thread RPC mutations.
    func deleteLocalThreadGroup(threadIDs: [String]) -> [String] {
        for threadID in threadIDs {
            removeThreadLocally(threadID, persistAsDeleted: true)
        }

        debugSyncLog("thread group deleted locally: count=\(threadIDs.count)")
        return threadIDs
    }

    // Centralizes local-only thread cleanup so repo-group deletion can reuse it safely.
    private func removeThreadLocally(_ threadId: String, persistAsDeleted: Bool) {
        cancelPerThreadRefreshWork(for: threadId)
        runningThreadIDs.remove(threadId)
        protectedRunningFallbackThreadIDs.remove(threadId)
        clearOutcomeBadge(for: threadId)

        threads.removeAll { $0.id == threadId }
        messagesByThread.removeValue(forKey: threadId)
        threadTimelineStateByThread.removeValue(forKey: threadId)
        lastPublishedMessageSignatureByThread.removeValue(forKey: threadId)
        foregroundAggressivePollingDeadlineByThread.removeValue(forKey: threadId)
        messagePersistence.save(
            messagesByThread: messagesByThread,
            historyStateByThread: historyStateByThread
        )

        hydratedThreadIDs.remove(threadId)
        loadingThreadIDs.remove(threadId)
        resumedThreadIDs.remove(threadId)
        threadsWithPendingRemoteHistoryChange.remove(threadId)
        resumeSeededHistoryThreadIDs.remove(threadId)
        streamingSystemMessageByItemID = streamingSystemMessageByItemID.filter { key, _ in
            !key.hasPrefix("\(threadId)|item:")
        }

        if let turnId = activeTurnIdByThread.removeValue(forKey: threadId) {
            threadIdByTurnID.removeValue(forKey: turnId)
            if activeTurnId == turnId { activeTurnId = nil }
        }
        threadIdByTurnID = threadIdByTurnID.filter { $0.value != threadId }

        if activeThreadId == threadId { activeThreadId = nil }

        removeLocallyArchivedThreadID(threadId)
        if persistAsDeleted {
            addLocallyDeletedThreadID(threadId)
        }
    }

    func clearHydrationCaches() {
        hydratedThreadIDs.removeAll()
        loadingThreadIDs.removeAll()
        threadsWithPendingRemoteHistoryChange.removeAll()
        resumeSeededHistoryThreadIDs.removeAll()
        cancelAllPerThreadRefreshWork()
    }

    func invalidatePerThreadRefreshGeneration(for threadId: String) {
        threadRefreshGenerationByThreadID[threadId, default: 0] &+= 1
    }

    func currentPerThreadRefreshGeneration(for threadId: String) -> UInt64 {
        threadRefreshGenerationByThreadID[threadId] ?? 0
    }

    func isPerThreadRefreshCurrent(for threadId: String, generation: UInt64) -> Bool {
        currentPerThreadRefreshGeneration(for: threadId) == generation
    }

    func normalizedThreadSyncEpoch(_ value: Int?) -> Int {
        guard let value, value >= 1 else {
            return 1
        }
        return value
    }

    @discardableResult
    func acceptThreadSyncMetadata(
        threadId: String,
        syncEpoch: Int?,
        sourceKind: String?,
        generation: UInt64? = nil
    ) -> Bool {
        let incomingEpoch = normalizedThreadSyncEpoch(syncEpoch)
        let currentEpoch = normalizedThreadSyncEpoch(threadSyncEpochByThreadID[threadId])

        if incomingEpoch < currentEpoch {
            debugSyncLog(
                "drop stale sync thread=\(threadId) incomingEpoch=\(incomingEpoch) currentEpoch=\(currentEpoch)"
            )
            return false
        }

        if incomingEpoch == currentEpoch,
           let generation,
           !isPerThreadRefreshCurrent(for: threadId, generation: generation) {
            debugSyncLog(
                "drop stale generation thread=\(threadId) epoch=\(incomingEpoch) generation=\(generation)"
            )
            return false
        }

        threadSyncEpochByThreadID[threadId] = incomingEpoch
        if let sourceKind = sourceKind?.trimmingCharacters(in: .whitespacesAndNewlines),
           !sourceKind.isEmpty {
            threadSyncSourceKindByThreadID[threadId] = sourceKind
        }
        return true
    }

    func decodeThreadSyncMetadata(
        from object: [String: JSONValue]?
    ) -> (syncEpoch: Int?, sourceKind: String?) {
        (
            object?["syncEpoch"]?.intValue
                ?? object?["sync_epoch"]?.intValue,
            object?["sourceKind"]?.stringValue
                ?? object?["source_kind"]?.stringValue
                ?? object?["projectionSource"]?.stringValue
                ?? object?["projection_source"]?.stringValue
        )
    }

    func cancelPerThreadRefreshWork(for threadId: String) {
        invalidatePerThreadRefreshGeneration(for: threadId)
        loadingThreadIDs.remove(threadId)
        threadHistoryLoadTaskByThreadID[threadId]?.cancel()
        threadHistoryLoadTaskByThreadID.removeValue(forKey: threadId)
        forcedHistoryLoadThreadIDs.remove(threadId)
        threadResumeTaskByThreadID[threadId]?.cancel()
        threadResumeTaskByThreadID.removeValue(forKey: threadId)
        threadResumeRequestSignatureByThreadID.removeValue(forKey: threadId)
        forcedResumeEscalationThreadIDs.remove(threadId)
        turnStateRefreshTaskByThreadID[threadId]?.cancel()
        turnStateRefreshTaskByThreadID.removeValue(forKey: threadId)
        canonicalHistoryReconcileTaskByThreadID[threadId]?.cancel()
        canonicalHistoryReconcileTaskByThreadID.removeValue(forKey: threadId)
        threadSyncEpochByThreadID.removeValue(forKey: threadId)
        threadSyncSourceKindByThreadID.removeValue(forKey: threadId)
        threadsNeedingCanonicalHistoryReconcile.remove(threadId)
        threadsWithPendingRemoteHistoryChange.remove(threadId)
    }

    func cancelAllPerThreadRefreshWork() {
        let invalidatedThreadIDs = Set(threadHistoryLoadTaskByThreadID.keys)
            .union(threadResumeTaskByThreadID.keys)
            .union(turnStateRefreshTaskByThreadID.keys)
            .union(forcedHistoryLoadThreadIDs)
            .union(forcedResumeEscalationThreadIDs)
            .union(threadResumeRequestSignatureByThreadID.keys)
            .union(canonicalHistoryReconcileTaskByThreadID.keys)
        invalidatedThreadIDs.forEach { invalidatePerThreadRefreshGeneration(for: $0) }
        loadingThreadIDs.removeAll()
        threadHistoryLoadTaskByThreadID.values.forEach { $0.cancel() }
        threadHistoryLoadTaskByThreadID.removeAll()
        forcedHistoryLoadThreadIDs.removeAll()
        threadResumeTaskByThreadID.values.forEach { $0.cancel() }
        threadResumeTaskByThreadID.removeAll()
        threadResumeRequestSignatureByThreadID.removeAll()
        forcedResumeEscalationThreadIDs.removeAll()
        turnStateRefreshTaskByThreadID.values.forEach { $0.cancel() }
        turnStateRefreshTaskByThreadID.removeAll()
        canonicalHistoryReconcileTaskByThreadID.values.forEach { $0.cancel() }
        canonicalHistoryReconcileTaskByThreadID.removeAll()
        threadSyncEpochByThreadID.removeAll()
        threadSyncSourceKindByThreadID.removeAll()
        threadsNeedingCanonicalHistoryReconcile.removeAll()
        threadsWithPendingRemoteHistoryChange.removeAll()
    }

    func scheduleCanonicalHistoryReconcileIfNeeded(for threadId: String) {
        guard threadsNeedingCanonicalHistoryReconcile.contains(threadId),
              canonicalHistoryReconcileTaskByThreadID[threadId] == nil,
              isConnected,
              !threadHasActiveOrRunningTurn(threadId),
              thread(for: threadId)?.syncState == .live else {
            return
        }

        canonicalHistoryReconcileTaskByThreadID[threadId] = Task { @MainActor [weak self] in
            defer {
                self?.canonicalHistoryReconcileTaskByThreadID.removeValue(forKey: threadId)
            }

            guard let self,
                  self.threadsNeedingCanonicalHistoryReconcile.contains(threadId),
                  self.isConnected,
                  !self.threadHasActiveOrRunningTurn(threadId),
                  self.thread(for: threadId)?.syncState == .live else {
                return
            }

            do {
                let outcome = try await self.loadThreadHistoryIfNeeded(threadId: threadId, forceRefresh: true)
                guard !Task.isCancelled else { return }
                if outcome.didCompleteCanonicalReconcile {
                    self.markThreadCanonicalHistoryReconciled(threadId)
                }
            } catch is CancellationError {
                return
            } catch {
                if self.shouldTreatAsThreadNotFound(error) {
                    self.threadsNeedingCanonicalHistoryReconcile.remove(threadId)
                    self.handleMissingThread(threadId)
                }
            }
        }
    }

    func markThreadNeedingCanonicalHistoryReconcile(_ threadId: String) {
        threadsNeedingCanonicalHistoryReconcile.insert(threadId)
        scheduleCanonicalHistoryReconcileIfNeeded(for: threadId)
    }

    func markThreadCanonicalHistoryReconciled(_ threadId: String) {
        threadsNeedingCanonicalHistoryReconcile.remove(threadId)
    }

    func shouldTreatAsThreadNotFound(_ error: Error) -> Bool {
        let message: String
        if let serviceError = error as? CodeRoverServiceError,
           case .rpcError(let rpcError) = serviceError {
            message = rpcError.message.lowercased()
        } else {
            message = error.localizedDescription.lowercased()
        }

        if message.contains("not materialized") || message.contains("not yet materialized") {
            return false
        }
        return message.contains("thread not found") || message.contains("unknown thread")
    }

    // Preserves locally derived metadata keys (for example repo context) when server payload is sparse.
    func mergedThreadMetadata(
        serverMetadata: [String: JSONValue]?,
        localMetadata: [String: JSONValue]?
    ) -> [String: JSONValue]? {
        var merged = serverMetadata ?? [:]
        for (key, value) in localMetadata ?? [:] where merged[key] == nil {
            merged[key] = value
        }
        return merged.isEmpty ? nil : merged
    }

    func debugSyncLog(_ message: String) {
        coderoverDiagnosticLog("CodeRoverSync", message)
    }

    // Treats thread as active if either turn mapping or runtime running fallback is present.
    func threadHasActiveOrRunningTurn(_ threadId: String) -> Bool {
        activeTurnID(for: threadId) != nil
            || runningThreadIDs.contains(threadId)
            || protectedRunningFallbackThreadIDs.contains(threadId)
    }

    // Keeps short-lived background execution alive when a run is still in flight.
    var hasAnyRunningTurn: Bool {
        !runningThreadIDs.isEmpty
            || !protectedRunningFallbackThreadIDs.isEmpty
            || !activeTurnIdByThread.isEmpty
    }

    var canRunRealtimeSyncLoop: Bool {
        syncRealtimeEnabled && isConnected && isInitialized
    }

    // Polls the currently displayed thread even while it is running so missed socket events can recover.
    // If the live snapshot fails, fall back to a history refresh instead of trusting stale running state.
    func syncActiveThreadState(threadId: String) async {
        let wasRunning = threadHasActiveOrRunningTurn(threadId)
        let shouldUseAggressiveForegroundPolling = shouldUseAggressiveForegroundPolling(for: threadId)
        if wasRunning {
            _ = await refreshInFlightTurnState(threadId: threadId)
        }

        let isRunningAfterRefresh = threadHasActiveOrRunningTurn(threadId)

        // A reconnect/background transition can leave the current thread onscreen while the
        // realtime stream was interrupted. Force one live resume snapshot on every running-thread
        // poll so the open timeline catches up even when the user never leaves the conversation.
        if wasRunning || isRunningAfterRefresh || shouldUseAggressiveForegroundPolling {
            _ = try? await ensureThreadResumed(threadId: threadId, force: true)
        }

        if shouldUseAggressiveForegroundPolling {
            do {
                try await loadTailThreadHistory(
                    threadId: threadId,
                    replaceLocalHistory: false,
                    refreshGeneration: currentPerThreadRefreshGeneration(for: threadId)
                )
            } catch {
                debugSyncLog(
                    "foreground codex tail refresh failed thread=\(threadId): \(error.localizedDescription)"
                )
                await syncThreadHistory(threadId: threadId, force: true)
            }
            return
        }

        await syncThreadHistory(threadId: threadId, force: true)
    }

    func beginForegroundAggressivePolling(threadId: String, ttl: TimeInterval = 90) {
        guard !threadId.isEmpty else {
            return
        }
        let deadline = Date().addingTimeInterval(ttl)
        if let currentDeadline = foregroundAggressivePollingDeadlineByThread[threadId],
           currentDeadline > deadline {
            return
        }
        foregroundAggressivePollingDeadlineByThread[threadId] = deadline
    }

    func endForegroundAggressivePolling(threadId: String) {
        guard !threadId.isEmpty else {
            return
        }
        foregroundAggressivePollingDeadlineByThread.removeValue(forKey: threadId)
    }

    func shouldUseAggressiveForegroundPolling(for threadId: String) -> Bool {
        guard isAppInForeground,
              activeThreadId == threadId,
              threads.first(where: { $0.id == threadId })?.provider == "codex" else {
            return false
        }

        if threadHasActiveOrRunningTurn(threadId) {
            return true
        }

        guard let deadline = foregroundAggressivePollingDeadlineByThread[threadId] else {
            return false
        }
        if deadline > Date() {
            return true
        }

        foregroundAggressivePollingDeadlineByThread.removeValue(forKey: threadId)
        return false
    }

    func refreshInactiveRunningBadgeThreads(limit: Int = 3) async {
        pruneRunningThreadWatchlist()

        let availableThreadIDs = Set(threads.map(\.id))
        let candidateThreadIDs = runningThreadWatchByID.values
            .sorted { lhs, rhs in
                lhs.expiresAt < rhs.expiresAt
            }
            .map(\.threadId)
            .filter { threadId in
                threadId != activeThreadId
                    && availableThreadIDs.contains(threadId)
                    && runningThreadIDs.contains(threadId)
            }
            .prefix(limit)

        for threadId in candidateThreadIDs {
            let wasRunning = threadHasActiveOrRunningTurn(threadId)
            let didRefresh = await refreshInFlightTurnState(threadId: threadId)

            guard !didRefresh || !wasRunning || !threadHasActiveOrRunningTurn(threadId) else {
                continue
            }

            await syncThreadHistory(threadId: threadId, force: true)
            if !failedThreadIDs.contains(threadId) {
                markReadyIfUnread(threadId: threadId)
            }
            clearRunningThreadWatch(threadId)
        }
    }

    func pruneRunningThreadWatchlist(now: Date = Date()) {
        runningThreadWatchByID = runningThreadWatchByID.filter { _, watch in
            watch.expiresAt > now
        }
    }

    // Starts or ends the iOS grace window that lets a just-backgrounded run finish cleanly.
    func updateBackgroundRunGraceTask() {
        guard !isAppInForeground else {
            endBackgroundRunGraceTask(reason: "foreground")
            return
        }

        guard hasAnyRunningTurn else {
            endBackgroundRunGraceTask(reason: "idle")
            return
        }

        guard backgroundTurnGraceTaskID == .invalid else {
            return
        }

        let taskID = UIApplication.shared.beginBackgroundTask(withName: "CodeRoverRunGrace") { [weak self] in
            Task { @MainActor [weak self] in
                self?.endBackgroundRunGraceTask(reason: "expired")
            }
        }

        guard taskID != .invalid else {
            debugSyncLog("background run grace task unavailable")
            return
        }

        backgroundTurnGraceTaskID = taskID
        debugSyncLog("background run grace task started")
    }

    func endBackgroundRunGraceTask(reason: String) {
        guard backgroundTurnGraceTaskID != .invalid else {
            return
        }

        let taskID = backgroundTurnGraceTaskID
        backgroundTurnGraceTaskID = .invalid
        UIApplication.shared.endBackgroundTask(taskID)
        debugSyncLog("background run grace task ended reason=\(reason)")
    }

    /// Best-effort server-side archive/unarchive. Failures are logged but never
    /// surface to the user or trigger reconnection side-effects.
    private func sendThreadArchiveRPC(threadId: String, unarchive: Bool) {
        guard isConnected, webSocketConnection != nil else { return }
        let method = unarchive ? "thread/unarchive" : "thread/archive"
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                _ = try await self.sendRequest(method: method, params: .object(["threadId": .string(threadId)]))
                self.debugSyncLog("\(method) RPC success: \(threadId)")
            } catch {
                self.debugSyncLog("\(method) RPC failed (non-fatal): \(error.localizedDescription)")
            }
        }
    }

    // MARK: - Persisted archive/delete sets

    private static let locallyDeletedThreadIDsKey = "coderover.locallyDeletedThreadIDs"

    var locallyArchivedThreadIDs: Set<String> {
        Set(defaults.stringArray(forKey: Self.locallyArchivedThreadIDsKey) ?? [])
    }

    var locallyDeletedThreadIDs: Set<String> {
        Set(defaults.stringArray(forKey: Self.locallyDeletedThreadIDsKey) ?? [])
    }

    private func addLocallyArchivedThreadID(_ threadId: String) {
        var ids = locallyArchivedThreadIDs
        ids.insert(threadId)
        defaults.set(Array(ids), forKey: Self.locallyArchivedThreadIDsKey)
    }

    private func removeLocallyArchivedThreadID(_ threadId: String) {
        var ids = locallyArchivedThreadIDs
        ids.remove(threadId)
        defaults.set(Array(ids), forKey: Self.locallyArchivedThreadIDsKey)
    }

    private func addLocallyDeletedThreadID(_ threadId: String) {
        var ids = locallyDeletedThreadIDs
        ids.insert(threadId)
        defaults.set(Array(ids), forKey: Self.locallyDeletedThreadIDsKey)
    }
}
