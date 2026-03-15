// FILE: CodeRoverServiceRecoveryRegressionTests.swift
// Purpose: Covers lock-screen reconnect regressions around secure envelopes and pairing recovery.
// Layer: Unit Test
// Exports: CodeRoverServiceRecoveryRegressionTests
// Depends on: XCTest, CryptoKit, CodeRoverMobile

import XCTest
import CryptoKit
@testable import CodeRoverMobile

@MainActor
final class CodeRoverServiceRecoveryRegressionTests: XCTestCase {
    private static var retainedServices: [CodeRoverService] = []

    func testReplayedEncryptedEnvelopeDoesNotForceRePair() throws {
        let service = makeService()
        service.secureConnectionState = .encrypted
        service.secureSession = makeSecureSession(lastInboundCounter: 5)

        let envelope = SecureEnvelope(
            kind: "encryptedEnvelope",
            v: coderoverSecureProtocolVersion,
            sessionId: "session-live",
            keyEpoch: 1,
            sender: "mac",
            counter: 5,
            ciphertext: "",
            tag: ""
        )
        let rawText = try encodeEnvelope(envelope)

        service.handleEncryptedEnvelopeText(rawText)

        XCTAssertEqual(service.secureConnectionState, .encrypted)
        XCTAssertNil(service.lastErrorMessage)
    }

    func testStaleEncryptedEnvelopeFromOlderSessionDoesNotForceRePair() throws {
        let service = makeService()
        service.secureConnectionState = .encrypted
        service.secureSession = makeSecureSession(lastInboundCounter: 0)

        let envelope = SecureEnvelope(
            kind: "encryptedEnvelope",
            v: coderoverSecureProtocolVersion,
            sessionId: "session-stale",
            keyEpoch: 1,
            sender: "mac",
            counter: 1,
            ciphertext: "",
            tag: ""
        )
        let rawText = try encodeEnvelope(envelope)

        service.handleEncryptedEnvelopeText(rawText)

        XCTAssertEqual(service.secureConnectionState, .encrypted)
        XCTAssertNil(service.lastErrorMessage)
    }

    func testForegroundRecoveryReloadsSavedPairingFromSecureStore() {
        let service = makeService()
        let payload = CodeRoverPairingQRPayload(
            v: coderoverPairingQRVersion,
            bridgeId: "bridge-\(UUID().uuidString)",
            macDeviceId: "mac-\(UUID().uuidString)",
            macIdentityPublicKey: Data("mac-public-key".utf8).base64EncodedString(),
            transportCandidates: [
                CodeRoverTransportCandidate(
                    kind: "local_ipv4",
                    url: "ws://192.168.0.10:8765/bridge/test",
                    label: "Home"
                ),
            ],
            expiresAt: Int64(Date().addingTimeInterval(300).timeIntervalSince1970 * 1000)
        )
        defer {
            SecureStore.deleteValue(for: CodeRoverSecureKeys.pairingRecords)
            SecureStore.deleteValue(for: CodeRoverSecureKeys.pairingActiveMacDeviceId)
            SecureStore.deleteValue(for: CodeRoverSecureKeys.pairingBridgeId)
            SecureStore.deleteValue(for: CodeRoverSecureKeys.pairingTransportCandidates)
            SecureStore.deleteValue(for: CodeRoverSecureKeys.pairingPreferredTransportURL)
            SecureStore.deleteValue(for: CodeRoverSecureKeys.pairingLastSuccessfulTransportURL)
            SecureStore.deleteValue(for: CodeRoverSecureKeys.pairingMacDeviceId)
            SecureStore.deleteValue(for: CodeRoverSecureKeys.pairingMacIdentityPublicKey)
            SecureStore.deleteValue(for: CodeRoverSecureKeys.secureProtocolVersion)
            SecureStore.deleteValue(for: CodeRoverSecureKeys.secureLastAppliedBridgeOutboundSeq)
            SecureStore.deleteValue(for: CodeRoverSecureKeys.trustedMacRegistry)
        }

        service.rememberBridgePairing(payload)
        service.savedBridgePairings = []
        service.activePairingMacDeviceId = nil
        service.applyResolvedActiveSavedBridgePairing()

        XCTAssertFalse(service.hasSavedBridgePairing)
        XCTAssertTrue(service.reloadSavedBridgePairingsFromSecureStoreIfNeeded())
        XCTAssertEqual(service.activeSavedBridgePairing?.macDeviceId, payload.macDeviceId)
        XCTAssertEqual(service.pairedBridgeId, payload.bridgeId)
    }

    private func makeService() -> CodeRoverService {
        let suiteName = "CodeRoverServiceRecoveryRegressionTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defaults.removePersistentDomain(forName: suiteName)
        let service = CodeRoverService(defaults: defaults)
        Self.retainedServices.append(service)
        return service
    }

    private func makeSecureSession(lastInboundCounter: Int) -> CodeRoverSecureSession {
        let keyData = Data(repeating: 7, count: 32)
        let key = SymmetricKey(data: keyData)
        return CodeRoverSecureSession(
            sessionId: "session-live",
            keyEpoch: 1,
            macDeviceId: "mac-live",
            macIdentityPublicKey: Data("mac-public-key".utf8).base64EncodedString(),
            phoneToMacKey: key,
            macToPhoneKey: key,
            lastInboundBridgeOutboundSeq: 0,
            lastInboundCounter: lastInboundCounter,
            nextOutboundCounter: 0
        )
    }

    private func encodeEnvelope(_ envelope: SecureEnvelope) throws -> String {
        let data = try JSONEncoder().encode(envelope)
        guard let rawText = String(data: data, encoding: .utf8) else {
            throw XCTSkip("Could not encode secure envelope")
        }
        return rawText
    }
}
