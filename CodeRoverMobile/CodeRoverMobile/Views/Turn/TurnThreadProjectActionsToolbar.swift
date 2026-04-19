// FILE: TurnThreadProjectActionsToolbar.swift
// Purpose: Hosts toolbar actions for Local/worktree handoff and thread fork routing.
// Layer: View Component
// Exports: TurnThreadProjectAction, TurnThreadProjectActionsToolbarButton
// Depends on: SwiftUI

import SwiftUI

enum TurnThreadProjectAction: Hashable {
    case handoff
    case forkToLocal
    case forkToWorktree
}

struct TurnThreadProjectActionsToolbarButton: View {
    let isEnabled: Bool
    let isRunningAction: Bool
    let isManagedWorktreeProject: Bool
    let canForkToLocal: Bool
    let onSelect: (TurnThreadProjectAction) -> Void

    var body: some View {
        Menu {
            Section("Project") {
                actionButton(
                    title: isManagedWorktreeProject ? "Hand Off to Local" : "Hand Off to Worktree",
                    systemImage: isManagedWorktreeProject ? "laptopcomputer" : "arrow.triangle.branch",
                    action: .handoff
                )
            }

            Section("Fork") {
                actionButton(
                    title: "Fork to Local",
                    systemImage: "arrow.turn.down.left",
                    action: .forkToLocal,
                    isActionEnabled: canForkToLocal
                )
                actionButton(
                    title: "Fork to Worktree",
                    systemImage: "arrow.triangle.branch",
                    action: .forkToWorktree
                )
            }
        } label: {
            Group {
                if isRunningAction {
                    ProgressView()
                        .controlSize(.small)
                        .frame(width: 24, height: 24)
                } else {
                    Image(systemName: "arrow.triangle.branch")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(.primary)
                        .frame(width: 24, height: 24)
                }
            }
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
        .adaptiveToolbarItem(in: Circle())
        .accessibilityLabel("Project actions")
    }

    private func actionButton(
        title: String,
        systemImage: String,
        action: TurnThreadProjectAction,
        isActionEnabled: Bool = true
    ) -> some View {
        Button {
            HapticFeedback.shared.triggerImpactFeedback(style: .light)
            onSelect(action)
        } label: {
            Label(title, systemImage: systemImage)
        }
        .disabled(!isEnabled || !isActionEnabled)
    }
}
