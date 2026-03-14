// FILE: CodeRoverServiceIncomingRunIndicatorTests.swift
// Purpose: Verifies sidebar run badge transitions (running/ready/failed) from app-server events.
// Layer: Unit Test
// Exports: CodeRoverServiceIncomingRunIndicatorTests
// Depends on: XCTest, CodeRoverMobile

import XCTest
import Network
@testable import CodeRoverMobile

@MainActor
final class CodeRoverServiceIncomingRunIndicatorTests: XCTestCase {
    private static var retainedServices: [CodeRoverService] = []

    func testTurnStartedMarksThreadAsRunning() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        sendTurnStarted(service: service, threadID: threadID, turnID: turnID)

        XCTAssertEqual(service.threadRunBadgeState(for: threadID), .running)
    }

    func testIncomingMethodIsTrimmedBeforeRouting() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        service.handleIncomingRPCMessage(
            RPCMessage(
                method: " turn/started ",
                params: .object([
                    "threadId": .string(threadID),
                    "turnId": .string(turnID),
                ])
            )
        )

        XCTAssertEqual(service.threadRunBadgeState(for: threadID), .running)
        XCTAssertEqual(service.activeTurnID(for: threadID), turnID)
    }

    func testTurnStartedSupportsConversationIDSnakeCase() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        service.handleNotification(
            method: "turn/started",
            params: .object([
                "conversation_id": .string(threadID),
                "turnId": .string(turnID),
            ])
        )

        XCTAssertEqual(service.threadRunBadgeState(for: threadID), .running)
        XCTAssertEqual(service.activeTurnID(for: threadID), turnID)
    }

    func testTurnStartedWithoutTurnIDStillMarksThreadAsRunning() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"

        service.handleNotification(
            method: "turn/started",
            params: .object([
                "threadId": .string(threadID),
            ])
        )

        XCTAssertNil(service.activeTurnID(for: threadID))
        XCTAssertEqual(service.threadRunBadgeState(for: threadID), .running)
    }

    func testTurnStartedAcceptsTopLevelIDAsTurnID() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        service.handleNotification(
            method: "turn/started",
            params: .object([
                "threadId": .string(threadID),
                "id": .string(turnID),
            ])
        )

        XCTAssertEqual(service.activeTurnID(for: threadID), turnID)
        XCTAssertEqual(service.threadRunBadgeState(for: threadID), .running)
    }

    func testTurnCompletedAcceptsTopLevelIDAsTurnID() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        sendTurnStarted(service: service, threadID: threadID, turnID: turnID)

        service.handleNotification(
            method: "turn/completed",
            params: .object([
                "threadId": .string(threadID),
                "id": .string(turnID),
            ])
        )

        XCTAssertNil(service.activeTurnID(for: threadID))
        XCTAssertEqual(service.threadRunBadgeState(for: threadID), .ready)
    }

    func testThreadStatusChangedActiveMarksRunning() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"

        service.handleNotification(
            method: "thread/status/changed",
            params: .object([
                "threadId": .string(threadID),
                "status": .object([
                    "type": .string("active"),
                ]),
            ])
        )

        XCTAssertEqual(service.threadRunBadgeState(for: threadID), .running)
    }

    func testThreadStatusChangedIdleStopsRunning() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        service.handleNotification(
            method: "thread/status/changed",
            params: .object([
                "threadId": .string(threadID),
                "status": .object([
                    "type": .string("active"),
                ]),
            ])
        )

        service.handleNotification(
            method: "thread/status/changed",
            params: .object([
                "threadId": .string(threadID),
                "status": .object([
                    "type": .string("idle"),
                ]),
            ])
        )

        XCTAssertNil(service.threadRunBadgeState(for: threadID))
    }

    func testThreadStatusChangedIdleDoesNotClearWhileTurnIsStillActive() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        sendTurnStarted(service: service, threadID: threadID, turnID: turnID)
        XCTAssertEqual(service.threadRunBadgeState(for: threadID), .running)

        service.handleNotification(
            method: "thread/status/changed",
            params: .object([
                "threadId": .string(threadID),
                "status": .object([
                    "type": .string("idle"),
                ]),
            ])
        )

        XCTAssertEqual(service.threadRunBadgeState(for: threadID), .running)
        XCTAssertEqual(service.activeTurnID(for: threadID), turnID)
    }

    func testThreadStatusChangedIdleDoesNotClearWhileProtectedRunningFallbackIsStillActive() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"

        service.runningThreadIDs.insert(threadID)
        service.protectedRunningFallbackThreadIDs.insert(threadID)
        XCTAssertEqual(service.threadRunBadgeState(for: threadID), .running)

        service.handleNotification(
            method: "thread/status/changed",
            params: .object([
                "threadId": .string(threadID),
                "status": .object([
                    "type": .string("idle"),
                ]),
            ])
        )

        XCTAssertEqual(service.threadRunBadgeState(for: threadID), .running)
        XCTAssertNil(service.latestTurnTerminalState(for: threadID))
    }

    func testStreamingFallbackMarksRunningWithoutActiveTurnMapping() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"

        service.appendSystemMessage(
            threadId: threadID,
            text: "Thinking...",
            kind: .thinking,
            isStreaming: true
        )

        XCTAssertNil(service.activeTurnID(for: threadID))
        XCTAssertEqual(service.threadRunBadgeState(for: threadID), .running)
    }

    func testSuccessfulCompletionMarksThreadAsReadyWhenUnread() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        sendTurnStarted(service: service, threadID: threadID, turnID: turnID)
        sendTurnCompletedSuccess(service: service, threadID: threadID, turnID: turnID)

        XCTAssertEqual(service.threadRunBadgeState(for: threadID), .ready)
    }

    func testStoppedCompletionRecordsStoppedTerminalStateWithoutReadyBadge() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        sendTurnStarted(service: service, threadID: threadID, turnID: turnID)
        sendTurnCompletedStopped(service: service, threadID: threadID, turnID: turnID)

        XCTAssertNil(service.threadRunBadgeState(for: threadID))
        XCTAssertEqual(service.latestTurnTerminalState(for: threadID), .stopped)
        XCTAssertEqual(service.turnTerminalState(for: turnID), .stopped)
    }

    func testErrorWithWillRetryDoesNotMarkFailed() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        sendTurnStarted(service: service, threadID: threadID, turnID: turnID)

        service.handleNotification(
            method: "error",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "message": .string("temporary"),
                "willRetry": .bool(true),
            ])
        )

        XCTAssertEqual(service.threadRunBadgeState(for: threadID), .running)
        XCTAssertTrue(service.failedThreadIDs.isEmpty)
    }

    func testCompletionFailureMarksThreadAsFailed() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        sendTurnStarted(service: service, threadID: threadID, turnID: turnID)
        sendTurnCompletedFailure(service: service, threadID: threadID, turnID: turnID, message: "boom")

        XCTAssertEqual(service.threadRunBadgeState(for: threadID), .failed)
        XCTAssertEqual(service.lastErrorMessage, "boom")
    }

    func testMarkThreadAsViewedClearsReadyAndFailedBadges() {
        let service = makeService()
        let readyThreadID = "thread-ready-\(UUID().uuidString)"
        let failedThreadID = "thread-failed-\(UUID().uuidString)"
        let readyTurnID = "turn-\(UUID().uuidString)"
        let failedTurnID = "turn-\(UUID().uuidString)"

        sendTurnStarted(service: service, threadID: readyThreadID, turnID: readyTurnID)
        sendTurnCompletedSuccess(service: service, threadID: readyThreadID, turnID: readyTurnID)

        sendTurnStarted(service: service, threadID: failedThreadID, turnID: failedTurnID)
        sendTurnFailed(service: service, threadID: failedThreadID, turnID: failedTurnID, message: "failed")

        service.markThreadAsViewed(readyThreadID)
        service.markThreadAsViewed(failedThreadID)

        XCTAssertNil(service.threadRunBadgeState(for: readyThreadID))
        XCTAssertNil(service.threadRunBadgeState(for: failedThreadID))
    }

    func testPrepareThreadForDisplayClearsOutcomeBadge() async {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        sendTurnStarted(service: service, threadID: threadID, turnID: turnID)
        sendTurnCompletedSuccess(service: service, threadID: threadID, turnID: turnID)
        XCTAssertEqual(service.threadRunBadgeState(for: threadID), .ready)

        await service.prepareThreadForDisplay(threadId: threadID)

        XCTAssertNil(service.threadRunBadgeState(for: threadID))
    }

    func testActiveThreadDoesNotReceiveReadyOrFailedBadge() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let successTurnID = "turn-\(UUID().uuidString)"
        let failedTurnID = "turn-\(UUID().uuidString)"

        service.activeThreadId = threadID
        sendTurnStarted(service: service, threadID: threadID, turnID: successTurnID)
        sendTurnCompletedSuccess(service: service, threadID: threadID, turnID: successTurnID)
        XCTAssertNil(service.threadRunBadgeState(for: threadID))

        sendTurnStarted(service: service, threadID: threadID, turnID: failedTurnID)
        sendTurnFailed(service: service, threadID: threadID, turnID: failedTurnID, message: "boom")
        XCTAssertNil(service.threadRunBadgeState(for: threadID))
    }

    func testNewTurnClearsPreviousOutcomeBeforeRunning() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let failedTurnID = "turn-\(UUID().uuidString)"
        let resumedTurnID = "turn-\(UUID().uuidString)"

        sendTurnStarted(service: service, threadID: threadID, turnID: failedTurnID)
        sendTurnFailed(service: service, threadID: threadID, turnID: failedTurnID, message: "boom")
        XCTAssertEqual(service.threadRunBadgeState(for: threadID), .failed)

        sendTurnStarted(service: service, threadID: threadID, turnID: resumedTurnID)
        XCTAssertEqual(service.threadRunBadgeState(for: threadID), .running)

        sendTurnCompletedSuccess(service: service, threadID: threadID, turnID: resumedTurnID)
        XCTAssertEqual(service.threadRunBadgeState(for: threadID), .ready)
    }

    func testMultipleThreadsTrackIndependentBadgeStates() {
        let service = makeService()
        let runningThreadID = "thread-running-\(UUID().uuidString)"
        let readyThreadID = "thread-ready-\(UUID().uuidString)"
        let failedThreadID = "thread-failed-\(UUID().uuidString)"
        let runningTurnID = "turn-\(UUID().uuidString)"
        let readyTurnID = "turn-\(UUID().uuidString)"
        let failedTurnID = "turn-\(UUID().uuidString)"

        sendTurnStarted(service: service, threadID: runningThreadID, turnID: runningTurnID)

        sendTurnStarted(service: service, threadID: readyThreadID, turnID: readyTurnID)
        sendTurnCompletedSuccess(service: service, threadID: readyThreadID, turnID: readyTurnID)

        sendTurnStarted(service: service, threadID: failedThreadID, turnID: failedTurnID)
        sendTurnFailed(service: service, threadID: failedThreadID, turnID: failedTurnID, message: "failed")

        XCTAssertEqual(service.threadRunBadgeState(for: runningThreadID), .running)
        XCTAssertEqual(service.threadRunBadgeState(for: readyThreadID), .ready)
        XCTAssertEqual(service.threadRunBadgeState(for: failedThreadID), .failed)
    }

    func testDisconnectClearsOutcomeBadges() async {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        sendTurnStarted(service: service, threadID: threadID, turnID: turnID)
        sendTurnCompletedSuccess(service: service, threadID: threadID, turnID: turnID)
        XCTAssertEqual(service.threadRunBadgeState(for: threadID), .ready)

        await service.disconnect()

        XCTAssertTrue(service.runningThreadIDs.isEmpty)
        XCTAssertTrue(service.readyThreadIDs.isEmpty)
        XCTAssertTrue(service.failedThreadIDs.isEmpty)
        XCTAssertNil(service.threadRunBadgeState(for: threadID))
    }

    func testThreadHasActiveOrRunningTurnUsesRunningFallback() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"

        XCTAssertFalse(service.threadHasActiveOrRunningTurn(threadID))
        service.runningThreadIDs.insert(threadID)
        XCTAssertTrue(service.threadHasActiveOrRunningTurn(threadID))
    }

    func testBackgroundConnectionAbortSuppressesErrorAndArmsReconnect() {
        let service = makeService()
        service.isConnected = true
        service.isInitialized = true
        service.lastErrorMessage = nil
        service.setForegroundState(false)

        service.handleReceiveError(NWError.posix(.ECONNABORTED))

        XCTAssertFalse(service.isConnected)
        XCTAssertFalse(service.isInitialized)
        XCTAssertNil(service.lastErrorMessage)
        XCTAssertTrue(service.shouldAutoReconnectOnForeground)
    }

    func testForegroundConnectionAbortArmsReconnect() {
        let service = makeService()
        service.isConnected = true
        service.isInitialized = true
        service.lastErrorMessage = nil
        service.setForegroundState(true)

        service.handleReceiveError(NWError.posix(.ECONNABORTED))

        XCTAssertFalse(service.isConnected)
        XCTAssertFalse(service.isInitialized)
        XCTAssertNil(service.lastErrorMessage)
        XCTAssertTrue(service.shouldAutoReconnectOnForeground)
        XCTAssertEqual(
            service.connectionRecoveryState,
            .retrying(attempt: 0, message: "Reconnecting...")
        )
    }

    func testForegroundConnectionTimeoutSuppressesErrorAndArmsReconnect() {
        let service = makeService()
        service.isConnected = true
        service.isInitialized = true
        service.lastErrorMessage = nil
        service.setForegroundState(true)

        service.handleReceiveError(NWError.posix(.ETIMEDOUT))

        XCTAssertFalse(service.isConnected)
        XCTAssertFalse(service.isInitialized)
        XCTAssertNil(service.lastErrorMessage)
        XCTAssertTrue(service.shouldAutoReconnectOnForeground)
        XCTAssertEqual(
            service.connectionRecoveryState,
            .retrying(attempt: 0, message: "Connection timed out. Retrying...")
        )
    }

    func testDisconnectPreservesSavedPairingAndArmsReconnect() {
        let service = makeService()

        withSavedBridgePairing(bridgeId: "bridge-\(UUID().uuidString)", transportURL: "ws://192.168.0.10:8765/bridge/test") {
            service.pairedBridgeId = SecureStore.readString(for: CodeRoverSecureKeys.pairingBridgeId)
            service.pairedTransportCandidates = SecureStore.readCodable(
                [CodeRoverTransportCandidate].self,
                for: CodeRoverSecureKeys.pairingTransportCandidates
            ) ?? []
            service.isConnected = true
            service.isInitialized = true

            service.handleReceiveError(CodeRoverServiceError.disconnected)

            XCTAssertFalse(service.isConnected)
            XCTAssertTrue(service.shouldAutoReconnectOnForeground)
            XCTAssertEqual(service.pairedBridgeId, SecureStore.readString(for: CodeRoverSecureKeys.pairingBridgeId))
            XCTAssertFalse(service.pairedTransportCandidates.isEmpty)
        }
    }

    func testSavedBridgePairingRequiresBridgeIdAndTransportCandidate() {
        let service = makeService()

        XCTAssertFalse(service.hasSavedBridgePairing)

        service.pairedBridgeId = "bridge-1"
        XCTAssertFalse(service.hasSavedBridgePairing)

        service.pairedTransportCandidates = [
            CodeRoverTransportCandidate(kind: "local_ipv4", url: "ws://192.168.0.10:8765/bridge/bridge-1", label: nil)
        ]
        XCTAssertTrue(service.hasSavedBridgePairing)
    }

    func testUnpairClearsSavedPairingAndTrustedMacRecord() async {
        let service = makeService()
        let macDeviceId = "mac-\(UUID().uuidString)"
        let macIdentityPublicKey = Data("trusted-mac-key".utf8).base64EncodedString()

        SecureStore.writeString("bridge-\(UUID().uuidString)", for: CodeRoverSecureKeys.pairingBridgeId)
        SecureStore.writeCodable(
            [CodeRoverTransportCandidate(kind: "local_ipv4", url: "ws://192.168.0.10:8765/bridge/test", label: nil)],
            for: CodeRoverSecureKeys.pairingTransportCandidates
        )
        SecureStore.writeString(macDeviceId, for: CodeRoverSecureKeys.pairingMacDeviceId)
        SecureStore.writeString(macIdentityPublicKey, for: CodeRoverSecureKeys.pairingMacIdentityPublicKey)
        SecureStore.writeCodable(
            CodeRoverTrustedMacRegistry(
                records: [
                    macDeviceId: CodeRoverTrustedMacRecord(
                        macDeviceId: macDeviceId,
                        macIdentityPublicKey: macIdentityPublicKey,
                        lastPairedAt: .now
                    )
                ]
            ),
            for: CodeRoverSecureKeys.trustedMacRegistry
        )
        defer {
            SecureStore.deleteValue(for: CodeRoverSecureKeys.pairingBridgeId)
            SecureStore.deleteValue(for: CodeRoverSecureKeys.pairingTransportCandidates)
            SecureStore.deleteValue(for: CodeRoverSecureKeys.pairingMacDeviceId)
            SecureStore.deleteValue(for: CodeRoverSecureKeys.pairingMacIdentityPublicKey)
            SecureStore.deleteValue(for: CodeRoverSecureKeys.trustedMacRegistry)
        }

        service.pairedBridgeId = SecureStore.readString(for: CodeRoverSecureKeys.pairingBridgeId)
        service.pairedTransportCandidates = SecureStore.readCodable(
            [CodeRoverTransportCandidate].self,
            for: CodeRoverSecureKeys.pairingTransportCandidates
        ) ?? []
        service.pairedMacDeviceId = SecureStore.readString(for: CodeRoverSecureKeys.pairingMacDeviceId)
        service.pairedMacIdentityPublicKey = SecureStore.readString(for: CodeRoverSecureKeys.pairingMacIdentityPublicKey)
        service.trustedMacRegistry = SecureStore.readCodable(
            CodeRoverTrustedMacRegistry.self,
            for: CodeRoverSecureKeys.trustedMacRegistry
        ) ?? .empty
        service.secureConnectionState = .trustedMac

        await service.unpair()

        XCTAssertFalse(service.hasSavedBridgePairing)
        XCTAssertNil(service.pairedMacDeviceId)
        XCTAssertNil(service.pairedMacIdentityPublicKey)
        XCTAssertEqual(service.secureConnectionState, .notPaired)
        XCTAssertTrue(service.trustedMacRegistry.records.isEmpty)
        XCTAssertNil(SecureStore.readString(for: CodeRoverSecureKeys.pairingBridgeId))
        XCTAssertNil(SecureStore.readString(for: CodeRoverSecureKeys.pairingMacDeviceId))
        let storedRegistry = SecureStore.readCodable(
            CodeRoverTrustedMacRegistry.self,
            for: CodeRoverSecureKeys.trustedMacRegistry
        ) ?? .empty
        XCTAssertTrue(storedRegistry.records.isEmpty)
    }

    func testRememberBridgePairingPersistsAllTransportCandidates() {
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
                    label: "Home LAN"
                ),
                CodeRoverTransportCandidate(
                    kind: "tailnet",
                    url: "ws://coderover-host.tailnet.ts.net:8765/bridge/test",
                    label: "Tailscale"
                ),
            ],
            expiresAt: Int64(Date().addingTimeInterval(300).timeIntervalSince1970 * 1000)
        )
        defer {
            SecureStore.deleteValue(for: CodeRoverSecureKeys.pairingBridgeId)
            SecureStore.deleteValue(for: CodeRoverSecureKeys.pairingTransportCandidates)
            SecureStore.deleteValue(for: CodeRoverSecureKeys.pairingPreferredTransportURL)
            SecureStore.deleteValue(for: CodeRoverSecureKeys.pairingLastSuccessfulTransportURL)
            SecureStore.deleteValue(for: CodeRoverSecureKeys.pairingMacDeviceId)
            SecureStore.deleteValue(for: CodeRoverSecureKeys.pairingMacIdentityPublicKey)
            SecureStore.deleteValue(for: CodeRoverSecureKeys.trustedMacRegistry)
        }

        service.rememberBridgePairing(payload)

        XCTAssertEqual(service.pairedTransportCandidates, payload.transportCandidates)
        let storedCandidates = SecureStore.readCodable(
            [CodeRoverTransportCandidate].self,
            for: CodeRoverSecureKeys.pairingTransportCandidates
        )
        XCTAssertEqual(storedCandidates, payload.transportCandidates)
    }

    func testSameSubnetReconnectCandidateBeatsPublicAndOtherPrivateIPs() {
        let service = makeService()
        service.localIPv4AddressesProvider = { ["192.168.1.23"] }
        service.pairedTransportCandidates = [
            CodeRoverTransportCandidate(kind: "local_ipv4", url: "ws://10.0.0.8:8765/bridge/test", label: "Old WiFi"),
            CodeRoverTransportCandidate(kind: "relay", url: "ws://8.8.8.8:8765/bridge/test", label: "Public"),
            CodeRoverTransportCandidate(kind: "local_ipv4", url: "ws://192.168.1.40:8765/bridge/test", label: "Same Subnet"),
        ]

        XCTAssertEqual(
            service.orderedTransportCandidateURLs,
            [
                "ws://192.168.1.40:8765/bridge/test",
                "ws://8.8.8.8:8765/bridge/test",
                "ws://10.0.0.8:8765/bridge/test",
            ]
        )
    }

    func testPublicIPBeatsMismatchedPrivateIPEvenIfPrivateWasPreferred() {
        let service = makeService()
        service.localIPv4AddressesProvider = { ["172.20.10.5"] }
        service.pairedTransportCandidates = [
            CodeRoverTransportCandidate(kind: "local_ipv4", url: "ws://192.168.0.10:8765/bridge/test", label: "Private"),
            CodeRoverTransportCandidate(kind: "relay", url: "ws://1.2.3.4:8765/bridge/test", label: "Public"),
        ]
        defer {
            SecureStore.deleteValue(for: CodeRoverSecureKeys.pairingPreferredTransportURL)
        }

        service.setPreferredTransportURL("ws://192.168.0.10:8765/bridge/test")

        XCTAssertEqual(
            service.orderedTransportCandidateURLs,
            [
                "ws://1.2.3.4:8765/bridge/test",
                "ws://192.168.0.10:8765/bridge/test",
            ]
        )
    }

    func testInitMigratesLegacyPairingIntoMultiPairingStore() {
        let bridgeId = "bridge-\(UUID().uuidString)"
        let macDeviceId = "mac-\(UUID().uuidString)"
        let macIdentityPublicKey = Data("mac-public-key".utf8).base64EncodedString()

        SecureStore.writeString(bridgeId, for: CodeRoverSecureKeys.pairingBridgeId)
        SecureStore.writeCodable(
            [CodeRoverTransportCandidate(kind: "local_ipv4", url: "ws://192.168.0.10:8765/bridge/test", label: "Home")],
            for: CodeRoverSecureKeys.pairingTransportCandidates
        )
        SecureStore.writeString(macDeviceId, for: CodeRoverSecureKeys.pairingMacDeviceId)
        SecureStore.writeString(macIdentityPublicKey, for: CodeRoverSecureKeys.pairingMacIdentityPublicKey)
        defer {
            SecureStore.deleteValue(for: CodeRoverSecureKeys.pairingRecords)
            SecureStore.deleteValue(for: CodeRoverSecureKeys.pairingActiveMacDeviceId)
            SecureStore.deleteValue(for: CodeRoverSecureKeys.pairingBridgeId)
            SecureStore.deleteValue(for: CodeRoverSecureKeys.pairingTransportCandidates)
            SecureStore.deleteValue(for: CodeRoverSecureKeys.pairingMacDeviceId)
            SecureStore.deleteValue(for: CodeRoverSecureKeys.pairingMacIdentityPublicKey)
        }

        let service = makeService()

        XCTAssertEqual(service.savedBridgePairings.count, 1)
        XCTAssertEqual(service.activeSavedBridgePairing?.macDeviceId, macDeviceId)
        XCTAssertEqual(service.pairedBridgeId, bridgeId)
        XCTAssertEqual(
            SecureStore.readCodable([CodeRoverBridgePairingRecord].self, for: CodeRoverSecureKeys.pairingRecords)?.count,
            1
        )
        XCTAssertEqual(
            SecureStore.readString(for: CodeRoverSecureKeys.pairingActiveMacDeviceId),
            macDeviceId
        )
    }

    func testRememberBridgePairingStoresMultipleMacsAndAllowsSwitchingActiveMac() {
        let service = makeService()
        let homePayload = makePairingPayload(macDeviceId: "mac-home", bridgeSuffix: "home", host: "192.168.0.10")
        let workPayload = makePairingPayload(macDeviceId: "mac-work", bridgeSuffix: "work", host: "192.168.0.20")
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

        service.rememberBridgePairing(homePayload)
        service.rememberBridgePairing(workPayload)

        XCTAssertEqual(service.savedBridgePairings.count, 2)
        XCTAssertEqual(service.activeSavedBridgePairing?.macDeviceId, workPayload.macDeviceId)
        XCTAssertTrue(service.setActiveSavedBridgePairing(macDeviceId: homePayload.macDeviceId))
        XCTAssertEqual(service.activeSavedBridgePairing?.macDeviceId, homePayload.macDeviceId)
        XCTAssertEqual(service.pairedBridgeId, homePayload.bridgeId)
        XCTAssertEqual(
            SecureStore.readString(for: CodeRoverSecureKeys.pairingActiveMacDeviceId),
            homePayload.macDeviceId
        )
    }

    func testRemovingActivePairingFallsBackToAnotherSavedMac() {
        let service = makeService()
        let homePayload = makePairingPayload(macDeviceId: "mac-home", bridgeSuffix: "home", host: "192.168.0.10")
        let workPayload = makePairingPayload(macDeviceId: "mac-work", bridgeSuffix: "work", host: "192.168.0.20")
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

        service.rememberBridgePairing(homePayload)
        service.rememberBridgePairing(workPayload)

        service.removeSavedBridgePairing(macDeviceId: workPayload.macDeviceId)

        XCTAssertEqual(service.savedBridgePairings.count, 1)
        XCTAssertEqual(service.activeSavedBridgePairing?.macDeviceId, homePayload.macDeviceId)
        XCTAssertEqual(service.pairedBridgeId, homePayload.bridgeId)
        XCTAssertTrue(service.hasSavedBridgePairing)
    }

    func testRecoverableTimeoutMapsToFriendlyFailureMessage() {
        let service = makeService()

        XCTAssertTrue(service.isRecoverableTransientConnectionError(NWError.posix(.ETIMEDOUT)))
        XCTAssertEqual(
            service.userFacingConnectFailureMessage(NWError.posix(.ETIMEDOUT)),
            "Connection timed out. Check the selected bridge transport and network."
        )
    }

    func testAssistantStreamingKeepsSeparateBlocksWhenItemChangesWithinTurn() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        service.appendAssistantDelta(threadId: threadID, turnId: turnID, itemId: "item-1", delta: "First")
        service.appendAssistantDelta(threadId: threadID, turnId: turnID, itemId: "item-1", delta: " chunk")
        service.appendAssistantDelta(threadId: threadID, turnId: turnID, itemId: "item-2", delta: "Second")

        let assistantMessages = service.messages(for: threadID).filter { $0.role == .assistant }
        XCTAssertEqual(assistantMessages.count, 2)
        XCTAssertEqual(assistantMessages[0].itemId, "item-1")
        XCTAssertEqual(assistantMessages[0].text, "First chunk")
        XCTAssertFalse(assistantMessages[0].isStreaming)

        XCTAssertEqual(assistantMessages[1].itemId, "item-2")
        XCTAssertEqual(assistantMessages[1].text, "Second")
        XCTAssertTrue(assistantMessages[1].isStreaming)
    }

    func testMarkTurnCompletedFinalizesAllAssistantItemsForTurn() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        service.appendAssistantDelta(threadId: threadID, turnId: turnID, itemId: "item-1", delta: "A")
        service.appendAssistantDelta(threadId: threadID, turnId: turnID, itemId: "item-2", delta: "B")

        service.markTurnCompleted(threadId: threadID, turnId: turnID)

        let assistantMessages = service.messages(for: threadID).filter { $0.role == .assistant }
        XCTAssertEqual(assistantMessages.count, 2)
        XCTAssertTrue(assistantMessages.allSatisfy { !$0.isStreaming })

        let turnStreamingKey = "\(threadID)|\(turnID)"
        XCTAssertFalse(service.streamingAssistantMessageByTurnID.keys.contains { key in
            key == turnStreamingKey || key.hasPrefix("\(turnStreamingKey)|item:")
        })
    }

    func testLegacyAgentDeltaParsesTopLevelTurnIdAndMessageId() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        service.handleNotification(
            method: "coderover/event/agent_message_content_delta",
            params: .object([
                "conversationId": .string(threadID),
                "id": .string(turnID),
                "msg": .object([
                    "type": .string("agent_message_content_delta"),
                    "message_id": .string("message-1"),
                    "delta": .string("Primo blocco"),
                ]),
            ])
        )

        service.handleNotification(
            method: "coderover/event/agent_message_content_delta",
            params: .object([
                "conversationId": .string(threadID),
                "id": .string(turnID),
                "msg": .object([
                    "type": .string("agent_message_content_delta"),
                    "message_id": .string("message-2"),
                    "delta": .string("Secondo blocco"),
                ]),
            ])
        )

        let assistantMessages = service.messages(for: threadID).filter { $0.role == .assistant }
        XCTAssertEqual(assistantMessages.count, 2)
        XCTAssertEqual(assistantMessages[0].turnId, turnID)
        XCTAssertEqual(assistantMessages[0].itemId, "message-1")
        XCTAssertEqual(assistantMessages[0].text, "Primo blocco")
        XCTAssertFalse(assistantMessages[0].isStreaming)

        XCTAssertEqual(assistantMessages[1].turnId, turnID)
        XCTAssertEqual(assistantMessages[1].itemId, "message-2")
        XCTAssertEqual(assistantMessages[1].text, "Secondo blocco")
        XCTAssertTrue(assistantMessages[1].isStreaming)
    }

    func testLegacyAgentCompletionUsesMessageIdToFinalizeMatchingStream() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        service.handleNotification(
            method: "coderover/event/agent_message_content_delta",
            params: .object([
                "conversationId": .string(threadID),
                "id": .string(turnID),
                "msg": .object([
                    "type": .string("agent_message_content_delta"),
                    "message_id": .string("message-1"),
                    "delta": .string("Testo parziale"),
                ]),
            ])
        )

        service.handleNotification(
            method: "coderover/event/agent_message",
            params: .object([
                "conversationId": .string(threadID),
                "id": .string(turnID),
                "msg": .object([
                    "type": .string("agent_message"),
                    "message_id": .string("message-1"),
                    "message": .string("Testo finale"),
                ]),
            ])
        )

        let assistantMessages = service.messages(for: threadID).filter { $0.role == .assistant }
        XCTAssertEqual(assistantMessages.count, 1)
        XCTAssertEqual(assistantMessages[0].turnId, turnID)
        XCTAssertEqual(assistantMessages[0].itemId, "message-1")
        XCTAssertEqual(assistantMessages[0].text, "Testo finale")
        XCTAssertFalse(assistantMessages[0].isStreaming)
    }

    private func sendTurnStarted(service: CodeRoverService, threadID: String, turnID: String) {
        service.handleNotification(
            method: "turn/started",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
            ])
        )
    }

    private func sendTurnCompletedSuccess(service: CodeRoverService, threadID: String, turnID: String) {
        service.handleNotification(
            method: "turn/completed",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
            ])
        )
    }

    private func sendTurnCompletedFailure(
        service: CodeRoverService,
        threadID: String,
        turnID: String,
        message: String
    ) {
        service.handleNotification(
            method: "turn/completed",
            params: .object([
                "threadId": .string(threadID),
                "turn": .object([
                    "id": .string(turnID),
                    "status": .string("failed"),
                    "error": .object([
                        "message": .string(message),
                    ]),
                ]),
            ])
        )
    }

    private func sendTurnCompletedStopped(service: CodeRoverService, threadID: String, turnID: String) {
        service.handleNotification(
            method: "turn/completed",
            params: .object([
                "threadId": .string(threadID),
                "turn": .object([
                    "id": .string(turnID),
                    "status": .string("interrupted"),
                ]),
            ])
        )
    }

    private func sendTurnFailed(service: CodeRoverService, threadID: String, turnID: String, message: String) {
        service.handleNotification(
            method: "turn/failed",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "message": .string(message),
            ])
        )
    }

    private func makeService() -> CodeRoverService {
        let suiteName = "CodeRoverServiceIncomingRunIndicatorTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defaults.removePersistentDomain(forName: suiteName)
        let service = CodeRoverService(defaults: defaults)
        service.messagesByThread = [:]
        // CodeRoverService currently crashes while deallocating in unit-test environment.
        // Keep instances alive for process lifetime so assertions remain deterministic.
        Self.retainedServices.append(service)
        return service
    }

    private func withSavedBridgePairing(
        bridgeId: String,
        transportURL: String,
        perform body: () -> Void
    ) {
        SecureStore.writeString(bridgeId, for: CodeRoverSecureKeys.pairingBridgeId)
        SecureStore.writeCodable(
            [CodeRoverTransportCandidate(kind: "local_ipv4", url: transportURL, label: nil)],
            for: CodeRoverSecureKeys.pairingTransportCandidates
        )
        defer {
            SecureStore.deleteValue(for: CodeRoverSecureKeys.pairingBridgeId)
            SecureStore.deleteValue(for: CodeRoverSecureKeys.pairingTransportCandidates)
        }

        body()
    }

    private func makePairingPayload(
        macDeviceId: String,
        bridgeSuffix: String,
        host: String
    ) -> CodeRoverPairingQRPayload {
        CodeRoverPairingQRPayload(
            v: coderoverPairingQRVersion,
            bridgeId: "bridge-\(bridgeSuffix)",
            macDeviceId: macDeviceId,
            macIdentityPublicKey: Data("mac-public-key-\(bridgeSuffix)".utf8).base64EncodedString(),
            transportCandidates: [
                CodeRoverTransportCandidate(
                    kind: "local_ipv4",
                    url: "ws://\(host):8765/bridge/\(bridgeSuffix)",
                    label: host
                )
            ],
            expiresAt: Int64(Date().addingTimeInterval(300).timeIntervalSince1970 * 1000)
        )
    }

    private func flushAsyncSideEffects() async {
        await Task.yield()
        try? await Task.sleep(nanoseconds: 30_000_000)
    }
}
