// FILE: CodexService+Helpers.swift
// Purpose: Shared utility helpers for model decoding and thread bookkeeping.
// Layer: Service
// Exports: CodexService helpers
// Depends on: Foundation

import Foundation

private func normalizedNonEmptyString(_ value: String?) -> String? {
    let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return trimmed.isEmpty ? nil : trimmed
}

extension CodexService {
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

    func upsertThread(_ thread: CodexThread) {
        if let existingIndex = threads.firstIndex(where: { $0.id == thread.id }) {
            threads[existingIndex] = thread
        } else {
            threads.append(thread)
        }

        threads = sortThreads(threads)
    }

    func sortThreads(_ value: [CodexThread]) -> [CodexThread] {
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
            SecureStore.writeString(normalized, for: CodexSecureKeys.pairingLastSuccessfulTransportURL)
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
                SecureStore.writeString(normalized, for: CodexSecureKeys.pairingPreferredTransportURL)
            } else {
                SecureStore.deleteValue(for: CodexSecureKeys.pairingPreferredTransportURL)
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
        SecureStore.writeCodable(trustedMacRegistry, for: CodexSecureKeys.trustedMacRegistry)
        if activePairingMacDeviceId == normalizedMacDeviceId {
            activePairingMacDeviceId = nil
        }
        applyResolvedActiveSavedBridgePairing()
        persistSavedBridgePairings()
    }

    func displayTitle(for pairing: CodexBridgePairingRecord) -> String {
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

    func updateActiveSavedBridgePairing(_ update: (inout CodexBridgePairingRecord) -> Void) {
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

    func setActiveSavedBridgePairingState(from pairing: CodexBridgePairingRecord?) {
        pairedBridgeId = pairing?.bridgeId
        pairedTransportCandidates = pairing?.transportCandidates ?? []
        preferredTransportURL = pairing?.preferredTransportURL
        lastSuccessfulTransportURL = pairing?.lastSuccessfulTransportURL
        pairedMacDeviceId = pairing?.macDeviceId
        pairedMacIdentityPublicKey = pairing?.macIdentityPublicKey
        secureProtocolVersion = pairing?.secureProtocolVersion ?? codexSecureProtocolVersion
        lastAppliedBridgeOutboundSeq = pairing?.lastAppliedBridgeOutboundSeq ?? 0
    }

    func updateSecureConnectionStateForSelectedPairing() {
        if let pairedMacDeviceId,
           let trustedMac = trustedMacRegistry.records[pairedMacDeviceId] {
            secureConnectionState = .trustedMac
            secureMacFingerprint = codexSecureFingerprint(for: trustedMac.macIdentityPublicKey)
            return
        }

        secureConnectionState = .notPaired
        secureMacFingerprint = nil
    }

    func persistSavedBridgePairings() {
        if savedBridgePairings.isEmpty {
            SecureStore.deleteValue(for: CodexSecureKeys.pairingRecords)
            SecureStore.deleteValue(for: CodexSecureKeys.pairingActiveMacDeviceId)
        } else {
            SecureStore.writeCodable(savedBridgePairings, for: CodexSecureKeys.pairingRecords)
            if let activePairingMacDeviceId {
                SecureStore.writeString(activePairingMacDeviceId, for: CodexSecureKeys.pairingActiveMacDeviceId)
            } else {
                SecureStore.deleteValue(for: CodexSecureKeys.pairingActiveMacDeviceId)
            }
        }

        syncLegacySavedBridgePairingMirror()
    }

    func syncLegacySavedBridgePairingMirror() {
        guard let activePairing = activeSavedBridgePairing else {
            SecureStore.deleteValue(for: CodexSecureKeys.pairingBridgeId)
            SecureStore.deleteValue(for: CodexSecureKeys.pairingTransportCandidates)
            SecureStore.deleteValue(for: CodexSecureKeys.pairingPreferredTransportURL)
            SecureStore.deleteValue(for: CodexSecureKeys.pairingLastSuccessfulTransportURL)
            SecureStore.deleteValue(for: CodexSecureKeys.pairingMacDeviceId)
            SecureStore.deleteValue(for: CodexSecureKeys.pairingMacIdentityPublicKey)
            SecureStore.deleteValue(for: CodexSecureKeys.secureProtocolVersion)
            SecureStore.deleteValue(for: CodexSecureKeys.secureLastAppliedBridgeOutboundSeq)
            return
        }

        SecureStore.writeString(activePairing.bridgeId, for: CodexSecureKeys.pairingBridgeId)
        SecureStore.writeCodable(activePairing.transportCandidates, for: CodexSecureKeys.pairingTransportCandidates)
        if let preferredTransportURL = activePairing.preferredTransportURL {
            SecureStore.writeString(preferredTransportURL, for: CodexSecureKeys.pairingPreferredTransportURL)
        } else {
            SecureStore.deleteValue(for: CodexSecureKeys.pairingPreferredTransportURL)
        }
        if let lastSuccessfulTransportURL = activePairing.lastSuccessfulTransportURL {
            SecureStore.writeString(lastSuccessfulTransportURL, for: CodexSecureKeys.pairingLastSuccessfulTransportURL)
        } else {
            SecureStore.deleteValue(for: CodexSecureKeys.pairingLastSuccessfulTransportURL)
        }
        SecureStore.writeString(activePairing.macDeviceId, for: CodexSecureKeys.pairingMacDeviceId)
        SecureStore.writeString(activePairing.macIdentityPublicKey, for: CodexSecureKeys.pairingMacIdentityPublicKey)
        SecureStore.writeString(
            String(activePairing.secureProtocolVersion),
            for: CodexSecureKeys.secureProtocolVersion
        )
        SecureStore.writeString(
            String(activePairing.lastAppliedBridgeOutboundSeq),
            for: CodexSecureKeys.secureLastAppliedBridgeOutboundSeq
        )
    }

    func displayTitle(for candidate: CodexTransportCandidate) -> String {
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

extension CodexService {
    static func loadLegacySavedBridgePairingFromSecureStore() -> CodexBridgePairingRecord? {
        let pairedBridgeId = normalizedNonEmptyString(
            SecureStore.readString(for: CodexSecureKeys.pairingBridgeId)
        )
        let pairedMacDeviceId = normalizedNonEmptyString(
            SecureStore.readString(for: CodexSecureKeys.pairingMacDeviceId)
        )
        let pairedMacIdentityPublicKey = normalizedNonEmptyString(
            SecureStore.readString(for: CodexSecureKeys.pairingMacIdentityPublicKey)
        )
        let transportCandidates = normalizeTransportCandidates(
            SecureStore.readCodable(
                [CodexTransportCandidate].self,
                for: CodexSecureKeys.pairingTransportCandidates
            ) ?? []
        )
        guard let pairedBridgeId,
              let pairedMacDeviceId,
              let pairedMacIdentityPublicKey,
              !transportCandidates.isEmpty else {
            return nil
        }

        let preferredTransportURL = normalizedNonEmptyString(
            SecureStore.readString(for: CodexSecureKeys.pairingPreferredTransportURL)
        )
        let lastSuccessfulTransportURL = normalizedNonEmptyString(
            SecureStore.readString(for: CodexSecureKeys.pairingLastSuccessfulTransportURL)
        )
        let secureProtocolVersion = Int(
            SecureStore.readString(for: CodexSecureKeys.secureProtocolVersion) ?? ""
        ) ?? codexSecureProtocolVersion
        let lastAppliedBridgeOutboundSeq = Int(
            SecureStore.readString(for: CodexSecureKeys.secureLastAppliedBridgeOutboundSeq) ?? ""
        ) ?? 0

        return CodexBridgePairingRecord(
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
        _ pairings: [CodexBridgePairingRecord]
    ) -> [CodexBridgePairingRecord] {
        var normalizedByMacDeviceId: [String: CodexBridgePairingRecord] = [:]
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

            let normalized = CodexBridgePairingRecord(
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
        _ candidates: [CodexTransportCandidate]
    ) -> [CodexTransportCandidate] {
        candidates.compactMap { candidate in
            guard let kind = normalizedNonEmptyString(candidate.kind),
                  let url = normalizedNonEmptyString(candidate.url) else {
                return nil
            }
            let label = normalizedNonEmptyString(candidate.label)
            return CodexTransportCandidate(kind: kind, url: url, label: label)
        }
    }
}
