// FILE: CodeRoverServiceConnectionErrorTests.swift
// Purpose: Verifies background disconnects stay silent while real connection failures still surface.
// Layer: Unit Test
// Exports: CodeRoverServiceConnectionErrorTests
// Depends on: XCTest, Network, CodeRoverMobile

import XCTest
import Network
@testable import CodeRoverMobile

@MainActor
final class CodeRoverServiceConnectionErrorTests: XCTestCase {
    func testBenignAbortIsSuppressedFromUserFacingErrors() {
        let service = CodeRoverService()
        let error = NWError.posix(.ECONNABORTED)

        XCTAssertTrue(service.isBenignBackgroundDisconnect(error))
        XCTAssertTrue(service.shouldSuppressUserFacingConnectionError(error))
    }

    func testTransientTimeoutStillSurfacesToUser() {
        let service = CodeRoverService()
        let error = NWError.posix(.ETIMEDOUT)

        XCTAssertTrue(service.isRecoverableTransientConnectionError(error))
        XCTAssertFalse(service.shouldSuppressUserFacingConnectionError(error))
    }

    func testConnectionRefusedStillSurfacesToUser() {
        let service = CodeRoverService()
        let error = NWError.posix(.ECONNREFUSED)

        XCTAssertFalse(service.shouldSuppressUserFacingConnectionError(error))
        XCTAssertEqual(
            service.userFacingConnectError(
                error: error,
                attemptedURL: "ws://192.168.0.12:8765/bridge/bridge-1",
                host: "192.168.0.12"
            ),
            "Connection refused by bridge transport at ws://192.168.0.12:8765/bridge/bridge-1."
        )
    }

    func testBenignBackgroundAbortGetsFriendlyFailureCopy() {
        let service = CodeRoverService()

        XCTAssertEqual(
            service.userFacingConnectFailureMessage(NWError.posix(.ECONNABORTED)),
            "Connection was interrupted. Tap Reconnect to try again."
        )
    }

    func testPostConnectSyncSurfacesSessionListFailure() async {
        let service = CodeRoverService()

        service.requestTransportOverride = { method, _ in
            switch method {
            case "_coderover/agent/list":
                return RPCMessage(id: .integer(1), result: .object(["agents": .array([])]))
            case "session/list":
                throw CodeRoverServiceError.invalidInput("session/list timed out")
            case "_coderover/model/list":
                return RPCMessage(id: .integer(2), result: .object(["items": .array([])]))
            default:
                return RPCMessage(id: .integer(999), result: .object([:]))
            }
        }

        await service.performPostConnectSyncPass()

        XCTAssertEqual(
            service.lastErrorMessage,
            "Unable to load chats from the paired Mac. Reconnect and try again."
        )
    }
}
