package com.coderover.android.ui.turn

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.coderover.android.data.model.AccessMode
import com.coderover.android.data.model.AppState
import com.coderover.android.data.model.ModelOption
import com.coderover.android.ui.shared.HapticFeedback
import com.coderover.android.ui.shared.ParityToolbarItemSurface
import com.coderover.android.ui.theme.CommandAccent
import com.coderover.android.ui.theme.PlanAccent
import com.coderover.android.ui.theme.monoFamily

@Composable
internal fun ComposerPrimaryToolbar(
    state: AppState,
    turnViewModel: TurnViewModel,
    selectedModel: ModelOption?,
    orderedModels: List<ModelOption>,
    selectedModelTitle: String,
    selectedReasoningTitle: String,
    reasoningOptions: List<String>,
    reasoningMenuDisabled: Boolean,
    supportsPlanMode: Boolean,
    isRunning: Boolean,
    isSendDisabled: Boolean,
    queuedCount: Int,
    isQueuePaused: Boolean,
    canResumeQueue: Boolean,
    isResumingQueue: Boolean,
    remainingAttachmentSlots: Int,
    isLoadingModels: Boolean,
    onSelectModel: (String?) -> Unit,
    onSelectReasoning: (String?) -> Unit,
    onTapAddImage: () -> Unit,
    onTapTakePhoto: () -> Unit,
    onSetPlanModeArmed: (Boolean) -> Unit,
    onResumeQueue: () -> Unit,
    onStop: (String?) -> Unit,
    onSend: () -> Unit,
    activeTurnId: String? = null,
) {
    val haptic = HapticFeedback.rememberHapticFeedback()
    val orderedReasoningOptions = remember(reasoningOptions) {
        orderedReasoningOptions(reasoningOptions)
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp)
            .padding(top = 10.dp, bottom = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Attachment menu
        Box {
            ParityToolbarItemSurface(
                size = 30.dp,
                enabled = !isRunning,
                onClick = {
                    haptic.triggerImpactFeedback()
                    turnViewModel.plusMenuExpanded = true
                },
            ) {
                Icon(
                    Icons.Outlined.Add,
                    contentDescription = "Attachment and plan options",
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(18.dp),
                )
            }
            DropdownMenu(
                expanded = turnViewModel.plusMenuExpanded,
                onDismissRequest = { turnViewModel.plusMenuExpanded = false },
            ) {
                if (supportsPlanMode) {
                    DropdownMenuItem(
                        text = { Text("Plan mode") },
                        leadingIcon = {
                            Icon(
                                androidx.compose.ui.res.painterResource(id = android.R.drawable.ic_menu_agenda),
                                contentDescription = null
                            )
                        },
                        trailingIcon = {
                            if (turnViewModel.isPlanModeArmed) {
                                Icon(Icons.Outlined.Check, contentDescription = null)
                            }
                        },
                        onClick = {
                            haptic.triggerImpactFeedback(style = HapticFeedback.Style.LIGHT)
                            onSetPlanModeArmed(!turnViewModel.isPlanModeArmed)
                            turnViewModel.plusMenuExpanded = false
                        },
                    )
                } else {
                    DropdownMenuItem(
                        text = { Text("Plan mode unavailable") },
                        leadingIcon = {
                            Icon(
                                androidx.compose.ui.res.painterResource(id = android.R.drawable.ic_menu_agenda),
                                contentDescription = null
                            )
                        },
                        enabled = false,
                        onClick = {},
                    )
                }

                HorizontalDivider()

                DropdownMenuItem(
                    text = { Text("Photo library") },
                    enabled = remainingAttachmentSlots > 0,
                    onClick = {
                        haptic.triggerImpactFeedback()
                        onTapAddImage()
                        turnViewModel.plusMenuExpanded = false
                    },
                )
                DropdownMenuItem(
                    text = { Text("Take a photo") },
                    enabled = remainingAttachmentSlots > 0,
                    onClick = {
                        haptic.triggerImpactFeedback()
                        onTapTakePhoto()
                        turnViewModel.plusMenuExpanded = false
                    },
                )
            }
        }

        // Model menu
        Box {
            ComposerMetaButton(
                title = selectedModelTitle,
                enabled = true,
                onClick = { turnViewModel.modelMenuExpanded = true },
                leadingIcon = null,
            )
            DropdownMenu(
                expanded = turnViewModel.modelMenuExpanded,
                onDismissRequest = { turnViewModel.modelMenuExpanded = false },
            ) {
                DropdownMenuItem(
                    text = { Text("Select model") },
                    enabled = false,
                    onClick = {},
                )
                if (isLoadingModels) {
                    DropdownMenuItem(
                        text = { Text("Loading models...") },
                        enabled = false,
                        onClick = {},
                    )
                } else if (orderedModels.isEmpty()) {
                    DropdownMenuItem(
                        text = { Text("No models available") },
                        enabled = false,
                        onClick = {},
                    )
                } else {
                    orderedModels.forEach { model ->
                        DropdownMenuItem(
                            text = { Text(composerModelTitle(model)) },
                            leadingIcon = if (selectedModel?.id == model.id) {
                                { Icon(Icons.Outlined.Check, contentDescription = null) }
                            } else {
                                null
                            },
                            onClick = {
                                haptic.triggerImpactFeedback(style = HapticFeedback.Style.LIGHT)
                                onSelectModel(model.id)
                                turnViewModel.modelMenuExpanded = false
                            },
                        )
                    }
                }
            }
        }

        // Reasoning menu
        Box {
            ComposerMetaButton(
                title = selectedReasoningTitle,
                enabled = !reasoningMenuDisabled,
                onClick = { turnViewModel.reasoningMenuExpanded = true },
                leadingIcon = {
                    Icon(
                        painter = androidx.compose.ui.res.painterResource(id = android.R.drawable.ic_menu_info_details),
                        contentDescription = null,
                        modifier = Modifier.size(12.dp)
                    )
                },
            )
            DropdownMenu(
                expanded = turnViewModel.reasoningMenuExpanded,
                onDismissRequest = { turnViewModel.reasoningMenuExpanded = false },
            ) {
                DropdownMenuItem(
                    text = { Text("Select reasoning") },
                    enabled = false,
                    onClick = {},
                )
                if (orderedReasoningOptions.isEmpty()) {
                    DropdownMenuItem(
                        text = { Text("No reasoning options") },
                        enabled = false,
                        onClick = {},
                    )
                } else {
                    orderedReasoningOptions.forEach { option ->
                        DropdownMenuItem(
                            text = { Text(option.title) },
                            leadingIcon = if (state.selectedReasoningEffort == option.effort) {
                                { Icon(Icons.Outlined.Check, contentDescription = null) }
                            } else {
                                null
                            },
                            onClick = {
                                haptic.triggerImpactFeedback(style = HapticFeedback.Style.LIGHT)
                                onSelectReasoning(option.effort)
                                turnViewModel.reasoningMenuExpanded = false
                            },
                        )
                    }
                }
            }
        }

        if (turnViewModel.isPlanModeArmed && supportsPlanMode) {
            Box(
                modifier = Modifier
                    .padding(start = 4.dp, end = 4.dp)
                    .width(1.dp)
                    .height(16.dp)
                    .background(MaterialTheme.colorScheme.outlineVariant)
            )
            Row(
                horizontalArrangement = Arrangement.spacedBy(5.dp),
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(vertical = 6.dp, horizontal = 4.dp)
            ) {
                Icon(
                    androidx.compose.ui.res.painterResource(id = android.R.drawable.ic_menu_agenda),
                    contentDescription = null,
                    tint = PlanAccent,
                    modifier = Modifier.size(12.dp)
                )
                Text(
                    text = "Plan",
                    style = MaterialTheme.typography.labelMedium,
                    color = PlanAccent,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }
        }

        Spacer(modifier = Modifier.weight(1f))

        if (isQueuePaused && queuedCount > 0) {
            Surface(
                modifier = Modifier.size(32.dp),
                shape = CircleShape,
                color = Color(0xFFFF9800),
                onClick = {
                    haptic.triggerImpactFeedback(style = HapticFeedback.Style.LIGHT)
                    onResumeQueue()
                },
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(
                        Icons.Outlined.Refresh,
                        contentDescription = "Resume queued messages",
                        tint = MaterialTheme.colorScheme.surface,
                        modifier = Modifier.size(13.dp),
                    )
                }
            }
        }

        if (isRunning) {
            Surface(
                modifier = Modifier.size(32.dp),
                shape = CircleShape,
                color = MaterialTheme.colorScheme.onSurface,
                onClick = {
                    haptic.triggerImpactFeedback()
                    onStop(activeTurnId)
                },
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(
                        Icons.Filled.Stop,
                        contentDescription = "Stop",
                        tint = MaterialTheme.colorScheme.surface,
                        modifier = Modifier.size(12.dp),
                    )
                }
            }
        }

        val sendButtonIconColor = if (isSendDisabled) {
            MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f)
        } else {
            MaterialTheme.colorScheme.surface
        }
        val sendButtonBackgroundColor = if (isSendDisabled) {
            MaterialTheme.colorScheme.surfaceVariant
        } else {
            MaterialTheme.colorScheme.onSurface
        }
        Surface(
            modifier = Modifier
                .size(34.dp),
            enabled = !isSendDisabled,
            shape = CircleShape,
            color = sendButtonBackgroundColor,
            onClick = {
                haptic.triggerImpactFeedback()
                onSend()
            },
        ) {
            Box(contentAlignment = Alignment.Center) {
                Icon(
                    Icons.AutoMirrored.Outlined.Send,
                    contentDescription = "Send",
                    tint = sendButtonIconColor,
                    modifier = Modifier.size(13.dp),
                )
                if (queuedCount > 0) {
                    QueueBadge(
                        queuedCount = queuedCount,
                        isQueuePaused = isQueuePaused,
                        modifier = Modifier
                            .align(Alignment.TopEnd)
                            .offset(x = 8.dp, y = (-8).dp)
                    )
                }
            }
        }
    }
}

@Composable
private fun QueueBadge(
    queuedCount: Int,
    isQueuePaused: Boolean,
    modifier: Modifier = Modifier,
) {
    val badgeColor = if (isQueuePaused) {
        androidx.compose.ui.graphics.Color(0xFFFF9800)
    } else {
        androidx.compose.ui.graphics.Color(0xFF00BCD4)
    }
    Surface(
        modifier = modifier,
        shape = CircleShape,
        color = badgeColor,
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
            horizontalArrangement = Arrangement.spacedBy(3.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (isQueuePaused) {
                Icon(
                    painter = androidx.compose.ui.res.painterResource(id = android.R.drawable.ic_media_pause),
                    contentDescription = null,
                    tint = androidx.compose.ui.graphics.Color.White,
                    modifier = Modifier.size(8.dp)
                )
            }
            Text(
                text = queuedCount.toString(),
                style = MaterialTheme.typography.labelSmall,
                color = androidx.compose.ui.graphics.Color.White,
            )
        }
    }
}

private data class ReasoningDisplayOption(
    val effort: String,
    val title: String,
) {
    val rank: Int
        get() = when (title) {
            "Low" -> 0
            "Medium" -> 1
            "High" -> 2
            "Extra High" -> 3
            else -> 4
        }
}

private fun orderedReasoningOptions(efforts: List<String>): List<ReasoningDisplayOption> {
    return efforts
        .map { effort ->
            ReasoningDisplayOption(
                effort = effort,
                title = composerReasoningTitle(effort)
            )
        }
        .sortedWith(compareByDescending<ReasoningDisplayOption> { it.rank }.thenByDescending { it.title })
}

@Composable
internal fun ComposerSecondaryToolbar(
    state: AppState,
    turnViewModel: TurnViewModel,
    onSelectAccessMode: (AccessMode) -> Unit,
    onRefreshGitBranches: () -> Unit,
    onCheckoutGitBranch: (String) -> Unit,
    onSelectGitBaseBranch: (String) -> Unit,
    onManualRefresh: () -> Unit,
) {
    val haptic = HapticFeedback.rememberHapticFeedback()
    val uriHandler = LocalUriHandler.current
    val selectedThread = state.selectedThread
    val showsManualRefresh = (selectedThread?.provider ?: state.selectedProviderId).trim().lowercase() != "codex"
    val isManualRefreshInFlight = state.selectedThreadId
        ?.let(state.historyStateByThread::get)
        ?.isTailRefreshing == true

    AnimatedVisibility(visible = !turnViewModel.isFocused) {
        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(999.dp),
            color = MaterialTheme.colorScheme.surface.copy(alpha = 0.9f),
            border = androidx.compose.foundation.BorderStroke(
                1.dp,
                MaterialTheme.colorScheme.outline.copy(alpha = 0.14f),
            ),
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 10.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box {
                    ComposerSecondaryChip(
                        label = null,
                        value = "Local",
                        onClick = {
                            haptic.triggerImpactFeedback()
                            turnViewModel.runtimeMenuExpanded = true
                        },
                    )
                    DropdownMenu(
                        expanded = turnViewModel.runtimeMenuExpanded,
                        onDismissRequest = { turnViewModel.runtimeMenuExpanded = false },
                    ) {
                        DropdownMenuItem(
                            text = { Text("Local") },
                            leadingIcon = { Icon(Icons.Outlined.Check, contentDescription = null) },
                            onClick = { turnViewModel.runtimeMenuExpanded = false },
                        )
                        DropdownMenuItem(
                            text = { Text("Cloud") },
                            onClick = {
                                turnViewModel.runtimeMenuExpanded = false
                                uriHandler.openUri("https://chatgpt.com/codex")
                            },
                        )
                    }
                }

                Box {
                    ComposerSecondaryChip(
                        label = null,
                        value = state.accessMode.displayName,
                        onClick = {
                            haptic.triggerImpactFeedback()
                            turnViewModel.accessMenuExpanded = true
                        },
                    )
                    DropdownMenu(
                        expanded = turnViewModel.accessMenuExpanded,
                        onDismissRequest = { turnViewModel.accessMenuExpanded = false },
                    ) {
                        AccessMode.entries.forEach { mode ->
                            DropdownMenuItem(
                                text = { Text(mode.displayName) },
                                leadingIcon = if (state.accessMode == mode) {
                                    { Icon(Icons.Outlined.Check, contentDescription = null) }
                                } else {
                                    null
                                },
                                onClick = {
                                    onSelectAccessMode(mode)
                                    turnViewModel.accessMenuExpanded = false
                                },
                            )
                        }
                    }
                }

                Spacer(modifier = Modifier.weight(1f))

                if (showsManualRefresh) {
                    Surface(
                        onClick = {
                            haptic.triggerImpactFeedback()
                            onManualRefresh()
                        },
                        enabled = state.isConnected && !isManualRefreshInFlight,
                        shape = CircleShape,
                        color = MaterialTheme.colorScheme.surface.copy(alpha = 0.7f),
                    ) {
                        Box(
                            modifier = Modifier
                                .size(28.dp)
                                .padding(4.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            if (isManualRefreshInFlight) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(16.dp),
                                    strokeWidth = 2.dp,
                                    color = MaterialTheme.colorScheme.primary,
                                )
                            } else {
                                Icon(
                                    imageVector = Icons.Outlined.Refresh,
                                    contentDescription = "Refresh conversation",
                                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.size(16.dp),
                                )
                            }
                        }
                    }
                }

                BranchSelectorChip(
                    state = state,
                    turnViewModel = turnViewModel,
                    onRefreshGitBranches = onRefreshGitBranches,
                    onCheckoutGitBranch = onCheckoutGitBranch,
                    onSelectGitBaseBranch = onSelectGitBaseBranch,
                )
            }
        }
    }
}

@Composable
private fun BranchSelectorChip(
    state: AppState,
    turnViewModel: TurnViewModel,
    onRefreshGitBranches: () -> Unit,
    onCheckoutGitBranch: (String) -> Unit,
    onSelectGitBaseBranch: (String) -> Unit,
) {
    val branchTargets = state.gitBranchTargets ?: return
    val currentBranch = branchTargets.currentBranch
        .ifBlank { state.gitRepoSyncResult?.branch.orEmpty() }
        .ifBlank { return }
    val defaultBranch = branchTargets.defaultBranch?.trim()?.takeIf(String::isNotEmpty)
    val selectedBaseBranch = state.selectedGitBaseBranch
        ?.trim()
        ?.takeIf(String::isNotEmpty)
        ?: defaultBranch
        ?: currentBranch
    val branches = remember(branchTargets.branches) { branchTargets.branches.distinct() }
    val isDirty = state.gitRepoSyncResult?.isDirty == true
    val branchText = if (isDirty) "$currentBranch*" else currentBranch

    Surface(
        onClick = { turnViewModel.gitMenuExpanded = true },
        shape = RoundedCornerShape(999.dp),
        color = Color.Transparent,
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 4.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Icon(
                painter = androidx.compose.ui.res.painterResource(id = android.R.drawable.ic_menu_share),
                contentDescription = null,
                modifier = Modifier.size(12.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                text = branchText,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }

    if (turnViewModel.gitMenuExpanded) {
        BranchSelectorSheet(
            branches = branches,
            branchesCheckedOutElsewhere = branchTargets.branchesCheckedOutElsewhere,
            worktreePathByBranch = branchTargets.worktreePathByBranch,
            currentBranch = currentBranch,
            selectedBaseBranch = selectedBaseBranch,
            defaultBranch = defaultBranch,
            isEnabled = state.isConnected,
            onDismiss = { turnViewModel.gitMenuExpanded = false },
            onRefresh = onRefreshGitBranches,
            onSelectCurrentBranch = { branch ->
                turnViewModel.gitMenuExpanded = false
                onCheckoutGitBranch(branch)
            },
            onSelectBaseBranch = { branch ->
                turnViewModel.gitMenuExpanded = false
                onSelectGitBaseBranch(branch)
            },
        )
    }
}

@Composable
private fun ComposerSecondaryChip(
    label: String?,
    value: String,
    leadingIcon: (@Composable () -> Unit)? = null,
    onClick: () -> Unit,
) {
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(999.dp),
        color = Color.Transparent,
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 4.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            leadingIcon?.invoke()
            if (!label.isNullOrBlank()) {
                Text(
                    text = label,
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Text(
                text = value,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = "˅",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun BranchSelectorSheet(
    branches: List<String>,
    branchesCheckedOutElsewhere: Set<String>,
    worktreePathByBranch: Map<String, String>,
    currentBranch: String,
    selectedBaseBranch: String,
    defaultBranch: String?,
    isEnabled: Boolean,
    onDismiss: () -> Unit,
    onRefresh: () -> Unit,
    onSelectCurrentBranch: (String) -> Unit,
    onSelectBaseBranch: (String) -> Unit,
) {
    val prioritizedBranches = remember(branches, defaultBranch) {
        val unique = branches.distinct()
        buildList {
            defaultBranch?.let { default ->
                if (unique.contains(default)) {
                    add(default)
                }
            }
            unique.forEach { branch ->
                if (branch != defaultBranch) {
                    add(branch)
                }
            }
        }
    }
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        containerColor = Color.Transparent,
        dragHandle = null,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 18.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Surface(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(30.dp),
                color = MaterialTheme.colorScheme.surface.copy(alpha = 0.96f),
                tonalElevation = 8.dp,
                shadowElevation = 10.dp,
            ) {
                Column(
                    modifier = Modifier.padding(horizontal = 18.dp, vertical = 18.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    BranchSelectorSection(
                        title = "Current branch",
                        branches = prioritizedBranches,
                        branchesCheckedOutElsewhere = branchesCheckedOutElsewhere,
                        worktreePathByBranch = worktreePathByBranch,
                        selectedBranch = currentBranch,
                        defaultBranch = defaultBranch,
                        isEnabled = isEnabled,
                        disableBranch = { branch ->
                            branch == currentBranch ||
                                (branch in branchesCheckedOutElsewhere && branch !in worktreePathByBranch)
                        },
                        onSelect = onSelectCurrentBranch,
                    )
                    BranchSelectorSection(
                        title = "PR target",
                        branches = prioritizedBranches,
                        branchesCheckedOutElsewhere = branchesCheckedOutElsewhere,
                        worktreePathByBranch = worktreePathByBranch,
                        selectedBranch = selectedBaseBranch,
                        defaultBranch = defaultBranch,
                        isEnabled = isEnabled,
                        disableBranch = { branch -> branch == currentBranch },
                        onSelect = onSelectBaseBranch,
                    )
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.55f))
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable(enabled = isEnabled, onClick = onRefresh)
                            .padding(horizontal = 4.dp, vertical = 2.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Icon(
                            Icons.Outlined.Refresh,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.size(16.dp),
                        )
                        Text(
                            text = "Reload branch list",
                            style = MaterialTheme.typography.bodyMedium,
                            color = if (isEnabled) {
                                MaterialTheme.colorScheme.onSurface
                            } else {
                                MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.55f)
                            },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun BranchSelectorSection(
    title: String,
    branches: List<String>,
    branchesCheckedOutElsewhere: Set<String>,
    worktreePathByBranch: Map<String, String>,
    selectedBranch: String,
    defaultBranch: String?,
    isEnabled: Boolean,
    disableBranch: (String) -> Boolean,
    onSelect: (String) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            text = title,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Surface(
            shape = RoundedCornerShape(20.dp),
            color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.20f),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(modifier = Modifier.padding(horizontal = 2.dp, vertical = 2.dp)) {
                branches.forEachIndexed { index, branch ->
                    BranchSelectorRow(
                        title = branchLabel(branch, defaultBranch),
                        badge = when {
                            branch !in branchesCheckedOutElsewhere -> null
                            branch in worktreePathByBranch -> "Worktree"
                            else -> "Open elsewhere"
                        },
                        selected = branch == selectedBranch,
                        enabled = isEnabled && !disableBranch(branch),
                        showDivider = index < branches.lastIndex,
                        onClick = { onSelect(branch) },
                    )
                }
            }
        }
    }
}

@Composable
private fun BranchSelectorRow(
    title: String,
    badge: String?,
    selected: Boolean,
    enabled: Boolean,
    showDivider: Boolean,
    onClick: () -> Unit,
) {
    Column(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable(enabled = enabled || selected, onClick = onClick)
                .padding(horizontal = 12.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (selected) {
                Icon(
                    Icons.Outlined.Check,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.size(18.dp),
                )
            } else {
                Spacer(Modifier.size(18.dp))
            }
            Text(
                text = title,
                style = MaterialTheme.typography.bodyLarge.copy(fontFamily = monoFamily),
                color = if (enabled || selected) {
                    MaterialTheme.colorScheme.onSurface
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.55f)
                },
                modifier = Modifier.padding(end = 8.dp),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (badge != null) {
                Text(
                    text = badge,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        if (showDivider) {
            HorizontalDivider(
                modifier = Modifier.padding(start = 42.dp, end = 12.dp),
                color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.42f),
            )
        }
    }
}

private fun branchLabel(branch: String, defaultBranch: String?): String {
    return if (branch == defaultBranch) "$branch (default)" else branch
}
