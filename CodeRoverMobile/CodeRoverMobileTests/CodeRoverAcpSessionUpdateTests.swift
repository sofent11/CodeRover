// FILE: CodeRoverAcpSessionUpdateTests.swift
// Purpose: Verifies ACP-native session/update handling for runtime state, transcript rows, and usage.
// Layer: Unit Test
// Exports: CodeRoverAcpSessionUpdateTests
// Depends on: XCTest, CodeRoverMobile

import XCTest
@testable import CodeRoverMobile

@MainActor
final class CodeRoverAcpSessionUpdateTests: XCTestCase {
    private static var retainedServices: [CodeRoverService] = []

    func testSessionInfoUpdateTracksRunningAndCompletedStates() throws {
        let service = makeService()
        service.availableProviders = [.codexDefault]
        service.threads = [ConversationThread(id: "session-1", provider: "codex")]

        service.handleIncomingRPCMessage(
            RPCMessage(
                method: "session/update",
                params: .object([
                    "sessionId": .string("session-1"),
                    "update": .object([
                        "sessionUpdate": .string("session_info_update"),
                        "title": .string("ACP Thread"),
                        "_meta": .object([
                            "coderover": .object([
                                "agentId": .string("codex"),
                                "runState": .string("running"),
                                "turnId": .string("turn-1"),
                            ]),
                        ]),
                    ]),
                ])
            )
        )

        XCTAssertEqual(service.activeTurnID(for: "session-1"), "turn-1")
        XCTAssertTrue(service.runningThreadIDs.contains("session-1"))
        XCTAssertEqual(service.threads.first?.title, "ACP Thread")

        service.handleIncomingRPCMessage(
            RPCMessage(
                method: "session/update",
                params: .object([
                    "sessionId": .string("session-1"),
                    "update": .object([
                        "sessionUpdate": .string("session_info_update"),
                        "_meta": .object([
                            "coderover": .object([
                                "runState": .string("completed"),
                                "turnId": .string("turn-1"),
                            ]),
                        ]),
                    ]),
                ])
            )
        )

        XCTAssertNil(service.activeTurnID(for: "session-1"))
        XCTAssertFalse(service.runningThreadIDs.contains("session-1"))
        XCTAssertEqual(service.latestTurnTerminalState(for: "session-1"), .completed)
        XCTAssertEqual(service.turnTerminalState(for: "turn-1"), .completed)
    }

    func testAgentPlanToolCallAndUsageUpdatesMergeIntoExistingRows() throws {
        let service = makeService()
        service.threads = [ConversationThread(id: "session-2", provider: "codex")]
        service.activeTurnIdByThread["session-2"] = "turn-2"
        service.threadIdByTurnID["turn-2"] = "session-2"

        service.handleIncomingRPCMessage(agentMessageUpdate(sessionId: "session-2", turnId: "turn-2", messageId: "assistant-1", text: "Hello"))
        service.handleIncomingRPCMessage(agentMessageUpdate(sessionId: "session-2", turnId: "turn-2", messageId: "assistant-1", text: " world"))

        service.handleIncomingRPCMessage(
            RPCMessage(
                method: "session/update",
                params: .object([
                    "sessionId": .string("session-2"),
                    "update": .object([
                        "sessionUpdate": .string("plan"),
                        "entries": .array([
                            .object([
                                "content": .string("Inspect the failing flow"),
                                "status": .string("in_progress"),
                            ]),
                            .object([
                                "content": .string("Apply the fix"),
                                "status": .string("pending"),
                            ]),
                        ]),
                        "_meta": .object([
                            "coderover": .object([
                                "turnId": .string("turn-2"),
                                "itemId": .string("plan-1"),
                                "explanation": .string("Working through the issue"),
                            ]),
                        ]),
                    ]),
                ])
            )
        )

        service.handleIncomingRPCMessage(toolCallUpdate(sessionId: "session-2", turnId: "turn-2", status: "in_progress", text: "Running", exitCode: nil))
        service.handleIncomingRPCMessage(toolCallUpdate(sessionId: "session-2", turnId: "turn-2", status: "completed", text: " done", exitCode: 0))

        service.handleIncomingRPCMessage(
            RPCMessage(
                method: "session/update",
                params: .object([
                    "sessionId": .string("session-2"),
                    "update": .object([
                        "sessionUpdate": .string("usage_update"),
                        "usage": .object([
                            "tokensUsed": .integer(1200),
                            "tokenLimit": .integer(32000),
                        ]),
                    ]),
                ])
            )
        )

        let messages = try XCTUnwrap(service.messagesByThread["session-2"])
        let assistant = try XCTUnwrap(messages.first(where: { $0.id == "assistant-1" }))
        XCTAssertEqual(assistant.role, .assistant)
        XCTAssertEqual(assistant.kind, .chat)
        XCTAssertEqual(assistant.text, "Hello world")

        let plan = try XCTUnwrap(messages.first(where: { $0.id == "plan-1" }))
        let planState = try XCTUnwrap(plan.planState)
        XCTAssertEqual(plan.kind, .plan)
        XCTAssertEqual(planState.explanation, "Working through the issue")
        XCTAssertEqual(planState.steps.map(\.step), ["Inspect the failing flow", "Apply the fix"])
        XCTAssertEqual(planState.steps.map(\.status), [.inProgress, .pending])

        let toolCall = try XCTUnwrap(messages.first(where: { $0.id == "tool-1" }))
        XCTAssertEqual(toolCall.kind, .commandExecution)
        XCTAssertEqual(toolCall.text, "Running done")
        XCTAssertFalse(toolCall.isStreaming)

        let details = try XCTUnwrap(service.commandExecutionDetailsByItemID["tool-1"])
        XCTAssertEqual(details.fullCommand, "ls -la")
        XCTAssertEqual(details.cwd, "/tmp/work")
        XCTAssertEqual(details.exitCode, 0)
        XCTAssertEqual(details.outputTail, "Running done")

        XCTAssertEqual(service.contextWindowUsageByThread["session-2"], ContextWindowUsage(tokensUsed: 1200, tokenLimit: 32000))
    }

    private func agentMessageUpdate(sessionId: String, turnId: String, messageId: String, text: String) -> RPCMessage {
        RPCMessage(
            method: "session/update",
            params: .object([
                "sessionId": .string(sessionId),
                "update": .object([
                    "sessionUpdate": .string("agent_message_chunk"),
                    "messageId": .string(messageId),
                    "content": textContent(text),
                    "_meta": .object([
                        "coderover": .object([
                            "turnId": .string(turnId),
                            "itemId": .string(messageId),
                        ]),
                    ]),
                ]),
            ])
        )
    }

    private func toolCallUpdate(
        sessionId: String,
        turnId: String,
        status: String,
        text: String,
        exitCode: Int?
    ) -> RPCMessage {
        var update: RPCObject = [
            "sessionUpdate": .string(exitCode == nil ? "tool_call" : "tool_call_update"),
            "toolCallId": .string("tool-1"),
            "kind": .string("execute"),
            "status": .string(status),
            "title": .string("Run command"),
            "content": textContent(text),
            "rawInput": .object([
                "command": .string("ls -la"),
                "cwd": .string("/tmp/work"),
            ]),
            "_meta": .object([
                "coderover": .object([
                    "turnId": .string(turnId),
                    "itemId": .string("tool-1"),
                ]),
            ]),
        ]

        if let exitCode {
            update["rawOutput"] = .object([
                "exitCode": .integer(exitCode),
                "durationMs": .integer(321),
            ])
        }

        return RPCMessage(
            method: "session/update",
            params: .object([
                "sessionId": .string(sessionId),
                "update": .object(update),
            ])
        )
    }

    private func textContent(_ text: String) -> JSONValue {
        .array([
            .object([
                "content": .object([
                    "type": .string("text"),
                    "text": .string(text),
                ]),
            ]),
        ])
    }

    private func makeService() -> CodeRoverService {
        let suiteName = "CodeRoverAcpSessionUpdateTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defaults.removePersistentDomain(forName: suiteName)
        let service = CodeRoverService(defaults: defaults)
        service.messagesByThread = [:]
        Self.retainedServices.append(service)
        return service
    }
}
