// FILE: CodeRoverService+Helpers.swift
// Purpose: Shared utility helpers for model decoding and thread bookkeeping.
// Layer: Service
// Exports: CodeRoverService helpers
// Depends on: Foundation

import Foundation

private func normalizedNonEmptyString(_ value: String?) -> String? {
    let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return trimmed.isEmpty ? nil : trimmed
}

extension CodeRoverService {
    struct SavedBridgePairingsRestoreResult {
        let pairings: [CodeRoverBridgePairingRecord]
        let activePairingMacDeviceId: String?
        let shouldPersistNormalizedPairings: Bool
    }

    func rebuildThreadLookupCaches() {
        threadByID = Dictionary(uniqueKeysWithValues: threads.map { ($0.id, $0) })
        threadIndexByID = Dictionary(
            uniqueKeysWithValues: threads.enumerated().map { index, thread in
                (thread.id, index)
            }
        )
        firstLiveThreadIDCache = threads.first(where: { $0.syncState == .live })?.id
        refreshSubagentIdentityDirectoryFromThreads()
    }

    func thread(for threadId: String) -> ConversationThread? {
        threadByID[threadId]
    }

    func threadIndex(for threadId: String) -> Int? {
        threadIndexByID[threadId]
    }

    func firstLiveThreadID() -> String? {
        firstLiveThreadIDCache
    }

    func resolveThreadID(_ preferredThreadID: String?) async throws -> String {
        if let preferredThreadID, !preferredThreadID.isEmpty {
            return preferredThreadID
        }

        if let activeThreadId, !activeThreadId.isEmpty {
            return activeThreadId
        }

        let newThread = try await startThread()
        return newThread.id
    }

    func upsertThread(_ thread: ConversationThread) {
        let resolvedThread = mergedThread(thread, with: self.thread(for: thread.id))
        let derivedIdentity = resolvedThread.derivedSubagentIdentity
        upsertSubagentIdentity(
            threadId: resolvedThread.id,
            agentId: resolvedThread.agentId,
            nickname: resolvedThread.agentNickname ?? derivedIdentity?.nickname,
            role: resolvedThread.agentRole ?? derivedIdentity?.role
        )

        if let existingIndex = threadIndex(for: thread.id) {
            threads[existingIndex] = resolvedThread
        } else {
            threads.append(resolvedThread)
        }

        threads = sortThreads(threads)
    }

    func mergedThread(_ incoming: ConversationThread, with existing: ConversationThread?) -> ConversationThread {
        guard let existing else {
            return incoming
        }

        var merged = incoming
        if merged.title == nil { merged.title = existing.title }
        if merged.name == nil { merged.name = existing.name }
        if merged.preview == nil { merged.preview = existing.preview }
        if merged.createdAt == nil { merged.createdAt = existing.createdAt }
        if merged.updatedAt == nil { merged.updatedAt = existing.updatedAt }
        if merged.cwd == nil { merged.cwd = existing.cwd }
        if merged.providerSessionId == nil { merged.providerSessionId = existing.providerSessionId }
        if merged.capabilities == nil { merged.capabilities = existing.capabilities }
        merged.metadata = mergedThreadMetadata(
            serverMetadata: merged.metadata,
            localMetadata: existing.metadata
        )
        if merged.parentThreadId == nil { merged.parentThreadId = existing.parentThreadId }
        if merged.agentId == nil { merged.agentId = existing.agentId }
        if merged.agentNickname == nil { merged.agentNickname = existing.agentNickname }
        if merged.agentRole == nil { merged.agentRole = existing.agentRole }
        if merged.model == nil { merged.model = existing.model }
        if merged.modelProvider == nil { merged.modelProvider = existing.modelProvider }
        return merged
    }

    func registerSubagentThreads(action: CodeRoverSubagentAction, parentThreadId: String) {
        guard !parentThreadId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return
        }

        let parentThread = thread(for: parentThreadId)
        upsertSubagentIdentity(action: action)

        for agent in action.agentRows {
            let childThreadId = agent.threadId.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !childThreadId.isEmpty, childThreadId != parentThreadId else {
                continue
            }

            let existing = thread(for: childThreadId)
            let placeholderTimestamp = existing?.updatedAt
                ?? existing?.createdAt
                ?? parentThread?.updatedAt
                ?? parentThread?.createdAt
                ?? Date()
            let placeholder = ConversationThread(
                id: childThreadId,
                title: nil,
                name: nil,
                preview: existing?.preview,
                createdAt: existing?.createdAt ?? placeholderTimestamp,
                updatedAt: existing?.updatedAt ?? placeholderTimestamp,
                cwd: existing?.cwd ?? parentThread?.cwd,
                provider: existing?.provider ?? parentThread?.provider ?? "codex",
                providerSessionId: existing?.providerSessionId,
                capabilities: existing?.capabilities ?? parentThread?.capabilities,
                metadata: existing?.metadata,
                parentThreadId: parentThreadId,
                agentId: agent.agentId,
                agentNickname: agent.nickname,
                agentRole: agent.role,
                model: existing?.model ?? (agent.modelIsRequestedHint ? nil : agent.model),
                modelProvider: existing?.modelProvider ?? (agent.modelIsRequestedHint ? nil : agent.model),
                syncState: existing?.syncState ?? parentThread?.syncState ?? .live
            )
            upsertThread(placeholder)
        }
    }

    func registerSubagentThreads(from messages: [ChatMessage], parentThreadId: String) {
        for action in messages.compactMap(\.subagentAction) {
            registerSubagentThreads(action: action, parentThreadId: parentThreadId)
        }
    }

    func refreshSubagentIdentityDirectoryFromThreads() {
        var didChange = false
        for thread in threads {
            let derivedIdentity = thread.derivedSubagentIdentity
            if upsertSubagentIdentity(
                threadId: thread.id,
                agentId: thread.agentId,
                nickname: thread.agentNickname ?? derivedIdentity?.nickname,
                role: thread.agentRole ?? derivedIdentity?.role,
                incrementVersion: false
            ) {
                didChange = true
            }
        }
        if didChange {
            subagentIdentityVersion &+= 1
        }
    }

    func upsertSubagentIdentity(action: CodeRoverSubagentAction, incrementVersion: Bool = true) {
        for agent in action.receiverAgents {
            upsertSubagentIdentity(
                threadId: agent.threadId,
                agentId: agent.agentId,
                nickname: agent.nickname,
                role: agent.role,
                incrementVersion: incrementVersion
            )
        }
    }

    func resolvedSubagentIdentity(threadId: String?, agentId: String?) -> CodeRoverSubagentIdentityEntry? {
        let normalizedThreadId = normalizedIdentifier(threadId)
        let normalizedAgentId = normalizedIdentifier(agentId)

        let threadEntry = normalizedThreadId.flatMap { subagentIdentityByThreadID[$0] }
        let agentEntry = normalizedAgentId.flatMap { subagentIdentityByAgentID[$0] }

        let merged = CodeRoverSubagentIdentityEntry(
            threadId: threadEntry?.threadId ?? agentEntry?.threadId ?? normalizedThreadId,
            agentId: threadEntry?.agentId ?? agentEntry?.agentId ?? normalizedAgentId,
            nickname: threadEntry?.nickname ?? agentEntry?.nickname,
            role: threadEntry?.role ?? agentEntry?.role
        )

        return merged.hasMetadata ? merged : nil
    }

    func resolvedSubagentDisplayLabel(threadId: String?, agentId: String?) -> String? {
        if let normalizedThreadId = normalizedIdentifier(threadId),
           let thread = thread(for: normalizedThreadId),
           let preferredLabel = thread.preferredSubagentLabel {
            return preferredLabel
        }

        let resolved = resolvedSubagentIdentity(threadId: threadId, agentId: agentId)
        let nickname = normalizedIdentifier(resolved?.nickname)
        let role = normalizedIdentifier(resolved?.role)

        if let nickname, let role {
            return "\(nickname) [\(role)]"
        }
        if let nickname {
            return nickname
        }
        if let role {
            return role.capitalized
        }

        return nil
    }

    func loadSubagentThreadMetadataIfNeeded(threadId: String) async {
        await loadSubagentThreadMetadataIfNeeded(threadIds: [threadId])
    }

    func loadSubagentThreadMetadataIfNeeded(threadIds: [String]) async {
        let normalizedThreadIds = uniqueNormalizedThreadIDs(threadIds)
        guard !normalizedThreadIds.isEmpty else {
            return
        }

        var didAttemptLoad = false
        for normalizedThreadId in normalizedThreadIds {
            if await loadSingleSubagentThreadMetadataIfNeeded(threadId: normalizedThreadId) {
                didAttemptLoad = true
            }
        }

        if didAttemptLoad {
            refreshSubagentIdentityDirectoryFromThreads()
        }
    }

    private func loadSingleSubagentThreadMetadataIfNeeded(threadId: String) async -> Bool {
        let existingThread = thread(for: threadId)
        let hasResolvedIdentity = existingThread?.preferredSubagentLabel != nil
            || normalizedIdentifier(existingThread?.agentNickname) != nil
            || normalizedIdentifier(existingThread?.agentRole) != nil
        guard !hasResolvedIdentity else {
            return false
        }

        let shouldForceRefresh = hydratedThreadIDs.contains(threadId)
        try? await loadThreadHistoryIfNeeded(threadId: threadId, forceRefresh: shouldForceRefresh)
        return true
    }

    private func uniqueNormalizedThreadIDs(_ threadIds: [String]) -> [String] {
        var seen: Set<String> = []
        var result: [String] = []

        for threadId in threadIds {
            guard let normalizedThreadId = normalizedIdentifier(threadId),
                  !seen.contains(normalizedThreadId) else {
                continue
            }
            seen.insert(normalizedThreadId)
            result.append(normalizedThreadId)
        }

        return result
    }

    @discardableResult
    func upsertSubagentIdentity(
        threadId: String?,
        agentId: String?,
        nickname: String?,
        role: String?,
        incrementVersion: Bool = true
    ) -> Bool {
        let normalizedThreadId = normalizedIdentifier(threadId)
        let normalizedAgentId = normalizedIdentifier(agentId)
        let normalizedNickname = normalizedIdentifier(nickname)
        let normalizedRole = normalizedIdentifier(role)

        guard normalizedThreadId != nil || normalizedAgentId != nil || normalizedNickname != nil || normalizedRole != nil else {
            return false
        }

        let threadEntry = normalizedThreadId.flatMap { subagentIdentityByThreadID[$0] }
        let agentEntry = normalizedAgentId.flatMap { subagentIdentityByAgentID[$0] }
        let merged = CodeRoverSubagentIdentityEntry(
            threadId: normalizedThreadId ?? threadEntry?.threadId ?? agentEntry?.threadId,
            agentId: normalizedAgentId ?? threadEntry?.agentId ?? agentEntry?.agentId,
            nickname: normalizedNickname ?? threadEntry?.nickname ?? agentEntry?.nickname,
            role: normalizedRole ?? threadEntry?.role ?? agentEntry?.role
        )

        guard merged.hasMetadata else { return false }

        var didChange = false
        if let normalizedThreadId, subagentIdentityByThreadID[normalizedThreadId] != merged {
            subagentIdentityByThreadID[normalizedThreadId] = merged
            didChange = true
        }
        if let normalizedAgentId, subagentIdentityByAgentID[normalizedAgentId] != merged {
            subagentIdentityByAgentID[normalizedAgentId] = merged
            didChange = true
        }
        if let linkedThreadId = merged.threadId,
           let linkedAgentId = merged.agentId {
            if subagentIdentityByThreadID[linkedThreadId] != merged {
                subagentIdentityByThreadID[linkedThreadId] = merged
                didChange = true
            }
            if subagentIdentityByAgentID[linkedAgentId] != merged {
                subagentIdentityByAgentID[linkedAgentId] = merged
                didChange = true
            }
        }

        if incrementVersion, didChange {
            subagentIdentityVersion &+= 1
        }
        return didChange
    }

    func resolvedSubagentPresentation(
        _ presentation: CodeRoverSubagentThreadPresentation,
        parentThreadId: String
    ) -> CodeRoverSubagentThreadPresentation {
        let normalizedParentThreadId = normalizedIdentifier(parentThreadId) ?? parentThreadId
        let normalizedThreadId = normalizedIdentifier(presentation.threadId)
        let normalizedAgentId = normalizedIdentifier(presentation.agentId)

        var resolvedThreadId = normalizedThreadId
        var resolvedAgentId = normalizedAgentId
        var resolvedNickname = normalizedIdentifier(presentation.nickname)
        var resolvedRole = normalizedIdentifier(presentation.role)
        var resolvedModel = normalizedIdentifier(presentation.model)
        var resolvedModelIsRequestedHint = presentation.modelIsRequestedHint
        var resolvedPrompt = normalizedIdentifier(presentation.prompt)

        if let directoryIdentity = resolvedSubagentIdentity(threadId: normalizedThreadId, agentId: normalizedAgentId) {
            resolvedThreadId = directoryIdentity.threadId ?? resolvedThreadId
            resolvedAgentId = directoryIdentity.agentId ?? resolvedAgentId
            resolvedNickname = directoryIdentity.nickname ?? resolvedNickname
            resolvedRole = directoryIdentity.role ?? resolvedRole
        }

        func mergeThreadMetadata(_ thread: ConversationThread?) {
            guard let thread else { return }
            if resolvedThreadId == nil { resolvedThreadId = normalizedIdentifier(thread.id) }
            if let threadAgentId = normalizedIdentifier(thread.agentId) {
                resolvedAgentId = threadAgentId
            }
            if let threadNickname = normalizedIdentifier(thread.agentNickname) {
                resolvedNickname = threadNickname
            }
            if let threadRole = normalizedIdentifier(thread.agentRole) {
                resolvedRole = threadRole
            }
            if let derivedIdentity = thread.derivedSubagentIdentity {
                if let derivedNickname = normalizedIdentifier(derivedIdentity.nickname) {
                    resolvedNickname = derivedNickname
                }
                if let derivedRole = normalizedIdentifier(derivedIdentity.role) {
                    resolvedRole = derivedRole
                }
            }
            if let threadModel = normalizedIdentifier(thread.modelDisplayLabel) {
                resolvedModel = threadModel
                resolvedModelIsRequestedHint = false
            }
        }

        if let normalizedThreadId {
            mergeThreadMetadata(thread(for: normalizedThreadId))
        }

        let lookupIdentifiers = Set([normalizedThreadId, normalizedAgentId].compactMap { $0 })
        if !lookupIdentifiers.isEmpty {
            let parentMessages = messagesByThread[normalizedParentThreadId] ?? []

            outer: for message in parentMessages.reversed() {
                guard let action = message.subagentAction else { continue }
                for candidate in action.agentRows.reversed() {
                    let candidateThreadId = normalizedIdentifier(candidate.threadId)
                    let candidateAgentId = normalizedIdentifier(candidate.agentId)
                    let matchedIdentifiers = Set([candidateThreadId, candidateAgentId].compactMap { $0 })
                    guard !lookupIdentifiers.isDisjoint(with: matchedIdentifiers) else {
                        continue
                    }

                    if resolvedThreadId == nil, let candidateThreadId {
                        resolvedThreadId = candidateThreadId
                    }
                    if resolvedAgentId == nil, let candidateAgentId {
                        resolvedAgentId = candidateAgentId
                    }
                    if resolvedNickname == nil {
                        resolvedNickname = normalizedIdentifier(candidate.nickname)
                    }
                    if resolvedRole == nil {
                        resolvedRole = normalizedIdentifier(candidate.role)
                    }
                    if resolvedModel == nil {
                        resolvedModel = normalizedIdentifier(candidate.model)
                        resolvedModelIsRequestedHint = candidate.modelIsRequestedHint
                    }
                    if resolvedPrompt == nil {
                        resolvedPrompt = normalizedIdentifier(candidate.prompt)
                    }

                    upsertSubagentIdentity(
                        threadId: candidateThreadId,
                        agentId: candidateAgentId,
                        nickname: candidate.nickname,
                        role: candidate.role,
                        incrementVersion: false
                    )

                    if let candidateThreadId {
                        mergeThreadMetadata(thread(for: candidateThreadId))
                    }
                    break outer
                }
            }
        }

        let finalThreadId = resolvedThreadId ?? normalizedThreadId ?? presentation.threadId
        return CodeRoverSubagentThreadPresentation(
            threadId: finalThreadId,
            agentId: resolvedAgentId,
            nickname: resolvedNickname,
            role: resolvedRole,
            model: resolvedModel,
            modelIsRequestedHint: resolvedModelIsRequestedHint,
            prompt: resolvedPrompt,
            fallbackStatus: presentation.fallbackStatus,
            fallbackMessage: presentation.fallbackMessage
        )
    }

    func sortThreads(_ value: [ConversationThread]) -> [ConversationThread] {
        value.sorted { lhs, rhs in
            let lhsDate = lhs.updatedAt ?? lhs.createdAt ?? Date.distantPast
            let rhsDate = rhs.updatedAt ?? rhs.createdAt ?? Date.distantPast
            return lhsDate > rhsDate
        }
    }

    func decodeModel<T: Decodable>(_ type: T.Type, from value: JSONValue) -> T? {
        guard let data = try? encoder.encode(value) else {
            return nil
        }

        return try? decoder.decode(type, from: data)
    }

    func rememberSuccessfulTransportURL(_ url: String) {
        let normalized = url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else {
            return
        }
        lastSuccessfulTransportURL = normalized
        guard activeSavedBridgePairing != nil else {
            SecureStore.writeString(normalized, for: CodeRoverSecureKeys.pairingLastSuccessfulTransportURL)
            return
        }
        updateActiveSavedBridgePairing { pairing in
            pairing.lastSuccessfulTransportURL = normalized
        }
    }

    func setPreferredTransportURL(_ url: String?) {
        let trimmed = url?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let normalized = trimmed.isEmpty ? nil : trimmed
        preferredTransportURL = normalized
        guard activeSavedBridgePairing != nil else {
            if let normalized {
                SecureStore.writeString(normalized, for: CodeRoverSecureKeys.pairingPreferredTransportURL)
            } else {
                SecureStore.deleteValue(for: CodeRoverSecureKeys.pairingPreferredTransportURL)
            }
            return
        }
        updateActiveSavedBridgePairing { pairing in
            pairing.preferredTransportURL = normalized
        }
    }

    func setActiveSavedBridgePairing(macDeviceId: String) -> Bool {
        let normalizedMacDeviceId = normalizedNonEmptyString(macDeviceId)
        guard let normalizedMacDeviceId,
              savedBridgePairings.contains(where: { $0.macDeviceId == normalizedMacDeviceId }) else {
            return false
        }

        activePairingMacDeviceId = normalizedMacDeviceId
        applyResolvedActiveSavedBridgePairing()
        persistSavedBridgePairings()
        return true
    }

    func removeSavedBridgePairing(macDeviceId: String) {
        let normalizedMacDeviceId = normalizedNonEmptyString(macDeviceId)
        guard let normalizedMacDeviceId else {
            return
        }

        savedBridgePairings.removeAll { $0.macDeviceId == normalizedMacDeviceId }
        trustedMacRegistry.records.removeValue(forKey: normalizedMacDeviceId)
        SecureStore.writeCodable(trustedMacRegistry, for: CodeRoverSecureKeys.trustedMacRegistry)
        if activePairingMacDeviceId == normalizedMacDeviceId {
            activePairingMacDeviceId = nil
        }
        applyResolvedActiveSavedBridgePairing()
        persistSavedBridgePairings()
    }

    func displayTitle(for pairing: CodeRoverBridgePairingRecord) -> String {
        if let label = pairing.transportCandidates
            .compactMap({ normalizedNonEmptyString($0.label) })
            .first {
            return label
        }

        if let host = pairing.transportCandidates
            .compactMap({ normalizedNonEmptyString(URL(string: $0.url)?.host) })
            .first {
            return host
        }

        let suffix = pairing.macDeviceId.suffix(6)
        return "Mac \(suffix)"
    }

    func updateActiveSavedBridgePairing(_ update: (inout CodeRoverBridgePairingRecord) -> Void) {
        guard let activePairingMacDeviceId,
              let pairingIndex = savedBridgePairings.firstIndex(where: { $0.macDeviceId == activePairingMacDeviceId }) else {
            syncLegacySavedBridgePairingMirror()
            return
        }

        update(&savedBridgePairings[pairingIndex])
        setActiveSavedBridgePairingState(from: savedBridgePairings[pairingIndex])
        persistSavedBridgePairings()
    }

    func applyResolvedActiveSavedBridgePairing() {
        guard !savedBridgePairings.isEmpty else {
            activePairingMacDeviceId = nil
            setActiveSavedBridgePairingState(from: nil)
            updateSecureConnectionStateForSelectedPairing()
            return
        }

        let resolvedPairing = activeSavedBridgePairing
            ?? savedBridgePairings.max(by: { lhs, rhs in
                lhs.lastPairedAt < rhs.lastPairedAt
            })
        activePairingMacDeviceId = resolvedPairing?.macDeviceId
        setActiveSavedBridgePairingState(from: resolvedPairing)
        updateSecureConnectionStateForSelectedPairing()
    }

    func setActiveSavedBridgePairingState(from pairing: CodeRoverBridgePairingRecord?) {
        pairedBridgeId = pairing?.bridgeId
        pairedTransportCandidates = pairing?.transportCandidates ?? []
        preferredTransportURL = pairing?.preferredTransportURL
        lastSuccessfulTransportURL = pairing?.lastSuccessfulTransportURL
        pairedMacDeviceId = pairing?.macDeviceId
        pairedMacIdentityPublicKey = pairing?.macIdentityPublicKey
        secureProtocolVersion = pairing?.secureProtocolVersion ?? coderoverSecureProtocolVersion
        lastAppliedBridgeOutboundSeq = pairing?.lastAppliedBridgeOutboundSeq ?? 0
    }

    func updateSecureConnectionStateForSelectedPairing() {
        if let pairedMacDeviceId,
           let trustedMac = trustedMacRegistry.records[pairedMacDeviceId] {
            secureConnectionState = .trustedMac
            secureMacFingerprint = coderoverSecureFingerprint(for: trustedMac.macIdentityPublicKey)
            return
        }

        secureConnectionState = .notPaired
        secureMacFingerprint = nil
    }

    func persistSavedBridgePairings() {
        if savedBridgePairings.isEmpty {
            SecureStore.deleteValue(for: CodeRoverSecureKeys.pairingRecords)
            SecureStore.deleteValue(for: CodeRoverSecureKeys.pairingActiveMacDeviceId)
        } else {
            SecureStore.writeCodable(savedBridgePairings, for: CodeRoverSecureKeys.pairingRecords)
            if let activePairingMacDeviceId {
                SecureStore.writeString(activePairingMacDeviceId, for: CodeRoverSecureKeys.pairingActiveMacDeviceId)
            } else {
                SecureStore.deleteValue(for: CodeRoverSecureKeys.pairingActiveMacDeviceId)
            }
        }

        syncLegacySavedBridgePairingMirror()
    }

    func restoredSavedBridgePairingsFromSecureStore() -> SavedBridgePairingsRestoreResult? {
        let storedPairings = SecureStore.readCodable(
            [CodeRoverBridgePairingRecord].self,
            for: CodeRoverSecureKeys.pairingRecords
        ) ?? []
        let normalizedStoredPairings = Self.normalizedSavedBridgePairings(storedPairings)
        let storedActivePairingMacDeviceId = normalizedNonEmptyString(
            SecureStore.readString(for: CodeRoverSecureKeys.pairingActiveMacDeviceId)
        )

        if normalizedStoredPairings.isEmpty {
            guard let legacyPairing = Self.loadLegacySavedBridgePairingFromSecureStore() else {
                return nil
            }

            return SavedBridgePairingsRestoreResult(
                pairings: [legacyPairing],
                activePairingMacDeviceId: legacyPairing.macDeviceId,
                shouldPersistNormalizedPairings: true
            )
        }

        return SavedBridgePairingsRestoreResult(
            pairings: normalizedStoredPairings,
            activePairingMacDeviceId: storedActivePairingMacDeviceId,
            shouldPersistNormalizedPairings: normalizedStoredPairings.count != storedPairings.count
        )
    }

    @discardableResult
    func reloadSavedBridgePairingsFromSecureStoreIfNeeded(force: Bool = false) -> Bool {
        guard force || !hasSavedBridgePairing else {
            return false
        }

        guard let restored = restoredSavedBridgePairingsFromSecureStore() else {
            return false
        }

        savedBridgePairings = restored.pairings
        activePairingMacDeviceId = restored.activePairingMacDeviceId
        applyResolvedActiveSavedBridgePairing()

        if restored.shouldPersistNormalizedPairings
            || activePairingMacDeviceId != restored.activePairingMacDeviceId {
            persistSavedBridgePairings()
        }

        return true
    }

    func syncLegacySavedBridgePairingMirror() {
        guard let activePairing = activeSavedBridgePairing else {
            SecureStore.deleteValue(for: CodeRoverSecureKeys.pairingBridgeId)
            SecureStore.deleteValue(for: CodeRoverSecureKeys.pairingTransportCandidates)
            SecureStore.deleteValue(for: CodeRoverSecureKeys.pairingPreferredTransportURL)
            SecureStore.deleteValue(for: CodeRoverSecureKeys.pairingLastSuccessfulTransportURL)
            SecureStore.deleteValue(for: CodeRoverSecureKeys.pairingMacDeviceId)
            SecureStore.deleteValue(for: CodeRoverSecureKeys.pairingMacIdentityPublicKey)
            SecureStore.deleteValue(for: CodeRoverSecureKeys.secureProtocolVersion)
            SecureStore.deleteValue(for: CodeRoverSecureKeys.secureLastAppliedBridgeOutboundSeq)
            return
        }

        SecureStore.writeString(activePairing.bridgeId, for: CodeRoverSecureKeys.pairingBridgeId)
        SecureStore.writeCodable(activePairing.transportCandidates, for: CodeRoverSecureKeys.pairingTransportCandidates)
        if let preferredTransportURL = activePairing.preferredTransportURL {
            SecureStore.writeString(preferredTransportURL, for: CodeRoverSecureKeys.pairingPreferredTransportURL)
        } else {
            SecureStore.deleteValue(for: CodeRoverSecureKeys.pairingPreferredTransportURL)
        }
        if let lastSuccessfulTransportURL = activePairing.lastSuccessfulTransportURL {
            SecureStore.writeString(lastSuccessfulTransportURL, for: CodeRoverSecureKeys.pairingLastSuccessfulTransportURL)
        } else {
            SecureStore.deleteValue(for: CodeRoverSecureKeys.pairingLastSuccessfulTransportURL)
        }
        SecureStore.writeString(activePairing.macDeviceId, for: CodeRoverSecureKeys.pairingMacDeviceId)
        SecureStore.writeString(activePairing.macIdentityPublicKey, for: CodeRoverSecureKeys.pairingMacIdentityPublicKey)
        SecureStore.writeString(
            String(activePairing.secureProtocolVersion),
            for: CodeRoverSecureKeys.secureProtocolVersion
        )
        SecureStore.writeString(
            String(activePairing.lastAppliedBridgeOutboundSeq),
            for: CodeRoverSecureKeys.secureLastAppliedBridgeOutboundSeq
        )
    }

    func displayTitle(for candidate: CodeRoverTransportCandidate) -> String {
        if let label = candidate.label, !label.isEmpty {
            return label
        }

        switch candidate.kind {
        case "local_ipv4":
            return "Local Network"
        case "local_hostname":
            return "Local Hostname"
        case "tailnet_ipv4", "tailnet":
            return "Tailscale"
        default:
            return candidate.kind.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    func extractTurnID(from value: JSONValue?) -> String? {
        guard let object = value?.objectValue else {
            return nil
        }

        if let turnId = object["turn"]?.objectValue?["id"]?.stringValue {
            return turnId
        }
        if let turnId = object["turnId"]?.stringValue {
            return turnId
        }
        if let turnId = object["turn_id"]?.stringValue {
            return turnId
        }

        guard let fallbackId = object["id"]?.stringValue else {
            return nil
        }

        // Avoid misclassifying item payload ids as turn ids.
        let looksLikeItemPayload = object["type"] != nil
            || object["item"] != nil
            || object["content"] != nil
            || object["output"] != nil
        if looksLikeItemPayload {
            return nil
        }

        return fallbackId
    }

}

extension CodeRoverService {
    static func loadLegacySavedBridgePairingFromSecureStore() -> CodeRoverBridgePairingRecord? {
        let pairedBridgeId = normalizedNonEmptyString(
            SecureStore.readString(for: CodeRoverSecureKeys.pairingBridgeId)
        )
        let pairedMacDeviceId = normalizedNonEmptyString(
            SecureStore.readString(for: CodeRoverSecureKeys.pairingMacDeviceId)
        )
        let pairedMacIdentityPublicKey = normalizedNonEmptyString(
            SecureStore.readString(for: CodeRoverSecureKeys.pairingMacIdentityPublicKey)
        )
        let transportCandidates = normalizeTransportCandidates(
            SecureStore.readCodable(
                [CodeRoverTransportCandidate].self,
                for: CodeRoverSecureKeys.pairingTransportCandidates
            ) ?? []
        )
        guard let pairedBridgeId,
              let pairedMacDeviceId,
              let pairedMacIdentityPublicKey,
              !transportCandidates.isEmpty else {
            return nil
        }

        let preferredTransportURL = normalizedNonEmptyString(
            SecureStore.readString(for: CodeRoverSecureKeys.pairingPreferredTransportURL)
        )
        let lastSuccessfulTransportURL = normalizedNonEmptyString(
            SecureStore.readString(for: CodeRoverSecureKeys.pairingLastSuccessfulTransportURL)
        )
        let secureProtocolVersion = Int(
            SecureStore.readString(for: CodeRoverSecureKeys.secureProtocolVersion) ?? ""
        ) ?? coderoverSecureProtocolVersion
        let lastAppliedBridgeOutboundSeq = Int(
            SecureStore.readString(for: CodeRoverSecureKeys.secureLastAppliedBridgeOutboundSeq) ?? ""
        ) ?? 0

        return CodeRoverBridgePairingRecord(
            bridgeId: pairedBridgeId,
            macDeviceId: pairedMacDeviceId,
            macIdentityPublicKey: pairedMacIdentityPublicKey,
            transportCandidates: transportCandidates,
            preferredTransportURL: preferredTransportURL,
            lastSuccessfulTransportURL: lastSuccessfulTransportURL,
            secureProtocolVersion: secureProtocolVersion,
            lastAppliedBridgeOutboundSeq: lastAppliedBridgeOutboundSeq,
            lastPairedAt: .now
        )
    }

    static func normalizedSavedBridgePairings(
        _ pairings: [CodeRoverBridgePairingRecord]
    ) -> [CodeRoverBridgePairingRecord] {
        var normalizedByMacDeviceId: [String: CodeRoverBridgePairingRecord] = [:]
        for pairing in pairings {
            let bridgeId = normalizedNonEmptyString(pairing.bridgeId)
            let macDeviceId = normalizedNonEmptyString(pairing.macDeviceId)
            let macIdentityPublicKey = normalizedNonEmptyString(pairing.macIdentityPublicKey)
            let transportCandidates = normalizeTransportCandidates(pairing.transportCandidates)
            guard let bridgeId,
                  let macDeviceId,
                  let macIdentityPublicKey,
                  !transportCandidates.isEmpty else {
                continue
            }

            let normalized = CodeRoverBridgePairingRecord(
                bridgeId: bridgeId,
                macDeviceId: macDeviceId,
                macIdentityPublicKey: macIdentityPublicKey,
                transportCandidates: transportCandidates,
                preferredTransportURL: normalizedNonEmptyString(pairing.preferredTransportURL),
                lastSuccessfulTransportURL: normalizedNonEmptyString(pairing.lastSuccessfulTransportURL),
                secureProtocolVersion: pairing.secureProtocolVersion,
                lastAppliedBridgeOutboundSeq: max(0, pairing.lastAppliedBridgeOutboundSeq),
                lastPairedAt: pairing.lastPairedAt
            )
            let existing = normalizedByMacDeviceId[macDeviceId]
            if existing == nil || normalized.lastPairedAt >= existing!.lastPairedAt {
                normalizedByMacDeviceId[macDeviceId] = normalized
            }
        }

        return normalizedByMacDeviceId.values.sorted { lhs, rhs in
            lhs.lastPairedAt > rhs.lastPairedAt
        }
    }

    static func normalizeTransportCandidates(
        _ candidates: [CodeRoverTransportCandidate]
    ) -> [CodeRoverTransportCandidate] {
        candidates.compactMap { candidate in
            guard let kind = normalizedNonEmptyString(candidate.kind),
                  let url = normalizedNonEmptyString(candidate.url) else {
                return nil
            }
            let label = normalizedNonEmptyString(candidate.label)
            return CodeRoverTransportCandidate(kind: kind, url: url, label: label)
        }
    }
}
