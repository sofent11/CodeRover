// FILE: SidebarThreadGrouping.swift
// Purpose: Produces sidebar thread groups by project path (`cwd`) and keeps archived chats separate.
// Layer: View Helper
// Exports: SidebarThreadGroupKind, SidebarThreadGroup, SidebarThreadGrouping

import Foundation

enum SidebarThreadGroupKind: Equatable {
    case project
    case archived
}

struct SidebarProjectChoice: Identifiable, Equatable {
    let id: String
    let label: String
    let projectPath: String
    let sortDate: Date
}

struct SidebarThreadGroup: Identifiable {
    let id: String
    let label: String
    let kind: SidebarThreadGroupKind
    let sortDate: Date
    let projectPath: String?
    let threads: [ConversationThread]
    let totalThreadCount: Int

    var hasMoreThreads: Bool {
        kind == .project && threads.count < totalThreadCount
    }

    func contains(_ thread: ConversationThread) -> Bool {
        threads.contains(where: { $0.id == thread.id })
    }
}

enum SidebarThreadGrouping {
    static func makeGroups(
        from threads: [ConversationThread],
        visibleCountByProjectID: [String: Int] = [:],
        now _: Date = Date(),
        calendar _: Calendar = .current
    ) -> [SidebarThreadGroup] {
        var archivedThreads: [ConversationThread] = []

        for thread in threads {
            if thread.syncState == .archivedLocal {
                archivedThreads.append(thread)
            }
        }

        var groups = makeProjectGroups(from: threads, visibleCountByProjectID: visibleCountByProjectID)

        let sortedArchived = sortThreadsByRecentActivity(archivedThreads)
        if let firstArchived = sortedArchived.first {
            groups.append(
                SidebarThreadGroup(
                    id: "archived",
                    label: "Archived (\(sortedArchived.count))",
                    kind: .archived,
                    sortDate: firstArchived.updatedAt ?? firstArchived.createdAt ?? .distantPast,
                    projectPath: nil,
                    threads: sortedArchived,
                    totalThreadCount: sortedArchived.count
                )
            )
        }

        return groups
    }

    // Reuses the sidebar project grouping rules for places like the New Chat chooser.
    static func makeProjectChoices(from threads: [ConversationThread]) -> [SidebarProjectChoice] {
        makeProjectGroups(from: threads, visibleCountByProjectID: [:]).compactMap { group in
            guard let projectPath = group.projectPath else {
                return nil
            }

            return SidebarProjectChoice(
                id: group.id,
                label: group.label,
                projectPath: projectPath,
                sortDate: group.sortDate
            )
        }
    }

    // Resolves all live thread ids that belong to the tapped project, even if the visible group is filtered.
    static func liveThreadIDsForProjectGroup(_ group: SidebarThreadGroup, in threads: [ConversationThread]) -> [String] {
        guard group.kind == .project else {
            return []
        }

        return sortThreadsByRecentActivity(
            threads.filter { thread in
                thread.syncState != .archivedLocal && projectGroupID(for: thread) == group.id
            }
        ).map(\.id)
    }

    private static func makeProjectGroup(
        projectKey: String,
        threads: [ConversationThread],
        visibleCount: Int
    ) -> SidebarThreadGroup {
        let sortedThreads = sortThreadsByRecentActivity(threads)
        let representativeThread = sortedThreads.first
        let sortDate = representativeThread?.updatedAt ?? representativeThread?.createdAt ?? .distantPast
        return SidebarThreadGroup(
            id: "project:\(projectKey)",
            label: representativeThread?.projectDisplayName ?? "No Project",
            kind: .project,
            sortDate: sortDate,
            projectPath: representativeThread?.normalizedProjectPath,
            threads: Array(sortedThreads.prefix(visibleCount)),
            totalThreadCount: sortedThreads.count
        )
    }

    // Keeps project-derived UI consistent by centralizing the live-thread → project bucket mapping.
    private static func makeProjectGroups(
        from threads: [ConversationThread],
        visibleCountByProjectID: [String: Int]
    ) -> [SidebarThreadGroup] {
        var liveThreadsByProject: [String: [ConversationThread]] = [:]

        for thread in threads where thread.syncState != .archivedLocal {
            liveThreadsByProject[thread.projectKey, default: []].append(thread)
        }

        return liveThreadsByProject.map { projectKey, projectThreads in
            let groupID = "project:\(projectKey)"
            let visibleCount = max(visibleCountByProjectID[groupID] ?? 10, 10)
            return makeProjectGroup(projectKey: projectKey, threads: projectThreads, visibleCount: visibleCount)
        }
        .sorted { lhs, rhs in
            if lhs.sortDate != rhs.sortDate {
                return lhs.sortDate > rhs.sortDate
            }

            if lhs.label != rhs.label {
                return lhs.label.localizedCaseInsensitiveCompare(rhs.label) == .orderedAscending
            }

            return lhs.id < rhs.id
        }
    }

    private static func sortThreadsByRecentActivity(_ threads: [ConversationThread]) -> [ConversationThread] {
        threads.sorted { lhs, rhs in
            let lhsDate = lhs.updatedAt ?? lhs.createdAt ?? .distantPast
            let rhsDate = rhs.updatedAt ?? rhs.createdAt ?? .distantPast
            if lhsDate != rhsDate {
                return lhsDate > rhsDate
            }
            return lhs.id < rhs.id
        }
    }

    private static func projectGroupID(for thread: ConversationThread) -> String {
        "project:\(thread.projectKey)"
    }
}
