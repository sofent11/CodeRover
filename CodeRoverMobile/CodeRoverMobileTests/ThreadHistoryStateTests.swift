import XCTest
@testable import CodeRoverMobile

final class ThreadHistoryStateTests: XCTestCase {
    func testTailMergeCreatesGapWhenLatestWindowSkipsMiddleHistory() {
        let service = makeService()
        let threadID = "thread-gap"

        service.messagesByThread[threadID] = makeMessages(threadID: threadID, range: 1...20)

        service.mergeHistoryWindow(
            threadId: threadID,
            mode: .tail,
            historyMessages: makeMessages(threadID: threadID, range: 71...120),
            oldestAnchor: makeAnchor(index: 71),
            newestAnchor: makeAnchor(index: 120),
            hasOlder: true,
            hasNewer: false
        )

        let state = try XCTUnwrap(service.historyStateByThread[threadID])
        XCTAssertEqual(state.segments.count, 2)
        XCTAssertEqual(state.gaps.count, 1)
        XCTAssertEqual(state.segments.first?.oldestAnchor, makeAnchor(index: 1))
        XCTAssertEqual(state.segments.last?.newestAnchor, makeAnchor(index: 120))
        XCTAssertTrue(state.hasOlderOnServer)
        XCTAssertFalse(state.hasNewerOnServer)
    }

    func testBeforeMergeClosesGapOnceMissingRangeArrives() {
        let service = makeService()
        let threadID = "thread-close-gap"

        service.messagesByThread[threadID] = makeMessages(threadID: threadID, range: 1...20)
        service.mergeHistoryWindow(
            threadId: threadID,
            mode: .tail,
            historyMessages: makeMessages(threadID: threadID, range: 71...120),
            oldestAnchor: makeAnchor(index: 71),
            newestAnchor: makeAnchor(index: 120),
            hasOlder: true,
            hasNewer: false
        )

        service.mergeHistoryWindow(
            threadId: threadID,
            mode: .before,
            historyMessages: makeMessages(threadID: threadID, range: 21...70),
            oldestAnchor: makeAnchor(index: 21),
            newestAnchor: makeAnchor(index: 70),
            hasOlder: false,
            hasNewer: false
        )

        let state = try XCTUnwrap(service.historyStateByThread[threadID])
        XCTAssertEqual(state.segments.count, 1)
        XCTAssertTrue(state.gaps.isEmpty)
        XCTAssertEqual(state.oldestLoadedAnchor, makeAnchor(index: 1))
        XCTAssertEqual(state.newestLoadedAnchor, makeAnchor(index: 120))
        XCTAssertFalse(state.hasOlderOnServer)
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

    private func makeAnchor(index: Int) -> ThreadHistoryAnchor {
        ThreadHistoryAnchor(
            itemId: "item-\(index)",
            createdAt: Date(timeIntervalSince1970: TimeInterval(index)),
            turnId: "turn-\(index / 10)"
        )
    }
}
