// FILE: ContentViewModelPairingTests.swift
// Purpose: Verifies removing the active paired Mac interrupts in-flight turns before unpairing.
// Layer: Unit Test
// Exports: ContentViewModelPairingTests
// Depends on: XCTest, CodeRoverMobile

import XCTest
@testable import CodeRoverMobile

@MainActor
final class ContentViewModelPairingTests: XCTestCase {
    private static var retainedServices: [CodeRoverService] = []

    func testRemoveActivePairingInterruptsKnownActiveTurnBeforeDeleting() async {
        let service = makeService()
        let viewModel = ContentViewModel()
        let payload = makePairingPayload()
        service.rememberBridgePairing(payload)
        service.isConnected = true
        service.activeThreadId = "thread-busy"
        service.activeTurnIdByThread["thread-busy"] = "turn-live"
        service.runningThreadIDs.insert("thread-busy")

        var recordedMethods: [String] = []
        var interruptParams: JSONValue?
        service.requestTransportOverride = { method, params in
            recordedMethods.append(method)
            interruptParams = params
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object([:]),
                includeJSONRPC: false
            )
        }

        await viewModel.removeSavedBridgePairing(
            macDeviceId: payload.macDeviceId,
            coderover: service
        )

        XCTAssertEqual(recordedMethods, ["turn/interrupt"])
        XCTAssertEqual(interruptParams?.objectValue?["threadId"]?.stringValue, "thread-busy")
        XCTAssertEqual(interruptParams?.objectValue?["turnId"]?.stringValue, "turn-live")
        XCTAssertFalse(service.hasSavedBridgePairing)
        XCTAssertNil(service.activeSavedBridgePairing)
        XCTAssertFalse(service.isConnected)
    }

    func testRemoveActivePairingResolvesRunningTurnBeforeInterrupting() async {
        let service = makeService()
        let viewModel = ContentViewModel()
        let payload = makePairingPayload()
        service.rememberBridgePairing(payload)
        service.isConnected = true
        service.activeThreadId = "thread-busy"
        service.runningThreadIDs.insert("thread-busy")

        var recordedMethods: [String] = []
        var interruptParams: JSONValue?
        service.requestTransportOverride = { method, params in
            recordedMethods.append(method)
            if method == "thread/read" {
                return RPCMessage(
                    id: .string(UUID().uuidString),
                    result: .object([
                        "thread": .object([
                            "turns": .array([
                                .object([
                                    "id": .string("turn-resolved"),
                                    "status": .string("in_progress"),
                                ])
                            ])
                        ])
                    ]),
                    includeJSONRPC: false
                )
            }

            interruptParams = params
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object([:]),
                includeJSONRPC: false
            )
        }

        await viewModel.removeSavedBridgePairing(
            macDeviceId: payload.macDeviceId,
            coderover: service
        )

        XCTAssertEqual(recordedMethods, ["thread/read", "turn/interrupt"])
        XCTAssertEqual(interruptParams?.objectValue?["threadId"]?.stringValue, "thread-busy")
        XCTAssertEqual(interruptParams?.objectValue?["turnId"]?.stringValue, "turn-resolved")
        XCTAssertFalse(service.hasSavedBridgePairing)
        XCTAssertFalse(service.isConnected)
    }

    private func makePairingPayload() -> CodeRoverPairingQRPayload {
        CodeRoverPairingQRPayload(
            v: coderoverPairingQRVersion,
            bridgeId: "bridge-1",
            macDeviceId: "mac-1",
            macIdentityPublicKey: "public-key",
            transportCandidates: [
                CodeRoverTransportCandidate(
                    kind: "local",
                    url: "ws://127.0.0.1:8765/bridge/bridge-1",
                    label: "This Mac"
                )
            ],
            expiresAt: 4_102_444_800
        )
    }

    private func makeService() -> CodeRoverService {
        let suiteName = "ContentViewModelPairingTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defaults.removePersistentDomain(forName: suiteName)
        let service = CodeRoverService(defaults: defaults)
        Self.retainedServices.append(service)
        return service
    }
}
