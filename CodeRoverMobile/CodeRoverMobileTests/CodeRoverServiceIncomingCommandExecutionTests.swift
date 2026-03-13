// FILE: CodeRoverServiceIncomingCommandExecutionTests.swift
// Purpose: Verifies legacy+modern command execution event handling and dedup behavior.
// Layer: Unit Test
// Exports: CodeRoverServiceIncomingCommandExecutionTests
// Depends on: XCTest, CodeRoverMobile

import XCTest
@testable import CodeRoverMobile

@MainActor
final class CodeRoverServiceIncomingCommandExecutionTests: XCTestCase {
    private static var retainedServices: [CodeRoverService] = []

    func testLegacyBeginAndModernItemStartedMergeIntoSingleRunRow() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let callID = "call-\(UUID().uuidString)"

        service.handleNotification(
            method: "coderover/event/exec_command_begin",
            params: .object([
                "conversationId": .string(threadID),
                "id": .string(turnID),
                "msg": .object([
                    "type": .string("exec_command_begin"),
                    "call_id": .string(callID),
                    "turn_id": .string(turnID),
                    "cwd": .string("/tmp"),
                    "command": .array([
                        .string("/bin/zsh"),
                        .string("-lc"),
                        .string("echo one"),
                    ]),
                ]),
            ])
        )

        service.handleNotification(
            method: "item/started",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "item": .object([
                    "id": .string(callID),
                    "type": .string("commandExecution"),
                    "status": .string("inProgress"),
                    "cwd": .string("/tmp"),
                    "command": .string("/bin/zsh -lc \"echo one\""),
                    "commandActions": .array([]),
                ]),
            ])
        )

        let runRows = service.messages(for: threadID).filter {
            $0.role == .system && $0.kind == .commandExecution
        }
        XCTAssertEqual(runRows.count, 1)
        XCTAssertTrue(runRows[0].text.lowercased().hasPrefix("running "))
    }

    func testOutputDeltaDoesNotReplaceExistingCommandPreview() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let callID = "call-\(UUID().uuidString)"

        service.handleNotification(
            method: "item/started",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "item": .object([
                    "id": .string(callID),
                    "type": .string("commandExecution"),
                    "status": .string("inProgress"),
                    "cwd": .string("/tmp"),
                    "command": .string("/bin/zsh -lc \"echo one\""),
                    "commandActions": .array([]),
                ]),
            ])
        )

        let before = service.messages(for: threadID).first { $0.itemId == callID }?.text
        service.handleNotification(
            method: "item/commandExecution/outputDelta",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "itemId": .string(callID),
                "delta": .string("ONE\n"),
            ])
        )
        let after = service.messages(for: threadID).first { $0.itemId == callID }?.text

        XCTAssertEqual(after, before)
        XCTAssertFalse((after ?? "").lowercased().contains("running command"))
    }

    func testLegacyEndCompletesExistingRunRow() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let callID = "call-\(UUID().uuidString)"

        service.handleNotification(
            method: "coderover/event/exec_command_begin",
            params: .object([
                "conversationId": .string(threadID),
                "id": .string(turnID),
                "msg": .object([
                    "type": .string("exec_command_begin"),
                    "call_id": .string(callID),
                    "turn_id": .string(turnID),
                    "cwd": .string("/tmp"),
                    "command": .array([.string("echo"), .string("ok")]),
                ]),
            ])
        )

        service.handleNotification(
            method: "coderover/event/exec_command_end",
            params: .object([
                "conversationId": .string(threadID),
                "id": .string(turnID),
                "msg": .object([
                    "type": .string("exec_command_end"),
                    "call_id": .string(callID),
                    "turn_id": .string(turnID),
                    "cwd": .string("/tmp"),
                    "status": .string("completed"),
                    "exit_code": .integer(0),
                    "command": .array([.string("echo"), .string("ok")]),
                ]),
            ])
        )

        let runRows = service.messages(for: threadID).filter {
            $0.role == .system && $0.kind == .commandExecution
        }
        XCTAssertEqual(runRows.count, 1)
        XCTAssertTrue(runRows[0].text.lowercased().hasPrefix("completed "))
        XCTAssertFalse(runRows[0].isStreaming)
    }

    func testToolCallDeltaAddsEssentialActivityLines() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        service.handleNotification(
            method: "item/toolCall/outputDelta",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "delta": .string("Read CodeRoverProtocol.swift\nSearch extractSystemTitleAndBody\n{\"ignore\":\"json\"}"),
            ])
        )

        let thinkingRows = service.messages(for: threadID).filter {
            $0.role == .system && $0.kind == .thinking
        }
        XCTAssertEqual(thinkingRows.count, 1)
        let body = thinkingRows[0].text
        XCTAssertTrue(body.contains("Read CodeRoverProtocol.swift"))
        XCTAssertTrue(body.contains("Search extractSystemTitleAndBody"))
        XCTAssertFalse(body.contains("ignore"))
    }

    func testLateActivityLineAfterTurnCompletionDoesNotReopenThinkingStream() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        service.handleNotification(
            method: "turn/started",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
            ])
        )
        service.handleNotification(
            method: "item/toolCall/outputDelta",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "delta": .string("Read file A.swift"),
            ])
        )
        service.handleNotification(
            method: "turn/completed",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
            ])
        )
        service.handleNotification(
            method: "coderover/event/read",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "path": .string("B.swift"),
            ])
        )

        let thinkingRows = service.messages(for: threadID).filter {
            $0.role == .system && $0.kind == .thinking
        }
        XCTAssertEqual(thinkingRows.count, 1)
        XCTAssertTrue(thinkingRows[0].text.contains("Read file A.swift"))
        XCTAssertTrue(thinkingRows[0].text.contains("Read B.swift"))
        XCTAssertFalse(thinkingRows[0].isStreaming)
    }

    func testLateActivityLineWithoutTurnIdAfterCompletionDoesNotCreateTrailingThinkingRow() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        service.handleNotification(
            method: "turn/started",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
            ])
        )
        service.handleNotification(
            method: "turn/completed",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
            ])
        )

        service.handleNotification(
            method: "coderover/event/background_event",
            params: .object([
                "threadId": .string(threadID),
                "message": .string("Controllo subito il repository"),
            ])
        )

        let thinkingRows = service.messages(for: threadID).filter {
            $0.role == .system && $0.kind == .thinking
        }
        XCTAssertTrue(thinkingRows.isEmpty)
    }

    func testLateTerminalInteractionDoesNotRegressCompletedCommandRow() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let callID = "call-\(UUID().uuidString)"

        service.handleNotification(
            method: "item/started",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "item": .object([
                    "id": .string(callID),
                    "type": .string("commandExecution"),
                    "status": .string("inProgress"),
                    "command": .string("/bin/zsh -lc \"echo one\""),
                ]),
            ])
        )
        service.handleNotification(
            method: "item/completed",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "item": .object([
                    "id": .string(callID),
                    "type": .string("commandExecution"),
                    "status": .string("completed"),
                    "command": .string("/bin/zsh -lc \"echo one\""),
                ]),
            ])
        )
        service.handleNotification(
            method: "item/commandExecution/terminalInteraction",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "itemId": .string(callID),
                "command": .string("/bin/zsh -lc \"echo one\""),
            ])
        )

        let runRow = service.messages(for: threadID).first(where: {
            $0.role == .system && $0.kind == .commandExecution && $0.itemId == callID
        })
        XCTAssertNotNil(runRow)
        XCTAssertTrue(runRow?.text.lowercased().hasPrefix("completed ") ?? false)
        XCTAssertFalse(runRow?.isStreaming ?? true)
    }

    func testReasoningDeltasPreserveWhitespaceAndCompletionReplacesSnapshot() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let itemID = "reasoning-\(UUID().uuidString)"

        service.handleNotification(
            method: "item/reasoning/textDelta",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "itemId": .string(itemID),
                "delta": .string("**Providing"),
            ])
        )
        service.handleNotification(
            method: "item/reasoning/textDelta",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "itemId": .string(itemID),
                "delta": .string(" exact 200-word paragraph**"),
            ])
        )
        service.handleNotification(
            method: "item/completed",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "item": .object([
                    "id": .string(itemID),
                    "type": .string("reasoning"),
                    "content": .array([
                        .object([
                            "type": .string("text"),
                            "text": .string("**Providing exact 200-word paragraph**"),
                        ]),
                    ]),
                ]),
            ])
        )

        let thinkingRows = service.messages(for: threadID).filter {
            $0.role == .system && $0.kind == .thinking
        }
        XCTAssertEqual(thinkingRows.count, 1)
        XCTAssertEqual(thinkingRows[0].text, "**Providing exact 200-word paragraph**")
    }

    func testLateReasoningDeltaAfterTurnCompletionDoesNotCreateNewThinkingRow() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let itemID = "reasoning-\(UUID().uuidString)"

        service.handleNotification(
            method: "turn/started",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
            ])
        )
        service.handleNotification(
            method: "turn/completed",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
            ])
        )

        service.handleNotification(
            method: "item/reasoning/textDelta",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "itemId": .string(itemID),
                "delta": .string("Late reasoning chunk"),
            ])
        )

        let thinkingRows = service.messages(for: threadID).filter {
            $0.role == .system && $0.kind == .thinking
        }
        XCTAssertTrue(thinkingRows.isEmpty)
    }

    func testLateReasoningDeltaAfterTurnCompletionUpdatesExistingThinkingWithoutStreaming() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let itemID = "reasoning-\(UUID().uuidString)"

        service.handleNotification(
            method: "turn/started",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
            ])
        )
        service.handleNotification(
            method: "item/reasoning/textDelta",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "itemId": .string(itemID),
                "delta": .string("First"),
            ])
        )
        service.handleNotification(
            method: "turn/completed",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
            ])
        )
        service.handleNotification(
            method: "item/reasoning/textDelta",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "itemId": .string(itemID),
                "delta": .string(" second"),
            ])
        )

        let thinkingRows = service.messages(for: threadID).filter {
            $0.role == .system && $0.kind == .thinking
        }
        XCTAssertEqual(thinkingRows.count, 1)
        XCTAssertEqual(thinkingRows[0].text, "First second")
        XCTAssertFalse(thinkingRows[0].isStreaming)
    }

    func testHistoryMergeReconcilesThinkingByTurnWhenTextDiffers() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let now = Date()

        let existing = [
            ChatMessage(
                threadId: threadID,
                role: .system,
                kind: .thinking,
                text: "**Providingexact200-wordparagraph**",
                createdAt: now,
                turnId: turnID,
                itemId: nil,
                isStreaming: false,
                deliveryState: .confirmed
            ),
        ]
        let history = [
            ChatMessage(
                threadId: threadID,
                role: .system,
                kind: .thinking,
                text: "**Providing exact 200-word paragraph**",
                createdAt: now.addingTimeInterval(1),
                turnId: turnID,
                itemId: nil,
                isStreaming: false,
                deliveryState: .confirmed
            ),
        ]

        let merged = service.mergeHistoryMessages(existing, history)
        XCTAssertEqual(merged.count, 1)
        XCTAssertEqual(merged[0].text, "**Providing exact 200-word paragraph**")
    }

    func testReasoningDeltaWithoutIDsIsIgnoredWhenMultipleThreadsExist() {
        let service = makeService()
        let firstThreadID = "thread-\(UUID().uuidString)"
        let secondThreadID = "thread-\(UUID().uuidString)"
        service.threads = [
            ConversationThread(id: firstThreadID, title: "First"),
            ConversationThread(id: secondThreadID, title: "Second"),
        ]
        service.activeThreadId = firstThreadID

        service.handleNotification(
            method: "item/reasoning/textDelta",
            params: .object([
                "delta": .string("Should not route"),
            ])
        )

        XCTAssertTrue(service.messages(for: firstThreadID).isEmpty)
        XCTAssertTrue(service.messages(for: secondThreadID).isEmpty)
    }

    func testHistoryMergeDedupesQuotedCommandExecutionPreviews() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let now = Date()

        let existing = [
            ChatMessage(
                threadId: threadID,
                role: .system,
                kind: .commandExecution,
                text: "completed /bin/zsh -lc rg --files",
                createdAt: now,
                turnId: turnID,
                isStreaming: false,
                deliveryState: .confirmed
            ),
        ]
        let history = [
            ChatMessage(
                threadId: threadID,
                role: .system,
                kind: .commandExecution,
                text: "completed /bin/zsh -lc \"rg --files\"",
                createdAt: now.addingTimeInterval(1),
                turnId: turnID,
                isStreaming: false,
                deliveryState: .confirmed
            ),
        ]

        let merged = service.mergeHistoryMessages(existing, history)
        let commandRows = merged.filter { $0.role == .system && $0.kind == .commandExecution }

        XCTAssertEqual(commandRows.count, 1)
        XCTAssertEqual(commandRows[0].turnId, turnID)
    }

    private func makeService() -> CodeRoverService {
        let suiteName = "CodeRoverServiceIncomingCommandExecutionTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defaults.removePersistentDomain(forName: suiteName)
        let service = CodeRoverService(defaults: defaults)
        service.messagesByThread = [:]
        // CodeRoverService currently crashes while deallocating in unit-test environment.
        // Keep instances alive for the process lifetime so assertions can run deterministically.
        Self.retainedServices.append(service)
        return service
    }
}
