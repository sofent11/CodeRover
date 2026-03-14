// FILE: ThreadHistoryState.swift
// Purpose: Models partial per-thread history coverage for incremental sync and gap loading.
// Layer: Model
// Exports: ThreadHistoryAnchor, ThreadHistorySegment, ThreadHistoryGap, ThreadHistoryState

import Foundation

enum ThreadHistoryWindowMode: String, Codable, Hashable, Sendable {
    case tail
    case before
    case after
}

struct ThreadHistoryAnchor: Codable, Hashable, Sendable {
    var itemId: String?
    var createdAt: Date
    var turnId: String?
}

struct ThreadHistorySegment: Codable, Hashable, Sendable, Identifiable {
    var id: String {
        [
            oldestAnchor.itemId ?? oldestAnchor.turnId ?? "oldest",
            newestAnchor.itemId ?? newestAnchor.turnId ?? "newest",
            String(oldestAnchor.createdAt.timeIntervalSince1970),
            String(newestAnchor.createdAt.timeIntervalSince1970),
        ].joined(separator: "|")
    }

    var oldestAnchor: ThreadHistoryAnchor
    var newestAnchor: ThreadHistoryAnchor
}

struct ThreadHistoryGap: Codable, Hashable, Sendable, Identifiable {
    var id: String {
        [
            olderAnchor.itemId ?? olderAnchor.turnId ?? "older",
            newerAnchor.itemId ?? newerAnchor.turnId ?? "newer",
            String(olderAnchor.createdAt.timeIntervalSince1970),
            String(newerAnchor.createdAt.timeIntervalSince1970),
        ].joined(separator: "|")
    }

    var olderAnchor: ThreadHistoryAnchor
    var newerAnchor: ThreadHistoryAnchor
}

struct ThreadHistoryState: Codable, Hashable, Sendable {
    var segments: [ThreadHistorySegment] = []
    var gaps: [ThreadHistoryGap] = []
    var oldestLoadedAnchor: ThreadHistoryAnchor?
    var newestLoadedAnchor: ThreadHistoryAnchor?
    var hasOlderOnServer = false
    var hasNewerOnServer = false
    var isLoadingOlder = false
    var isTailRefreshing = false
}
