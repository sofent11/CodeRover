// FILE: ThreadTimelineState.swift
// Purpose: Stores canonical per-thread timeline items keyed by stable timeline item id.
// Layer: Service Helper
// Exports: ThreadTimelineState
// Depends on: ChatMessage

import Foundation

struct ThreadTimelineState: Sendable {
    private(set) var itemsByID: [String: ChatMessage] = [:]
    private(set) var orderedItemIDs: [String] = []

    init(messages: [ChatMessage] = []) {
        replaceAll(with: messages)
    }

    mutating func replaceAll(with messages: [ChatMessage]) {
        itemsByID = [:]
        orderedItemIDs = []
        for message in messages {
            upsert(message)
        }
    }

    mutating func upsert(_ message: ChatMessage) {
        itemsByID[message.id] = message
        if !orderedItemIDs.contains(message.id) {
            orderedItemIDs.append(message.id)
        }
        orderedItemIDs.sort { lhs, rhs in
            guard let lhsMessage = itemsByID[lhs], let rhsMessage = itemsByID[rhs] else {
                return lhs < rhs
            }
            return Self.compare(lhsMessage, rhsMessage)
        }
    }

    func message(for id: String) -> ChatMessage? {
        itemsByID[id]
    }

    func renderedMessages() -> [ChatMessage] {
        orderedItemIDs.compactMap { itemsByID[$0] }
    }

    private static func compare(_ lhs: ChatMessage, _ rhs: ChatMessage) -> Bool {
        let lhsOrder = lhs.timelineOrdinal ?? lhs.orderIndex
        let rhsOrder = rhs.timelineOrdinal ?? rhs.orderIndex
        if lhsOrder != rhsOrder {
            return lhsOrder < rhsOrder
        }
        if lhs.createdAt != rhs.createdAt {
            return lhs.createdAt < rhs.createdAt
        }
        return lhs.id < rhs.id
    }
}
