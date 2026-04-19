// FILE: TurnComposerView.swift
// Purpose: Renders the turn composer input, queued-draft actions, attachments, and send/stop controls.
// Layer: View Component (orchestrator)
// Exports: TurnComposerView
// Depends on: SwiftUI, ComposerAttachmentsPreview, FileAutocompletePanel, SkillAutocompletePanel, ComposerBottomBar, QueuedDraftsPanel, FileMentionChip, TurnComposerInputTextView

import SwiftUI
import UIKit

struct TurnComposerView: View {
    @Environment(\.colorScheme) private var colorScheme

    @Binding var input: String
    let isInputFocused: Binding<Bool>

    let composerAttachments: [TurnComposerImageAttachment]
    let remainingAttachmentSlots: Int
    let isComposerInteractionLocked: Bool
    let isSendDisabled: Bool
    let isPlanModeArmed: Bool
    let supportsPlanMode: Bool
    let queuedDrafts: [QueuedTurnDraft]
    let queuedCount: Int
    let isQueuePaused: Bool
    let canSteerQueuedDrafts: Bool
    let steeringDraftID: String?
    let activeTurnID: String?
    let isThreadRunning: Bool
    let composerMentionedFiles: [TurnComposerMentionedFile]
    let composerMentionedSkills: [TurnComposerMentionedSkill]
    let fileAutocompleteItems: [FuzzyFileMatch]
    let isFileAutocompleteVisible: Bool
    let isFileAutocompleteLoading: Bool
    let fileAutocompleteQuery: String
    let skillAutocompleteItems: [SkillMetadata]
    let isSkillAutocompleteVisible: Bool
    let isSkillAutocompleteLoading: Bool
    let skillAutocompleteQuery: String
    let slashCommandPanelState: TurnComposerSlashCommandPanelState
    let composerReviewSelection: TurnComposerReviewSelection?
    let isSubagentsSelectionArmed: Bool
    let hasComposerContentConflictingWithReview: Bool

    let orderedModelOptions: [ModelOption]
    let selectedModelID: String?
    let selectedModelTitle: String
    let isLoadingModels: Bool

    let reasoningDisplayOptions: [TurnComposerReasoningDisplayOption]
    let selectedReasoningEffort: String?
    let selectedReasoningTitle: String
    let reasoningMenuDisabled: Bool

    let selectedAccessMode: AccessMode
    let isConnected: Bool
    let isReconnectAvailable: Bool
    let isReconnectInFlight: Bool
    let connectionStatusMessage: String

    let showsGitBranchSelector: Bool
    let isGitBranchSelectorEnabled: Bool
    let availableGitBranchTargets: [String]
    let gitBranchesCheckedOutElsewhere: Set<String>
    let gitWorktreePathsByBranch: [String: String]
    let selectedGitBaseBranch: String
    let currentGitBranch: String
    let gitDefaultBranch: String
    let isLoadingGitBranchTargets: Bool
    let isSwitchingGitBranch: Bool
    let onSelectGitBranch: (String) -> Void
    let onCreateGitBranch: (String) -> Void
    let onSelectGitBaseBranch: (String) -> Void
    let onRefreshGitBranches: () -> Void
    let onReconnect: () -> Void

    let onSelectModel: (String) -> Void
    let onSelectReasoning: (String) -> Void
    let onSelectAccessMode: (AccessMode) -> Void
    let onTapAddImage: () -> Void
    let onTapTakePhoto: () -> Void
    let onSetPlanModeArmed: (Bool) -> Void
    let onRemoveAttachment: (String) -> Void
    let onStopTurn: (String?) -> Void
    let onInputChangedForFileAutocomplete: (String) -> Void
    let onInputChangedForSkillAutocomplete: (String) -> Void
    let onInputChangedForSlashCommandAutocomplete: (String) -> Void
    let onSelectFileAutocomplete: (FuzzyFileMatch) -> Void
    let onSelectSkillAutocomplete: (SkillMetadata) -> Void
    let onSelectSlashCommand: (TurnComposerSlashCommand) -> Void
    let onSelectCodeReviewTarget: (TurnComposerReviewTarget) -> Void
    let onRemoveMentionedFile: (String) -> Void
    let onRemoveMentionedSkill: (String) -> Void
    let onRemoveComposerReviewSelection: () -> Void
    let onRemoveComposerSubagentsSelection: () -> Void
    let onPasteImageData: ([Data]) -> Void
    let onResumeQueue: () -> Void
    let onSteerQueuedDraft: (String) -> Void
    let onRemoveQueuedDraft: (String) -> Void
    let onSend: () -> Void

    @State private var composerInputHeight: CGFloat = 32

    // ─── ENTRY POINT ─────────────────────────────────────────────
    var body: some View {
        VStack(spacing: 6) {
            if !isConnected {
                offlineComposerBanner
            }

            if isFileAutocompleteVisible {
                FileAutocompletePanel(
                    items: fileAutocompleteItems,
                    isLoading: isFileAutocompleteLoading,
                    query: fileAutocompleteQuery,
                    onSelect: onSelectFileAutocomplete
                )
            }

            if isSkillAutocompleteVisible {
                SkillAutocompletePanel(
                    items: skillAutocompleteItems,
                    isLoading: isSkillAutocompleteLoading,
                    query: skillAutocompleteQuery,
                    onSelect: onSelectSkillAutocomplete
                )
            }

            if slashCommandPanelState != .hidden {
                SlashCommandAutocompletePanel(
                    state: slashCommandPanelState,
                    hasComposerContentConflictingWithReview: hasComposerContentConflictingWithReview,
                    showsGitBranchSelector: showsGitBranchSelector,
                    isLoadingGitBranchTargets: isLoadingGitBranchTargets,
                    selectedGitBaseBranch: selectedGitBaseBranch,
                    gitDefaultBranch: gitDefaultBranch,
                    onSelectCommand: onSelectSlashCommand,
                    onSelectReviewTarget: onSelectCodeReviewTarget,
                    onClose: onRemoveComposerReviewSelection
                )
            }

            if !queuedDrafts.isEmpty {
                QueuedDraftsPanel(
                    drafts: queuedDrafts,
                    canSteerDrafts: canSteerQueuedDrafts,
                    steeringDraftID: steeringDraftID,
                    onSteer: onSteerQueuedDraft,
                    onRemove: onRemoveQueuedDraft
                )
                    .frame(maxWidth: .infinity, alignment: .leading)

                    .padding([.horizontal, .bottom], 4)
                    .adaptiveGlass(.regular, in: UnevenRoundedRectangle(
                        topLeadingRadius: 28,
                        bottomLeadingRadius: 0,
                        bottomTrailingRadius: 0,
                        topTrailingRadius: 28,
                        style: .continuous
                    ))
                    .padding(.bottom, -10)
                    .padding(.horizontal, 16)
            }

            VStack(spacing: 0) {
                if !composerAttachments.isEmpty {
                    ComposerAttachmentsPreview(
                        attachments: composerAttachments,
                        onRemove: onRemoveAttachment
                    )
                    .padding(.horizontal, 16)
                    .padding(.top, 4)
                    .padding(.bottom, 8)
                }

                if !composerMentionedFiles.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(composerMentionedFiles) { file in
                                FileMentionChip(fileName: file.fileName) {
                                    onRemoveMentionedFile(file.id)
                                }
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.top, 10)
                }

                if !composerMentionedSkills.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(composerMentionedSkills) { skill in
                                SkillMentionChip(skillName: skill.name) {
                                    onRemoveMentionedSkill(skill.id)
                                }
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.top, 8)
                }

                if let reviewSelection = composerReviewSelection {
                    TurnComposerReviewSelectionChip(
                        selection: reviewSelection,
                        selectedGitBaseBranch: selectedGitBaseBranch,
                        gitDefaultBranch: gitDefaultBranch,
                        onRemove: onRemoveComposerReviewSelection
                    )
                    .padding(.horizontal, 16)
                    .padding(.top, 8)
                }

                if isSubagentsSelectionArmed {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ComposerActionChip(
                                title: "Subagents",
                                symbolName: "person.3",
                                tintColor: .teal,
                                removeAccessibilityLabel: "Remove subagents"
                            ) {
                                onRemoveComposerSubagentsSelection()
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.top, 8)
                }

                ZStack(alignment: .topLeading) {
                    if input.isEmpty {
                        Text("Ask for follow-up changes, or type / for Codex commands")
                            .font(AppFont.body())
                            .foregroundStyle(Color(.placeholderText))
                            .allowsHitTesting(false)
                    }

                    TurnComposerInputTextView(
                        text: $input,
                        isFocused: isInputFocused,
                        isEditable: !isComposerInteractionLocked,
                        dynamicHeight: $composerInputHeight,
                        onPasteImageData: { imageDataItems in
                            HapticFeedback.shared.triggerImpactFeedback(style: .light)
                            onPasteImageData(imageDataItems)
                        }
                    )
                    .frame(height: composerInputHeight)
                }
                .padding(.horizontal, 16)
                .padding(
                    .top,
                    composerAttachments.isEmpty
                        && composerMentionedFiles.isEmpty
                        && composerMentionedSkills.isEmpty
                        && composerReviewSelection == nil
                        && !isSubagentsSelectionArmed
                        ? 14 : 8
                )
                .padding(.bottom, 12)
                .onChange(of: input) { _, newValue in
                    onInputChangedForFileAutocomplete(newValue)
                    onInputChangedForSkillAutocomplete(newValue)
                    onInputChangedForSlashCommandAutocomplete(newValue)
                }

                ComposerBottomBar(
                    orderedModelOptions: orderedModelOptions,
                    selectedModelID: selectedModelID,
                    selectedModelTitle: selectedModelTitle,
                    isLoadingModels: isLoadingModels,
                    reasoningDisplayOptions: reasoningDisplayOptions,
                    selectedReasoningEffort: selectedReasoningEffort,
                    selectedReasoningTitle: selectedReasoningTitle,
                    reasoningMenuDisabled: reasoningMenuDisabled,
                    remainingAttachmentSlots: remainingAttachmentSlots,
                    isComposerInteractionLocked: isComposerInteractionLocked,
                    isSendDisabled: isSendDisabled,
                    isPlanModeArmed: isPlanModeArmed,
                    supportsPlanMode: supportsPlanMode,
                    queuedCount: queuedCount,
                    isQueuePaused: isQueuePaused,
                    activeTurnID: activeTurnID,
                    isThreadRunning: isThreadRunning,
                    onSelectModel: onSelectModel,
                    onSelectReasoning: onSelectReasoning,
                    onTapAddImage: onTapAddImage,
                    onTapTakePhoto: onTapTakePhoto,
                    onSetPlanModeArmed: onSetPlanModeArmed,
                    onResumeQueue: onResumeQueue,
                    onStopTurn: onStopTurn,
                    onSend: onSend
                )
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .adaptiveGlass(.regular, in: RoundedRectangle(cornerRadius: 28))

            if !isInputFocused.wrappedValue {
                // The secondary control row is nice to have, but when the keyboard is up
                // it can become the first thing that gets clipped on shorter devices.
                HStack(spacing: 0) {
                    HStack(spacing: 14) {
                        runtimePicker
                        accessMenuLabel
                    }

                    Spacer(minLength: 0)

                    if showsGitBranchSelector {
                        TurnGitBranchSelector(
                            isEnabled: isGitBranchSelectorEnabled,
                            availableGitBranchTargets: availableGitBranchTargets,
                            gitBranchesCheckedOutElsewhere: gitBranchesCheckedOutElsewhere,
                            gitWorktreePathsByBranch: gitWorktreePathsByBranch,
                            selectedGitBaseBranch: selectedGitBaseBranch,
                            currentGitBranch: currentGitBranch,
                            defaultBranch: gitDefaultBranch,
                            isLoadingGitBranchTargets: isLoadingGitBranchTargets,
                            isSwitchingGitBranch: isSwitchingGitBranch,
                            onSelectGitBranch: onSelectGitBranch,
                            onCreateGitBranch: onCreateGitBranch,
                            onSelectGitBaseBranch: onSelectGitBaseBranch,
                            onRefreshGitBranches: onRefreshGitBranches
                        )
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .adaptiveGlass(.regular, in: Capsule())
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 6)
        .animation(.easeInOut(duration: 0.18), value: isInputFocused.wrappedValue)
    }

    private var offlineComposerBanner: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Disconnected")
                    .font(AppFont.subheadline(weight: .semibold))
                    .foregroundStyle(.primary)

                Text(connectionStatusMessage)
                    .font(AppFont.caption())
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 8)

            if isReconnectAvailable {
                Button {
                    HapticFeedback.shared.triggerImpactFeedback(style: .light)
                    onReconnect()
                } label: {
                    Text(isReconnectInFlight ? "Reconnecting..." : "Reconnect")
                        .font(AppFont.caption(weight: .semibold))
                        .foregroundStyle(.primary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(Color(.secondarySystemFill), in: Capsule())
                }
                .buttonStyle(.plain)
                .disabled(isReconnectInFlight)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .adaptiveGlass(.regular, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }

    // MARK: - Below-card controls

    private var accessMenuLabel: some View {
        Menu {
            ForEach(AccessMode.allCases, id: \.rawValue) { mode in
                Button {
                    HapticFeedback.shared.triggerImpactFeedback(style: .light)
                    onSelectAccessMode(mode)
                } label: {
                    if selectedAccessMode == mode {
                        Label(mode.displayName, systemImage: "checkmark")
                    } else {
                        Text(mode.displayName)
                    }
                }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: selectedAccessMode == .fullAccess
                      ? "exclamationmark.shield"
                      : "checkmark.shield")
                    .font(branchTextFont)

                Text(selectedAccessMode.displayName)
                    .font(branchTextFont)
                    .fontWeight(.regular)
                    .lineLimit(1)

                Image(systemName: "chevron.down")
                    .font(branchChevronFont)
            }
            .foregroundStyle(selectedAccessMode == .fullAccess ? .orange : branchLabelColor)
            .contentShape(Rectangle())
        }
        .tint(branchLabelColor)
    }

    // MARK: - Runtime controls

    private var runtimePicker: some View {
        Menu {
            Button {
                // Already on Local — no-op.
            } label: {
                Label("Local", systemImage: "checkmark")
            }

            Button {
                HapticFeedback.shared.triggerImpactFeedback(style: .light)
                if let url = URL(string: "https://chatgpt.com/codex") {
                    UIApplication.shared.open(url)
                }
            } label: {
                Text("Cloud")
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "laptopcomputer")
                    .font(branchTextFont)

                Text("Local")
                    .font(branchTextFont)
                    .fontWeight(.regular)
                    .lineLimit(1)

                Image(systemName: "chevron.down")
                    .font(branchChevronFont)
            }
            .foregroundStyle(branchLabelColor)
            .contentShape(Rectangle())
        }
        .tint(branchLabelColor)
    }

    private let branchLabelColor = Color(.secondaryLabel)
    private var branchTextFont: Font { AppFont.subheadline() }
    private var branchChevronFont: Font { AppFont.system(size: 9, weight: .regular) }
}

private struct TurnComposerReviewSelectionChip: View {
    let selection: TurnComposerReviewSelection
    let selectedGitBaseBranch: String
    let gitDefaultBranch: String
    let onRemove: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "ladybug")
                .font(AppFont.system(size: 12, weight: .semibold))
                .foregroundStyle(Color(.systemOrange))

            VStack(alignment: .leading, spacing: 2) {
                Text("Code Review")
                    .font(AppFont.caption(weight: .semibold))
                Text(subtitle)
                    .font(AppFont.caption2())
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 8)

            Button(action: onRemove) {
                Image(systemName: "xmark")
                    .font(AppFont.system(size: 10, weight: .bold))
                    .foregroundStyle(.secondary)
                    .frame(width: 22, height: 22)
                    .background(Color(.secondarySystemFill), in: Circle())
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(Color(.secondarySystemFill), in: Capsule())
    }

    private var subtitle: String {
        switch selection.target {
        case .uncommittedChanges:
            return "Review current local changes"
        case .baseBranch:
            let selectedBranch = selectedGitBaseBranch.trimmingCharacters(in: .whitespacesAndNewlines)
            let defaultBranch = gitDefaultBranch.trimmingCharacters(in: .whitespacesAndNewlines)
            let branch = !selectedBranch.isEmpty ? selectedBranch : (!defaultBranch.isEmpty ? defaultBranch : "base branch")
            return "Review against \(branch)"
        case .none:
            return "Choose what the reviewer should compare"
        }
    }
}

private struct ComposerActionChip: View {
    let title: String
    let symbolName: String
    let tintColor: Color
    let removeAccessibilityLabel: String
    let onRemove: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: symbolName)
                .font(AppFont.system(size: 10, weight: .semibold))
                .foregroundStyle(tintColor)

            Text(title)
                .font(AppFont.footnote(weight: .medium))
                .foregroundStyle(tintColor)
                .lineLimit(1)

            Button(action: onRemove) {
                Image(systemName: "xmark")
                    .font(AppFont.system(size: 8, weight: .bold))
                    .foregroundStyle(tintColor)
                    .frame(width: 14, height: 14)
                    .background(tintColor.opacity(0.14), in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(removeAccessibilityLabel)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(tintColor.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
    }
}

private struct SlashCommandAutocompletePanel: View {
    let state: TurnComposerSlashCommandPanelState
    let hasComposerContentConflictingWithReview: Bool
    let showsGitBranchSelector: Bool
    let isLoadingGitBranchTargets: Bool
    let selectedGitBaseBranch: String
    let gitDefaultBranch: String
    let onSelectCommand: (TurnComposerSlashCommand) -> Void
    let onSelectReviewTarget: (TurnComposerReviewTarget) -> Void
    let onClose: () -> Void

    private static let rowHeight: CGFloat = 50
    private static let maxVisibleRows = 6

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            switch state {
            case .hidden:
                EmptyView()
            case .commands(let query):
                commandList(query: query)
            case .codeReviewTargets:
                reviewTargetList
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(4)
        .adaptiveGlass(.regular, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
        .padding(.horizontal, 4)
    }

    @ViewBuilder
    private func commandList(query: String) -> some View {
        let items = TurnComposerSlashCommand.filtered(matching: query)

        if items.isEmpty {
            Text("No commands for /\(query)")
                .font(AppFont.footnote())
                .foregroundStyle(.secondary)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(items) { item in
                        let isEnabled = isCommandEnabled(item)
                        Button {
                            HapticFeedback.shared.triggerImpactFeedback(style: .light)
                            onSelectCommand(item)
                        } label: {
                            HStack(spacing: 10) {
                                Image(systemName: item.symbolName)
                                    .font(AppFont.system(size: 15, weight: .semibold))
                                    .foregroundStyle(isEnabled ? .primary : .secondary)
                                    .frame(width: 22)

                                VStack(alignment: .leading, spacing: 4) {
                                    Text(item.title)
                                        .font(AppFont.subheadline(weight: .semibold))
                                        .foregroundStyle(isEnabled ? .primary : .secondary)
                                        .lineLimit(1)

                                    Text(commandSubtitle(for: item))
                                        .font(AppFont.caption2())
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                }

                                Spacer(minLength: 8)

                                Text(item.commandToken)
                                    .font(AppFont.footnote())
                                    .foregroundStyle(.secondary)
                            }
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .frame(height: Self.rowHeight)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(AutocompleteRowButtonStyle())
                        .disabled(!isEnabled)
                    }
                }
            }
            .scrollIndicators(.visible)
            .frame(maxHeight: Self.rowHeight * CGFloat(min(items.count, Self.maxVisibleRows)))
        }
    }

    private var reviewTargetList: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Code Review")
                        .font(AppFont.subheadline(weight: .semibold))
                    Text("Choose what the reviewer should compare.")
                        .font(AppFont.caption())
                        .foregroundStyle(.secondary)
                }

                Spacer(minLength: 8)

                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(AppFont.system(size: 11, weight: .bold))
                        .foregroundStyle(.secondary)
                        .frame(width: 28, height: 28)
                        .background(Color(.secondarySystemFill), in: Circle())
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 12)
            .padding(.top, 10)
            .padding(.bottom, 6)

            reviewTargetButton(
                target: .uncommittedChanges,
                subtitle: "Review everything currently modified in the repo",
                isEnabled: true
            )

            if showsGitBranchSelector {
                reviewTargetButton(
                    target: .baseBranch,
                    subtitle: baseBranchSubtitle,
                    isEnabled: isBaseBranchTargetAvailable
                )
            }
        }
    }

    private func reviewTargetButton(
        target: TurnComposerReviewTarget,
        subtitle: String,
        isEnabled: Bool
    ) -> some View {
        Button {
            HapticFeedback.shared.triggerImpactFeedback(style: .light)
            onSelectReviewTarget(target)
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                Text(target.title)
                    .font(AppFont.subheadline(weight: .semibold))
                    .foregroundStyle(isEnabled ? .primary : .secondary)
                Text(subtitle)
                    .font(AppFont.caption2())
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .frame(height: Self.rowHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(AutocompleteRowButtonStyle())
        .disabled(!isEnabled)
    }

    private var resolvedBaseBranchName: String? {
        let trimmedSelected = selectedGitBaseBranch.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedSelected.isEmpty {
            return trimmedSelected
        }

        let trimmedDefault = gitDefaultBranch.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmedDefault.isEmpty ? nil : trimmedDefault
    }

    private var isBaseBranchTargetAvailable: Bool {
        resolvedBaseBranchName != nil
    }

    private var baseBranchSubtitle: String {
        if let resolvedBaseBranchName {
            return "Diff against \(resolvedBaseBranchName)"
        }
        if isLoadingGitBranchTargets {
            return "Loading base branches..."
        }
        return "Pick a base branch first"
    }

    private func isCommandEnabled(_ command: TurnComposerSlashCommand) -> Bool {
        switch command {
        case .codeReview:
            return !hasComposerContentConflictingWithReview
        case .status:
            return true
        case .subagents:
            return true
        }
    }

    private func commandSubtitle(for command: TurnComposerSlashCommand) -> String {
        guard isCommandEnabled(command) else {
            return "Clear draft text, files, skills, and images first"
        }
        return command.subtitle
    }
}

#Preview("Queued Drafts + Composer") {
    QueuedDraftsPanelPreviewWrapper()
}

private struct QueuedDraftsPanelPreviewWrapper: View {
    @State private var input = ""
    @State private var isInputFocused = false

    private let fakeDrafts: [QueuedTurnDraft] = [
        QueuedTurnDraft(id: "1", text: "Fix the login bug on the settings page", attachments: [], skillMentions: [], createdAt: .now),
        QueuedTurnDraft(id: "2", text: "Add dark mode support to the onboarding flow", attachments: [], skillMentions: [], createdAt: .now),
        QueuedTurnDraft(id: "3", text: "Refactor the networking layer to use async/await", attachments: [], skillMentions: [], createdAt: .now),
    ]

    var body: some View {
        VStack {
            Spacer()

            TurnComposerView(
                input: $input,
                isInputFocused: $isInputFocused,
                composerAttachments: [],
                remainingAttachmentSlots: 4,
                isComposerInteractionLocked: false,
                isSendDisabled: false,
                isPlanModeArmed: true,
                supportsPlanMode: true,
                queuedDrafts: fakeDrafts,
                queuedCount: 3,
                isQueuePaused: false,
                canSteerQueuedDrafts: true,
                steeringDraftID: nil,
                activeTurnID: nil,
                isThreadRunning: true,
                composerMentionedFiles: [],
                composerMentionedSkills: [],
                fileAutocompleteItems: [],
                isFileAutocompleteVisible: false,
                isFileAutocompleteLoading: false,
                fileAutocompleteQuery: "",
                skillAutocompleteItems: [],
                isSkillAutocompleteVisible: false,
                isSkillAutocompleteLoading: false,
                skillAutocompleteQuery: "",
                slashCommandPanelState: .hidden,
                composerReviewSelection: nil,
                isSubagentsSelectionArmed: false,
                hasComposerContentConflictingWithReview: false,
                orderedModelOptions: [],
                selectedModelID: nil,
                selectedModelTitle: "GPT-5.3-Codex",
                isLoadingModels: false,
                reasoningDisplayOptions: [],
                selectedReasoningEffort: nil,
                selectedReasoningTitle: "High",
                reasoningMenuDisabled: true,
                selectedAccessMode: .onRequest,
                isConnected: false,
                isReconnectAvailable: true,
                isReconnectInFlight: false,
                connectionStatusMessage: "History is available offline. Reconnect before sending new messages.",
                showsGitBranchSelector: false,
                isGitBranchSelectorEnabled: false,
                availableGitBranchTargets: [],
                gitBranchesCheckedOutElsewhere: [],
                gitWorktreePathsByBranch: [:],
                selectedGitBaseBranch: "",
                currentGitBranch: "main",
                gitDefaultBranch: "main",
                isLoadingGitBranchTargets: false,
                isSwitchingGitBranch: false,
                onSelectGitBranch: { _ in },
                onCreateGitBranch: { _ in },
                onSelectGitBaseBranch: { _ in },
                onRefreshGitBranches: {},
                onReconnect: {},
                onSelectModel: { _ in },
                onSelectReasoning: { _ in },
                onSelectAccessMode: { _ in },
                onTapAddImage: {},
                onTapTakePhoto: {},
                onSetPlanModeArmed: { _ in },
                onRemoveAttachment: { _ in },
                onStopTurn: { _ in },
                onInputChangedForFileAutocomplete: { _ in },
                onInputChangedForSkillAutocomplete: { _ in },
                onInputChangedForSlashCommandAutocomplete: { _ in },
                onSelectFileAutocomplete: { _ in },
                onSelectSkillAutocomplete: { _ in },
                onSelectSlashCommand: { _ in },
                onSelectCodeReviewTarget: { _ in },
                onRemoveMentionedFile: { _ in },
                onRemoveMentionedSkill: { _ in },
                onRemoveComposerReviewSelection: {},
                onRemoveComposerSubagentsSelection: {},
                onPasteImageData: { _ in },
                onResumeQueue: {},
                onSteerQueuedDraft: { _ in },
                onRemoveQueuedDraft: { _ in },
                onSend: {}
            )
        }
        .background(Color(.secondarySystemBackground))
    }
}
