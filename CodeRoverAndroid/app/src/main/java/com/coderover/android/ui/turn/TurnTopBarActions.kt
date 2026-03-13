package com.coderover.android.ui.turn

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.coderover.android.data.model.ContextWindowUsage
import com.coderover.android.data.model.GitDiffTotals
import com.coderover.android.data.model.GitRepoSyncResult
import com.coderover.android.data.model.TurnGitActionKind
import com.coderover.android.ui.theme.monoFamily

@Composable
internal fun TurnTopBarActions(
    gitRepoSyncResult: GitRepoSyncResult?,
    contextWindowUsage: ContextWindowUsage?,
    enabled: Boolean,
    onShowRepoDiff: () -> Unit,
    onSelectGitAction: (TurnGitActionKind) -> Unit,
    onCompactContext: () -> Unit,
) {
    Row(verticalAlignment = Alignment.CenterVertically) {
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

        if (gitRepoSyncResult != null) {
            TurnGitActionsMenu(
                gitRepoSyncResult = gitRepoSyncResult,
                enabled = enabled,
                onSelect = onSelectGitAction,
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
        onClick = onClick,
        shape = RoundedCornerShape(999.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f),
        modifier = Modifier.padding(end = 8.dp),
    ) {
        Row(modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp)) {
            Text(
                text = "+${totals.additions}",
                color = MaterialTheme.colorScheme.primary,
                style = MaterialTheme.typography.labelMedium.copy(fontFamily = monoFamily),
            )
            Text(
                text = " -${totals.deletions}",
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.labelMedium.copy(fontFamily = monoFamily),
            )
            if (totals.binaryFiles > 0) {
                Text(
                    text = " B${totals.binaryFiles}",
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
    enabled: Boolean,
    onSelect: (TurnGitActionKind) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        Surface(
            shape = CircleShape,
            color = MaterialTheme.colorScheme.surface.copy(alpha = 0.88f),
        ) {
            IconButton(onClick = { expanded = true }) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(
                        painter = painterResource(id = android.R.drawable.ic_menu_manage),
                        contentDescription = "Git actions",
                        tint = if (enabled) {
                            MaterialTheme.colorScheme.onSurface
                        } else {
                            MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f)
                        },
                    )
                    if (gitRepoSyncResult.state in setOf("behind_only", "diverged", "dirty_and_behind")) {
                        Box(
                            modifier = Modifier
                                .align(Alignment.TopEnd)
                                .offset(x = 2.dp, y = (-2).dp)
                                .size(8.dp)
                                .background(MaterialTheme.colorScheme.tertiary, CircleShape),
                        )
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
                text = { Text(TurnGitActionKind.SYNC_NOW.title) },
                onClick = {
                    expanded = false
                    onSelect(TurnGitActionKind.SYNC_NOW)
                },
                enabled = enabled,
            )
            GitMenuHeader("Write")
            listOf(
                TurnGitActionKind.COMMIT,
                TurnGitActionKind.PUSH,
                TurnGitActionKind.COMMIT_AND_PUSH,
                TurnGitActionKind.CREATE_PR,
            ).forEach { action ->
                DropdownMenuItem(
                    text = { Text(action.title) },
                    onClick = {
                        expanded = false
                        onSelect(action)
                    },
                    enabled = enabled,
                )
            }
            if (gitRepoSyncResult.state in setOf("dirty", "dirty_and_behind", "diverged", "no_upstream")) {
                GitMenuHeader("Recovery")
                DropdownMenuItem(
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
