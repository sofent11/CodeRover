package com.coderover.android.ui.turn

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

@Composable
internal fun SlashCommandAutocompletePanel(
    state: TurnComposerSlashCommandPanelState,
    hasComposerContentConflictingWithReview: Boolean,
    showsGitBranchSelector: Boolean,
    isLoadingGitBranchTargets: Boolean,
    selectedGitBaseBranch: String,
    gitDefaultBranch: String,
    onSelectCommand: (TurnComposerSlashCommand) -> Unit,
    onSelectReviewTarget: (TurnComposerReviewTarget) -> Unit,
    onClose: () -> Unit,
) {
    when (state) {
        is TurnComposerSlashCommandPanelState.Hidden -> Unit
        is TurnComposerSlashCommandPanelState.Commands -> {
            val query = state.query.trim().lowercase()
            val commands = listOf(TurnComposerSlashCommand.CODE_REVIEW, TurnComposerSlashCommand.STATUS)
                .filter { command ->
                    val haystack = when (command) {
                        TurnComposerSlashCommand.CODE_REVIEW -> "review /review code review"
                        TurnComposerSlashCommand.STATUS -> "status /status"
                    }
                    query.isEmpty() || haystack.contains(query)
                }
            if (commands.isEmpty()) return
            LazyColumn(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 180.dp)
                    .padding(4.dp)
                    .background(
                        MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.8f),
                        RoundedCornerShape(20.dp),
                    )
                    .padding(horizontal = 4.dp),
            ) {
                items(commands) { command ->
                    val isEnabled = isCommandEnabled(command, hasComposerContentConflictingWithReview)
                    val title = when (command) {
                        TurnComposerSlashCommand.CODE_REVIEW -> "/review"
                        TurnComposerSlashCommand.STATUS -> "/status"
                    }
                    val subtitle = commandSubtitleFor(command, isEnabled, hasComposerContentConflictingWithReview)
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable(enabled = isEnabled) { onSelectCommand(command) }
                            .padding(horizontal = 12.dp, vertical = 8.dp),
                        verticalArrangement = Arrangement.spacedBy(2.dp),
                    ) {
                        Text(text = title, style = MaterialTheme.typography.bodyMedium)
                        Text(
                            text = subtitle,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }

        is TurnComposerSlashCommandPanelState.CodeReviewTargets -> {
            val resolvedBaseBranchName = resolveBaseBranchName(selectedGitBaseBranch, gitDefaultBranch)
            val isBaseBranchTargetAvailable = resolvedBaseBranchName != null
            val baseBranchSubtitle = baseBranchSubtitle(
                resolvedBaseBranchName,
                isLoadingGitBranchTargets,
            )
            LazyColumn(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 160.dp)
                    .padding(4.dp)
                    .background(
                        MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.8f),
                        RoundedCornerShape(20.dp),
                    )
                    .padding(horizontal = 4.dp),
            ) {
                item {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 12.dp, vertical = 8.dp),
                        verticalArrangement = Arrangement.spacedBy(3.dp),
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Column(modifier = Modifier.weight(1f)) {
                                Text(
                                    text = "Code Review",
                                    style = MaterialTheme.typography.titleMedium,
                                )
                                Text(
                                    text = "Choose what the reviewer should compare.",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            IconButton(onClick = onClose) {
                                Icon(
                                    imageVector = Icons.Outlined.Close,
                                    contentDescription = "Close",
                                    modifier = Modifier.size(18.dp),
                                )
                            }
                        }
                    }
                }
                item {
                    ReviewTargetButton(
                        target = TurnComposerReviewTarget.UNCOMMITTED_CHANGES,
                        subtitle = "Review everything currently modified in the repo",
                        isEnabled = true,
                        onSelectReviewTarget = onSelectReviewTarget,
                    )
                }
                if (showsGitBranchSelector) {
                    item {
                        ReviewTargetButton(
                            target = TurnComposerReviewTarget.BASE_BRANCH,
                            subtitle = baseBranchSubtitle,
                            isEnabled = isBaseBranchTargetAvailable,
                            onSelectReviewTarget = onSelectReviewTarget,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ReviewTargetButton(
    target: TurnComposerReviewTarget,
    subtitle: String,
    isEnabled: Boolean,
    onSelectReviewTarget: (TurnComposerReviewTarget) -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = isEnabled) { onSelectReviewTarget(target) }
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(
            text = target.title,
            style = MaterialTheme.typography.bodyMedium,
            color = if (isEnabled) {
                MaterialTheme.colorScheme.onSurface
            } else {
                MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f)
            },
        )
        Text(
            text = subtitle,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

private fun isCommandEnabled(
    command: TurnComposerSlashCommand,
    hasComposerContentConflictingWithReview: Boolean,
): Boolean {
    return when (command) {
        TurnComposerSlashCommand.CODE_REVIEW -> !hasComposerContentConflictingWithReview
        TurnComposerSlashCommand.STATUS -> true
    }
}

private fun commandSubtitleFor(
    command: TurnComposerSlashCommand,
    isEnabled: Boolean,
    hasComposerContentConflictingWithReview: Boolean,
): String {
    if (!isEnabled) {
        return "Clear draft text, files, skills, and images first"
    }
    return when (command) {
        TurnComposerSlashCommand.CODE_REVIEW -> "Run the reviewer on local changes"
        TurnComposerSlashCommand.STATUS -> "Show context usage and rate limits"
    }
}

private fun resolveBaseBranchName(selectedGitBaseBranch: String, gitDefaultBranch: String): String? {
    val trimmedSelected = selectedGitBaseBranch.trim()
    if (trimmedSelected.isNotEmpty()) {
        return trimmedSelected
    }
    val trimmedDefault = gitDefaultBranch.trim()
    return if (trimmedDefault.isNotEmpty()) trimmedDefault else null
}

private fun baseBranchSubtitle(
    resolvedBaseBranchName: String?,
    isLoadingGitBranchTargets: Boolean,
): String {
    if (resolvedBaseBranchName != null) {
        return "Diff against $resolvedBaseBranchName"
    }
    if (isLoadingGitBranchTargets) {
        return "Loading base branches..."
    }
    return "Pick a base branch first"
}
