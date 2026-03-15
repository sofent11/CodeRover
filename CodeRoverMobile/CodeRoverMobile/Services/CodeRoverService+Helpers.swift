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
        if let existingIndex = threads.firstIndex(where: { $0.id == thread.id }) {
            threads[existingIndex] = thread
        } else {
            threads.append(thread)
        }

        threads = sortThreads(threads)
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
