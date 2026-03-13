package com.coderover.android.ui.turn

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.coderover.android.app.AppViewModel
import com.coderover.android.data.model.AccessMode
import com.coderover.android.data.model.AppState
import com.coderover.android.data.model.ImageAttachment
import com.coderover.android.data.model.TurnSkillMention
import com.coderover.android.data.model.ModelOption
import com.coderover.android.ui.shared.GlassCard
import kotlinx.coroutines.launch

@Composable
internal fun TurnComposerView(
    state: AppState,
    input: String,
    onInputChanged: (String) -> Unit,
    isRunning: Boolean,
    onSend: (String, List<ImageAttachment>, List<TurnSkillMention>, Boolean) -> Unit,
    onStop: () -> Unit,
    onReconnect: () -> Unit,
    onSelectModel: (String?) -> Unit,
    onSelectReasoning: (String?) -> Unit,
    onSelectAccessMode: (AccessMode) -> Unit,
    viewModel: AppViewModel,
    turnViewModel: TurnViewModel,
    selectedModel: ModelOption?,
    orderedModels: List<ModelOption>,
    selectedModelTitle: String,
    selectedReasoningTitle: String,
    onTapAddImage: () -> Unit,
    onTapTakePhoto: () -> Unit,
    onTapPasteImage: () -> Unit,
) {
    val coroutineScope = rememberCoroutineScope()
    val threadIdForQueue = state.selectedThreadId
    val queuedDrafts = if (threadIdForQueue != null) state.queuedTurnDraftsByThread[threadIdForQueue].orEmpty() else emptyList()
    val queuePauseMessage = threadIdForQueue?.let { state.queuePauseMessageByThread[it] }
    val reasoningOptions = selectedModel?.supportedReasoningEfforts.orEmpty()
    val runtimeCapabilities = state.activeRuntimeCapabilities
    val supportsPlanMode = runtimeCapabilities.planMode
    val supportsReasoningOptions = runtimeCapabilities.reasoningOptions
    val supportsTurnSteer = runtimeCapabilities.turnSteer
    val queuePresentation = turnViewModel.queuePresentation(
        queuedDraftCount = queuedDrafts.size,
        queuePauseMessage = queuePauseMessage,
    )
    val presentation = turnViewModel.composerPresentation(
        input = input,
        isConnected = state.isConnected,
        queuedDraftCount = queuePresentation.draftCount,
        queuePauseMessage = queuePresentation.pauseMessage,
    )

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        AnimatedVisibility(visible = !state.isConnected) {
            ComposerDisconnectedBanner(
                state = state,
                onReconnect = onReconnect,
            )
        }

        GlassCard(
            modifier = Modifier.fillMaxWidth(),
            cornerRadius = 28.dp,
        ) {
            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(0.dp),
            ) {
                ComposerTopPanels(
                    turnViewModel = turnViewModel,
                    queuedDrafts = queuedDrafts,
                    canSteerDrafts = isRunning && queuePresentation.canSteerDrafts && supportsTurnSteer,
                    showsPlanMode = supportsPlanMode,
                    onSteerDraft = { draftId ->
                        if (threadIdForQueue != null) {
                            coroutineScope.launch {
                                turnViewModel.requestAssistantResponseAnchor()
                                turnViewModel.performDraftSteer(draftId) {
                                    viewModel.steerQueuedDraft(threadIdForQueue, draftId)
                                }
                            }
                        }
                    },
                    onFileSelected = { file ->
                        onInputChanged(turnViewModel.addMentionedFile(input, file))
                    },
                    onSkillSelected = { skill ->
                        onInputChanged(turnViewModel.addMentionedSkill(input, skill))
                    },
                    onRemoveDraft = { draftId ->
                        if (threadIdForQueue != null) {
                            viewModel.removeQueuedDraft(threadIdForQueue, draftId)
                        }
                    },
                )

                if (turnViewModel.composerAttachments.isNotEmpty()) {
                    ComposerAttachmentsPreview(
                        attachments = turnViewModel.composerAttachments,
                        onRemove = turnViewModel::removeComposerAttachment,
                    )
                }

                if (turnViewModel.composerMentionedFiles.isNotEmpty()) {
                    FileMentionChipRow(
                        files = turnViewModel.composerMentionedFiles,
                        onRemove = { mentionId ->
                            onInputChanged(turnViewModel.removeMentionedFile(input, mentionId))
                        },
                    )
                }

                if (turnViewModel.composerMentionedSkills.isNotEmpty()) {
                    SkillMentionChipRow(
                        skills = turnViewModel.composerMentionedSkills,
                        onRemove = { mentionId ->
                            onInputChanged(turnViewModel.removeMentionedSkill(input, mentionId))
                        },
                    )
                }

                TurnComposerInputTextView(
                    input = input,
                    onInputChanged = onInputChanged,
                    onFocusedChanged = { turnViewModel.isFocused = it },
                    onPasteImageData = { imageDataItems ->
                        turnViewModel.setComposerNotice(null)
                        turnViewModel.addComposerAttachments(imageDataItems)
                    },
                    onSend = {
                        if (presentation.canSend) {
                            turnViewModel.requestAssistantResponseAnchor()
                            onSend(
                                turnViewModel.composeSendText(input),
                                turnViewModel.readyComposerAttachments,
                                turnViewModel.readySkillMentions,
                                turnViewModel.isPlanModeArmed && supportsPlanMode,
                            )
                            turnViewModel.clearComposerSelections()
                        }
                    },
                    sendEnabled = presentation.canSend,
                )

                ComposerPrimaryToolbar(
                    state = state,
                    turnViewModel = turnViewModel,
                    selectedModel = selectedModel,
                    orderedModels = orderedModels,
                    selectedModelTitle = selectedModelTitle,
                    selectedReasoningTitle = selectedReasoningTitle,
                    reasoningOptions = if (supportsReasoningOptions) reasoningOptions else emptyList(),
                    supportsPlanMode = supportsPlanMode,
                    isRunning = isRunning,
                    sendEnabled = presentation.canSend,
                    queuedCount = queuePresentation.draftCount,
                    isQueuePaused = queuePresentation.isPaused,
                    canResumeQueue = queuePresentation.canResume,
                    isResumingQueue = queuePresentation.isResuming,
                    remainingAttachmentSlots = turnViewModel.remainingAttachmentSlots,
                    onSelectModel = onSelectModel,
                    onSelectReasoning = onSelectReasoning,
                    onTapAddImage = onTapAddImage,
                    onTapTakePhoto = onTapTakePhoto,
                    onTapPasteImage = onTapPasteImage,
                    onResumeQueue = {
                        if (threadIdForQueue != null) {
                            coroutineScope.launch {
                                turnViewModel.requestAssistantResponseAnchor()
                                turnViewModel.performQueueResume {
                                    viewModel.resumeQueuedDrafts(threadIdForQueue)
                                }
                            }
                        }
                    },
                    onSend = {
                        turnViewModel.requestAssistantResponseAnchor()
                        onSend(
                            turnViewModel.composeSendText(input),
                            turnViewModel.readyComposerAttachments,
                            turnViewModel.readySkillMentions,
                            turnViewModel.isPlanModeArmed && supportsPlanMode,
                        )
                        turnViewModel.clearComposerSelections()
                    },
                    onStop = onStop,
                )
            }
        }

        TurnToolbarContent(
            state = state,
            turnViewModel = turnViewModel,
            onSelectAccessMode = onSelectAccessMode,
            onRefreshGitBranches = {
                val currentCwdLocal = state.selectedThread?.cwd
                if (currentCwdLocal != null) {
                    coroutineScope.launch {
                        viewModel.gitBranchesWithStatus(currentCwdLocal)
                    }
                }
            },
            onCheckoutGitBranch = { branch ->
                val currentCwdLocal = state.selectedThread?.cwd
                if (currentCwdLocal != null) {
                    coroutineScope.launch {
                        viewModel.checkoutGitBranch(currentCwdLocal, branch)
                        viewModel.gitBranchesWithStatus(currentCwdLocal)
                    }
                }
            },
            onSelectGitBaseBranch = { branch ->
                state.selectedThreadId?.let { threadId ->
                    viewModel.selectGitBaseBranch(threadId, branch)
                }
            },
        )
    }
}
