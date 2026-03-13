package com.coderover.android.ui.turn

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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
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
import com.coderover.android.data.model.CommandPhase
import com.coderover.android.ui.shared.StatusTag
import com.coderover.android.ui.theme.CommandAccent
import com.coderover.android.ui.theme.Danger
import com.coderover.android.ui.theme.monoFamily

@Composable
internal fun CommandExecutionMessageContent(message: ChatMessage) {
    var showOutputDetails by remember(message.id) { mutableStateOf(false) }
    val preview = remember(message.id, message.text, message.isStreaming, message.commandState) {
        message.commandState?.let { state ->
            CommandPreviewUi(
                command = state.fullCommand,
                outputLines = buildList {
                    state.cwd?.let { add("cwd: $it") }
                    state.exitCode?.let { add("exit code: $it") }
                    state.durationMs?.let { add("${it}ms") }
                    state.outputTail
                        .lines()
                        .filter(String::isNotBlank)
                        .takeLast(3)
                        .forEach(::add)
                },
                statusLabel = state.phase.statusLabel,
            )
        } ?: parseCommandPreview(message.text, message.isStreaming)
    }
    val accent = commandStatusAccentColor(preview.statusLabel)
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        preview.command?.let { command ->
            Surface(
                shape = RoundedCornerShape(14.dp),
                color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.7f),
            ) {
                Text(
                    text = command,
                    style = MaterialTheme.typography.bodyMedium.copy(fontFamily = monoFamily),
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
                )
            }
        }
        preview.outputLines.forEach { line ->
            Text(
                text = line,
                style = MaterialTheme.typography.bodyMedium.copy(fontFamily = monoFamily),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (preview.command == null && preview.outputLines.isEmpty() && message.text.isNotBlank()) {
            Text(
                text = message.text.trim(),
                style = MaterialTheme.typography.bodyMedium.copy(fontFamily = monoFamily),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        StatusTag(
            text = preview.statusLabel,
            containerColor = accent.copy(alpha = 0.12f),
            contentColor = accent,
        )
        message.commandState?.outputTail
            ?.trim()
            ?.takeIf(String::isNotEmpty)
            ?.let {
                OutlinedButton(
                    onClick = { showOutputDetails = true },
                    shape = RoundedCornerShape(999.dp),
                ) {
                    Text("View output")
                }
            }
    }
    if (showOutputDetails) {
        CommandDetailDialog(
            detail = remember(message.id, message.commandState, message.text, preview.statusLabel, preview.command) {
                buildCommandDetail(message, preview)
            },
            onDismiss = { showOutputDetails = false },
        )
    }
}

@Composable
internal fun CommandDetailDialog(
    detail: CommandDetailUi,
    onDismiss: () -> Unit,
) {
    Dialog(onDismissRequest = onDismiss) {
        Surface(
            shape = RoundedCornerShape(28.dp),
            color = MaterialTheme.colorScheme.surface,
            modifier = Modifier
                .fillMaxWidth()
                .fillMaxHeight(0.88f),
        ) {
            Column(modifier = Modifier.padding(horizontal = 18.dp, vertical = 18.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = detail.command ?: "Command output",
                        style = MaterialTheme.typography.titleMedium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    TextButton(onClick = onDismiss) {
                        Text("Close")
                    }
                }
                Spacer(Modifier.size(10.dp))
                detail.command?.let { command ->
                    Surface(
                        shape = RoundedCornerShape(16.dp),
                        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f),
                    ) {
                        SelectionContainer {
                            Text(
                                text = command,
                                style = MaterialTheme.typography.bodyMedium.copy(fontFamily = monoFamily),
                                modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
                            )
                        }
                    }
                    Spacer(Modifier.size(10.dp))
                }
                Row(
                    modifier = Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    StatusTag(
                        text = detail.statusLabel,
                        containerColor = commandStatusAccentColor(detail.statusLabel).copy(alpha = 0.12f),
                        contentColor = commandStatusAccentColor(detail.statusLabel),
                    )
                    detail.cwd?.let { CommandMetaTag("cwd", it) }
                    detail.exitCode?.let { CommandMetaTag("exit", it.toString()) }
                    detail.durationMs?.let { CommandMetaTag("duration", "${it}ms") }
                }
                Spacer(Modifier.size(12.dp))
                if (detail.outputSections.isEmpty()) {
                    SelectionContainer {
                        Text(
                            text = detail.fallbackBody.ifBlank { "No output available." },
                            style = MaterialTheme.typography.bodyMedium.copy(fontFamily = monoFamily),
                            modifier = Modifier
                                .fillMaxWidth()
                                .horizontalScroll(rememberScrollState()),
                        )
                    }
                } else {
                    LazyColumn(
                        modifier = Modifier.fillMaxSize(),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        items(detail.outputSections, key = { it.title ?: "output-${it.lines.size}" }) { section ->
                            CommandOutputSectionCard(section)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun CommandMetaTag(
    label: String,
    value: String,
) {
    Surface(
        shape = RoundedCornerShape(999.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.65f),
    ) {
        Text(
            text = "$label: $value",
            style = MaterialTheme.typography.labelSmall.copy(fontFamily = monoFamily),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
        )
    }
}

@Composable
private fun CommandOutputSectionCard(section: CommandOutputSectionUi) {
    Surface(
        shape = RoundedCornerShape(18.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            section.title?.let { title ->
                Text(
                    text = title,
                    style = MaterialTheme.typography.labelMedium.copy(fontFamily = monoFamily),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Surface(
                shape = RoundedCornerShape(16.dp),
                color = MaterialTheme.colorScheme.surface.copy(alpha = 0.96f),
            ) {
                SelectionContainer {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .horizontalScroll(rememberScrollState())
                            .padding(horizontal = 12.dp, vertical = 10.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        section.lines.forEach { line ->
                            Text(
                                text = line.text.ifEmpty { " " },
                                style = MaterialTheme.typography.bodySmall.copy(fontFamily = monoFamily),
                                color = commandOutputLineColor(line.kind),
                            )
                        }
                    }
                }
            }
        }
    }
}


@Composable
private fun commandStatusAccentColor(statusLabel: String): Color {
    return when {
        statusLabel.contains("run", ignoreCase = true) -> MaterialTheme.colorScheme.primary
        statusLabel.contains("attention", ignoreCase = true) || statusLabel.contains("stop", ignoreCase = true) -> Danger
        else -> CommandAccent
    }
}

@Composable
private fun commandOutputLineColor(kind: CommandOutputLineKind): Color {
    return when (kind) {
        CommandOutputLineKind.STANDARD -> MaterialTheme.colorScheme.onSurface
        CommandOutputLineKind.META -> MaterialTheme.colorScheme.onSurfaceVariant
        CommandOutputLineKind.WARNING -> MaterialTheme.colorScheme.tertiary
        CommandOutputLineKind.ERROR -> Danger
    }
}
