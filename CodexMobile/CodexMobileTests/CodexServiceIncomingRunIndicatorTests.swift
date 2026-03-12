// FILE: CodexServiceIncomingRunIndicatorTests.swift
// Purpose: Verifies sidebar run badge transitions (running/ready/failed) from app-server events.
// Layer: Unit Test
// Exports: CodexServiceIncomingRunIndicatorTests
// Depends on: XCTest, CodexMobile

import XCTest
import Network
@testable import CodexMobile

@MainActor
final class CodexServiceIncomingRunIndicatorTests: XCTestCase {
    private static var retainedServices: [CodexService] = []

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
            service.pairedBridgeId = SecureStore.readString(for: CodexSecureKeys.pairingBridgeId)
            service.pairedTransportCandidates = SecureStore.readCodable(
                [CodexTransportCandidate].self,
                for: CodexSecureKeys.pairingTransportCandidates
            ) ?? []
            service.isConnected = true
            service.isInitialized = true

            service.handleReceiveError(CodexServiceError.disconnected)

            XCTAssertFalse(service.isConnected)
            XCTAssertTrue(service.shouldAutoReconnectOnForeground)
            XCTAssertEqual(service.pairedBridgeId, SecureStore.readString(for: CodexSecureKeys.pairingBridgeId))
            XCTAssertFalse(service.pairedTransportCandidates.isEmpty)
        }
    }

    func testSavedBridgePairingRequiresBridgeIdAndTransportCandidate() {
        let service = makeService()

        XCTAssertFalse(service.hasSavedBridgePairing)

        service.pairedBridgeId = "bridge-1"
        XCTAssertFalse(service.hasSavedBridgePairing)

        service.pairedTransportCandidates = [
            CodexTransportCandidate(kind: "local_ipv4", url: "ws://192.168.0.10:8765/bridge/bridge-1", label: nil)
        ]
        XCTAssertTrue(service.hasSavedBridgePairing)
    }

    func testUnpairClearsSavedPairingAndTrustedMacRecord() async {
        let service = makeService()
        let macDeviceId = "mac-\(UUID().uuidString)"
        let macIdentityPublicKey = Data("trusted-mac-key".utf8).base64EncodedString()

        SecureStore.writeString("bridge-\(UUID().uuidString)", for: CodexSecureKeys.pairingBridgeId)
        SecureStore.writeCodable(
            [CodexTransportCandidate(kind: "local_ipv4", url: "ws://192.168.0.10:8765/bridge/test", label: nil)],
            for: CodexSecureKeys.pairingTransportCandidates
        )
        SecureStore.writeString(macDeviceId, for: CodexSecureKeys.pairingMacDeviceId)
        SecureStore.writeString(macIdentityPublicKey, for: CodexSecureKeys.pairingMacIdentityPublicKey)
        SecureStore.writeCodable(
            CodexTrustedMacRegistry(
                records: [
                    macDeviceId: CodexTrustedMacRecord(
                        macDeviceId: macDeviceId,
                        macIdentityPublicKey: macIdentityPublicKey,
                        lastPairedAt: .now
                    )
                ]
            ),
            for: CodexSecureKeys.trustedMacRegistry
        )
        defer {
            SecureStore.deleteValue(for: CodexSecureKeys.pairingBridgeId)
            SecureStore.deleteValue(for: CodexSecureKeys.pairingTransportCandidates)
            SecureStore.deleteValue(for: CodexSecureKeys.pairingMacDeviceId)
            SecureStore.deleteValue(for: CodexSecureKeys.pairingMacIdentityPublicKey)
            SecureStore.deleteValue(for: CodexSecureKeys.trustedMacRegistry)
        }

        service.pairedBridgeId = SecureStore.readString(for: CodexSecureKeys.pairingBridgeId)
        service.pairedTransportCandidates = SecureStore.readCodable(
            [CodexTransportCandidate].self,
            for: CodexSecureKeys.pairingTransportCandidates
        ) ?? []
        service.pairedMacDeviceId = SecureStore.readString(for: CodexSecureKeys.pairingMacDeviceId)
        service.pairedMacIdentityPublicKey = SecureStore.readString(for: CodexSecureKeys.pairingMacIdentityPublicKey)
        service.trustedMacRegistry = SecureStore.readCodable(
            CodexTrustedMacRegistry.self,
            for: CodexSecureKeys.trustedMacRegistry
        ) ?? .empty
        service.secureConnectionState = .trustedMac

        await service.unpair()

        XCTAssertFalse(service.hasSavedBridgePairing)
        XCTAssertNil(service.pairedMacDeviceId)
        XCTAssertNil(service.pairedMacIdentityPublicKey)
        XCTAssertEqual(service.secureConnectionState, .notPaired)
        XCTAssertTrue(service.trustedMacRegistry.records.isEmpty)
        XCTAssertNil(SecureStore.readString(for: CodexSecureKeys.pairingBridgeId))
        XCTAssertNil(SecureStore.readString(for: CodexSecureKeys.pairingMacDeviceId))
        let storedRegistry = SecureStore.readCodable(
            CodexTrustedMacRegistry.self,
            for: CodexSecureKeys.trustedMacRegistry
        ) ?? .empty
        XCTAssertTrue(storedRegistry.records.isEmpty)
    }

    func testRememberBridgePairingPersistsAllTransportCandidates() {
        let service = makeService()
        let payload = CodexPairingQRPayload(
            v: codexPairingQRVersion,
            bridgeId: "bridge-\(UUID().uuidString)",
            macDeviceId: "mac-\(UUID().uuidString)",
            macIdentityPublicKey: Data("mac-public-key".utf8).base64EncodedString(),
            transportCandidates: [
                CodexTransportCandidate(
                    kind: "local_ipv4",
                    url: "ws://192.168.0.10:8765/bridge/test",
                    label: "Home LAN"
                ),
                CodexTransportCandidate(
                    kind: "tailnet",
                    url: "ws://remodex-host.tailnet.ts.net:8765/bridge/test",
                    label: "Tailscale"
                ),
            ],
            expiresAt: Int64(Date().addingTimeInterval(300).timeIntervalSince1970 * 1000)
        )
        defer {
            SecureStore.deleteValue(for: CodexSecureKeys.pairingBridgeId)
            SecureStore.deleteValue(for: CodexSecureKeys.pairingTransportCandidates)
            SecureStore.deleteValue(for: CodexSecureKeys.pairingPreferredTransportURL)
            SecureStore.deleteValue(for: CodexSecureKeys.pairingLastSuccessfulTransportURL)
            SecureStore.deleteValue(for: CodexSecureKeys.pairingMacDeviceId)
            SecureStore.deleteValue(for: CodexSecureKeys.pairingMacIdentityPublicKey)
            SecureStore.deleteValue(for: CodexSecureKeys.trustedMacRegistry)
        }

        service.rememberBridgePairing(payload)

        XCTAssertEqual(service.pairedTransportCandidates, payload.transportCandidates)
        let storedCandidates = SecureStore.readCodable(
            [CodexTransportCandidate].self,
            for: CodexSecureKeys.pairingTransportCandidates
        )
        XCTAssertEqual(storedCandidates, payload.transportCandidates)
    }

    func testPreferredTransportURLOverridesReconnectOrdering() {
        let service = makeService()
        service.pairedTransportCandidates = [
            CodexTransportCandidate(kind: "local_ipv4", url: "ws://192.168.0.10:8765/bridge/test", label: "Home"),
            CodexTransportCandidate(kind: "tailnet", url: "ws://remodex-host.tailnet.ts.net:8765/bridge/test", label: "Tailscale"),
            CodexTransportCandidate(kind: "local_hostname", url: "ws://remodex.local:8765/bridge/test", label: "Hostname"),
        ]
        service.lastSuccessfulTransportURL = "ws://192.168.0.10:8765/bridge/test"

        service.setPreferredTransportURL("ws://remodex-host.tailnet.ts.net:8765/bridge/test")

        XCTAssertEqual(
            service.orderedTransportCandidateURLs,
            [
                "ws://remodex-host.tailnet.ts.net:8765/bridge/test",
                "ws://192.168.0.10:8765/bridge/test",
                "ws://remodex.local:8765/bridge/test",
            ]
        )
        XCTAssertEqual(
            SecureStore.readString(for: CodexSecureKeys.pairingPreferredTransportURL),
            "ws://remodex-host.tailnet.ts.net:8765/bridge/test"
        )
        defer {
            SecureStore.deleteValue(for: CodexSecureKeys.pairingPreferredTransportURL)
        }
    }

    func testInitMigratesLegacyPairingIntoMultiPairingStore() {
        let bridgeId = "bridge-\(UUID().uuidString)"
        let macDeviceId = "mac-\(UUID().uuidString)"
        let macIdentityPublicKey = Data("mac-public-key".utf8).base64EncodedString()

        SecureStore.writeString(bridgeId, for: CodexSecureKeys.pairingBridgeId)
        SecureStore.writeCodable(
            [CodexTransportCandidate(kind: "local_ipv4", url: "ws://192.168.0.10:8765/bridge/test", label: "Home")],
            for: CodexSecureKeys.pairingTransportCandidates
        )
        SecureStore.writeString(macDeviceId, for: CodexSecureKeys.pairingMacDeviceId)
        SecureStore.writeString(macIdentityPublicKey, for: CodexSecureKeys.pairingMacIdentityPublicKey)
        defer {
            SecureStore.deleteValue(for: CodexSecureKeys.pairingRecords)
            SecureStore.deleteValue(for: CodexSecureKeys.pairingActiveMacDeviceId)
            SecureStore.deleteValue(for: CodexSecureKeys.pairingBridgeId)
            SecureStore.deleteValue(for: CodexSecureKeys.pairingTransportCandidates)
            SecureStore.deleteValue(for: CodexSecureKeys.pairingMacDeviceId)
            SecureStore.deleteValue(for: CodexSecureKeys.pairingMacIdentityPublicKey)
        }

        let service = makeService()

        XCTAssertEqual(service.savedBridgePairings.count, 1)
        XCTAssertEqual(service.activeSavedBridgePairing?.macDeviceId, macDeviceId)
        XCTAssertEqual(service.pairedBridgeId, bridgeId)
        XCTAssertEqual(
            SecureStore.readCodable([CodexBridgePairingRecord].self, for: CodexSecureKeys.pairingRecords)?.count,
            1
        )
        XCTAssertEqual(
            SecureStore.readString(for: CodexSecureKeys.pairingActiveMacDeviceId),
            macDeviceId
        )
    }

    func testRememberBridgePairingStoresMultipleMacsAndAllowsSwitchingActiveMac() {
        let service = makeService()
        let homePayload = makePairingPayload(macDeviceId: "mac-home", bridgeSuffix: "home", host: "192.168.0.10")
        let workPayload = makePairingPayload(macDeviceId: "mac-work", bridgeSuffix: "work", host: "192.168.0.20")
        defer {
            SecureStore.deleteValue(for: CodexSecureKeys.pairingRecords)
            SecureStore.deleteValue(for: CodexSecureKeys.pairingActiveMacDeviceId)
            SecureStore.deleteValue(for: CodexSecureKeys.pairingBridgeId)
            SecureStore.deleteValue(for: CodexSecureKeys.pairingTransportCandidates)
            SecureStore.deleteValue(for: CodexSecureKeys.pairingPreferredTransportURL)
            SecureStore.deleteValue(for: CodexSecureKeys.pairingLastSuccessfulTransportURL)
            SecureStore.deleteValue(for: CodexSecureKeys.pairingMacDeviceId)
            SecureStore.deleteValue(for: CodexSecureKeys.pairingMacIdentityPublicKey)
            SecureStore.deleteValue(for: CodexSecureKeys.secureProtocolVersion)
            SecureStore.deleteValue(for: CodexSecureKeys.secureLastAppliedBridgeOutboundSeq)
            SecureStore.deleteValue(for: CodexSecureKeys.trustedMacRegistry)
        }

        service.rememberBridgePairing(homePayload)
        service.rememberBridgePairing(workPayload)

        XCTAssertEqual(service.savedBridgePairings.count, 2)
        XCTAssertEqual(service.activeSavedBridgePairing?.macDeviceId, workPayload.macDeviceId)
        XCTAssertTrue(service.setActiveSavedBridgePairing(macDeviceId: homePayload.macDeviceId))
        XCTAssertEqual(service.activeSavedBridgePairing?.macDeviceId, homePayload.macDeviceId)
        XCTAssertEqual(service.pairedBridgeId, homePayload.bridgeId)
        XCTAssertEqual(
            SecureStore.readString(for: CodexSecureKeys.pairingActiveMacDeviceId),
            homePayload.macDeviceId
        )
    }

    func testRemovingActivePairingFallsBackToAnotherSavedMac() {
        let service = makeService()
        let homePayload = makePairingPayload(macDeviceId: "mac-home", bridgeSuffix: "home", host: "192.168.0.10")
        let workPayload = makePairingPayload(macDeviceId: "mac-work", bridgeSuffix: "work", host: "192.168.0.20")
        defer {
            SecureStore.deleteValue(for: CodexSecureKeys.pairingRecords)
            SecureStore.deleteValue(for: CodexSecureKeys.pairingActiveMacDeviceId)
            SecureStore.deleteValue(for: CodexSecureKeys.pairingBridgeId)
            SecureStore.deleteValue(for: CodexSecureKeys.pairingTransportCandidates)
            SecureStore.deleteValue(for: CodexSecureKeys.pairingPreferredTransportURL)
            SecureStore.deleteValue(for: CodexSecureKeys.pairingLastSuccessfulTransportURL)
            SecureStore.deleteValue(for: CodexSecureKeys.pairingMacDeviceId)
            SecureStore.deleteValue(for: CodexSecureKeys.pairingMacIdentityPublicKey)
            SecureStore.deleteValue(for: CodexSecureKeys.secureProtocolVersion)
            SecureStore.deleteValue(for: CodexSecureKeys.secureLastAppliedBridgeOutboundSeq)
            SecureStore.deleteValue(for: CodexSecureKeys.trustedMacRegistry)
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
            method: "codex/event/agent_message_content_delta",
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
            method: "codex/event/agent_message_content_delta",
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
            method: "codex/event/agent_message_content_delta",
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
            method: "codex/event/agent_message",
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

    private func sendTurnStarted(service: CodexService, threadID: String, turnID: String) {
        service.handleNotification(
            method: "turn/started",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
            ])
        )
    }

    private func sendTurnCompletedSuccess(service: CodexService, threadID: String, turnID: String) {
        service.handleNotification(
            method: "turn/completed",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
            ])
        )
    }

    private func sendTurnCompletedFailure(
        service: CodexService,
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

    private func sendTurnCompletedStopped(service: CodexService, threadID: String, turnID: String) {
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

    private func sendTurnFailed(service: CodexService, threadID: String, turnID: String, message: String) {
        service.handleNotification(
            method: "turn/failed",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "message": .string(message),
            ])
        )
    }

    private func makeService() -> CodexService {
        let suiteName = "CodexServiceIncomingRunIndicatorTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defaults.removePersistentDomain(forName: suiteName)
        let service = CodexService(defaults: defaults)
        service.messagesByThread = [:]
        // CodexService currently crashes while deallocating in unit-test environment.
        // Keep instances alive for process lifetime so assertions remain deterministic.
        Self.retainedServices.append(service)
        return service
    }

    private func withSavedBridgePairing(
        bridgeId: String,
        transportURL: String,
        perform body: () -> Void
    ) {
        SecureStore.writeString(bridgeId, for: CodexSecureKeys.pairingBridgeId)
        SecureStore.writeCodable(
            [CodexTransportCandidate(kind: "local_ipv4", url: transportURL, label: nil)],
            for: CodexSecureKeys.pairingTransportCandidates
        )
        defer {
            SecureStore.deleteValue(for: CodexSecureKeys.pairingBridgeId)
            SecureStore.deleteValue(for: CodexSecureKeys.pairingTransportCandidates)
        }

        body()
    }

    private func makePairingPayload(
        macDeviceId: String,
        bridgeSuffix: String,
        host: String
    ) -> CodexPairingQRPayload {
        CodexPairingQRPayload(
            v: codexPairingQRVersion,
            bridgeId: "bridge-\(bridgeSuffix)",
            macDeviceId: macDeviceId,
            macIdentityPublicKey: Data("mac-public-key-\(bridgeSuffix)".utf8).base64EncodedString(),
            transportCandidates: [
                CodexTransportCandidate(
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
