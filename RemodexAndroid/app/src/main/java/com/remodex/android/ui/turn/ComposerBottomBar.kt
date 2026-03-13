package com.remodex.android.ui.turn

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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.remodex.android.data.model.AccessMode
import com.remodex.android.data.model.AppState
import com.remodex.android.data.model.ModelOption
import com.remodex.android.ui.shared.HapticFeedback
import com.remodex.android.ui.theme.CommandAccent
import com.remodex.android.ui.theme.PlanAccent
import com.remodex.android.ui.theme.monoFamily

@Composable
internal fun ComposerPrimaryToolbar(
    state: AppState,
    turnViewModel: TurnViewModel,
    selectedModel: ModelOption?,
    orderedModels: List<ModelOption>,
    selectedModelTitle: String,
    selectedReasoningTitle: String,
    reasoningOptions: List<String>,
    supportsPlanMode: Boolean,
    isRunning: Boolean,
    sendEnabled: Boolean,
    queuedCount: Int,
    isQueuePaused: Boolean,
    canResumeQueue: Boolean,
    isResumingQueue: Boolean,
    remainingAttachmentSlots: Int,
    onSelectModel: (String?) -> Unit,
    onSelectReasoning: (String?) -> Unit,
    onTapAddImage: () -> Unit,
    onTapTakePhoto: () -> Unit,
    onTapPasteImage: () -> Unit,
    onResumeQueue: () -> Unit,
    onSend: () -> Unit,
    onStop: () -> Unit,
) {
    val haptic = HapticFeedback.rememberHapticFeedback()
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(
            onClick = {
                haptic.triggerImpactFeedback()
                turnViewModel.plusMenuExpanded = true
            },
            enabled = !isRunning,
            modifier = Modifier.size(32.dp),
        ) {
            Icon(
                Icons.Outlined.Add,
                contentDescription = "Composer options",
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            DropdownMenu(
                expanded = turnViewModel.plusMenuExpanded,
                onDismissRequest = { turnViewModel.plusMenuExpanded = false },
            ) {
                DropdownMenuItem(
                    text = {
                        Text(
                            if (remainingAttachmentSlots > 0) {
                                "Add Image"
                            } else {
                                "Image Limit Reached"
                            },
                        )
                    },
                    enabled = remainingAttachmentSlots > 0,
                    onClick = {
                        onTapAddImage()
                        turnViewModel.plusMenuExpanded = false
                    },
                )
                DropdownMenuItem(
                    text = {
                        Text(
                            if (remainingAttachmentSlots > 0) {
                                "Take Photo"
                            } else {
                                "Image Limit Reached"
                            },
                        )
                    },
                    enabled = remainingAttachmentSlots > 0,
                    onClick = {
                        onTapTakePhoto()
                        turnViewModel.plusMenuExpanded = false
                    },
                )
                DropdownMenuItem(
                    text = {
                        Text(
                            if (remainingAttachmentSlots > 0) {
                                "Paste Image"
                            } else {
                                "Image Limit Reached"
                            },
                        )
                    },
                    enabled = remainingAttachmentSlots > 0,
                    onClick = {
                        onTapPasteImage()
                        turnViewModel.plusMenuExpanded = false
                    },
                )
                if (supportsPlanMode) {
                    DropdownMenuItem(
                        text = { Text(if (turnViewModel.isPlanModeArmed) "Disable Plan Mode" else "Enable Plan Mode") },
                        leadingIcon = {
                            if (turnViewModel.isPlanModeArmed) {
                                Icon(Icons.Outlined.Check, contentDescription = null)
                            }
                        },
                        onClick = {
                            turnViewModel.togglePlanMode()
                            turnViewModel.plusMenuExpanded = false
                        },
                    )
                } else {
                    DropdownMenuItem(
                        text = { Text("Plan Mode Unavailable") },
                        enabled = false,
                        onClick = {},
                    )
                }
            }
        }

        Box {
            ComposerMetaButton(
                title = selectedModelTitle,
                enabled = orderedModels.isNotEmpty() && !isRunning,
                onClick = { turnViewModel.modelMenuExpanded = true },
            )
            DropdownMenu(
                expanded = turnViewModel.modelMenuExpanded,
                onDismissRequest = { turnViewModel.modelMenuExpanded = false },
            ) {
                if (orderedModels.isEmpty()) {
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
                                onSelectModel(model.id)
                                turnViewModel.modelMenuExpanded = false
                            },
                        )
                    }
                }
            }
        }

        Box {
            ComposerMetaButton(
                title = selectedReasoningTitle,
                enabled = reasoningOptions.isNotEmpty() && !isRunning,
                onClick = { turnViewModel.reasoningMenuExpanded = true },
            )
            DropdownMenu(
                expanded = turnViewModel.reasoningMenuExpanded,
                onDismissRequest = { turnViewModel.reasoningMenuExpanded = false },
            ) {
                if (reasoningOptions.isEmpty()) {
                    DropdownMenuItem(
                        text = { Text("No reasoning options") },
                        enabled = false,
                        onClick = {},
                    )
                } else {
                    reasoningOptions.forEach { effort ->
                        DropdownMenuItem(
                            text = { Text(composerReasoningTitle(effort)) },
                            leadingIcon = if (state.selectedReasoningEffort == effort) {
                                { Icon(Icons.Outlined.Check, contentDescription = null) }
                            } else {
                                null
                            },
                            onClick = {
                                onSelectReasoning(effort)
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
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(vertical = 6.dp, horizontal = 4.dp)
            ) {
                Icon(
                    androidx.compose.ui.res.painterResource(id = android.R.drawable.ic_menu_edit),
                    contentDescription = null,
                    tint = PlanAccent,
                    modifier = Modifier.size(12.dp)
                )
                Text(
                    text = "Plan",
                    style = MaterialTheme.typography.bodySmall,
                    color = PlanAccent,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }
        }

        Spacer(Modifier.weight(1f))

        state.contextWindowUsage?.let { usage ->
            ContextWindowProgressRing(
                usage = usage,
            )
        }
        Spacer(Modifier.width(4.dp))

        if (isQueuePaused && queuedCount > 0) {
            IconButton(
                onClick = onResumeQueue,
                enabled = canResumeQueue,
                modifier = Modifier
                    .size(32.dp)
                    .background(
                        if (canResumeQueue) {
                            MaterialTheme.colorScheme.tertiary
                        } else {
                            MaterialTheme.colorScheme.surfaceVariant
                        },
                        CircleShape,
                    ),
            ) {
                Icon(
                    Icons.Outlined.Refresh,
                    contentDescription = if (isResumingQueue) "Resuming queued drafts" else "Resume queued drafts",
                    tint = if (canResumeQueue) {
                        MaterialTheme.colorScheme.onTertiary
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.55f)
                    },
                    modifier = Modifier.size(16.dp),
                )
            }
        }

        if (isRunning) {
            IconButton(
                onClick = {
                    haptic.triggerImpactFeedback(HapticFeedback.Style.MEDIUM)
                    onStop()
                },
                modifier = Modifier
                    .size(40.dp)
                    .background(MaterialTheme.colorScheme.onSurface, CircleShape),
            ) {
                Icon(
                    Icons.Outlined.Close,
                    contentDescription = "Stop",
                    tint = MaterialTheme.colorScheme.surface,
                    modifier = Modifier.size(20.dp),
                )
            }
        } else {
            IconButton(
                onClick = {
                    haptic.triggerImpactFeedback()
                    onSend()
                },
                enabled = sendEnabled,
                modifier = Modifier
                    .size(40.dp)
                    .background(
                        if (sendEnabled) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant,
                        CircleShape,
                    ),
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(
                        Icons.AutoMirrored.Outlined.Send,
                        contentDescription = "Send",
                        tint = if (sendEnabled) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f),
                        modifier = Modifier.size(20.dp),
                    )
                    if (queuedCount > 0) {
                        Surface(
                            modifier = Modifier
                                .align(Alignment.TopEnd)
                                .padding(start = 18.dp, bottom = 18.dp),
                            shape = CircleShape,
                            color = MaterialTheme.colorScheme.error,
                        ) {
                            Text(
                                text = queuedCount.toString(),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onError,
                                modifier = Modifier.padding(horizontal = 5.dp, vertical = 1.dp),
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
internal fun ComposerSecondaryToolbar(
    state: AppState,
    turnViewModel: TurnViewModel,
    onSelectAccessMode: (AccessMode) -> Unit,
    onRefreshGitBranches: () -> Unit,
    onCheckoutGitBranch: (String) -> Unit,
    onSelectGitBaseBranch: (String) -> Unit,
) {
    val haptic = HapticFeedback.rememberHapticFeedback()
    val uriHandler = LocalUriHandler.current

    AnimatedVisibility(visible = !turnViewModel.isFocused) {
        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(999.dp),
            color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box {
                    Surface(
                        onClick = {
                            haptic.triggerImpactFeedback()
                            turnViewModel.runtimeMenuExpanded = true
                        },
                        shape = RoundedCornerShape(999.dp),
                        color = MaterialTheme.colorScheme.surface.copy(alpha = 0.7f),
                    ) {
                        Row(
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            Box(
                                modifier = Modifier
                                    .size(6.dp)
                                    .background(CommandAccent, CircleShape),
                            )
                            Text(
                                text = "Local",
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurface,
                            )
                        }
                    }

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
                        label = "Access",
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
                modifier = Modifier.size(14.dp),
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

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun BranchSelectorSheet(
    branches: List<String>,
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
                        selectedBranch = currentBranch,
                        defaultBranch = defaultBranch,
                        isEnabled = isEnabled,
                        disableBranch = { branch -> branch == currentBranch },
                        onSelect = onSelectCurrentBranch,
                    )
                    BranchSelectorSection(
                        title = "PR target",
                        branches = prioritizedBranches,
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
                            Icons.Outlined.Sync,
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
            )
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
