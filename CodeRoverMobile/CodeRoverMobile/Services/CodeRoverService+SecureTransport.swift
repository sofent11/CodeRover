// FILE: CodeRoverService+SecureTransport.swift
// Purpose: Performs the iPhone-side E2EE handshake, wire control routing, and encrypted envelope handling.
// Layer: Service
// Exports: CodeRoverService secure transport helpers
// Depends on: CryptoKit, Foundation, Security, Network

import CryptoKit
import Foundation
import Security

extension CodeRoverService {
    // Completes the secure handshake before any JSON-RPC traffic is sent over the bridge transport.
    func performSecureHandshake() async throws {
        guard let sessionId = normalizedBridgeId,
              let macDeviceId = normalizedPairedMacDeviceId else {
            throw CodeRoverSecureTransportError.invalidHandshake(
                "The saved bridge pairing is incomplete. Scan a fresh QR code to reconnect."
            )
        }

        let trustedMac = trustedMacRegistry.records[macDeviceId]
        let handshakeMode: CodeRoverSecureHandshakeMode = trustedMac != nil ? .trustedReconnect : .qrBootstrap
        let expectedMacIdentityPublicKey: String
        switch handshakeMode {
        case .trustedReconnect:
            expectedMacIdentityPublicKey = trustedMac?.macIdentityPublicKey ?? ""
            secureConnectionState = .reconnecting
        case .qrBootstrap:
            guard let pairingPublicKey = normalizedPairedMacIdentityPublicKey else {
                throw CodeRoverSecureTransportError.invalidHandshake(
                    "The initial pairing metadata is missing the Mac identity key. Scan a new QR code to reconnect."
                )
            }
            expectedMacIdentityPublicKey = pairingPublicKey
            secureConnectionState = .handshaking
        }

        let phoneEphemeralPrivateKey = Curve25519.KeyAgreement.PrivateKey()
        let clientNonce = randomSecureNonce()
        let clientHello = SecureClientHello(
            protocolVersion: secureProtocolVersion,
            sessionId: sessionId,
            handshakeMode: handshakeMode,
            phoneDeviceId: phoneIdentityState.phoneDeviceId,
            phoneIdentityPublicKey: phoneIdentityState.phoneIdentityPublicKey,
            phoneEphemeralPublicKey: phoneEphemeralPrivateKey.publicKey.rawRepresentation.base64EncodedString(),
            clientNonce: clientNonce.base64EncodedString()
        )
        pendingHandshake = CodeRoverPendingHandshake(
            mode: handshakeMode,
            transcriptBytes: Data(),
            phoneEphemeralPrivateKey: phoneEphemeralPrivateKey,
            phoneDeviceId: phoneIdentityState.phoneDeviceId
        )
        try await sendWireControlMessage(clientHello)

        let serverHello = try await waitForMatchingServerHello(
            expectedSessionId: sessionId,
            expectedMacDeviceId: macDeviceId,
            expectedMacIdentityPublicKey: expectedMacIdentityPublicKey,
            expectedClientNonce: clientHello.clientNonce,
            clientNonce: clientNonce,
            phoneDeviceId: phoneIdentityState.phoneDeviceId,
            phoneIdentityPublicKey: phoneIdentityState.phoneIdentityPublicKey,
            phoneEphemeralPublicKey: clientHello.phoneEphemeralPublicKey
        )
        guard serverHello.protocolVersion == coderoverSecureProtocolVersion else {
            throw CodeRoverSecureTransportError.incompatibleVersion(
                "This bridge is using a different secure transport version. Update CodeRover on the iPhone or Mac and try again."
            )
        }
        guard serverHello.sessionId == sessionId else {
            throw CodeRoverSecureTransportError.invalidHandshake("The secure bridge session ID did not match the saved pairing.")
        }
        guard serverHello.macDeviceId == macDeviceId else {
            throw CodeRoverSecureTransportError.invalidHandshake("The bridge reported a different Mac identity for this paired bridge.")
        }
        guard serverHello.macIdentityPublicKey == expectedMacIdentityPublicKey else {
            throw CodeRoverSecureTransportError.invalidHandshake("The secure Mac identity key did not match the paired device.")
        }

        let serverNonce = Data(base64EncodedOrEmpty: serverHello.serverNonce)
        let transcriptBytes = coderoverSecureTranscriptBytes(
            sessionId: sessionId,
            protocolVersion: serverHello.protocolVersion,
            handshakeMode: serverHello.handshakeMode,
            keyEpoch: serverHello.keyEpoch,
            macDeviceId: serverHello.macDeviceId,
            phoneDeviceId: phoneIdentityState.phoneDeviceId,
            macIdentityPublicKey: serverHello.macIdentityPublicKey,
            phoneIdentityPublicKey: phoneIdentityState.phoneIdentityPublicKey,
            macEphemeralPublicKey: serverHello.macEphemeralPublicKey,
            phoneEphemeralPublicKey: clientHello.phoneEphemeralPublicKey,
            clientNonce: clientNonce,
            serverNonce: serverNonce,
            expiresAtForTranscript: serverHello.expiresAtForTranscript
        )
        debugSecureLog(
            "verify mode=\(serverHello.handshakeMode.rawValue) session=\(shortSecureId(sessionId)) "
            + "keyEpoch=\(serverHello.keyEpoch) mac=\(shortSecureId(serverHello.macDeviceId)) "
            + "phone=\(shortSecureId(phoneIdentityState.phoneDeviceId)) "
            + "expectedMacKey=\(shortSecureFingerprint(expectedMacIdentityPublicKey)) "
            + "actualMacKey=\(shortSecureFingerprint(serverHello.macIdentityPublicKey)) "
            + "phoneKey=\(shortSecureFingerprint(phoneIdentityState.phoneIdentityPublicKey)) "
            + "transcript=\(shortTranscriptDigest(transcriptBytes))"
        )
        let macPublicKey = try Curve25519.Signing.PublicKey(
            rawRepresentation: Data(base64EncodedOrEmpty: serverHello.macIdentityPublicKey)
        )
        let macSignature = Data(base64EncodedOrEmpty: serverHello.macSignature)
        let isSignatureValid = macPublicKey.isValidSignature(macSignature, for: transcriptBytes)
        debugSecureLog(
            "verify-result mode=\(serverHello.handshakeMode.rawValue) valid=\(isSignatureValid) "
            + "signature=\(shortTranscriptDigest(macSignature))"
        )
        guard isSignatureValid else {
            throw CodeRoverSecureTransportError.invalidHandshake("The secure Mac signature could not be verified.")
        }

        pendingHandshake = CodeRoverPendingHandshake(
            mode: handshakeMode,
            transcriptBytes: transcriptBytes,
            phoneEphemeralPrivateKey: phoneEphemeralPrivateKey,
            phoneDeviceId: phoneIdentityState.phoneDeviceId
        )

        let phonePrivateKey = try Curve25519.Signing.PrivateKey(
            rawRepresentation: Data(base64EncodedOrEmpty: phoneIdentityState.phoneIdentityPrivateKey)
        )
        let phoneSignatureData = try phonePrivateKey.signature(for: coderoverClientAuthTranscript(from: transcriptBytes))
        let clientAuth = SecureClientAuth(
            sessionId: sessionId,
            phoneDeviceId: phoneIdentityState.phoneDeviceId,
            keyEpoch: serverHello.keyEpoch,
            phoneSignature: phoneSignatureData.base64EncodedString()
        )
        try await sendWireControlMessage(clientAuth)

        _ = try await waitForMatchingSecureReady(
            expectedSessionId: sessionId,
            expectedKeyEpoch: serverHello.keyEpoch,
            expectedMacDeviceId: macDeviceId
        )

        let macEphemeralPublicKey = try Curve25519.KeyAgreement.PublicKey(
            rawRepresentation: Data(base64EncodedOrEmpty: serverHello.macEphemeralPublicKey)
        )
        let sharedSecret = try phoneEphemeralPrivateKey.sharedSecretFromKeyAgreement(with: macEphemeralPublicKey)
        let salt = SHA256.hash(data: transcriptBytes)
        let infoPrefix = "\(coderoverSecureHandshakeTag)|\(sessionId)|\(macDeviceId)|\(phoneIdentityState.phoneDeviceId)|\(serverHello.keyEpoch)"
        let phoneToMacKey = sharedSecret.hkdfDerivedSymmetricKey(
            using: SHA256.self,
            salt: Data(salt),
            sharedInfo: Data("\(infoPrefix)|phoneToMac".utf8),
            outputByteCount: 32
        )
        let macToPhoneKey = sharedSecret.hkdfDerivedSymmetricKey(
            using: SHA256.self,
            salt: Data(salt),
            sharedInfo: Data("\(infoPrefix)|macToPhone".utf8),
            outputByteCount: 32
        )

        secureSession = CodeRoverSecureSession(
            sessionId: sessionId,
            keyEpoch: serverHello.keyEpoch,
            macDeviceId: macDeviceId,
            macIdentityPublicKey: serverHello.macIdentityPublicKey,
            phoneToMacKey: phoneToMacKey,
            macToPhoneKey: macToPhoneKey,
            lastInboundBridgeOutboundSeq: lastAppliedBridgeOutboundSeq,
            lastInboundCounter: -1,
            nextOutboundCounter: 0
        )
        pendingHandshake = nil
        secureConnectionState = .encrypted
        secureMacFingerprint = coderoverSecureFingerprint(for: serverHello.macIdentityPublicKey)
        lastSentBridgeAckSeq = lastAppliedBridgeOutboundSeq
        pendingBridgeAckSeq = nil
        bridgeAckFlushTask?.cancel()
        bridgeAckFlushTask = nil

        if handshakeMode == .qrBootstrap {
            trustMac(deviceId: macDeviceId, publicKey: serverHello.macIdentityPublicKey)
        }

        try await sendWireControlMessage(
            SecureResumeState(
                sessionId: sessionId,
                keyEpoch: serverHello.keyEpoch,
                lastAppliedBridgeOutboundSeq: lastAppliedBridgeOutboundSeq
            )
        )
    }

    // Handles raw bridge-wire JSON before any JSON-RPC decoding so secure controls stay separate.
    func processIncomingWireText(_ text: String) {
        lastInboundWireActivityAt = Date()
        if let kind = wireMessageKind(from: text) {
            debugSecureLog("wire <- kind=\(kind) bytes=\(text.count)")
            switch kind {
            case "serverHello", "secureReady", "secureError":
                bufferSecureControlMessage(kind: kind, rawText: text)
                return
            case "encryptedEnvelope":
                handleEncryptedEnvelopeText(text)
                return
            default:
                break
            }
        }

        processIncomingText(text)
    }

    // Encrypts JSON-RPC requests/responses before they leave the iPhone.
    func secureWireText(for plaintext: String) throws -> String {
        guard var secureSession else {
            throw CodeRoverSecureTransportError.invalidHandshake(
                "The secure CodeRover session is not ready yet. Try reconnecting."
            )
        }

        let payload = SecureApplicationPayload(
            bridgeOutboundSeq: nil,
            payloadText: plaintext
        )
        let payloadData = try JSONEncoder().encode(payload)
        let nonceData = coderoverSecureNonce(sender: "iphone", counter: secureSession.nextOutboundCounter)
        let nonce = try AES.GCM.Nonce(data: nonceData)
        let sealedBox = try AES.GCM.seal(payloadData, using: secureSession.phoneToMacKey, nonce: nonce)
        let envelope = SecureEnvelope(
            kind: "encryptedEnvelope",
            v: coderoverSecureProtocolVersion,
            sessionId: secureSession.sessionId,
            keyEpoch: secureSession.keyEpoch,
            sender: "iphone",
            counter: secureSession.nextOutboundCounter,
            ciphertext: sealedBox.ciphertext.base64EncodedString(),
            tag: sealedBox.tag.base64EncodedString()
        )
        secureSession.nextOutboundCounter += 1
        self.secureSession = secureSession
        let data = try JSONEncoder().encode(envelope)
        guard let text = String(data: data, encoding: .utf8) else {
            throw CodeRoverSecureTransportError.invalidHandshake("Unable to encode the secure CodeRover envelope.")
        }
        return text
    }

    // Saves the QR-derived bridge metadata used for secure reconnects.
    func rememberBridgePairing(_ payload: CodeRoverPairingQRPayload) {
        // A fresh QR scan is an explicit re-bootstrap request. Drop any existing trusted-mac
        // shortcut for this device so the next connect performs qr_bootstrap and can re-establish
        // trust even if the bridge forgot the phone across resets or earlier persistence bugs.
        trustedMacRegistry.records.removeValue(forKey: payload.macDeviceId)
        SecureStore.writeCodable(trustedMacRegistry, for: CodeRoverSecureKeys.trustedMacRegistry)
        let pairingRecord = CodeRoverBridgePairingRecord(
            bridgeId: payload.bridgeId,
            macDeviceId: payload.macDeviceId,
            macIdentityPublicKey: payload.macIdentityPublicKey,
            transportCandidates: CodeRoverService.normalizeTransportCandidates(payload.transportCandidates),
            preferredTransportURL: nil,
            lastSuccessfulTransportURL: nil,
            secureProtocolVersion: coderoverSecureProtocolVersion,
            lastAppliedBridgeOutboundSeq: 0,
            lastPairedAt: .now
        )
        savedBridgePairings.removeAll { $0.macDeviceId == pairingRecord.macDeviceId }
        savedBridgePairings.append(pairingRecord)
        activePairingMacDeviceId = pairingRecord.macDeviceId
        applyResolvedActiveSavedBridgePairing()
        persistSavedBridgePairings()
        secureConnectionState = .handshaking
        secureMacFingerprint = coderoverSecureFingerprint(for: payload.macIdentityPublicKey)
    }

    // Resets volatile secure state while preserving the trusted-device registry.
    func resetSecureTransportState() {
        secureSession = nil
        pendingHandshake = nil
        bridgeAckFlushTask?.cancel()
        bridgeAckFlushTask = nil
        pendingBridgeAckSeq = nil
        lastSentBridgeAckSeq = lastAppliedBridgeOutboundSeq
        let continuations = pendingSecureControlContinuations
        pendingSecureControlContinuations.removeAll()
        bufferedSecureControlMessages.removeAll()

        for waiters in continuations.values {
            for waiter in waiters {
                waiter.continuation.resume(throwing: CodeRoverServiceError.disconnected)
            }
        }

        guard !secureConnectionState.blocksAutomaticReconnect else {
            return
        }
        updateSecureConnectionStateForSelectedPairing()
    }
}

private extension CodeRoverService {
    func sendWireControlMessage<Value: Encodable>(_ value: Value) async throws {
        let data = try JSONEncoder().encode(value)
        guard let text = String(data: data, encoding: .utf8) else {
            throw CodeRoverSecureTransportError.invalidHandshake("Unable to encode the secure CodeRover control payload.")
        }
        try await sendRawText(text)
    }

    func waitForSecureControlMessage(kind: String, timeoutSeconds: TimeInterval = 12) async throws -> String {
        if let bufferedSecureError = bufferedSecureControlMessages["secureError"]?.first,
           let secureError = try? decodeSecureControl(SecureErrorMessage.self, from: bufferedSecureError) {
            bufferedSecureControlMessages["secureError"] = []
            throw CodeRoverSecureTransportError.secureError(secureError.message)
        }

        if var buffered = bufferedSecureControlMessages[kind], !buffered.isEmpty {
            let first = buffered.removeFirst()
            bufferedSecureControlMessages[kind] = buffered
            return first
        }

        let waiterID = UUID()
        let timeoutMessage = "Timed out waiting for the secure CodeRover \(kind) message."

        return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<String, Error>) in
            pendingSecureControlContinuations[kind, default: []].append(
                CodeRoverSecureControlWaiter(id: waiterID, continuation: continuation)
            )

            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(timeoutSeconds * 1_000_000_000))
                guard let self else { return }
                self.resumePendingSecureControlWaiterIfNeeded(
                    kind: kind,
                    waiterID: waiterID,
                    result: .failure(CodeRoverSecureTransportError.timedOut(timeoutMessage))
                )
            }
        }
    }

    func bufferSecureControlMessage(kind: String, rawText: String) {
        if kind == "secureError",
           let secureError = try? decodeSecureControl(SecureErrorMessage.self, from: rawText) {
            if handleRecoverableSecureErrorIfNeeded(secureError) {
                return
            }
            lastErrorMessage = secureError.message
            if secureError.code == "update_required" {
                secureConnectionState = .updateRequired
            } else if secureError.code == "pairing_expired"
                || secureError.code == "phone_not_trusted"
                || secureError.code == "phone_identity_changed"
                || secureError.code == "phone_replacement_required" {
                secureConnectionState = .rePairRequired
            }

            let continuations = pendingSecureControlContinuations
            pendingSecureControlContinuations.removeAll()
            bufferedSecureControlMessages.removeAll()
            for waiters in continuations.values {
                for waiter in waiters {
                    waiter.continuation.resume(throwing: CodeRoverSecureTransportError.secureError(secureError.message))
                }
            }
            if continuations.isEmpty {
                bufferedSecureControlMessages["secureError"] = [rawText]
            }
            return
        }

        if var waiters = pendingSecureControlContinuations[kind], !waiters.isEmpty {
            let waiter = waiters.removeFirst()
            if waiters.isEmpty {
                pendingSecureControlContinuations.removeValue(forKey: kind)
            } else {
                pendingSecureControlContinuations[kind] = waiters
            }
            waiter.continuation.resume(returning: rawText)
            return
        }

        bufferedSecureControlMessages[kind, default: []].append(rawText)
    }

    func handleRecoverableSecureErrorIfNeeded(_ secureError: SecureErrorMessage) -> Bool {
        guard secureError.code == "resume_gap" else {
            return false
        }

        lastErrorMessage = nil
        scheduleResumeGapRecovery()
        return true
    }

    func scheduleResumeGapRecovery() {
        var seenThreadIDs: Set<String> = []
        var prioritizedThreadIDs: [String] = []
        for candidateThreadID in [activeThreadId] + Array(runningThreadIDs) + Array(activeTurnIdByThread.keys) {
            guard let normalizedThreadID = normalizedIdentifier(candidateThreadID),
                  seenThreadIDs.insert(normalizedThreadID).inserted else {
                continue
            }
            prioritizedThreadIDs.append(normalizedThreadID)
        }
        guard !prioritizedThreadIDs.isEmpty else {
            return
        }

        Task { @MainActor [weak self] in
            guard let self, self.isConnected else { return }
            for threadId in prioritizedThreadIDs {
                self.requestPrioritizedThreadSync(threadId: threadId)
                await self.syncThreadHistory(threadId: threadId, force: true)
                _ = await self.refreshInFlightTurnState(threadId: threadId)
            }
        }
    }

    // Resumes a specific secure-control waiter once, so timeout tasks cannot double-resume it.
    func resumePendingSecureControlWaiterIfNeeded(
        kind: String,
        waiterID: UUID,
        result: Result<String, Error>
    ) {
        guard var waiters = pendingSecureControlContinuations[kind],
              let waiterIndex = waiters.firstIndex(where: { $0.id == waiterID }) else {
            return
        }

        let waiter = waiters.remove(at: waiterIndex)
        if waiters.isEmpty {
            pendingSecureControlContinuations.removeValue(forKey: kind)
        } else {
            pendingSecureControlContinuations[kind] = waiters
        }
        waiter.continuation.resume(with: result)
    }

    func handleEncryptedEnvelopeText(_ text: String) {
        // No active session yet (handshake in progress) — silently drop stale envelopes.
        guard var secureSession else { return }

        guard let envelope = try? decodeSecureControl(SecureEnvelope.self, from: text) else {
            debugSecureLog("dropping malformed encryptedEnvelope")
            return
        }

        guard envelope.sessionId == secureSession.sessionId,
              envelope.keyEpoch == secureSession.keyEpoch,
              envelope.sender == "mac" else {
            debugSecureLog(
                "dropping stale encryptedEnvelope session=\(shortSecureId(envelope.sessionId)) "
                    + "expected=\(shortSecureId(secureSession.sessionId)) keyEpoch=\(envelope.keyEpoch)"
            )
            return
        }

        guard envelope.counter > secureSession.lastInboundCounter else {
            debugSecureLog(
                "dropping replayed encryptedEnvelope counter=\(envelope.counter) "
                    + "lastInbound=\(secureSession.lastInboundCounter)"
            )
            return
        }

        do {
            let nonce = try AES.GCM.Nonce(
                data: coderoverSecureNonce(sender: envelope.sender, counter: envelope.counter)
            )
            let sealedBox = try AES.GCM.SealedBox(
                nonce: nonce,
                ciphertext: Data(base64EncodedOrEmpty: envelope.ciphertext),
                tag: Data(base64EncodedOrEmpty: envelope.tag)
            )
            let plaintext = try AES.GCM.open(sealedBox, using: secureSession.macToPhoneKey)
            let payload = try JSONDecoder().decode(SecureApplicationPayload.self, from: plaintext)
            let wasFirstInboundPayload = secureSession.lastInboundCounter < 0
            secureSession.lastInboundCounter = envelope.counter

            if let bridgeOutboundSeq = payload.bridgeOutboundSeq {
                if shouldResetBridgeReplayFloor(
                    bridgeOutboundSeq: bridgeOutboundSeq,
                    secureSession: secureSession,
                    wasFirstInboundPayload: wasFirstInboundPayload
                ) {
                    debugSecureLog(
                        "wire <- encryptedEnvelope resetting replay floor bridgeSeq=\(bridgeOutboundSeq) "
                        + "lastApplied=\(lastAppliedBridgeOutboundSeq) keyEpoch=\(secureSession.keyEpoch)"
                    )
                    lastAppliedBridgeOutboundSeq = 0
                    lastSentBridgeAckSeq = 0
                    pendingBridgeAckSeq = nil
                    updateActiveSavedBridgePairing { pairing in
                        pairing.lastAppliedBridgeOutboundSeq = 0
                    }
                    secureSession.lastInboundBridgeOutboundSeq = 0
                }
                if bridgeOutboundSeq <= lastAppliedBridgeOutboundSeq {
                    debugSecureLog("wire <- encryptedEnvelope dropped bridgeSeq=\(bridgeOutboundSeq) lastApplied=\(lastAppliedBridgeOutboundSeq)")
                    return
                }
                lastAppliedBridgeOutboundSeq = bridgeOutboundSeq
                secureSession.lastInboundBridgeOutboundSeq = bridgeOutboundSeq
                updateActiveSavedBridgePairing { pairing in
                    pairing.lastAppliedBridgeOutboundSeq = bridgeOutboundSeq
                }
                scheduleBridgeReplayAck(for: bridgeOutboundSeq)
            }

            self.secureSession = secureSession

            debugSecureLog(
                "wire <- encryptedEnvelope counter=\(envelope.counter) bridgeSeq=\(payload.bridgeOutboundSeq ?? -1) "
                + "payloadBytes=\(payload.payloadText.count)"
            )
            lastRawMessage = payload.payloadText
            processIncomingText(payload.payloadText)
        } catch {
            lastErrorMessage = CodeRoverSecureTransportError.decryptFailed.localizedDescription
            secureConnectionState = .rePairRequired
        }
    }

    func shouldResetBridgeReplayFloor(
        bridgeOutboundSeq: Int,
        secureSession: CodeRoverSecureSession,
        wasFirstInboundPayload: Bool
    ) -> Bool {
        guard bridgeOutboundSeq > 0 else {
            return false
        }

        guard bridgeOutboundSeq <= lastAppliedBridgeOutboundSeq else {
            return false
        }

        // A fresh encrypted session with a lower bridge sequence means the bridge process restarted
        // and reset its outbound counter. Keep replay protection within a live bridge process, but
        // allow the first packet of a new secure session to re-establish the floor.
        return wasFirstInboundPayload
            && secureSession.lastInboundBridgeOutboundSeq == lastAppliedBridgeOutboundSeq
    }

    func trustMac(deviceId: String, publicKey: String) {
        trustedMacRegistry.records[deviceId] = CodeRoverTrustedMacRecord(
            macDeviceId: deviceId,
            macIdentityPublicKey: publicKey,
            lastPairedAt: Date()
        )
        SecureStore.writeCodable(trustedMacRegistry, for: CodeRoverSecureKeys.trustedMacRegistry)
        secureMacFingerprint = coderoverSecureFingerprint(for: publicKey)
    }

    func scheduleBridgeReplayAck(for bridgeOutboundSeq: Int) {
        guard bridgeOutboundSeq > lastSentBridgeAckSeq else {
            return
        }
        pendingBridgeAckSeq = max(pendingBridgeAckSeq ?? 0, bridgeOutboundSeq)
        guard bridgeAckFlushTask == nil else {
            return
        }
        bridgeAckFlushTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 150_000_000)
            await self?.flushPendingBridgeReplayAckIfNeeded()
        }
    }

    func flushPendingBridgeReplayAckIfNeeded() async {
        defer {
            bridgeAckFlushTask = nil
        }
        guard let secureSession,
              let pendingBridgeAckSeq,
              pendingBridgeAckSeq > lastSentBridgeAckSeq else {
            return
        }
        do {
            try await sendWireControlMessage(
                SecureAckState(
                    sessionId: secureSession.sessionId,
                    keyEpoch: secureSession.keyEpoch,
                    lastAppliedBridgeOutboundSeq: pendingBridgeAckSeq
                )
            )
            lastSentBridgeAckSeq = pendingBridgeAckSeq
            if self.pendingBridgeAckSeq == pendingBridgeAckSeq {
                self.pendingBridgeAckSeq = nil
            }
        } catch {
            coderoverDiagnosticLog("secure", "ackState send failed error=\(error.localizedDescription)")
        }
    }

    /// Waits for a serverHello whose echoed clientNonce matches the one we sent.
    /// Stale serverHellos from a previous handshake attempt (e.g. buffered by the transport
    /// across a phone disconnect/reconnect) are silently discarded until the correct one
    /// arrives or the per-message 12-second timeout fires.
    func waitForMatchingServerHello(
        expectedSessionId: String,
        expectedMacDeviceId: String,
        expectedMacIdentityPublicKey: String,
        expectedClientNonce: String,
        clientNonce: Data,
        phoneDeviceId: String,
        phoneIdentityPublicKey: String,
        phoneEphemeralPublicKey: String
    ) async throws -> SecureServerHello {
        while true {
            let raw = try await waitForSecureControlMessage(kind: "serverHello")
            let hello = try decodeSecureControl(SecureServerHello.self, from: raw)
            if let echoedNonce = hello.clientNonce, echoedNonce != expectedClientNonce {
                debugSecureLog("discarding stale serverHello (clientNonce mismatch)")
                continue
            }
            if hello.clientNonce == nil,
               !isMatchingLegacyServerHello(
                    hello,
                    expectedSessionId: expectedSessionId,
                    expectedMacDeviceId: expectedMacDeviceId,
                    expectedMacIdentityPublicKey: expectedMacIdentityPublicKey,
                    clientNonce: clientNonce,
                    phoneDeviceId: phoneDeviceId,
                    phoneIdentityPublicKey: phoneIdentityPublicKey,
                    phoneEphemeralPublicKey: phoneEphemeralPublicKey
               ) {
                debugSecureLog("discarding stale serverHello (legacy signature mismatch)")
                continue
            }
            return hello
        }
    }

    // Falls back to transcript-signature matching for pre-echo serverHello payloads.
    func isMatchingLegacyServerHello(
        _ hello: SecureServerHello,
        expectedSessionId: String,
        expectedMacDeviceId: String,
        expectedMacIdentityPublicKey: String,
        clientNonce: Data,
        phoneDeviceId: String,
        phoneIdentityPublicKey: String,
        phoneEphemeralPublicKey: String
    ) -> Bool {
        guard hello.protocolVersion == coderoverSecureProtocolVersion,
              hello.sessionId == expectedSessionId,
              hello.macDeviceId == expectedMacDeviceId,
              hello.macIdentityPublicKey == expectedMacIdentityPublicKey,
              let macPublicKey = try? Curve25519.Signing.PublicKey(
                  rawRepresentation: Data(base64EncodedOrEmpty: hello.macIdentityPublicKey)
              ) else {
            return false
        }

        let transcriptBytes = coderoverSecureTranscriptBytes(
            sessionId: expectedSessionId,
            protocolVersion: hello.protocolVersion,
            handshakeMode: hello.handshakeMode,
            keyEpoch: hello.keyEpoch,
            macDeviceId: hello.macDeviceId,
            phoneDeviceId: phoneDeviceId,
            macIdentityPublicKey: hello.macIdentityPublicKey,
            phoneIdentityPublicKey: phoneIdentityPublicKey,
            macEphemeralPublicKey: hello.macEphemeralPublicKey,
            phoneEphemeralPublicKey: phoneEphemeralPublicKey,
            clientNonce: clientNonce,
            serverNonce: Data(base64EncodedOrEmpty: hello.serverNonce),
            expiresAtForTranscript: hello.expiresAtForTranscript
        )
        return macPublicKey.isValidSignature(
            Data(base64EncodedOrEmpty: hello.macSignature),
            for: transcriptBytes
        )
    }

    /// Waits for a secureReady whose keyEpoch matches the current handshake.
    /// Stale secureReady messages from previous sessions are discarded until the
    /// correct one arrives or the per-message 12-second timeout fires.
    func waitForMatchingSecureReady(
        expectedSessionId: String,
        expectedKeyEpoch: Int,
        expectedMacDeviceId: String
    ) async throws -> SecureReadyMessage {
        while true {
            let raw = try await waitForSecureControlMessage(kind: "secureReady")
            let ready = try decodeSecureControl(SecureReadyMessage.self, from: raw)
            if ready.sessionId == expectedSessionId,
               ready.keyEpoch == expectedKeyEpoch,
               ready.macDeviceId == expectedMacDeviceId {
                return ready
            }
            debugSecureLog("discarding stale secureReady (keyEpoch=\(ready.keyEpoch) expected=\(expectedKeyEpoch))")
        }
    }

    func wireMessageKind(from rawText: String) -> String? {
        guard let data = rawText.data(using: .utf8),
              let json = try? JSONDecoder().decode(JSONValue.self, from: data),
              let object = json.objectValue else {
            return nil
        }
        return object["kind"]?.stringValue
    }

    func decodeSecureControl<Value: Decodable>(_ type: Value.Type, from rawText: String) throws -> Value {
        guard let data = rawText.data(using: .utf8) else {
            throw CodeRoverSecureTransportError.invalidHandshake("The secure control payload was not valid UTF-8.")
        }
        return try JSONDecoder().decode(type, from: data)
    }

    func randomSecureNonce() -> Data {
        var data = Data(repeating: 0, count: 32)
        _ = data.withUnsafeMutableBytes { buffer in
            SecRandomCopyBytes(kSecRandomDefault, buffer.count, buffer.baseAddress!)
        }
        return data
    }

    func debugSecureLog(_ message: String) {
        coderoverDiagnosticLog("CodeRoverSecure", message)
    }

    func shortSecureId(_ value: String) -> String {
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return normalized.isEmpty ? "none" : String(normalized.prefix(8))
    }

    func shortSecureFingerprint(_ publicKeyBase64: String) -> String {
        let bytes = Data(base64EncodedOrEmpty: publicKeyBase64)
        guard !bytes.isEmpty else {
            return "invalid"
        }
        return shortTranscriptDigest(bytes)
    }

    func shortTranscriptDigest(_ data: Data) -> String {
        SHA256.hash(data: data).compactMap { String(format: "%02x", $0) }.joined().prefix(16).description
    }
}
