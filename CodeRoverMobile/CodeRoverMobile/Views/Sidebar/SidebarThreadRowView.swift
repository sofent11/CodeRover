// FILE: SidebarThreadRowView.swift
// Purpose: Displays a single sidebar conversation row.
// Layer: View Component
// Exports: SidebarThreadRowView

import SwiftUI

struct SidebarThreadRowView: View {
    let thread: ConversationThread
    let isSelected: Bool
    let runBadgeState: ConversationThreadRunBadgeState?
    let timingLabel: String?
    let diffTotals: TurnSessionDiffTotals?
    let childSubagentCount: Int
    let isSubagentExpanded: Bool
    let onToggleSubagents: (() -> Void)?
    let onTap: () -> Void
    var onRename: ((String) -> Void)? = nil
    var onArchiveToggle: (() -> Void)? = nil
    var onDelete: (() -> Void)? = nil

    @State private var isShowingRenameAlert = false
    @State private var renameText = ""

    var body: some View {
        Group {
            if thread.isSubagent {
                subagentRow
            } else {
                parentRow
            }
        }
        .background {
            if isSelected {
                Color(.tertiarySystemFill).opacity(0.8)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
        }
        .padding(.horizontal, 12)
        .contextMenu {
            if onRename != nil {
                Button {
                    HapticFeedback.shared.triggerImpactFeedback(style: .light)
                    renameText = thread.displayTitle
                    isShowingRenameAlert = true
                } label: {
                    Label("Rename", systemImage: "pencil")
                }
            }

            if let onArchiveToggle {
                Button {
                    HapticFeedback.shared.triggerImpactFeedback(style: .light)
                    onArchiveToggle()
                } label: {
                    Label(
                        thread.syncState == .archivedLocal ? "Unarchive" : "Archive",
                        systemImage: thread.syncState == .archivedLocal ? "tray.and.arrow.up" : "archivebox"
                    )
                }
            }

            if let onDelete {
                Button(role: .destructive) {
                    HapticFeedback.shared.triggerImpactFeedback(style: .light)
                    onDelete()
                } label: {
                    Label("Delete", systemImage: "trash")
                }
            }
        }
        .alert("Rename Conversation", isPresented: $isShowingRenameAlert) {
            TextField("Name", text: $renameText)
            Button("Rename") {
                let trimmed = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty {
                    onRename?(trimmed)
                }
            }
            Button("Cancel", role: .cancel) {}
        }
    }

    private var parentRow: some View {
        Button(action: {
            HapticFeedback.shared.triggerImpactFeedback(style: .light)
            onTap()
        }) {
            HStack(alignment: .center, spacing: 8) {
                if let runBadgeState {
                    SidebarThreadRunBadgeView(state: runBadgeState)
                        .padding(.leading, 10)
                        .padding(.top, 4)
                } else {
                    Color.clear
                        .frame(width: 10, height: 10)
                        .padding(.leading, 10)
                        .padding(.top, 4)
                }

                SidebarThreadAgentTypeIcon(thread: thread)

                VStack(alignment: .leading, spacing: 4) {
                    Text(thread.displayTitle)
                        .font(AppFont.body())
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .foregroundStyle(.primary)

                    if thread.syncState == .archivedLocal {
                        Text("Stored locally")
                            .font(AppFont.footnote())
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                parentTrailingMeta
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.leading, 16)
        .padding(.trailing, 16)
        .padding(.vertical, 12)
    }

    private var parentTrailingMeta: some View {
        HStack(spacing: 6) {
            if thread.syncState == .archivedLocal {
                Text("Archived")
                    .font(AppFont.caption2())
                    .foregroundStyle(.orange)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(Color.orange.opacity(0.12), in: Capsule())
            }

            if let diffTotals {
                SidebarThreadDiffTotalsLabel(totals: diffTotals)
            }

            expansionToggleButton

            if let timingLabel {
                Text(timingLabel)
                    .font(AppFont.footnote())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.trailing, 16)
    }

    private var subagentRow: some View {
        Button(action: {
            HapticFeedback.shared.triggerImpactFeedback(style: .light)
            onTap()
        }) {
            HStack(alignment: .center, spacing: 8) {
                Color.clear
                    .frame(width: 10, height: 10)
                    .padding(.leading, 10)

                SidebarThreadAgentTypeIcon(thread: thread)

                SidebarSubagentNameLabel(thread: thread)
                    .frame(maxWidth: .infinity, alignment: .leading)

                subagentTrailingMeta
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.leading, 16)
        .padding(.trailing, 16)
        .padding(.vertical, 4)
    }

    private var subagentTrailingMeta: some View {
        HStack(spacing: 4) {
            expansionToggleButton

            if let timingLabel {
                Text(timingLabel)
                    .font(AppFont.caption())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.trailing, 16)
    }

    @ViewBuilder
    private var expansionToggleButton: some View {
        if childSubagentCount > 0, let onToggleSubagents {
            Button(action: {
                HapticFeedback.shared.triggerImpactFeedback(style: .light)
                onToggleSubagents()
            }) {
                Image(systemName: isSubagentExpanded ? "chevron.down" : "chevron.right")
                    .font(AppFont.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 18, height: 18)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(isSubagentExpanded ? "Collapse subagents" : "Expand subagents")
        }
    }
}

private struct SidebarThreadAgentTypeIcon: View {
    let thread: ConversationThread

    private var title: String {
        if thread.isSubagent {
            if let role = thread.agentRole?.trimmingCharacters(in: .whitespacesAndNewlines), !role.isEmpty {
                return role
            }
            if let derivedRole = thread.derivedSubagentIdentity?.role?.trimmingCharacters(in: .whitespacesAndNewlines),
               !derivedRole.isEmpty {
                return derivedRole
            }
        }

        return thread.providerBadgeTitle
    }

    private var initial: String {
        if !thread.isSubagent {
            return thread.providerMonogram
        }
        let scalars = title.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) }
        guard let firstScalar = scalars.first else {
            return "A"
        }
        return String(Character(firstScalar)).uppercased()
    }

    private var tintColor: Color {
        SubagentLabelParser.nicknameColor(for: title)
    }

    var body: some View {
        Text(initial)
            .font(AppFont.caption2(weight: .semibold))
            .foregroundStyle(tintColor)
            .frame(width: 22, height: 22)
            .background(tintColor.opacity(0.14), in: Circle())
            .accessibilityLabel(title)
    }
}

private struct SidebarSubagentNameLabel: View {
    let thread: ConversationThread
    @Environment(CodeRoverService.self) private var coderover

    var body: some View {
        let _ = coderover.subagentIdentityVersion
        let source = thread.preferredSubagentLabel
            ?? coderover.resolvedSubagentDisplayLabel(threadId: thread.id, agentId: thread.agentId)
            ?? "Subagent"
        let parsed = SubagentLabelParser.parse(source)
        let nickname = parsed.nickname.isEmpty || parsed.nickname == "Conversation" ? "Subagent" : parsed.nickname
        SubagentLabelParser.styledText(nickname: nickname, roleSuffix: parsed.roleSuffix)
            .font(AppFont.caption(weight: .medium))
            .lineLimit(1)
            .truncationMode(.tail)
    }
}

private struct SidebarThreadDiffTotalsLabel: View {
    let totals: TurnSessionDiffTotals

    var body: some View {
        HStack(spacing: 3) {
            Text("+\(totals.additions)")
                .foregroundStyle(Color.green)
            Text("-\(totals.deletions)")
                .foregroundStyle(Color.red)
        }
        .font(AppFont.mono(.caption2))
        .lineLimit(1)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Conversation diff total")
        .accessibilityValue("+\(totals.additions) -\(totals.deletions)")
    }
}
