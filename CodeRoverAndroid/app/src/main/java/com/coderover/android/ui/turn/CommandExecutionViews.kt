package com.coderover.android.ui.turn

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Code
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
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
import com.coderover.android.ui.theme.CommandAccent
import com.coderover.android.ui.theme.Danger
import com.coderover.android.ui.theme.monoFamily

@Composable
internal fun CommandExecutionMessageContent(message: ChatMessage) {
    var showOutputDetails by remember(message.id) { mutableStateOf(false) }
    val preview = remember(message.id, message.text, message.isStreaming, message.commandState) {
        message.commandState?.let { state ->
            CommandPreviewUi(
                command = state.shortCommand.ifBlank { state.fullCommand },
                outputLines = emptyList(),
                statusLabel = state.phase.statusLabel,
            )
        } ?: parseCommandPreview(message.text, message.isStreaming)
    }

    if (preview.command != null) {
        CommandExecutionCardBody(
            command = preview.command,
            statusLabel = preview.statusLabel,
            accent = commandStatusAccentColor(preview.statusLabel),
            onClick = { showOutputDetails = true },
        )
    } else if (message.text.isNotBlank()) {
        Text(
            text = message.text.trim(),
            style = MaterialTheme.typography.bodyMedium.copy(fontFamily = monoFamily),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
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
private fun CommandExecutionCardBody(
    command: String,
    statusLabel: String,
    accent: Color,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .fillMaxHeight()
                .size(width = 3.dp, height = 24.dp)
                .background(accent, RoundedCornerShape(999.dp)),
        )

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 2.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = Icons.Outlined.Code,
                contentDescription = null,
                modifier = Modifier.size(14.dp),
                tint = accent,
            )

            Text(
                text = command,
                style = MaterialTheme.typography.bodyMedium.copy(fontFamily = monoFamily),
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )

            Text(
                text = statusLabel,
                style = MaterialTheme.typography.labelSmall.copy(fontFamily = monoFamily),
                color = accent,
            )

            Icon(
                imageVector = Icons.AutoMirrored.Outlined.KeyboardArrowRight,
                contentDescription = null,
                modifier = Modifier.size(14.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
            )
        }
    }
}

@Composable
internal fun CommandDetailDialog(
    detail: CommandDetailUi,
    onDismiss: () -> Unit,
) {
    var isOutputExpanded by remember(detail) { mutableStateOf(false) }

    Dialog(onDismissRequest = onDismiss) {
        Surface(
            shape = RoundedCornerShape(28.dp),
            color = MaterialTheme.colorScheme.surface,
            modifier = Modifier
                .fillMaxWidth()
                .fillMaxHeight(0.88f),
        ) {
            Column(
                modifier = Modifier.padding(horizontal = 18.dp, vertical = 18.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = "Command",
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.weight(1f),
                    )
                    TextButton(onClick = onDismiss) {
                        Text("Close")
                    }
                }

                detail.command?.let { command ->
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(
                            text = "Command",
                            style = MaterialTheme.typography.labelSmall.copy(fontFamily = monoFamily),
                            color = commandStatusAccentColor(detail.statusLabel),
                        )
                        Surface(
                            shape = RoundedCornerShape(10.dp),
                            color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f),
                        ) {
                            SelectionContainer {
                                Text(
                                    text = command,
                                    style = MaterialTheme.typography.bodyMedium.copy(fontFamily = monoFamily),
                                    color = MaterialTheme.colorScheme.onSurface,
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(12.dp),
                                )
                            }
                        }
                    }
                }

                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    CommandMetadataRow(
                        label = "Status",
                        value = detail.statusLabel,
                        valueColor = commandStatusAccentColor(detail.statusLabel),
                    )
                    detail.cwd?.let { CommandMetadataRow(label = "Directory", value = it) }
                    detail.exitCode?.let { exitCode ->
                        CommandMetadataRow(
                            label = "Exit code",
                            value = exitCode.toString(),
                            valueColor = if (exitCode == 0) CommandAccent else Danger,
                        )
                    }
                    detail.durationMs?.let { durationMs ->
                        CommandMetadataRow(label = "Duration", value = formattedDuration(durationMs))
                    }
                }

                if (detail.outputSections.isNotEmpty()) {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextButton(
                            onClick = { isOutputExpanded = !isOutputExpanded },
                            contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp),
                        ) {
                            Row(
                                horizontalArrangement = Arrangement.spacedBy(6.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(
                                    text = if (isOutputExpanded) "▾" else "▸",
                                    style = MaterialTheme.typography.labelSmall.copy(fontFamily = monoFamily),
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                                Text(
                                    text = "Output",
                                    style = MaterialTheme.typography.labelSmall.copy(fontFamily = monoFamily),
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }

                        if (isOutputExpanded) {
                            detail.outputSections.forEach { section ->
                                CommandOutputSectionCard(section)
                            }
                        }
                    }
                } else {
                    SelectionContainer {
                        Text(
                            text = detail.fallbackBody.ifBlank { "No output available." },
                            style = MaterialTheme.typography.bodyMedium.copy(fontFamily = monoFamily),
                            color = MaterialTheme.colorScheme.onSurface,
                            modifier = Modifier.horizontalScroll(rememberScrollState()),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun CommandMetadataRow(
    label: String,
    value: String,
    valueColor: Color = MaterialTheme.colorScheme.onSurface,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall.copy(fontFamily = monoFamily),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.weight(1f))
        Text(
            text = value,
            style = MaterialTheme.typography.labelSmall.copy(fontFamily = monoFamily),
            color = valueColor,
        )
    }
}

@Composable
private fun CommandOutputSectionCard(section: CommandOutputSectionUi) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        section.title?.let { title ->
            Text(
                text = title,
                style = MaterialTheme.typography.labelSmall.copy(fontFamily = monoFamily),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Surface(
            shape = RoundedCornerShape(10.dp),
            color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f),
        ) {
            SelectionContainer {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .horizontalScroll(rememberScrollState())
                        .padding(12.dp),
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

private fun formattedDuration(ms: Int): String {
    if (ms < 1000) {
        return "${ms}ms"
    }
    val seconds = ms / 1000.0
    if (seconds < 60) {
        return String.format("%.1fs", seconds)
    }
    val minutes = (seconds / 60).toInt()
    val remainingSeconds = seconds.toInt() % 60
    return "${minutes}m ${remainingSeconds}s"
}

@Composable
private fun commandStatusAccentColor(statusLabel: String): Color {
    return when {
        statusLabel.contains("run", ignoreCase = true) -> CommandAccent
        statusLabel.contains("completed", ignoreCase = true) -> Color(0xFF2AA876)
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
