package com.coderover.android.ui.turn

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import com.coderover.android.data.model.ChatMessage
import com.coderover.android.ui.shared.StatusTag
import com.coderover.android.ui.theme.CommandAccent
import com.coderover.android.ui.theme.Danger
import com.coderover.android.ui.theme.monoFamily

@Composable
internal fun FileChangeMessageContent(message: ChatMessage) {
    var showDiffDetails by remember(message.id) { mutableStateOf(false) }
    val entries = remember(message.id, message.text, message.fileChanges) {
        if (message.fileChanges.isNotEmpty()) {
            message.fileChanges.map { change ->
                val (additions, deletions) = resolveDiffCounts(
                    additions = change.additions,
                    deletions = change.deletions,
                    rawDiff = change.diff,
                )
                FileChangeEntryUi(
                    path = change.path,
                    actionLabel = fileChangeActionLabel(change.kind),
                    additions = additions,
                    deletions = deletions,
                )
            }
        } else {
            parseFileChangeEntries(message.text)
        }
    }
    val groupedEntries = remember(entries) { groupFileChangeEntries(entries) }
    val diffFiles = remember(message.id, message.text, message.fileChanges) {
        buildDiffDetailFiles(message)
    }
    val canOpenDiffDetails = diffFiles.isNotEmpty() && !message.isStreaming

    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (entries.isNotEmpty()) {
            groupedEntries.forEach { group ->
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(
                        text = group.actionLabel,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                    )
                    group.entries.take(6).forEach { entry ->
                        FileChangeInlineSummaryRow(
                            entry = entry,
                            enabled = canOpenDiffDetails,
                            onClick = { showDiffDetails = true },
                        )
                    }
                    if (group.entries.size > 6) {
                        Text(
                            text = "+${group.entries.size - 6} more ${group.actionLabel.lowercase()} files",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
                        )
                    }
                }
            }
        } else if (message.text.isNotBlank()) {
            Text(
                text = message.text.trim(),
                style = MaterialTheme.typography.bodyMedium.copy(fontFamily = monoFamily),
            )
        }
    }
    if (showDiffDetails) {
        DiffDetailDialog(
            title = "Repository changes",
            files = diffFiles,
            fallbackBody = remember(message.id, message.fileChanges, message.text) {
                buildDiffDetailText(message)
            },
            onDismiss = { showDiffDetails = false },
        )
    }
}

@Composable
private fun FileChangeInlineSummaryRow(
    entry: FileChangeEntryUi,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    val rowModifier = if (enabled) {
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = 1.dp)
    } else {
        Modifier
            .fillMaxWidth()
            .padding(vertical = 1.dp)
    }

    Row(
        modifier = rowModifier,
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            text = compactFileChangePath(entry.path),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.primary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                text = "+${entry.additions}",
                style = MaterialTheme.typography.labelMedium.copy(fontFamily = monoFamily),
                color = CommandAccent,
            )
            Text(
                text = "-${entry.deletions}",
                style = MaterialTheme.typography.labelMedium.copy(fontFamily = monoFamily),
                color = Danger,
            )
        }
    }
}

private fun compactFileChangePath(path: String): String {
    val normalized = path.trim().removePrefix("a/").removePrefix("b/")
    return normalized.substringAfterLast('/').ifEmpty { normalized }
}

@Composable
internal fun DiffDetailDialog(
    title: String,
    files: List<DiffFileDetailUi>,
    fallbackBody: String,
    onDismiss: () -> Unit,
) {
    var expandedFileIds by remember { mutableStateOf(emptySet<String>()) }
    val allExpanded = files.isNotEmpty() && files.all { expandedFileIds.contains(it.path) }

    Dialog(onDismissRequest = onDismiss) {
        Surface(
            shape = RoundedCornerShape(28.dp),
            color = MaterialTheme.colorScheme.surface,
            modifier = Modifier
                .fillMaxWidth()
                .fillMaxHeight(0.9f),
        ) {
            Column(modifier = Modifier.padding(horizontal = 18.dp, vertical = 18.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = title,
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.weight(1f),
                    )
                    if (files.isNotEmpty()) {
                        TextButton(onClick = {
                            expandedFileIds = if (allExpanded) emptySet() else files.map { it.path }.toSet()
                        }) {
                            Text(if (allExpanded) "Collapse All" else "Expand All")
                        }
                    }
                    TextButton(onClick = onDismiss) {
                        Text("Close")
                    }
                }
                Spacer(Modifier.size(8.dp))
                if (files.isEmpty()) {
                    SelectionContainer {
                        Text(
                            text = fallbackBody.ifBlank { "No details available." },
                            style = MaterialTheme.typography.bodyMedium.copy(fontFamily = monoFamily),
                            modifier = Modifier
                                .fillMaxWidth()
                                .horizontalScroll(rememberScrollState()),
                        )
                    }
                } else {
                    LazyColumn(
                        modifier = Modifier.fillMaxSize(),
                        verticalArrangement = Arrangement.spacedBy(14.dp),
                    ) {
                        items(files, key = { "${it.actionLabel}:${it.path}" }) { file ->
                            DiffFileDetailCard(
                                file = file,
                                isExpanded = expandedFileIds.contains(file.path),
                                onToggleExpand = {
                                    expandedFileIds = if (expandedFileIds.contains(file.path)) {
                                        expandedFileIds - file.path
                                    } else {
                                        expandedFileIds + file.path
                                    }
                                },
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun DiffFileDetailCard(
    file: DiffFileDetailUi,
    isExpanded: Boolean,
    onToggleExpand: () -> Unit,
) {
    val accent = fileChangeAccentColor(file.actionLabel)
    Surface(
        shape = RoundedCornerShape(20.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.45f),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clickable { onToggleExpand() }
                .padding(horizontal = 14.dp, vertical = 14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                StatusTag(
                    text = file.actionLabel.take(1),
                    containerColor = accent.copy(alpha = 0.12f),
                    contentColor = accent,
                )
                Text(
                    text = file.path,
                    style = MaterialTheme.typography.bodyMedium.copy(fontFamily = monoFamily),
                    modifier = Modifier.weight(1f),
                )
            }
            if (file.additions > 0 || file.deletions > 0) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = buildString {
                            if (file.additions > 0) append("+${file.additions}")
                            if (file.deletions > 0) {
                                if (isNotEmpty()) append(" ")
                                append("-${file.deletions}")
                            }
                        },
                        style = MaterialTheme.typography.labelMedium.copy(fontFamily = monoFamily),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Icon(
                        imageVector = if (isExpanded) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown,
                        contentDescription = null,
                        modifier = Modifier.size(16.dp),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            } else {
                Icon(
                    imageVector = if (isExpanded) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown,
                    contentDescription = null,
                    modifier = Modifier
                        .size(16.dp)
                        .align(Alignment.End),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (isExpanded && file.hunks.isNotEmpty()) {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    file.hunks.forEach { hunk ->
                        Surface(
                            shape = RoundedCornerShape(16.dp),
                            color = MaterialTheme.colorScheme.surface.copy(alpha = 0.92f),
                        ) {
                            SelectionContainer {
                                Column(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .horizontalScroll(rememberScrollState())
                                        .padding(horizontal = 12.dp, vertical = 10.dp),
                                    verticalArrangement = Arrangement.spacedBy(4.dp),
                                ) {
                                    hunk.header?.let { header ->
                                        Text(
                                            text = header,
                                            style = MaterialTheme.typography.labelMedium.copy(fontFamily = monoFamily),
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        )
                                    }
                                    hunk.lines.forEach { line ->
                                        Text(
                                            text = line.text,
                                            style = MaterialTheme.typography.bodySmall.copy(fontFamily = monoFamily),
                                            color = diffLineColor(line.kind),
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            } else if (isExpanded && file.rawBody.isNotBlank()) {
                SelectionContainer {
                    Text(
                        text = file.rawBody,
                        style = MaterialTheme.typography.bodySmall.copy(fontFamily = monoFamily),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}


@Composable
private fun fileChangeAccentColor(actionLabel: String): Color {
    return when (actionLabel.lowercase()) {
        "added" -> CommandAccent
        "deleted" -> Danger
        "moved" -> MaterialTheme.colorScheme.tertiary
        else -> MaterialTheme.colorScheme.primary
    }
}

@Composable
private fun diffLineColor(kind: DiffLineKind): Color {
    return when (kind) {
        DiffLineKind.ADDED -> CommandAccent
        DiffLineKind.REMOVED -> Danger
        DiffLineKind.CONTEXT -> MaterialTheme.colorScheme.onSurface
        DiffLineKind.META -> MaterialTheme.colorScheme.onSurfaceVariant
    }
}
