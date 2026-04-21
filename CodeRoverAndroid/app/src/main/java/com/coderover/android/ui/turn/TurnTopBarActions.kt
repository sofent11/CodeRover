package com.coderover.android.ui.turn

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import com.coderover.android.R
import com.coderover.android.data.model.ContextWindowUsage
import com.coderover.android.data.model.GitDiffTotals
import com.coderover.android.data.model.GitRepoSyncResult
import com.coderover.android.data.model.ThreadSummary
import com.coderover.android.data.model.TurnGitActionKind
import com.coderover.android.ui.shared.ParityToolbarItemSurface
import com.coderover.android.ui.theme.monoFamily

internal enum class TurnThreadProjectAction {
    HANDOFF,
    FORK_TO_LOCAL,
    FORK_TO_WORKTREE,
}

@Composable
internal fun TurnTopBarActions(
    showsDesktopRestart: Boolean,
    isRestartingDesktopApp: Boolean,
    gitRepoSyncResult: GitRepoSyncResult?,
    gitSyncState: String?,
    currentThread: ThreadSummary?,
    canForkToLocal: Boolean,
    isRunningThreadProjectAction: Boolean,
    isRunningGitAction: Boolean,
    showsDiscardRuntimeChangesAndSync: Boolean,
    contextWindowUsage: ContextWindowUsage?,
    enabled: Boolean,
    onTapDesktopRestart: () -> Unit,
    onShowRepoDiff: () -> Unit,
    onSelectThreadProjectAction: (TurnThreadProjectAction) -> Unit,
    onSelectGitAction: (TurnGitActionKind) -> Unit,
    onCompactContext: () -> Unit,
) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        if (showsDesktopRestart) {
            ParityToolbarItemSurface(
                modifier = Modifier.padding(end = 10.dp),
                enabled = !isRestartingDesktopApp,
                onClick = onTapDesktopRestart,
            ) {
                if (isRestartingDesktopApp) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(20.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.primary,
                    )
                } else {
                    Icon(
                        imageVector = Icons.Outlined.Refresh,
                        contentDescription = "Restart Codex desktop app",
                        tint = MaterialTheme.colorScheme.onSurface,
                        modifier = Modifier.size(22.dp),
                    )
                }
            }
        }

        contextWindowUsage?.let { usage ->
            ContextWindowProgressRing(
                usage = usage,
                onCompact = onCompactContext,
            )
            Spacer(Modifier.width(12.dp))
        }

        gitRepoSyncResult?.repoDiffTotals?.let { totals ->
            TurnToolbarDiffPill(
                totals = totals,
                onClick = onShowRepoDiff,
            )
        }

        if (currentThread?.cwd != null) {
            TurnThreadProjectActionsMenu(
                isManagedWorktreeProject = currentThread.isManagedWorktreeProject,
                canForkToLocal = canForkToLocal,
                isRunningAction = isRunningThreadProjectAction,
                enabled = enabled && !isRunningThreadProjectAction,
                onSelect = onSelectThreadProjectAction,
            )
        }

        if (gitRepoSyncResult != null) {
            TurnGitActionsMenu(
                gitRepoSyncResult = gitRepoSyncResult,
                gitSyncState = gitSyncState,
                isRunningGitAction = isRunningGitAction,
                showsDiscardRuntimeChangesAndSync = showsDiscardRuntimeChangesAndSync,
                enabled = enabled,
                onSelect = onSelectGitAction,
            )
        }
    }
}

@Composable
private fun TurnThreadProjectActionsMenu(
    isManagedWorktreeProject: Boolean,
    canForkToLocal: Boolean,
    isRunningAction: Boolean,
    enabled: Boolean,
    onSelect: (TurnThreadProjectAction) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    Box(modifier = Modifier.padding(end = 10.dp)) {
        ParityToolbarItemSurface(
            enabled = enabled,
            onClick = { expanded = true },
        ) {
            if (isRunningAction) {
                CircularProgressIndicator(
                    modifier = Modifier.size(20.dp),
                    strokeWidth = 2.dp,
                    color = MaterialTheme.colorScheme.primary,
                )
            } else {
                Icon(
                    imageVector = Icons.Outlined.MoreVert,
                    contentDescription = "Project actions",
                    tint = if (enabled) {
                        MaterialTheme.colorScheme.onSurface
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f)
                    },
                    modifier = Modifier.size(22.dp),
                )
            }
        }

        DropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false },
        ) {
            GitMenuHeader("Project")
            DropdownMenuItem(
                text = { Text(if (isManagedWorktreeProject) "Hand Off to Local" else "Hand Off to Worktree") },
                onClick = {
                    expanded = false
                    onSelect(TurnThreadProjectAction.HANDOFF)
                },
                enabled = enabled,
            )
            GitMenuHeader("Fork")
            DropdownMenuItem(
                text = { Text("Fork to Local") },
                onClick = {
                    expanded = false
                    onSelect(TurnThreadProjectAction.FORK_TO_LOCAL)
                },
                enabled = enabled && canForkToLocal,
            )
            DropdownMenuItem(
                text = { Text("Fork to Worktree") },
                onClick = {
                    expanded = false
                    onSelect(TurnThreadProjectAction.FORK_TO_WORKTREE)
                },
                enabled = enabled,
            )
        }
    }
}

@Composable
private fun TurnToolbarDiffPill(
    totals: GitDiffTotals,
    onClick: () -> Unit,
) {
    Surface(
        modifier = Modifier
            .padding(end = 10.dp)
            .clip(RoundedCornerShape(999.dp))
            .clickable(onClick = onClick),
        shape = RoundedCornerShape(999.dp),
        color = MaterialTheme.colorScheme.surface.copy(alpha = 0.88f),
        border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.22f)),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
        ) {
            Text(
                text = "+${totals.additions}",
                color = Color(0xFF34C759),
                style = MaterialTheme.typography.labelMedium.copy(fontFamily = monoFamily),
            )
            Text(
                text = "-${totals.deletions}",
                color = Color(0xFFFF3B30),
                style = MaterialTheme.typography.labelMedium.copy(fontFamily = monoFamily),
            )
            if (totals.binaryFiles > 0) {
                Text(
                    text = "B${totals.binaryFiles}",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.labelMedium.copy(fontFamily = monoFamily),
                )
            }
        }
    }
}

@Composable
private fun TurnGitActionsMenu(
    gitRepoSyncResult: GitRepoSyncResult,
    gitSyncState: String?,
    isRunningGitAction: Boolean,
    showsDiscardRuntimeChangesAndSync: Boolean,
    enabled: Boolean,
    onSelect: (TurnGitActionKind) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        ParityToolbarItemSurface(
            enabled = enabled,
            onClick = { expanded = true },
        ) {
            Box(contentAlignment = Alignment.Center) {
                if (isRunningGitAction) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(20.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.primary,
                    )
                } else {
                    Box {
                        Icon(
                            painter = painterResource(id = R.drawable.git_commit),
                            contentDescription = "Git actions",
                            tint = if (enabled) {
                                MaterialTheme.colorScheme.onSurface
                            } else {
                                MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f)
                            },
                            modifier = Modifier.size(20.dp),
                        )
                        val syncStatusColor = when (gitSyncState) {
                            "behind_only", "diverged", "dirty_and_behind" -> Color(0xFFFF9800)
                            else -> null
                        }
                        if (syncStatusColor != null) {
                            Box(
                                modifier = Modifier
                                    .align(Alignment.TopEnd)
                                    .offset(x = 2.dp, y = (-2).dp)
                                    .size(8.dp)
                                    .background(syncStatusColor, CircleShape)
                            ) {
                                Box(
                                    modifier = Modifier
                                        .fillMaxSize()
                                        .padding(1.5.dp)
                                        .background(MaterialTheme.colorScheme.surface, CircleShape)
                                )
                            }
                        }
                    }
                }
            }
        }

        DropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false },
        ) {
            GitMenuHeader("Update")
            DropdownMenuItem(
                leadingIcon = {
                    Icon(
                        painter = painterResource(id = R.drawable.git_arrow_sync),
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onSurface,
                        modifier = Modifier.size(20.dp),
                    )
                },
                text = { Text(TurnGitActionKind.SYNC_NOW.title) },
                onClick = {
                    expanded = false
                    onSelect(TurnGitActionKind.SYNC_NOW)
                },
                enabled = enabled,
            )
            GitMenuHeader("Write")
            listOf(
                TurnGitActionKind.COMMIT to R.drawable.git_commit,
                TurnGitActionKind.PUSH to R.drawable.git_arrow_up_circle,
                TurnGitActionKind.COMMIT_AND_PUSH to R.drawable.git_cloud_upload,
                TurnGitActionKind.CREATE_PR to R.drawable.git_github,
            ).forEach { (action, iconRes) ->
                DropdownMenuItem(
                    leadingIcon = {
                        Icon(
                            painter = painterResource(id = iconRes),
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.onSurface,
                            modifier = Modifier.size(20.dp),
                        )
                    },
                    text = { Text(action.title) },
                    onClick = {
                        expanded = false
                        onSelect(action)
                    },
                    enabled = enabled,
                )
            }
            if (showsDiscardRuntimeChangesAndSync) {
                GitMenuHeader("Recovery")
                DropdownMenuItem(
                    leadingIcon = {
                        Icon(
                            painter = painterResource(id = R.drawable.git_trash_circle),
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.onSurface,
                            modifier = Modifier.size(20.dp),
                        )
                    },
                    text = { Text(TurnGitActionKind.DISCARD_LOCAL_CHANGES.title) },
                    onClick = {
                        expanded = false
                        onSelect(TurnGitActionKind.DISCARD_LOCAL_CHANGES)
                    },
                    enabled = enabled,
                )
            }
        }
    }
}

@Composable
private fun GitMenuHeader(title: String) {
    Text(
        text = title,
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
    )
}
