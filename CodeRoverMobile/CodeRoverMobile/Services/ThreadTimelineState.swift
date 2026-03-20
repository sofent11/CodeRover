// FILE: ThreadTimelineState.swift
// Purpose: Stores canonical per-thread timeline items keyed by stable timeline item id.
// Layer: Service Helper
// Exports: ThreadTimelineState
// Depends on: ChatMessage

import Foundation

struct ThreadTimelineState: Sendable {
    private(set) var itemsByID: [String: ChatMessage] = [:]
    private(set) var orderedItemIDs: [String] = []
    private(set) var orderedIndexByID: [String: Int] = [:]

    init(messages: [ChatMessage] = []) {
        replaceAll(with: messages)
    }

    mutating func replaceAll(with messages: [ChatMessage]) {
        itemsByID = [:]
        orderedItemIDs = []
        orderedIndexByID = [:]
        for message in messages {
            upsert(message)
        }
    }

    mutating func upsert(_ message: ChatMessage) {
        let previousIndex = orderedIndexByID[message.id]
        itemsByID[message.id] = message
        if let previousIndex {
            orderedItemIDs.remove(at: previousIndex)
            orderedIndexByID.removeValue(forKey: message.id)
            rebuildOrderedIndexMap(startingAt: previousIndex)
        }

        let insertionIndex = insertionIndex(for: message)
        orderedItemIDs.insert(message.id, at: insertionIndex)
        rebuildOrderedIndexMap(startingAt: min(previousIndex ?? insertionIndex, insertionIndex))
    }

    func message(for id: String) -> ChatMessage? {
        itemsByID[id]
    }

    func renderedMessages() -> [ChatMessage] {
        orderedItemIDs.compactMap { itemsByID[$0] }
    }

    nonisolated static func mergeSortedMessages(
        canonicalMessages: [ChatMessage],
        overlayMessages: [ChatMessage]
    ) -> [ChatMessage] {
        guard !canonicalMessages.isEmpty else {
            return overlayMessages.sorted(by: compare)
        }
        guard !overlayMessages.isEmpty else {
            return canonicalMessages
        }

        let sortedOverlay = overlayMessages.sorted(by: compare)
        var merged: [ChatMessage] = []
        merged.reserveCapacity(canonicalMessages.count + sortedOverlay.count)

        var canonicalIndex = 0
        var overlayIndex = 0

        while canonicalIndex < canonicalMessages.count, overlayIndex < sortedOverlay.count {
            if compare(canonicalMessages[canonicalIndex], sortedOverlay[overlayIndex]) {
                merged.append(canonicalMessages[canonicalIndex])
                canonicalIndex += 1
            } else {
                merged.append(sortedOverlay[overlayIndex])
                overlayIndex += 1
            }
        }

        if canonicalIndex < canonicalMessages.count {
            merged.append(contentsOf: canonicalMessages[canonicalIndex...])
        }
        if overlayIndex < sortedOverlay.count {
            merged.append(contentsOf: sortedOverlay[overlayIndex...])
        }

        return merged
    }

    private mutating func rebuildOrderedIndexMap(startingAt startIndex: Int) {
        guard startIndex < orderedItemIDs.count else { return }
        for index in startIndex..<orderedItemIDs.count {
            orderedIndexByID[orderedItemIDs[index]] = index
        }
    }

    private func insertionIndex(for message: ChatMessage) -> Int {
        var low = 0
        var high = orderedItemIDs.count

        while low < high {
            let mid = (low + high) / 2
            guard let candidate = itemsByID[orderedItemIDs[mid]] else {
                high = mid
                continue
            }

            if Self.compare(candidate, message) {
                low = mid + 1
            } else {
                high = mid
            }
        }

        return low
    }

    nonisolated static func compare(_ lhs: ChatMessage, _ rhs: ChatMessage) -> Bool {
        if lhs.timelineOrdinal != nil || rhs.timelineOrdinal != nil {
            let lhsOrder = lhs.timelineOrdinal ?? lhs.orderIndex
            let rhsOrder = rhs.timelineOrdinal ?? rhs.orderIndex
            if lhsOrder != rhsOrder {
                return lhsOrder < rhsOrder
            }
        } else if lhs.orderIndex != rhs.orderIndex {
            return lhs.orderIndex < rhs.orderIndex
        }

        if lhs.createdAt != rhs.createdAt {
            return lhs.createdAt < rhs.createdAt
        }
        return lhs.id < rhs.id
    }
}
