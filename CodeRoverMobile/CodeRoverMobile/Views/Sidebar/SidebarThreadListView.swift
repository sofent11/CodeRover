// FILE: SidebarThreadListView.swift
// Purpose: Renders sidebar thread groups and empty states.
// Layer: View Component
// Exports: SidebarThreadListView

import SwiftUI

struct SidebarThreadListView: View {
    var isFiltering: Bool = false
    let isConnected: Bool
    let isCreatingThread: Bool
    let threads: [ConversationThread]
    let groups: [SidebarThreadGroup]
    let selectedThread: ConversationThread?
    let bottomContentInset: CGFloat
    let timingLabelProvider: (ConversationThread) -> String?
    let diffTotalsByThreadID: [String: TurnSessionDiffTotals]
    let runBadgeStateByThreadID: [String: ConversationThreadRunBadgeState]
    let onSelectThread: (ConversationThread) -> Void
    let onCreateThreadInProjectGroup: (SidebarThreadGroup) -> Void
    var onArchiveProjectGroup: ((SidebarThreadGroup) -> Void)? = nil
    var onRenameThread: ((ConversationThread, String) -> Void)? = nil
    var onArchiveToggleThread: ((ConversationThread) -> Void)? = nil
    var onDeleteThread: ((ConversationThread) -> Void)? = nil
    var onLoadMoreProjectGroup: ((SidebarThreadGroup) -> Void)? = nil
    @Environment(CodeRoverService.self) private var coderover
    @AppStorage("sidebar.collapsedProjectGroupIDs") private var collapsedProjectGroupIDsStorage = ""
    @State private var expandedProjectGroupIDs: Set<String> = []
    @State private var knownProjectGroupIDs: Set<String> = []
    @State private var hasInitializedProjectGroupExpansion = false
    @State private var isArchivedExpanded = false
    @State private var expandedSubagentParentIDs: Set<String> = []
    @State private var revealedProjectGroupIDs: Set<String> = []

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {

                if threads.isEmpty && !isFiltering {
                    Text(isConnected ? "No conversations" : "Connect to view conversations")
                        .foregroundStyle(.secondary)
                        .font(AppFont.subheadline())
                        .padding(.horizontal, 16)
                        .padding(.top, 20)
                } else if groups.flatMap(\.threads).isEmpty && isFiltering {
                    Text("No matching conversations")
                        .foregroundStyle(.secondary)
                        .font(AppFont.subheadline())
                        .padding(.horizontal, 16)
                        .padding(.top, 20)
                } else {
                    ForEach(groups) { group in
                        groupSection(group)
                    }
                }
            }
            .padding(.bottom, bottomContentInset)
        }
        .scrollDismissesKeyboard(.interactively)
        .task(id: visibleSubagentThreadIDs) {
            await coderover.loadSubagentThreadMetadataIfNeeded(threadIds: visibleSubagentThreadIDs)
        }
        .onAppear {
            syncExpandedProjectGroupState()
            syncRevealedProjectGroupState()
            revealSelectedThreadProjectGroup()
            revealSelectedSubagentAncestors()
        }
        .onChange(of: groups.map(\.id)) { _, _ in
            syncExpandedProjectGroupState()
            syncRevealedProjectGroupState()
            revealSelectedThreadProjectGroup()
            revealSelectedSubagentAncestors()
        }
        .onChange(of: selectedThread?.id) { _, _ in
            revealSelectedThreadProjectGroup()
            revealSelectedSubagentAncestors()
        }
    }

    @ViewBuilder
    private func groupSection(_ group: SidebarThreadGroup) -> some View {
        switch group.kind {
        case .project:
            projectGroupSection(group)

        case .archived:
            archivedGroupSection(group)
        }
    }

    private func projectGroupSection(_ group: SidebarThreadGroup) -> some View {
        let hierarchy = SidebarSubagentHierarchy(groupThreads: group.threads)
        let visibleRootThreads = SidebarProjectThreadPreviewState.visibleRootThreads(
            for: group,
            selectedThread: selectedThread,
            isFiltering: isFiltering,
            manuallyExpandedGroupIDs: revealedProjectGroupIDs
        )
        let shouldShowMoreButton = SidebarProjectThreadPreviewState.shouldShowMoreButton(
            for: group,
            selectedThread: selectedThread,
            isFiltering: isFiltering,
            manuallyExpandedGroupIDs: revealedProjectGroupIDs
        )

        return VStack(alignment: .leading, spacing: 0) {
            projectHeader(group)

            if expandedProjectGroupIDs.contains(group.id) {
                VStack(spacing: 2) {
                    ForEach(visibleRootThreads) { thread in
                        threadRowTree(thread, childrenByParentID: hierarchy.childrenByParentID)
                    }

                    if shouldShowMoreButton {
                        let totalRootCount = SidebarProjectThreadPreviewState.rootThreads(in: group.threads).count
                        let hiddenCount = totalRootCount - visibleRootThreads.count
                        projectGroupShowMoreButton(group, hiddenCount: hiddenCount)
                    }

                    if group.hasMoreThreads, let onLoadMoreProjectGroup {
                        Button {
                            HapticFeedback.shared.triggerImpactFeedback(style: .light)
                            onLoadMoreProjectGroup(group)
                        } label: {
                            Text("More")
                                .font(AppFont.subheadline())
                                .foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 18)
                                .padding(.vertical, 8)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.bottom, 14)
                .transition(.opacity)
            }
        }
    }

    private func projectGroupShowMoreButton(_ group: SidebarThreadGroup, hiddenCount: Int) -> some View {
        HStack {
            Button {
                HapticFeedback.shared.triggerImpactFeedback(style: .light)
                _ = withAnimation(.easeInOut(duration: 0.2)) {
                    revealedProjectGroupIDs.insert(group.id)
                }
            } label: {
                HStack(spacing: 6) {
                    Text(hiddenCount > 0 ? "Show \(hiddenCount) more" : "Show more")
                    Image(systemName: "chevron.down")
                        .font(AppFont.system(size: 10, weight: .semibold))
                }
                .font(AppFont.caption(weight: .semibold))
                .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)

            Spacer(minLength: 0)
        }
        .padding(.leading, 48)
        .padding(.top, 6)
    }

    private func projectHeader(_ group: SidebarThreadGroup) -> some View {
        let isExpanded = expandedProjectGroupIDs.contains(group.id)
        let projectIconSystemName = ConversationThread.projectIconSystemName(for: group.projectPath)

        return HStack(spacing: 12) {
            Button {
                HapticFeedback.shared.triggerImpactFeedback(style: .light)
                toggleProjectGroupExpansion(group.id)
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: projectIconSystemName)
                        .font(AppFont.body(weight: .medium))
                        .foregroundStyle(.primary)
                    Text(group.label)
                        .font(AppFont.body(weight: .medium))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .contextMenu {
                if let onArchiveProjectGroup {
                    Button {
                        HapticFeedback.shared.triggerImpactFeedback(style: .light)
                        onArchiveProjectGroup(group)
                    } label: {
                        Label("Archive Project", systemImage: "archivebox")
                    }
                }
            }

            HStack(spacing: 8) {
                Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                    .font(AppFont.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 14, height: 14)
                    .animation(.easeInOut(duration: 0.2), value: isExpanded)

                Button {
                    HapticFeedback.shared.triggerImpactFeedback()
                    onCreateThreadInProjectGroup(group)
                } label: {
                    Image(systemName: "plus")
                        .font(AppFont.system(size: 12, weight: .semibold))
                        .foregroundStyle(.primary)
                        .frame(width: 30, height: 30)
                        .background(Color.primary.opacity(0.08), in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(!isConnected || isCreatingThread)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 18)
        .padding(.bottom, 10)
    }

    private func archivedGroupSection(_ group: SidebarThreadGroup) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                HapticFeedback.shared.triggerImpactFeedback(style: .light)
                withAnimation(.easeInOut(duration: 0.2)) {
                    isArchivedExpanded.toggle()
                }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "archivebox")
                        .font(AppFont.body(weight: .medium))
                        .foregroundStyle(.primary)
                    Text(group.label)
                        .font(AppFont.body(weight: .medium))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(AppFont.caption(weight: .semibold))
                        .foregroundStyle(.secondary)
                        .rotationEffect(.degrees(isArchivedExpanded ? 90 : 0))
                        .animation(.easeInOut(duration: 0.2), value: isArchivedExpanded)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 16)
            .padding(.top, 18)
            .padding(.bottom, 10)

            if isArchivedExpanded {
                VStack(spacing: 4) {
                    ForEach(group.threads) { thread in
                        threadRow(thread)
                    }
                }
                .padding(.bottom, 14)
                .transition(.opacity)
            }
        }
    }

    private func threadRowTree(
        _ thread: ConversationThread,
        childrenByParentID: [String: [ConversationThread]],
        ancestorThreadIDs: Set<String> = []
    ) -> AnyView {
        let childThreads = childrenByParentID[thread.id] ?? []
        let isExpanded = expandedSubagentParentIDs.contains(thread.id)
        let nextAncestorThreadIDs = ancestorThreadIDs.union([thread.id])

        return AnyView(
            VStack(alignment: .leading, spacing: thread.isSubagent ? 2 : 4) {
                threadRow(
                    thread,
                    childSubagentCount: childThreads.count,
                    isSubagentExpanded: isExpanded,
                    onToggleSubagents: childThreads.isEmpty ? nil : {
                        toggleSubagentExpansion(parentThreadID: thread.id)
                    }
                )

                if isExpanded, !childThreads.isEmpty {
                    VStack(spacing: 2) {
                        ForEach(childThreads) { childThread in
                            if nextAncestorThreadIDs.contains(childThread.id) {
                                AnyView(threadRow(childThread))
                            } else {
                                threadRowTree(
                                    childThread,
                                    childrenByParentID: childrenByParentID,
                                    ancestorThreadIDs: nextAncestorThreadIDs
                                )
                            }
                        }
                    }
                }
            }
        )
    }

    private func threadRow(
        _ thread: ConversationThread,
        childSubagentCount: Int = 0,
        isSubagentExpanded: Bool = false,
        onToggleSubagents: (() -> Void)? = nil
    ) -> some View {
        SidebarThreadRowView(
            thread: thread,
            isSelected: selectedThread?.id == thread.id,
            runBadgeState: runBadgeStateByThreadID[thread.id],
            timingLabel: timingLabelProvider(thread),
            diffTotals: diffTotalsByThreadID[thread.id],
            childSubagentCount: childSubagentCount,
            isSubagentExpanded: isSubagentExpanded,
            onToggleSubagents: onToggleSubagents,
            onTap: {
                if selectedThread?.id == thread.id, childSubagentCount > 0 {
                    onToggleSubagents?()
                } else {
                    onSelectThread(thread)
                }
            },
            onRename: onRenameThread.map { handler in { newName in handler(thread, newName) } },
            onArchiveToggle: onArchiveToggleThread.map { handler in { handler(thread) } },
            onDelete: onDeleteThread.map { handler in { handler(thread) } }
        )
    }

    private var visibleSubagentThreadIDs: [String] {
        var visibleThreadIDs: [String] = []

        for group in groups {
            switch group.kind {
            case .project:
                guard expandedProjectGroupIDs.contains(group.id) else { continue }
                let hierarchy = SidebarSubagentHierarchy(groupThreads: group.threads)
                let visibleRootThreads = SidebarProjectThreadPreviewState.visibleRootThreads(
                    for: group,
                    selectedThread: selectedThread,
                    isFiltering: isFiltering,
                    manuallyExpandedGroupIDs: revealedProjectGroupIDs
                )
                for rootThread in visibleRootThreads {
                    collectVisibleSubagentThreadIDs(
                        from: rootThread,
                        childrenByParentID: hierarchy.childrenByParentID,
                        ancestorThreadIDs: [],
                        into: &visibleThreadIDs
                    )
                }
            case .archived:
                guard isArchivedExpanded else { continue }
                for thread in group.threads where thread.isSubagent {
                    visibleThreadIDs.append(thread.id)
                }
            }
        }

        return visibleThreadIDs
    }

    private func collectVisibleSubagentThreadIDs(
        from thread: ConversationThread,
        childrenByParentID: [String: [ConversationThread]],
        ancestorThreadIDs: Set<String>,
        into visibleThreadIDs: inout [String]
    ) {
        if thread.isSubagent {
            visibleThreadIDs.append(thread.id)
        }

        guard expandedSubagentParentIDs.contains(thread.id) else {
            return
        }

        let nextAncestorThreadIDs = ancestorThreadIDs.union([thread.id])
        for childThread in childrenByParentID[thread.id] ?? [] {
            guard !nextAncestorThreadIDs.contains(childThread.id) else { continue }
            collectVisibleSubagentThreadIDs(
                from: childThread,
                childrenByParentID: childrenByParentID,
                ancestorThreadIDs: nextAncestorThreadIDs,
                into: &visibleThreadIDs
            )
        }
    }

    private func toggleProjectGroupExpansion(_ groupID: String) {
        var persistedCollapsedGroupIDs = SidebarProjectExpansionState.decodePersistedGroupIDs(
            collapsedProjectGroupIDsStorage
        )
        if expandedProjectGroupIDs.contains(groupID) {
            expandedProjectGroupIDs.remove(groupID)
            revealedProjectGroupIDs.remove(groupID)
            persistedCollapsedGroupIDs.insert(groupID)
        } else {
            expandedProjectGroupIDs.insert(groupID)
            persistedCollapsedGroupIDs.remove(groupID)
        }
        collapsedProjectGroupIDsStorage = SidebarProjectExpansionState.encodePersistedGroupIDs(
            persistedCollapsedGroupIDs
        )
    }

    private func syncExpandedProjectGroupState() {
        let nextState = SidebarProjectExpansionState.synchronizedState(
            currentExpandedGroupIDs: expandedProjectGroupIDs,
            knownGroupIDs: knownProjectGroupIDs,
            visibleGroups: groups,
            hasInitialized: hasInitializedProjectGroupExpansion,
            persistedCollapsedGroupIDs: SidebarProjectExpansionState.decodePersistedGroupIDs(
                collapsedProjectGroupIDsStorage
            )
        )
        expandedProjectGroupIDs = nextState.expandedGroupIDs
        knownProjectGroupIDs = nextState.knownGroupIDs
        hasInitializedProjectGroupExpansion = true
    }

    private func syncRevealedProjectGroupState() {
        let visibleProjectGroupIDs = Set(
            groups
                .filter { $0.kind == .project }
                .map(\.id)
        )
        revealedProjectGroupIDs = revealedProjectGroupIDs.intersection(visibleProjectGroupIDs)
    }

    private func revealSelectedThreadProjectGroup() {
        if let selectedGroupID = SidebarProjectExpansionState.groupIDContainingSelectedThread(
            selectedThread,
            in: groups
        ),
           SidebarProjectExpansionState.shouldAutoRevealSelectedGroup(
               selectedGroupID,
               persistedCollapsedGroupIDs: SidebarProjectExpansionState.decodePersistedGroupIDs(
                   collapsedProjectGroupIDsStorage
               )
           ) {
            expandedProjectGroupIDs.insert(selectedGroupID)
        }
    }

    private func toggleSubagentExpansion(parentThreadID: String) {
        if expandedSubagentParentIDs.contains(parentThreadID) {
            expandedSubagentParentIDs.remove(parentThreadID)
        } else {
            expandedSubagentParentIDs.insert(parentThreadID)
        }
    }

    private func revealSelectedSubagentAncestors() {
        guard let selectedThread else { return }
        expandedSubagentParentIDs.formUnion(subagentAncestorIDs(for: selectedThread))
    }

    private func subagentAncestorIDs(for thread: ConversationThread) -> Set<String> {
        let threadsByID = Dictionary(uniqueKeysWithValues: threads.map { ($0.id, $0) })
        var ancestorIDs: Set<String> = []
        var currentParentID = thread.parentThreadId

        while let parentID = currentParentID, !ancestorIDs.contains(parentID) {
            ancestorIDs.insert(parentID)
            currentParentID = threadsByID[parentID]?.parentThreadId
        }

        return ancestorIDs
    }
}

private enum SidebarProjectThreadPreviewState {
    static let collapsedRootThreadLimit = 6

    static func visibleRootThreads(
        for group: SidebarThreadGroup,
        selectedThread: ConversationThread?,
        isFiltering: Bool,
        manuallyExpandedGroupIDs: Set<String>
    ) -> [ConversationThread] {
        let rootThreads = rootThreads(in: group.threads)
        if shouldRevealAllRootThreads(
            for: group,
            rootThreads: rootThreads,
            selectedThread: selectedThread,
            isFiltering: isFiltering,
            manuallyExpandedGroupIDs: manuallyExpandedGroupIDs
        ) {
            return rootThreads
        }

        return Array(rootThreads.prefix(collapsedRootThreadLimit))
    }

    static func shouldShowMoreButton(
        for group: SidebarThreadGroup,
        selectedThread: ConversationThread?,
        isFiltering: Bool,
        manuallyExpandedGroupIDs: Set<String>
    ) -> Bool {
        let rootThreads = rootThreads(in: group.threads)
        guard group.kind == .project,
              rootThreads.count > collapsedRootThreadLimit,
              !isFiltering,
              !manuallyExpandedGroupIDs.contains(group.id) else {
            return false
        }

        return !selectedThreadRequiresExpansion(
            selectedThread,
            in: group,
            rootThreads: rootThreads
        )
    }

    static func rootThreads(in groupThreads: [ConversationThread]) -> [ConversationThread] {
        let groupThreadIDs = Set(groupThreads.map(\.id))
        return groupThreads.filter { thread in
            guard let parentThreadID = thread.parentThreadId else {
                return true
            }

            return !groupThreadIDs.contains(parentThreadID)
        }
    }

    static func selectedThreadRequiresExpansion(
        _ selectedThread: ConversationThread?,
        in group: SidebarThreadGroup,
        rootThreads: [ConversationThread]? = nil
    ) -> Bool {
        guard let selectedThread, group.contains(selectedThread) else {
            return false
        }

        let groupRootThreads = rootThreads ?? self.rootThreads(in: group.threads)
        let visibleRootThreadIDs = Set(groupRootThreads.prefix(collapsedRootThreadLimit).map(\.id))
        let selectedRootThreadID = rootThreadID(containing: selectedThread, in: group.threads) ?? selectedThread.id

        return !visibleRootThreadIDs.contains(selectedRootThreadID)
    }

    private static func shouldRevealAllRootThreads(
        for group: SidebarThreadGroup,
        rootThreads: [ConversationThread],
        selectedThread: ConversationThread?,
        isFiltering: Bool,
        manuallyExpandedGroupIDs: Set<String>
    ) -> Bool {
        guard group.kind == .project, rootThreads.count > collapsedRootThreadLimit else {
            return true
        }

        if isFiltering || manuallyExpandedGroupIDs.contains(group.id) {
            return true
        }

        return selectedThreadRequiresExpansion(
            selectedThread,
            in: group,
            rootThreads: rootThreads
        )
    }

    private static func rootThreadID(containing thread: ConversationThread, in groupThreads: [ConversationThread]) -> String? {
        let threadsByID = Dictionary(uniqueKeysWithValues: groupThreads.map { ($0.id, $0) })
        var currentThread = thread
        var visitedThreadIDs: Set<String> = [thread.id]

        while let parentThreadID = currentThread.parentThreadId,
              !visitedThreadIDs.contains(parentThreadID),
              let parentThread = threadsByID[parentThreadID] {
            currentThread = parentThread
            visitedThreadIDs.insert(parentThreadID)
        }

        return currentThread.id
    }
}

private struct SidebarSubagentHierarchy {
    let rootThreads: [ConversationThread]
    let childrenByParentID: [String: [ConversationThread]]

    init(groupThreads: [ConversationThread]) {
        let threadsByID = Dictionary(uniqueKeysWithValues: groupThreads.map { ($0.id, $0) })
        var childrenByParentID: [String: [ConversationThread]] = [:]
        var rootThreads: [ConversationThread] = []

        for thread in groupThreads {
            if let parentThreadID = thread.parentThreadId,
               threadsByID[parentThreadID] != nil {
                childrenByParentID[parentThreadID, default: []].append(thread)
            } else {
                rootThreads.append(thread)
            }
        }

        self.rootThreads = rootThreads
        self.childrenByParentID = childrenByParentID
    }
}

enum SidebarProjectExpansionState {
    struct SyncResult {
        let expandedGroupIDs: Set<String>
        let knownGroupIDs: Set<String>
    }

    static func decodePersistedGroupIDs(_ rawValue: String) -> Set<String> {
        Set(
            rawValue
                .split(separator: "\n")
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
        )
    }

    static func encodePersistedGroupIDs(_ groupIDs: Set<String>) -> String {
        groupIDs
            .sorted()
            .joined(separator: "\n")
    }

    static func synchronizedState(
        currentExpandedGroupIDs: Set<String>,
        knownGroupIDs: Set<String>,
        visibleGroups: [SidebarThreadGroup],
        hasInitialized: Bool,
        persistedCollapsedGroupIDs: Set<String>
    ) -> SyncResult {
        let visibleProjectGroupIDs = Set(
            visibleGroups
                .filter { $0.kind == .project }
                .map(\.id)
        )

        guard hasInitialized else {
            return SyncResult(
                expandedGroupIDs: visibleProjectGroupIDs.subtracting(persistedCollapsedGroupIDs),
                knownGroupIDs: visibleProjectGroupIDs
            )
        }

        let staleExpanded = currentExpandedGroupIDs.intersection(visibleProjectGroupIDs)
        let newGroupIDs = visibleProjectGroupIDs.subtracting(knownGroupIDs)
        let expandedGroupIDs = staleExpanded
            .union(newGroupIDs.subtracting(persistedCollapsedGroupIDs))
            .subtracting(persistedCollapsedGroupIDs)

        return SyncResult(
            expandedGroupIDs: expandedGroupIDs,
            knownGroupIDs: visibleProjectGroupIDs
        )
    }

    static func groupIDContainingSelectedThread(
        _ selectedThread: ConversationThread?,
        in groups: [SidebarThreadGroup]
    ) -> String? {
        guard let selectedThread else { return nil }
        return groups.first { group in
            group.kind == .project && group.threads.contains(where: { $0.id == selectedThread.id })
        }?.id
    }

    static func shouldAutoRevealSelectedGroup(
        _ groupID: String,
        persistedCollapsedGroupIDs: Set<String>
    ) -> Bool {
        !persistedCollapsedGroupIDs.contains(groupID)
    }
}
