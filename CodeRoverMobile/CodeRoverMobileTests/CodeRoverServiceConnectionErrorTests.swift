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

    func testHistoryRequestTimeoutDoesNotSurfaceAsConnectionError() {
        let service = CodeRoverService()
        let error = CodeRoverServiceError.historyRequestTimedOut(threadId: "thread-history")

        XCTAssertTrue(service.isHistoryRequestTimeoutError(error))
        XCTAssertTrue(service.shouldSuppressUserFacingConnectionError(error))
        XCTAssertFalse(service.isRecoverableTransientConnectionError(error))
        XCTAssertEqual(
            service.userFacingConnectFailureMessage(error),
            "Conversation history is taking longer than expected. Keep the bridge connected and try reloading this chat."
        )
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
}
