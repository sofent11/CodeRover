// FILE: CodeRoverAcpServerRequestTests.swift
// Purpose: Verifies ACP-native server requests populate approval and structured-input state.
// Layer: Unit Test
// Exports: CodeRoverAcpServerRequestTests
// Depends on: XCTest, CodeRoverMobile

import XCTest
@testable import CodeRoverMobile

@MainActor
final class CodeRoverAcpServerRequestTests: XCTestCase {
    private static var retainedServices: [CodeRoverService] = []

    func testSessionRequestPermissionPopulatesPendingApproval() throws {
        let service = makeService()

        service.handleIncomingRPCMessage(
            RPCMessage(
                id: .string("request-1"),
                method: "session/request_permission",
                params: .object([
                    "sessionId": .string("session-approval"),
                    "toolCall": .object([
                        "kind": .string("execute"),
                        "title": .string("Run command"),
                        "rawInput": .object([
                            "command": .string("rm -rf build"),
                            "reason": .string("Clean generated artifacts"),
                        ]),
                        "_meta": .object([
                            "coderover": .object([
                                "turnId": .string("turn-approval"),
                            ]),
                        ]),
                    ]),
                ])
            )
        )

        let approval = try XCTUnwrap(service.pendingApproval)
        XCTAssertEqual(approval.method, "session/request_permission/execute")
        XCTAssertEqual(approval.command, "rm -rf build")
        XCTAssertEqual(approval.reason, "Clean generated artifacts")
        XCTAssertEqual(approval.threadId, "session-approval")
        XCTAssertEqual(approval.turnId, "turn-approval")
    }

    func testStructuredInputRequestCreatesPromptMessage() throws {
        let service = makeService()
        service.threads = [ConversationThread(id: "session-input", provider: "codex")]
        service.activeTurnIdByThread["session-input"] = "turn-input"

        service.handleIncomingRPCMessage(
            RPCMessage(
                id: .string("request-2"),
                method: "_coderover/session/request_input",
                params: .object([
                    "sessionId": .string("session-input"),
                    "questions": .array([
                        .object([
                            "id": .string("choice"),
                            "header": .string("Access"),
                            "question": .string("How should we proceed?"),
                            "options": .array([
                                .object([
                                    "label": .string("Allow once"),
                                    "description": .string("Approve this single action"),
                                ]),
                                .object([
                                    "label": .string("Deny"),
                                    "description": .string("Reject the request"),
                                ]),
                            ]),
                        ]),
                    ]),
                    "_meta": .object([
                        "coderover": .object([
                            "turnId": .string("turn-input"),
                            "itemId": .string("prompt-1"),
                        ]),
                    ]),
                ])
            )
        )

        let prompt = try XCTUnwrap(service.messagesByThread["session-input"]?.first(where: { $0.itemId == "prompt-1" }))
        XCTAssertEqual(prompt.kind, .userInputPrompt)
        XCTAssertEqual(prompt.turnId, "turn-input")
        XCTAssertEqual(prompt.text, "Access\nHow should we proceed?")
        XCTAssertEqual(prompt.structuredUserInputRequest?.questions.first?.id, "choice")
        XCTAssertEqual(prompt.structuredUserInputRequest?.questions.first?.options.map(\.label), ["Allow once", "Deny"])
        XCTAssertEqual(service.threadIdByTurnID["turn-input"], "session-input")
    }

    private func makeService() -> CodeRoverService {
        let suiteName = "CodeRoverAcpServerRequestTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defaults.removePersistentDomain(forName: suiteName)
        let service = CodeRoverService(defaults: defaults)
        service.messagesByThread = [:]
        Self.retainedServices.append(service)
        return service
    }
}
