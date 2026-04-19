// FILE: TurnToolbarContent.swift
// Purpose: Encapsulates the TurnView navigation toolbar and thread-path sheet.
// Layer: View Component
// Exports: TurnToolbarContent, TurnThreadNavigationContext

import SwiftUI

struct TurnThreadNavigationContext {
    let folderName: String
    let subtitle: String
    let fullPath: String
}

struct TurnToolbarContent: ToolbarContent {
    let displayTitle: String
    let providerTitle: String?
    let navigationContext: TurnThreadNavigationContext?
    let showsDesktopRestart: Bool
    let isRestartingDesktopApp: Bool
    let repoDiffTotals: GitDiffTotals?
    let isLoadingRepoDiff: Bool
    let showsThreadProjectActions: Bool
    let isThreadProjectActionEnabled: Bool
    let isRunningThreadProjectAction: Bool
    let isManagedWorktreeProject: Bool
    let canForkToLocal: Bool
    let showsGitActions: Bool
    let isGitActionEnabled: Bool
    let isRunningGitAction: Bool
    let showsDiscardRuntimeChangesAndSync: Bool
    let gitSyncState: String?
    let contextWindowUsage: ContextWindowUsage?
    var onTapDesktopRestart: (() -> Void)?
    var onCompactContext: (() -> Void)?
    var onTapRepoDiff: (() -> Void)?
    var onThreadProjectAction: ((TurnThreadProjectAction) -> Void)?
    let onGitAction: (TurnGitActionKind) -> Void

    @Binding var isShowingPathSheet: Bool

    var body: some ToolbarContent {
        ToolbarItem(placement: .principal) {
            VStack(alignment: .leading, spacing: 1) {
                Text(displayTitle)
                    .font(AppFont.headline())
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)

                if let context = navigationContext {
                    HStack(spacing: 6) {
                        if let providerTitle, !providerTitle.isEmpty {
                            Text(providerTitle)
                                .font(AppFont.caption(weight: .semibold))
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Color(.secondarySystemFill), in: Capsule())
                        }

                        Button {
                            HapticFeedback.shared.triggerImpactFeedback(style: .light)
                            isShowingPathSheet = true
                        } label: {
                            Text(context.subtitle)
                                .font(AppFont.mono(.caption))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }

        ToolbarItem(placement: .topBarTrailing) {
            HStack(spacing: 10) {
                if showsDesktopRestart, let onTapDesktopRestart {
                    Button {
                        HapticFeedback.shared.triggerImpactFeedback(style: .light)
                        onTapDesktopRestart()
                    } label: {
                        TurnDesktopRestartToolbarLabel(isLoading: isRestartingDesktopApp)
                    }
                    .buttonStyle(.plain)
                    .disabled(isRestartingDesktopApp)
                    .accessibilityLabel("Restart Codex desktop app")
                }

                if let contextWindowUsage {
                    ContextWindowProgressRing(
                        usage: contextWindowUsage,
                        onCompact: onCompactContext
                    )
                }

                if let repoDiffTotals {
                    TurnToolbarDiffTotalsLabel(
                        totals: repoDiffTotals,
                        isLoading: isLoadingRepoDiff,
                        onTap: onTapRepoDiff
                    )
                }

                if showsThreadProjectActions, let onThreadProjectAction {
                    TurnThreadProjectActionsToolbarButton(
                        isEnabled: isThreadProjectActionEnabled,
                        isRunningAction: isRunningThreadProjectAction,
                        isManagedWorktreeProject: isManagedWorktreeProject,
                        canForkToLocal: canForkToLocal,
                        onSelect: onThreadProjectAction
                    )
                }

                if showsGitActions {
                    TurnGitActionsToolbarButton(
                        isEnabled: isGitActionEnabled,
                        isRunningAction: isRunningGitAction,
                        showsDiscardRuntimeChangesAndSync: showsDiscardRuntimeChangesAndSync,
                        gitSyncState: gitSyncState,
                        onSelect: onGitAction
                    )
                }
            }
        }
    }
}

private struct TurnDesktopRestartToolbarLabel: View {
    let isLoading: Bool

    var body: some View {
        Group {
            if isLoading {
                ProgressView()
                    .controlSize(.small)
                    .frame(width: 24, height: 24)
            } else {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.primary)
                    .frame(width: 24, height: 24)
            }
        }
        .contentShape(Circle())
        .adaptiveToolbarItem(in: Circle())
    }
}

private struct TurnToolbarDiffTotalsLabel: View {
    let totals: GitDiffTotals
    let isLoading: Bool
    let onTap: (() -> Void)?

    var body: some View {
        Group {
            if let onTap {
                Button {
                    HapticFeedback.shared.triggerImpactFeedback(style: .light)
                    onTap()
                } label: {
                    labelContent
                }
                .buttonStyle(.plain)
                .disabled(isLoading)
            } else {
                labelContent
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Repository diff total")
        .accessibilityValue(accessibilityValue)
    }

    private var labelContent: some View {
        HStack(spacing: 4) {
            if isLoading {
                ProgressView()
                    .controlSize(.mini)
            }
            Text("+\(totals.additions)")
                .foregroundStyle(Color.green)
            Text("-\(totals.deletions)")
                .foregroundStyle(Color.red)
            if totals.binaryFiles > 0 {
                Text("B\(totals.binaryFiles)")
                    .foregroundStyle(.secondary)
            }
        }
        .font(AppFont.mono(.caption))
        .frame(minHeight: 24)
        .fixedSize(horizontal: true, vertical: false)
        .opacity(isLoading ? 0.8 : 1)
        .adaptiveToolbarItem(in: Capsule())
    }

    private var accessibilityValue: String {
        if totals.binaryFiles > 0 {
            return "+\(totals.additions) -\(totals.deletions) binary \(totals.binaryFiles)"
        }
        return "+\(totals.additions) -\(totals.deletions)"
    }
}

struct TurnThreadPathSheet: View {
    let context: TurnThreadNavigationContext

    var body: some View {
        NavigationStack {
            ScrollView {
                Text(context.fullPath)
                    .font(AppFont.mono(.callout))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
            }
            .navigationTitle(context.folderName)
            .navigationBarTitleDisplayMode(.inline)
            .adaptiveNavigationBar()
        }
        .presentationDetents([.fraction(0.25), .medium])
    }
}
