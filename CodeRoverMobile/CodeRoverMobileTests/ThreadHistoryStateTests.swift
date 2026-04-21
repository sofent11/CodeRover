import Observation
import XCTest
@testable import CodeRoverMobile

@MainActor
final class ThreadHistoryStateTests: XCTestCase {
    func testTailMergeStoresCursorWindow() {
        let service = makeService()
        let threadID = "thread-cursor-window"

        service.mergeHistoryWindow(
            threadId: threadID,
            mode: .tail,
            historyMessages: makeMessages(threadID: threadID, range: 71 ... 120),
            olderCursor: "cursor-71",
            newerCursor: "cursor-120",
            hasOlder: true,
            hasNewer: false
        )

        let state = try XCTUnwrap(service.historyStateByThread[threadID])
        XCTAssertEqual(state.oldestCursor, "cursor-71")
        XCTAssertEqual(state.newestCursor, "cursor-120")
        XCTAssertTrue(state.hasOlderOnServer)
        XCTAssertFalse(state.hasNewerOnServer)
    }

    func testLoadThreadHistoryUsesAfterWhenNewestCursorExists() async throws {
        let service = makeService()
        let threadID = "thread-after-catch-up"
        service.isConnected = true
        service.isInitialized = true
        service.messagesByThread[threadID] = makeMessages(threadID: threadID, range: 1 ... 20)
        service.historyStateByThread[threadID] = ThreadHistoryState(
            oldestCursor: "cursor-1",
            newestCursor: "cursor-20",
            hasOlderOnServer: false,
            hasNewerOnServer: true
        )

        let afterExpectation = expectation(description: "after request")
        service.requestTransportOverride = { method, params in
            XCTAssertEqual(method, "thread/read")
            let historyObject = try XCTUnwrap(params?.objectValue?["history"]?.objectValue)
            XCTAssertEqual(historyObject["mode"]?.stringValue, "after")
            XCTAssertEqual(historyObject["cursor"]?.stringValue, "cursor-20")
            afterExpectation.fulfill()
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object([
                    "thread": self.makeThreadPayload(
                        threadID: threadID,
                        title: "After",
                        messageRange: 21 ... 22
                    ),
                    "historyWindow": self.makeHistoryWindowObject(
                        olderCursor: "cursor-21",
                        newerCursor: "cursor-22",
                        hasOlder: false,
                        hasNewer: false
                    ),
                ]),
                includeJSONRPC: false
            )
        }

        try await service.loadThreadHistoryIfNeeded(threadId: threadID)

        await fulfillment(of: [afterExpectation], timeout: 1.0)
        XCTAssertEqual(service.messagesByThread[threadID]?.map(\.itemId), ["item-1", "item-2", "item-3", "item-4", "item-5", "item-6", "item-7", "item-8", "item-9", "item-10", "item-11", "item-12", "item-13", "item-14", "item-15", "item-16", "item-17", "item-18", "item-19", "item-20", "item-21", "item-22"])
        XCTAssertEqual(service.historyStateByThread[threadID]?.newestCursor, "cursor-22")
    }

    func testLoadThreadHistoryReplacesLegacyLocalTimelineWithTailSnapshot() async throws {
        let service = makeService()
        let threadID = "thread-tail-replace"
        service.isConnected = true
        service.isInitialized = true
        service.messagesByThread[threadID] = makeMessages(threadID: threadID, range: 1 ... 20)

        let tailExpectation = expectation(description: "tail request")
        service.requestTransportOverride = { method, params in
            XCTAssertEqual(method, "thread/read")
            let historyObject = try XCTUnwrap(params?.objectValue?["history"]?.objectValue)
            XCTAssertEqual(historyObject["mode"]?.stringValue, "tail")
            XCTAssertNil(historyObject["cursor"])
            tailExpectation.fulfill()
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object([
                    "thread": self.makeThreadPayload(
                        threadID: threadID,
                        title: "Tail",
                        messageRange: 71 ... 120
                    ),
                    "historyWindow": self.makeHistoryWindowObject(
                        olderCursor: "cursor-71",
                        newerCursor: "cursor-120",
                        hasOlder: true,
                        hasNewer: false
                    ),
                ]),
                includeJSONRPC: false
            )
        }

        try await service.loadThreadHistoryIfNeeded(threadId: threadID)

        await fulfillment(of: [tailExpectation], timeout: 1.0)
        XCTAssertEqual(service.messagesByThread[threadID]?.first?.itemId, "item-71")
        XCTAssertEqual(service.messagesByThread[threadID]?.last?.itemId, "item-120")
        XCTAssertEqual(service.historyStateByThread[threadID]?.oldestCursor, "cursor-71")
        XCTAssertEqual(service.historyStateByThread[threadID]?.newestCursor, "cursor-120")
    }

    func testManagedThreadUpdatedAtAdvanceInvalidatesCachedHistory() {
        let service = makeService()
        let threadID = "thread-managed-stale-history"
        let oldUpdatedAt = Date(timeIntervalSince1970: 100)
        let newUpdatedAt = Date(timeIntervalSince1970: 200)

        service.threads = [
            ConversationThread(
                id: threadID,
                title: "Claude Thread",
                updatedAt: oldUpdatedAt,
                provider: "claude"
            ),
        ]
        service.messagesByThread[threadID] = makeMessages(threadID: threadID, range: 1 ... 3)
        service.historyStateByThread[threadID] = ThreadHistoryState(
            oldestCursor: "cursor-1",
            newestCursor: "cursor-3",
            hasOlderOnServer: false,
            hasNewerOnServer: false
        )
        service.hydratedThreadIDs.insert(threadID)
        service.resumedThreadIDs.insert(threadID)
        service.loadingThreadIDs.insert(threadID)

        service.reconcileLocalThreadsWithServer([
            ConversationThread(
                id: threadID,
                title: "Claude Thread",
                updatedAt: newUpdatedAt,
                provider: "claude"
            ),
        ])

        XCTAssertFalse(service.hydratedThreadIDs.contains(threadID))
        XCTAssertFalse(service.resumedThreadIDs.contains(threadID))
        XCTAssertFalse(service.loadingThreadIDs.contains(threadID))
        XCTAssertNil(service.historyStateByThread[threadID])
        XCTAssertEqual(service.threads.first?.updatedAt, newUpdatedAt)
        XCTAssertEqual(service.messagesByThread[threadID]?.map(\.itemId), ["item-1", "item-2", "item-3"])
    }

    func testIncomingDeltaAppendsDirectlyWhenPreviousCursorMatchesTail() async throws {
        let service = makeService()
        let threadID = "thread-direct-append"
        service.isConnected = true
        service.isInitialized = true
        service.activeThreadId = threadID
        service.runningThreadIDs.insert(threadID)
        service.activeTurnIdByThread[threadID] = "turn-1"
        service.threads = [ConversationThread(id: threadID, title: "Thread", provider: "claude")]
        service.messagesByThread[threadID] = makeMessages(threadID: threadID, range: 1 ... 10)
        service.historyStateByThread[threadID] = ThreadHistoryState(
            oldestCursor: "cursor-1",
            newestCursor: "cursor-10",
            hasOlderOnServer: false,
            hasNewerOnServer: false
        )

        service.requestTransportOverride = { method, _ in
            XCTFail("Did not expect history catch-up for \(method)")
            return RPCMessage(id: .string(UUID().uuidString), result: .object([:]), includeJSONRPC: false)
        }

        service.handleNotification(
            method: "item/agentMessage/delta",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string("turn-1"),
                "itemId": .string("item-11"),
                "previousItemId": .string("item-10"),
                "cursor": .string("cursor-11"),
                "previousCursor": .string("cursor-10"),
                "delta": .string("message-11"),
            ])
        )

        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(service.messagesByThread[threadID]?.last?.itemId, "item-11")
        XCTAssertEqual(service.historyStateByThread[threadID]?.newestCursor, "cursor-11")
    }

    func testIncomingDeltaTriggersAfterCatchUpWhenCursorMismatches() async throws {
        let service = makeService()
        let threadID = "thread-after-gap"
        service.isConnected = true
        service.isInitialized = true
        service.activeThreadId = threadID
        service.runningThreadIDs.insert(threadID)
        service.activeTurnIdByThread[threadID] = "turn-1"
        service.threads = [ConversationThread(id: threadID, title: "Thread", provider: "gemini")]
        service.messagesByThread[threadID] = makeMessages(threadID: threadID, range: 1 ... 1)
        service.historyStateByThread[threadID] = ThreadHistoryState(
            oldestCursor: "cursor-1",
            newestCursor: "cursor-1",
            hasOlderOnServer: false,
            hasNewerOnServer: true
        )

        let afterExpectation = expectation(description: "after catch-up request")
        service.requestTransportOverride = { method, params in
            XCTAssertEqual(method, "thread/read")
            let historyObject = try XCTUnwrap(params?.objectValue?["history"]?.objectValue)
            XCTAssertEqual(historyObject["mode"]?.stringValue, "after")
            XCTAssertEqual(historyObject["cursor"]?.stringValue, "cursor-1")
            afterExpectation.fulfill()
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object([
                    "thread": self.makeThreadPayload(
                        threadID: threadID,
                        title: "After",
                        messageRange: 2 ... 3
                    ),
                    "historyWindow": self.makeHistoryWindowObject(
                        olderCursor: "cursor-2",
                        newerCursor: "cursor-3",
                        hasOlder: false,
                        hasNewer: false
                    ),
                ]),
                includeJSONRPC: false
            )
        }

        service.handleNotification(
            method: "item/agentMessage/delta",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string("turn-1"),
                "itemId": .string("item-3"),
                "cursor": .string("cursor-3"),
                "previousCursor": .string("cursor-2"),
                "delta": .string("partial-3"),
            ])
        )

        await fulfillment(of: [afterExpectation], timeout: 1.0)
        XCTAssertEqual(service.messagesByThread[threadID]?.map(\.itemId), ["item-1", "item-2", "item-3"])
        XCTAssertEqual(service.historyStateByThread[threadID]?.newestCursor, "cursor-3")
    }

    func testIncomingDeltaAfterLocalTurnStartBypassesSeededUserCursorGap() async throws {
        let service = makeService()
        let threadID = "thread-local-turn-gap"
        let turnID = "turn-11"
        service.isConnected = true
        service.isInitialized = true
        service.activeThreadId = threadID
        service.threads = [ConversationThread(id: threadID, title: "Thread", provider: "codex")]
        service.messagesByThread[threadID] = makeMessages(threadID: threadID, range: 1 ... 10)
        service.historyStateByThread[threadID] = ThreadHistoryState(
            oldestCursor: "cursor-1",
            newestCursor: "cursor-10",
            hasOlderOnServer: false,
            hasNewerOnServer: false
        )

        let pendingMessageId = service.appendUserMessage(threadId: threadID, text: "hello")
        service.markThreadAsRunning(threadID)
        service.handleSuccessfulTurnStartResponse(
            RPCMessage(
                id: .string(UUID().uuidString),
                result: .object([
                    "turn": .object([
                        "id": .string(turnID),
                    ]),
                ]),
                includeJSONRPC: false
            ),
            pendingMessageId: pendingMessageId,
            threadId: threadID
        )

        XCTAssertEqual(service.pendingRealtimeSeededTurnIDByThread[threadID], turnID)

        let catchUpExpectation = expectation(description: "no realtime catch-up")
        catchUpExpectation.isInverted = true
        service.requestTransportOverride = { method, _ in
            if method == "thread/read" {
                catchUpExpectation.fulfill()
            }
            return RPCMessage(id: .string(UUID().uuidString), result: .object([:]), includeJSONRPC: false)
        }

        service.handleNotification(
            method: "item/agentMessage/delta",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "itemId": .string("item-11"),
                "previousItemId": .string("local:\(turnID):user"),
                "cursor": .string("cursor-11"),
                "previousCursor": .string("cursor-user-\(turnID)"),
                "delta": .string("live-11"),
            ])
        )

        try await Task.sleep(nanoseconds: 200_000_000)
        await fulfillment(of: [catchUpExpectation], timeout: 0.3)
        XCTAssertEqual(service.messagesByThread[threadID]?.last?.role, .assistant)
        XCTAssertEqual(service.messagesByThread[threadID]?.last?.text, "live-11")
        XCTAssertEqual(service.historyStateByThread[threadID]?.newestCursor, "cursor-11")
        XCTAssertNil(service.pendingRealtimeSeededTurnIDByThread[threadID])
    }

    func testIncomingDeltaAfterLocalTurnStartAppendsWithoutCursorBaseline() async throws {
        let service = makeService()
        let threadID = "thread-local-turn-no-cursor"
        let turnID = "turn-1"
        service.isConnected = true
        service.isInitialized = true
        service.activeThreadId = threadID
        service.threads = [ConversationThread(id: threadID, title: "Thread", provider: "codex")]

        let pendingMessageId = service.appendUserMessage(threadId: threadID, text: "first")
        service.markThreadAsRunning(threadID)
        service.handleSuccessfulTurnStartResponse(
            RPCMessage(
                id: .string(UUID().uuidString),
                result: .object([
                    "turn": .object([
                        "id": .string(turnID),
                    ]),
                ]),
                includeJSONRPC: false
            ),
            pendingMessageId: pendingMessageId,
            threadId: threadID
        )

        let catchUpExpectation = expectation(description: "no realtime catch-up")
        catchUpExpectation.isInverted = true
        service.requestTransportOverride = { method, _ in
            if method == "thread/read" {
                catchUpExpectation.fulfill()
            }
            return RPCMessage(id: .string(UUID().uuidString), result: .object([:]), includeJSONRPC: false)
        }

        service.handleNotification(
            method: "item/agentMessage/delta",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "itemId": .string("item-1"),
                "previousItemId": .string("local:\(turnID):user"),
                "cursor": .string("cursor-1"),
                "previousCursor": .string("cursor-user-\(turnID)"),
                "delta": .string("first-live"),
            ])
        )

        try await Task.sleep(nanoseconds: 200_000_000)
        await fulfillment(of: [catchUpExpectation], timeout: 0.3)
        XCTAssertEqual(service.messagesByThread[threadID]?.last?.text, "first-live")
        XCTAssertEqual(service.historyStateByThread[threadID]?.newestCursor, "cursor-1")
        XCTAssertNil(service.pendingRealtimeSeededTurnIDByThread[threadID])
    }

    func testAssistantRealtimeDeltaUsesTopLevelIDWithoutHistoryCatchUp() async throws {
        let service = makeService()
        let threadID = "thread-top-level-item-id"
        let turnID = "turn-top-level-item-id"
        service.isConnected = true
        service.isInitialized = true
        service.activeThreadId = threadID
        service.runningThreadIDs.insert(threadID)
        service.activeTurnIdByThread[threadID] = turnID
        service.threads = [ConversationThread(id: threadID, title: "Thread", provider: "claude")]

        let catchUpExpectation = expectation(description: "no realtime catch-up")
        catchUpExpectation.isInverted = true
        service.requestTransportOverride = { method, _ in
            if method == "thread/read" {
                catchUpExpectation.fulfill()
            }
            return RPCMessage(id: .string(UUID().uuidString), result: .object([:]), includeJSONRPC: false)
        }

        service.handleNotification(
            method: "item/started",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "id": .string("item-top-level"),
                "type": .string("message"),
                "role": .string("assistant"),
                "content": .array([
                    .object([
                        "type": .string("text"),
                        "text": .string(""),
                    ]),
                ]),
            ])
        )

        service.handleNotification(
            method: "item/agentMessage/delta",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "id": .string("item-top-level"),
                "delta": .string("live-top-level"),
            ])
        )

        try await Task.sleep(nanoseconds: 200_000_000)
        await fulfillment(of: [catchUpExpectation], timeout: 0.3)

        let lastMessage = try XCTUnwrap(service.messagesByThread[threadID]?.last)
        XCTAssertEqual(lastMessage.itemId, "item-top-level")
        XCTAssertEqual(lastMessage.text, "live-top-level")
        XCTAssertTrue(lastMessage.isStreaming)
    }

    func testAssistantRealtimeDeltaFallsBackToActiveTurnWhenTurnIDMissing() async throws {
        let service = makeService()
        let threadID = "thread-missing-turn-id"
        let turnID = "turn-active-fallback"
        service.isConnected = true
        service.isInitialized = true
        service.activeThreadId = threadID
        service.runningThreadIDs.insert(threadID)
        service.activeTurnIdByThread[threadID] = turnID
        service.threadIdByTurnID[turnID] = threadID
        service.threads = [ConversationThread(id: threadID, title: "Thread", provider: "codex")]

        let catchUpExpectation = expectation(description: "no realtime catch-up")
        catchUpExpectation.isInverted = true
        service.requestTransportOverride = { method, _ in
            if method == "thread/read" {
                catchUpExpectation.fulfill()
            }
            return RPCMessage(id: .string(UUID().uuidString), result: .object([:]), includeJSONRPC: false)
        }

        service.handleNotification(
            method: "item/started",
            params: .object([
                "threadId": .string(threadID),
                "id": .string("item-active-fallback"),
                "type": .string("message"),
                "role": .string("assistant"),
                "content": .array([
                    .object([
                        "type": .string("text"),
                        "text": .string(""),
                    ]),
                ]),
            ])
        )

        service.handleNotification(
            method: "item/agentMessage/delta",
            params: .object([
                "threadId": .string(threadID),
                "id": .string("item-active-fallback"),
                "delta": .string("stream-continues"),
            ])
        )

        try await Task.sleep(nanoseconds: 200_000_000)
        await fulfillment(of: [catchUpExpectation], timeout: 0.3)

        let lastMessage = try XCTUnwrap(service.messagesByThread[threadID]?.last)
        XCTAssertEqual(lastMessage.turnId, turnID)
        XCTAssertEqual(lastMessage.itemId, "item-active-fallback")
        XCTAssertEqual(lastMessage.text, "stream-continues")
        XCTAssertTrue(lastMessage.isStreaming)
    }

    func testSyncActiveThreadStateForceResumesRunningThreadBeforeHistoryCatchUp() async throws {
        let service = makeService()
        let threadID = "thread-force-resume"
        let turnID = "turn-force-resume"
        service.isConnected = true
        service.isInitialized = true
        service.activeThreadId = threadID
        service.runningThreadIDs.insert(threadID)
        service.activeTurnIdByThread[threadID] = turnID
        service.threads = [ConversationThread(id: threadID, title: "Thread", provider: "codex")]

        var observedMethods: [String] = []
        service.requestTransportOverride = { method, params in
            observedMethods.append(method)

            if observedMethods.count == 1 {
                XCTAssertEqual(method, "thread/read")
                XCTAssertNil(params?.objectValue?["history"])
                return RPCMessage(
                    id: .string(UUID().uuidString),
                    result: .object([
                        "thread": .object([
                            "id": .string(threadID),
                            "turns": .array([
                                .object([
                                    "id": .string(turnID),
                                    "status": .string("running"),
                                    "items": .array([]),
                                ]),
                            ]),
                        ]),
                    ]),
                    includeJSONRPC: false
                )
            }

            if observedMethods.count == 2 {
                XCTAssertEqual(method, "thread/resume")
                return RPCMessage(
                    id: .string(UUID().uuidString),
                    result: .object([
                        "thread": self.makeThreadPayload(
                            threadID: threadID,
                            title: "Resume",
                            messageRange: 1 ... 1
                        ),
                    ]),
                    includeJSONRPC: false
                )
            }

            XCTAssertEqual(method, "thread/read")
            let historyObject = try XCTUnwrap(params?.objectValue?["history"]?.objectValue)
            XCTAssertEqual(historyObject["mode"]?.stringValue, "tail")
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object([
                    "thread": self.makeThreadPayload(
                        threadID: threadID,
                        title: "Tail",
                        messageRange: 1 ... 1
                    ),
                    "historyWindow": self.makeHistoryWindowObject(
                        olderCursor: "cursor-1",
                        newerCursor: "cursor-1",
                        hasOlder: false,
                        hasNewer: false
                    ),
                ]),
                includeJSONRPC: false
            )
        }

        await service.syncActiveThreadState(threadId: threadID)

        XCTAssertEqual(observedMethods, ["thread/read", "thread/resume", "thread/read"])
        XCTAssertEqual(service.messagesByThread[threadID]?.last?.itemId, "item-1")
        XCTAssertEqual(service.historyStateByThread[threadID]?.newestCursor, "cursor-1")
    }

    func testPrepareThreadForDisplayForceResumesActiveCodexThreadWithoutLocalRunningState() async {
        let service = makeService()
        let threadID = "thread-open-live-codex"
        service.isConnected = true
        service.isInitialized = false
        service.threads = [ConversationThread(id: threadID, title: "Thread", provider: "codex")]
        service.messagesByThread[threadID] = makeMessages(threadID: threadID, range: 1 ... 1)
        service.resumedThreadIDs.insert(threadID)

        var observedMethods: [String] = []
        service.requestTransportOverride = { method, params in
            observedMethods.append(method)

            if observedMethods.count == 1 {
                XCTAssertEqual(method, "thread/read")
                XCTAssertEqual(params?.objectValue?["includeTurns"]?.boolValue, true)
                return RPCMessage(
                    id: .string(UUID().uuidString),
                    result: .object([
                        "thread": .object([
                            "id": .string(threadID),
                            "turns": .array([
                                .object([
                                    "id": .string("turn-1"),
                                    "status": .string("completed"),
                                    "items": .array([]),
                                ]),
                            ]),
                        ]),
                    ]),
                    includeJSONRPC: false
                )
            }

            XCTAssertEqual(method, "thread/resume")
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object([
                    "thread": self.makeThreadPayload(
                        threadID: threadID,
                        title: "Resume",
                        messageRange: 1 ... 2
                    ),
                ]),
                includeJSONRPC: false
            )
        }

        await service.prepareThreadForDisplay(threadId: threadID)

        XCTAssertEqual(observedMethods, ["thread/read", "thread/resume"])
        XCTAssertNotNil(service.foregroundAggressivePollingDeadlineByThread[threadID])
        XCTAssertEqual(service.messagesByThread[threadID]?.last?.itemId, "item-2")
    }

    func testPrepareThreadForDisplayBumpsDisplayActivationRevision() async {
        let service = makeService()
        let threadID = "thread-display-activation"

        await service.prepareThreadForDisplay(threadId: threadID)
        let firstRevision = service.threadDisplayActivationRevision(for: threadID)

        await service.prepareThreadForDisplay(threadId: threadID)
        let secondRevision = service.threadDisplayActivationRevision(for: threadID)

        XCTAssertEqual(firstRevision, 1)
        XCTAssertEqual(secondRevision, 2)
    }

    func testLoadThreadHistoryKeepsResumeSeededCodexMessagesWhenTailSnapshotIsOlder() async throws {
        let service = makeService()
        let threadID = "thread-resume-seeded-codex"
        service.isConnected = true
        service.isInitialized = true
        service.threads = [ConversationThread(id: threadID, title: "Thread", provider: "codex")]
        service.messagesByThread[threadID] = makeMessages(threadID: threadID, range: 1 ... 2)
        service.resumeSeededHistoryThreadIDs.insert(threadID)

        let tailExpectation = expectation(description: "tail request without replace")
        service.requestTransportOverride = { method, params in
            XCTAssertEqual(method, "thread/read")
            let historyObject = try XCTUnwrap(params?.objectValue?["history"]?.objectValue)
            XCTAssertEqual(historyObject["mode"]?.stringValue, "tail")
            tailExpectation.fulfill()
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object([
                    "thread": self.makeThreadPayload(
                        threadID: threadID,
                        title: "Tail",
                        messageRange: 1 ... 1
                    ),
                    "historyWindow": self.makeHistoryWindowObject(
                        olderCursor: "cursor-1",
                        newerCursor: "cursor-1",
                        hasOlder: false,
                        hasNewer: true
                    ),
                ]),
                includeJSONRPC: false
            )
        }

        try await service.loadThreadHistoryIfNeeded(threadId: threadID)

        await fulfillment(of: [tailExpectation], timeout: 1.0)
        XCTAssertEqual(service.messagesByThread[threadID]?.map(\.itemId), ["item-1", "item-2"])
        XCTAssertEqual(service.historyStateByThread[threadID]?.newestCursor, "cursor-1")
    }

    func testVisibleCodexThreadKeepsLocalTimelineWhenTailSnapshotIsOlderAndCursorMissing() async throws {
        let service = makeService()
        let threadID = "thread-visible-codex-tail-merge"
        service.isConnected = true
        service.isInitialized = true
        service.activeThreadId = threadID
        service.threads = [ConversationThread(id: threadID, title: "Thread", provider: "codex")]
        service.messagesByThread[threadID] = makeMessages(threadID: threadID, range: 1 ... 2)

        let tailExpectation = expectation(description: "tail request without replace for visible codex thread")
        service.requestTransportOverride = { method, params in
            XCTAssertEqual(method, "thread/read")
            let historyObject = try XCTUnwrap(params?.objectValue?["history"]?.objectValue)
            XCTAssertEqual(historyObject["mode"]?.stringValue, "tail")
            tailExpectation.fulfill()
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object([
                    "thread": self.makeThreadPayload(
                        threadID: threadID,
                        title: "Tail",
                        messageRange: 1 ... 1
                    ),
                    "historyWindow": self.makeHistoryWindowObject(
                        olderCursor: "cursor-1",
                        newerCursor: "cursor-1",
                        hasOlder: false,
                        hasNewer: true
                    ),
                ]),
                includeJSONRPC: false
            )
        }

        try await service.loadThreadHistoryIfNeeded(threadId: threadID)

        await fulfillment(of: [tailExpectation], timeout: 1.0)
        XCTAssertEqual(service.messagesByThread[threadID]?.map(\.itemId), ["item-1", "item-2"])
        XCTAssertEqual(service.historyStateByThread[threadID]?.newestCursor, "cursor-1")
    }

    func testMergeCanonicalHistoryKeepsLongerLocalAssistantTextWhenServerSnapshotIsStale() {
        let service = makeService()
        let threadID = "thread-stale-snapshot"

        service.messagesByThread[threadID] = [
            ChatMessage(
                id: "item-1",
                threadId: threadID,
                role: .assistant,
                text: "newer local text",
                createdAt: Date(timeIntervalSince1970: 1),
                turnId: "turn-1",
                itemId: "item-1",
                isStreaming: false,
                deliveryState: .confirmed,
                orderIndex: 1
            ),
        ]
        service.threadTimelineStateByThread[threadID] = ThreadTimelineState(
            messages: service.messagesByThread[threadID] ?? []
        )

        let merged = service.mergeCanonicalHistoryIntoTimelineState(
            threadId: threadID,
            historyMessages: [
                ChatMessage(
                    id: "item-1",
                    threadId: threadID,
                    role: .assistant,
                    text: "newer",
                    createdAt: Date(timeIntervalSince1970: 1),
                    turnId: "turn-1",
                    itemId: "item-1",
                    isStreaming: false,
                    deliveryState: .confirmed,
                    orderIndex: 1
                ),
            ],
            activeThreadIDs: [],
            runningThreadIDs: []
        )

        XCTAssertEqual(merged.first?.text, "newer local text")
        XCTAssertEqual(service.messagesByThread[threadID]?.first?.text, "newer local text")
    }

    func testUpdateCurrentOutputPublishesInPlaceMessageMutation() {
        let service = makeService()
        let threadID = "thread-observation"

        service.messagesByThread[threadID] = [
            ChatMessage(
                id: "assistant-1",
                threadId: threadID,
                role: .assistant,
                text: "before",
                createdAt: Date(timeIntervalSince1970: 1),
                turnId: "turn-1",
                itemId: "item-1",
                isStreaming: true,
                orderIndex: 1
            ),
        ]

        var didInvalidate = false
        withObservationTracking {
            _ = service.messagesByThread[threadID]
            _ = service.messageRevisionByThread[threadID]
        } onChange: {
            didInvalidate = true
        }

        service.messagesByThread[threadID]?[0].text = "after"
        service.updateCurrentOutput(for: threadID)

        XCTAssertEqual(service.messagesByThread[threadID]?.first?.text, "after")
        XCTAssertTrue(didInvalidate)
    }

    func testMergeCanonicalHistoryReordersExistingItemsWhenOrdinalArrives() {
        let service = makeService()
        let threadID = "thread-canonical-reorder"

        let lateMessage = ChatMessage(
            id: "item-2",
            threadId: threadID,
            role: .assistant,
            text: "second",
            createdAt: Date(timeIntervalSince1970: 2),
            turnId: "turn-1",
            itemId: "item-2",
            isStreaming: true,
            orderIndex: 100
        )
        let earlyMessage = ChatMessage(
            id: "item-1",
            threadId: threadID,
            role: .assistant,
            text: "first",
            createdAt: Date(timeIntervalSince1970: 1),
            turnId: "turn-1",
            itemId: "item-1",
            isStreaming: true,
            orderIndex: 101
        )

        _ = service.synchronizeThreadTimelineState(
            threadId: threadID,
            canonicalMessages: [lateMessage, earlyMessage]
        )

        let historyMessages = [
            ChatMessage(
                id: "item-1",
                threadId: threadID,
                role: .assistant,
                text: "first",
                createdAt: Date(timeIntervalSince1970: 1),
                turnId: "turn-1",
                itemId: "item-1",
                timelineOrdinal: 10,
                timelineStatus: "completed",
                orderIndex: 10
            ),
            ChatMessage(
                id: "item-2",
                threadId: threadID,
                role: .assistant,
                text: "second",
                createdAt: Date(timeIntervalSince1970: 2),
                turnId: "turn-1",
                itemId: "item-2",
                timelineOrdinal: 20,
                timelineStatus: "completed",
                orderIndex: 20
            ),
        ]

        let merged = service.mergeCanonicalHistoryIntoTimelineState(
            threadId: threadID,
            historyMessages: historyMessages,
            activeThreadIDs: [],
            runningThreadIDs: []
        )

        XCTAssertEqual(merged.map(\.id), ["item-1", "item-2"])
        XCTAssertEqual(merged.first?.timelineOrdinal, 10)
        XCTAssertEqual(merged.first?.orderIndex, 10)
        XCTAssertEqual(merged.last?.timelineOrdinal, 20)
        XCTAssertEqual(merged.last?.orderIndex, 20)
        XCTAssertEqual(merged.last?.timelineStatus, "completed")
    }

    func testThreadTimelineStateRepositionsExistingItemWithoutFullResort() {
        var state = ThreadTimelineState(
            messages: [
                ChatMessage(
                    id: "item-2",
                    threadId: "thread",
                    role: .assistant,
                    text: "second",
                    createdAt: Date(timeIntervalSince1970: 2),
                    turnId: "turn-1",
                    itemId: "item-2",
                    orderIndex: 100
                ),
                ChatMessage(
                    id: "item-3",
                    threadId: "thread",
                    role: .assistant,
                    text: "third",
                    createdAt: Date(timeIntervalSince1970: 3),
                    turnId: "turn-1",
                    itemId: "item-3",
                    orderIndex: 101
                ),
            ]
        )

        state.upsert(
            ChatMessage(
                id: "item-1",
                threadId: "thread",
                role: .assistant,
                text: "first",
                createdAt: Date(timeIntervalSince1970: 1),
                turnId: "turn-1",
                itemId: "item-1",
                orderIndex: 102
            )
        )
        state.upsert(
            ChatMessage(
                id: "item-1",
                threadId: "thread",
                role: .assistant,
                text: "first",
                createdAt: Date(timeIntervalSince1970: 1),
                turnId: "turn-1",
                itemId: "item-1",
                timelineOrdinal: 10,
                orderIndex: 10
            )
        )

        XCTAssertEqual(state.renderedMessages().map(\.id), ["item-1", "item-2", "item-3"])
        XCTAssertEqual(state.orderedIndexByID["item-1"], 0)
    }

    private func makeService() -> CodeRoverService {
        let suiteName = "ThreadHistoryStateTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defaults.removePersistentDomain(forName: suiteName)
        return CodeRoverService(defaults: defaults)
    }

    private func makeMessages(threadID: String, range: ClosedRange<Int>) -> [ChatMessage] {
        range.map { index in
            ChatMessage(
                id: "message-\(index)",
                threadId: threadID,
                role: .assistant,
                text: "message-\(index)",
                createdAt: Date(timeIntervalSince1970: TimeInterval(index)),
                turnId: "turn-\(index / 10)",
                itemId: "item-\(index)",
                orderIndex: index
            )
        }
    }

    private func makeHistoryWindowObject(
        olderCursor: String?,
        newerCursor: String?,
        hasOlder: Bool,
        hasNewer: Bool
    ) -> JSONValue {
        .object([
            "olderCursor": olderCursor.map(JSONValue.string) ?? .null,
            "newerCursor": newerCursor.map(JSONValue.string) ?? .null,
            "hasOlder": .bool(hasOlder),
            "hasNewer": .bool(hasNewer),
        ])
    }

    private func makeThreadPayload(
        threadID: String,
        title: String,
        messageRange: ClosedRange<Int>
    ) -> JSONValue {
        .object([
            "id": .string(threadID),
            "title": .string(title),
            "provider": .string("codex"),
            "turns": .array([
                .object([
                    "id": .string("turn-\(messageRange.lowerBound / 10)"),
                    "items": .array(
                        messageRange.map { index in
                            .object([
                                "id": .string("item-\(index)"),
                                "type": .string("assistantMessage"),
                                "createdAt": .string(
                                    ISO8601DateFormatter().string(
                                        from: Date(timeIntervalSince1970: TimeInterval(index))
                                    )
                                ),
                                "content": .array([
                                    .object([
                                        "type": .string("text"),
                                        "text": .string("message-\(index)"),
                                    ]),
                                ]),
                            ])
                        }
                    ),
                ]),
            ]),
        ])
    }
}
