package com.coderover.android.ui.turn

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.coderover.android.app.AppViewModel
import com.coderover.android.data.model.AccessMode
import com.coderover.android.data.model.AppState
import com.coderover.android.data.model.CodeRoverReviewTarget
import com.coderover.android.data.model.ImageAttachment
import com.coderover.android.data.model.TurnSkillMention
import com.coderover.android.data.model.ModelOption
import com.coderover.android.ui.shared.GlassCard
import com.coderover.android.ui.shared.ParityInputSurface
import com.coderover.android.ui.shared.StatusTag
import com.coderover.android.ui.theme.PlanAccent
import kotlinx.coroutines.launch

@Composable
internal fun TurnComposerView(
    state: AppState,
    input: String,
    onInputChanged: (String) -> Unit,
    isRunning: Boolean,
    onSend: (String, List<ImageAttachment>, List<TurnSkillMention>, Boolean) -> Unit,
    onStartReview: (String, CodeRoverReviewTarget, String?) -> Unit,
    onShowStatus: () -> Unit,
    onStop: () -> Unit,
    onReconnect: () -> Unit,
    onSelectModel: (String?) -> Unit,
    onSelectReasoning: (String?) -> Unit,
    onSelectAccessMode: (AccessMode) -> Unit,
    viewModel: AppViewModel,
    turnViewModel: TurnViewModel,
    isCodexThread: Boolean,
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
            .padding(horizontal = 12.dp)
            .padding(top = 6.dp, bottom = 6.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        AnimatedVisibility(visible = !state.isConnected) {
            ComposerDisconnectedBanner(
                state = state,
                threadId = threadIdForQueue,
                onReconnect = onReconnect,
            )
        }

        // Panels outside the main card: File, Skill, Slash Command autocomplete
        if (turnViewModel.autocompleteFiles.isNotEmpty()) {
            FileAutocompletePanel(
                files = turnViewModel.autocompleteFiles,
                onSelect = { file ->
                    onInputChanged(turnViewModel.addMentionedFile(input, file))
                },
            )
        }

        if (turnViewModel.autocompleteSkills.isNotEmpty()) {
            SkillAutocompletePanel(
                skills = turnViewModel.autocompleteSkills,
                onSelect = { skill ->
                    onInputChanged(turnViewModel.addMentionedSkill(input, skill))
                },
            )
        }

        if (isCodexThread && turnViewModel.slashCommandPanelState !is TurnComposerSlashCommandPanelState.Hidden) {
            SlashCommandAutocompletePanel(
                state = turnViewModel.slashCommandPanelState,
                hasComposerContentConflictingWithReview = turnViewModel.hasComposerContentConflictingWithReview,
                showsGitBranchSelector = state.gitBranchTargets != null,
                isLoadingGitBranchTargets = false,
                selectedGitBaseBranch = turnViewModel.reviewBaseBranchName(state).orEmpty(),
                gitDefaultBranch = state.gitBranchTargets?.defaultBranch.orEmpty(),
                onSelectCommand = { command ->
                    val updatedInput = turnViewModel.onSelectSlashCommand(input, command)
                    onInputChanged(updatedInput)
                    if (command == TurnComposerSlashCommand.STATUS) {
                        onShowStatus()
                    }
                },
                onSelectReviewTarget = { target ->
                    onInputChanged(turnViewModel.onSelectCodeReviewTarget(input, target))
                },
                onClose = turnViewModel::clearComposerReviewSelection,
            )
        }

        // Queued Drafts Panel (outside main card with special styling)
        if (queuedDrafts.isNotEmpty()) {
            QueuedDraftsPanel(
                drafts = queuedDrafts,
                canSteerDrafts = isRunning && queuePresentation.canSteerDrafts && supportsTurnSteer,
                steeringDraftId = turnViewModel.steeringDraftId,
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
                onRemoveDraft = { draftId ->
                    if (threadIdForQueue != null) {
                        viewModel.removeQueuedDraft(threadIdForQueue, draftId)
                    }
                },
            )
        }

        ParityInputSurface(
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(0.dp),
            ) {
                // Notice and Plan mode (inside the card now)
                AnimatedVisibility(
                    visible = turnViewModel.composerNoticeMessage != null ||
                        (turnViewModel.isPlanModeArmed && supportsPlanMode),
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(bottom = 8.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        turnViewModel.composerNoticeMessage?.let { notice ->
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(horizontal = 4.dp, vertical = 4.dp),
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                StatusTag(
                                    text = "Images",
                                    containerColor = MaterialTheme.colorScheme.surfaceVariant,
                                    contentColor = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                                Text(
                                    text = notice,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 2,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }

                        if (turnViewModel.isPlanModeArmed && supportsPlanMode) {
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(horizontal = 4.dp, vertical = 4.dp),
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                StatusTag(
                                    text = "Plan mode",
                                    containerColor = PlanAccent.copy(alpha = 0.14f),
                                    contentColor = PlanAccent,
                                )
                                Text(
                                    text = "Structured plan before execution.",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                    }
                }

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

                turnViewModel.composerReviewSelection?.let { reviewSelection ->
                    TurnComposerReviewSelectionChip(
                        selection = reviewSelection,
                        baseBranchName = turnViewModel.reviewBaseBranchName(state),
                        hasConflictingContent = turnViewModel.hasComposerContentConflictingWithReview
                            || input.isNotBlank(),
                        onRemove = turnViewModel::clearComposerReviewSelection,
                    )
                }

                if (turnViewModel.isSubagentsSelectionArmed) {
                    TurnComposerSubagentsSelectionChip(
                        onRemove = turnViewModel::clearSubagentsSelection,
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
                            val reviewSelection = turnViewModel.composerReviewSelection?.target
                            if (reviewSelection != null && threadIdForQueue != null) {
                                onStartReview(
                                    threadIdForQueue,
                                    reviewSelection.serviceTarget,
                                    if (reviewSelection == TurnComposerReviewTarget.BASE_BRANCH) {
                                        turnViewModel.reviewBaseBranchName(state)
                                    } else {
                                        null
                                    },
                                )
                            } else {
                                onSend(
                                    turnViewModel.composeSendText(input),
                                    turnViewModel.readyComposerAttachments,
                                    turnViewModel.readySkillMentions,
                                    turnViewModel.isPlanModeArmed && supportsPlanMode,
                                )
                            }
                            turnViewModel.clearComposerSelections()
                        }
                    },
                    sendEnabled = presentation.canSend,
                )

                val reasoningMenuDisabled = !supportsReasoningOptions || reasoningOptions.isEmpty() || selectedModel == null
                ComposerPrimaryToolbar(
                    state = state,
                    turnViewModel = turnViewModel,
                    selectedModel = selectedModel,
                    orderedModels = orderedModels,
                    selectedModelTitle = selectedModelTitle,
                    selectedReasoningTitle = selectedReasoningTitle,
                    reasoningOptions = if (supportsReasoningOptions) reasoningOptions else emptyList(),
                    reasoningMenuDisabled = reasoningMenuDisabled,
                    supportsPlanMode = supportsPlanMode,
                    isRunning = isRunning,
                    isSendDisabled = !presentation.canSend,
                    queuedCount = queuePresentation.draftCount,
                    isQueuePaused = queuePresentation.isPaused,
                    canResumeQueue = queuePresentation.canResume,
                    isResumingQueue = queuePresentation.isResuming,
                    remainingAttachmentSlots = turnViewModel.remainingAttachmentSlots,
                    isLoadingModels = false,
                    onSelectModel = onSelectModel,
                    onSelectReasoning = onSelectReasoning,
                    onTapAddImage = onTapAddImage,
                    onTapTakePhoto = onTapTakePhoto,
                    onSetPlanModeArmed = { turnViewModel.isPlanModeArmed = it },
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
                    onStop = { _ -> onStop() },
                    onSend = {
                        if (!presentation.canSend) {
                            return@ComposerPrimaryToolbar
                        }
                        turnViewModel.requestAssistantResponseAnchor()
                        val reviewSelection = turnViewModel.composerReviewSelection?.target
                        if (reviewSelection != null && threadIdForQueue != null) {
                            onStartReview(
                                threadIdForQueue,
                                reviewSelection.serviceTarget,
                                if (reviewSelection == TurnComposerReviewTarget.BASE_BRANCH) {
                                    turnViewModel.reviewBaseBranchName(state)
                                } else {
                                    null
                                },
                            )
                        } else {
                            onSend(
                                turnViewModel.composeSendText(input),
                                turnViewModel.readyComposerAttachments,
                                turnViewModel.readySkillMentions,
                                turnViewModel.isPlanModeArmed && supportsPlanMode,
                            )
                        }
                        turnViewModel.clearComposerSelections()
                    },
                    activeTurnId = null,
                )
            }
        }

        AnimatedVisibility(visible = !turnViewModel.isFocused) {
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
                        val branchTargets = state.gitBranchTargets
                        val normalizedCurrentPath = normalizedProjectPath(state.selectedThread?.normalizedProjectPath)
                        val normalizedWorktreePath = normalizedProjectPath(branchTargets?.worktreePathByBranch?.get(branch))
                        val existingWorktreeThread = normalizedWorktreePath?.let { projectPath ->
                            viewModel.findLiveThreadForProjectPath(projectPath, state.selectedThreadId)
                        }
                        val isCheckedOutElsewhereWithoutThread = branchTargets?.branchesCheckedOutElsewhere?.contains(branch) == true &&
                            normalizedWorktreePath == null

                        if (normalizedWorktreePath != null && normalizedWorktreePath != normalizedCurrentPath) {
                            if (existingWorktreeThread != null) {
                                turnViewModel.setComposerNotice("Opened the existing worktree chat for $branch.")
                                viewModel.selectThread(existingWorktreeThread.id)
                            } else {
                                turnViewModel.setComposerNotice("This branch is already checked out in another worktree.")
                            }
                        } else if (isCheckedOutElsewhereWithoutThread) {
                            turnViewModel.setComposerNotice("This branch is already open in another worktree.")
                        } else {
                            coroutineScope.launch {
                                turnViewModel.setComposerNotice(null)
                                viewModel.checkoutGitBranch(currentCwdLocal, branch)
                                viewModel.gitBranchesWithStatus(currentCwdLocal)
                            }
                        }
                    }
                },
                onSelectGitBaseBranch = { branch ->
                    state.selectedThreadId?.let { threadId ->
                        viewModel.selectGitBaseBranch(threadId, branch)
                    }
                },
                onManualRefresh = {
                    viewModel.refreshThreadsIfConnected()
                },
            )
        }
    }
}

private fun normalizedProjectPath(path: String?): String? {
    return path?.trim()?.trimEnd('/')?.takeIf(String::isNotEmpty)
}

@Composable
private fun TurnComposerReviewSelectionChip(
    selection: TurnComposerReviewSelection,
    baseBranchName: String?,
    hasConflictingContent: Boolean,
    onRemove: () -> Unit,
) {
    val title = when (selection.target) {
        TurnComposerReviewTarget.UNCOMMITTED_CHANGES -> "Review: uncommitted changes"
        TurnComposerReviewTarget.BASE_BRANCH -> "Review: base branch"
        null -> "Review"
    }
    val subtitle = when (selection.target) {
        TurnComposerReviewTarget.BASE_BRANCH -> baseBranchName?.let { "Against $it" } ?: "Choose a base branch"
        TurnComposerReviewTarget.UNCOMMITTED_CHANGES -> "Working tree diff"
        null -> "Choose a review target"
    }
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 6.dp),
        shape = RoundedCornerShape(18.dp),
        color = if (hasConflictingContent) {
            androidx.compose.ui.graphics.Color(0xFFFFF3E8)
        } else {
            androidx.compose.ui.graphics.Color(0xFFEAF4EC)
        },
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(text = title)
                Text(text = subtitle, style = androidx.compose.material3.MaterialTheme.typography.labelSmall)
            }
            Spacer(Modifier.width(8.dp))
            Surface(
                onClick = onRemove,
                color = androidx.compose.ui.graphics.Color.Transparent,
            ) {
                Icon(
                    imageVector = Icons.Outlined.Close,
                    contentDescription = "Remove review selection",
                    modifier = Modifier.size(18.dp),
                )
            }
        }
    }
}

@Composable
private fun TurnComposerSubagentsSelectionChip(
    onRemove: () -> Unit,
) {
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 6.dp),
        shape = RoundedCornerShape(18.dp),
        color = MaterialTheme.colorScheme.primary.copy(alpha = 0.08f),
        border = androidx.compose.foundation.BorderStroke(
            1.dp,
            MaterialTheme.colorScheme.primary.copy(alpha = 0.12f),
        ),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            StatusTag(
                text = "Subagents",
                containerColor = MaterialTheme.colorScheme.primary.copy(alpha = 0.12f),
                contentColor = MaterialTheme.colorScheme.primary,
            )
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Text(
                    text = "Delegation enabled",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                Text(
                    text = "The assistant can spawn or coordinate subagents for this send.",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Surface(
                shape = RoundedCornerShape(999.dp),
                color = MaterialTheme.colorScheme.surfaceVariant,
                modifier = Modifier.clickable(onClick = onRemove),
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        imageVector = Icons.Outlined.Close,
                        contentDescription = "Remove subagents selection",
                        modifier = Modifier.size(14.dp),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        text = "Remove",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}
