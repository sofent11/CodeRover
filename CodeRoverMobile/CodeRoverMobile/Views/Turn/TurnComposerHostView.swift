// FILE: TurnComposerHostView.swift
// Purpose: Adapts TurnView state and callbacks into the large TurnComposerView API, including queued-draft actions.
// Layer: View Component
// Exports: TurnComposerHostView
// Depends on: SwiftUI, TurnComposerView, TurnViewModel, CodeRoverService

import SwiftUI

struct TurnComposerHostView: View {
    @Bindable var viewModel: TurnViewModel

    let coderover: CodeRoverService
    let thread: ConversationThread
    let activeTurnID: String?
    let isThreadRunning: Bool
    let isInputFocused: Binding<Bool>
    let orderedModelOptions: [ModelOption]
    let selectedModelTitle: String
    let reasoningDisplayOptions: [TurnComposerReasoningDisplayOption]
    let selectedReasoningTitle: String
    let isConnected: Bool
    let isReconnectAvailable: Bool
    let isReconnectInFlight: Bool
    let connectionStatusMessage: String
    let showsGitControls: Bool
    let isGitBranchSelectorEnabled: Bool
    let onSelectGitBranch: (String) -> Void
    let onCreateGitBranch: (String) -> Void
    let onRefreshGitBranches: () -> Void
    let onShowStatus: () -> Void
    let onReconnect: () -> Void
    let onSend: () -> Void

    // ─── ENTRY POINT ─────────────────────────────────────────────
    var body: some View {
        let isCodexThread = coderover.runtimeProviderID(for: thread.provider) == "codex"
        let runtimeCapabilities = thread.capabilities ?? coderover.currentRuntimeProvider().supports
        let supportsPlanMode = runtimeCapabilities.planMode && coderover.supportsTurnCollaborationMode
        let supportsReasoningOptions = runtimeCapabilities.reasoningOptions
        let supportsTurnSteer = runtimeCapabilities.turnSteer

        TurnComposerView(
            input: $viewModel.input,
            isInputFocused: isInputFocused,
            composerAttachments: viewModel.composerAttachments,
            remainingAttachmentSlots: viewModel.remainingAttachmentSlots,
            isComposerInteractionLocked: viewModel.isComposerInteractionLocked(activeTurnID: activeTurnID),
            isSendDisabled: viewModel.isSendDisabled(isConnected: isConnected, activeTurnID: activeTurnID),
            isPlanModeArmed: supportsPlanMode ? viewModel.isPlanModeArmed : false,
            supportsPlanMode: supportsPlanMode,
            queuedDrafts: viewModel.queuedDraftsList(coderover: coderover, threadID: thread.id),
            queuedCount: viewModel.queuedCount(coderover: coderover, threadID: thread.id),
            isQueuePaused: viewModel.isQueuePaused(coderover: coderover, threadID: thread.id),
            canSteerQueuedDrafts: isThreadRunning && supportsTurnSteer,
            steeringDraftID: viewModel.steeringDraftID,
            activeTurnID: activeTurnID,
            isThreadRunning: isThreadRunning,
            composerMentionedFiles: viewModel.composerMentionedFiles,
            composerMentionedSkills: viewModel.composerMentionedSkills,
            fileAutocompleteItems: viewModel.fileAutocompleteItems,
            isFileAutocompleteVisible: viewModel.isFileAutocompleteVisible,
            isFileAutocompleteLoading: viewModel.isFileAutocompleteLoading,
            fileAutocompleteQuery: viewModel.fileAutocompleteQuery,
            skillAutocompleteItems: viewModel.skillAutocompleteItems,
            isSkillAutocompleteVisible: viewModel.isSkillAutocompleteVisible,
            isSkillAutocompleteLoading: viewModel.isSkillAutocompleteLoading,
            skillAutocompleteQuery: viewModel.skillAutocompleteQuery,
            slashCommandPanelState: isCodexThread ? viewModel.slashCommandPanelState : .hidden,
            composerReviewSelection: isCodexThread ? viewModel.composerReviewSelection : nil,
            isSubagentsSelectionArmed: isCodexThread ? viewModel.isSubagentsSelectionArmed : false,
            hasComposerContentConflictingWithReview: viewModel.hasComposerContentConflictingWithReview,
            orderedModelOptions: orderedModelOptions,
            selectedModelID: coderover.selectedModelOption()?.id,
            selectedModelTitle: selectedModelTitle,
            isLoadingModels: coderover.isLoadingModels,
            reasoningDisplayOptions: reasoningDisplayOptions,
            selectedReasoningEffort: coderover.selectedReasoningEffortForSelectedModel(),
            selectedReasoningTitle: selectedReasoningTitle,
            reasoningMenuDisabled: !supportsReasoningOptions || reasoningDisplayOptions.isEmpty || coderover.selectedModelOption() == nil,
            selectedAccessMode: coderover.selectedAccessMode,
            isConnected: isConnected,
            isReconnectAvailable: isReconnectAvailable,
            isReconnectInFlight: isReconnectInFlight,
            connectionStatusMessage: connectionStatusMessage,
            showsGitBranchSelector: showsGitControls,
            isGitBranchSelectorEnabled: isGitBranchSelectorEnabled,
            availableGitBranchTargets: viewModel.availableGitBranchTargets,
            gitBranchesCheckedOutElsewhere: viewModel.gitBranchesCheckedOutElsewhere,
            gitWorktreePathsByBranch: viewModel.gitWorktreePathsByBranch,
            selectedGitBaseBranch: viewModel.selectedGitBaseBranch,
            currentGitBranch: viewModel.currentGitBranch,
            gitDefaultBranch: viewModel.gitDefaultBranch,
            isLoadingGitBranchTargets: viewModel.isLoadingGitBranchTargets,
            isSwitchingGitBranch: viewModel.isSwitchingGitBranch,
            onSelectGitBranch: onSelectGitBranch,
            onCreateGitBranch: onCreateGitBranch,
            onSelectGitBaseBranch: viewModel.selectGitBaseBranch,
            onRefreshGitBranches: onRefreshGitBranches,
            onReconnect: onReconnect,
            onSelectModel: coderover.setSelectedModelId,
            onSelectReasoning: coderover.setSelectedReasoningEffort,
            onSelectAccessMode: coderover.setSelectedAccessMode,
            onTapAddImage: { viewModel.openPhotoLibraryPicker(coderover: coderover) },
            onTapTakePhoto: { viewModel.openCamera(coderover: coderover) },
            onSetPlanModeArmed: { isArmed in
                viewModel.setPlanModeArmed(supportsPlanMode ? isArmed : false)
            },
            onRemoveAttachment: viewModel.removeComposerAttachment,
            onStopTurn: { turnID in
                viewModel.interruptTurn(turnID, coderover: coderover, threadID: thread.id)
            },
            onInputChangedForFileAutocomplete: { text in
                viewModel.onInputChangedForFileAutocomplete(
                    text,
                    coderover: coderover,
                    thread: thread,
                    activeTurnID: activeTurnID
                )
            },
            onInputChangedForSkillAutocomplete: { text in
                viewModel.onInputChangedForSkillAutocomplete(
                    text,
                    coderover: coderover,
                    thread: thread,
                    activeTurnID: activeTurnID
                )
            },
            onInputChangedForSlashCommandAutocomplete: { text in
                viewModel.onInputChangedForSlashCommandAutocomplete(
                    text,
                    activeTurnID: activeTurnID,
                    isEnabled: isCodexThread
                )
            },
            onSelectFileAutocomplete: viewModel.onSelectFileAutocomplete,
            onSelectSkillAutocomplete: viewModel.onSelectSkillAutocomplete,
            onSelectSlashCommand: { command in
                viewModel.onSelectSlashCommand(command)
                if command == .status {
                    onShowStatus()
                }
            },
            onSelectCodeReviewTarget: viewModel.onSelectCodeReviewTarget,
            onRemoveMentionedFile: viewModel.removeMentionedFile,
            onRemoveMentionedSkill: viewModel.removeMentionedSkill,
            onRemoveComposerReviewSelection: viewModel.clearComposerReviewSelection,
            onRemoveComposerSubagentsSelection: viewModel.clearSubagentsSelection,
            onPasteImageData: { imageDataItems in
                viewModel.enqueuePastedImageData(imageDataItems, coderover: coderover)
            },
            onResumeQueue: {
                viewModel.resumeQueueAndFlushIfPossible(coderover: coderover, threadID: thread.id)
            },
            onSteerQueuedDraft: { draftID in
                viewModel.steerQueuedDraft(id: draftID, coderover: coderover, threadID: thread.id)
            },
            onRemoveQueuedDraft: { draftID in
                viewModel.removeQueuedDraft(id: draftID, coderover: coderover, threadID: thread.id)
            },
            onSend: onSend
        )
    }
}
