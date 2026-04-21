package com.coderover.android.ui.turn

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material3.Icon
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.coderover.android.data.model.AssistantRevertPresentation
import com.coderover.android.data.model.ChatMessage
import com.coderover.android.data.model.MessageKind
import com.coderover.android.data.model.MessageRole
import com.coderover.android.ui.shared.StatusTag
import com.coderover.android.ui.theme.Border
import com.coderover.android.ui.theme.CommandAccent
import com.coderover.android.ui.theme.PlanAccent
import com.coderover.android.ui.theme.monoFamily

@Composable
internal fun TurnMessageBubble(
    message: ChatMessage,
    onSubmitStructuredInput: (kotlinx.serialization.json.JsonElement, Map<String, String>) -> Unit,
    onTapSubagentThread: (String) -> Unit = {},
    grouped: Boolean = false,
    replyPresentation: ReplyPresentation? = null,
    copyBlockText: String? = null,
    aggregatedFileChangePresentation: FileChangeBlockPresentation? = null,
    suppressFileChangeActions: Boolean = false,
    assistantRevertPresentation: AssistantRevertPresentation? = null,
    onTapAssistantRevert: (ChatMessage) -> Unit = {},
) {
    when {
        message.role == MessageRole.USER -> {
            ConversationBubble(
                message = message,
                fillFraction = if (grouped) 1f else 0.82f,
                background = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.78f),
                contentColor = MaterialTheme.colorScheme.onSurface,
                shape = RoundedCornerShape(24.dp),
                replyPresentation = replyPresentation,
            )
        }

        message.role == MessageRole.ASSISTANT &&
            message.kind == MessageKind.CHAT &&
            !isCommandTranscriptMessage(message) -> {
            NonUserMessageBlock(copyBlockText = copyBlockText) {
                AssistantMessageBlock(
                    message = message,
                    replyPresentation = replyPresentation,
                    assistantRevertPresentation = assistantRevertPresentation,
                    onTapAssistantRevert = onTapAssistantRevert,
                )
            }
        }

        else -> {
            NonUserMessageBlock(copyBlockText = copyBlockText) {
                SystemMessageBlock(
                    message = message,
                    onSubmitStructuredInput = onSubmitStructuredInput,
                    onTapSubagentThread = onTapSubagentThread,
                    aggregatedFileChangePresentation = aggregatedFileChangePresentation,
                    suppressFileChangeActions = suppressFileChangeActions,
                )
            }
        }
    }
}

@Composable
private fun NonUserMessageBlock(
    copyBlockText: String?,
    content: @Composable () -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        content()
        copyBlockText?.let { text ->
            CopyBlockButton(text = text)
        }
    }
}

@Composable
private fun AssistantMessageBlock(
    message: ChatMessage,
    replyPresentation: ReplyPresentation? = null,
    assistantRevertPresentation: AssistantRevertPresentation? = null,
    onTapAssistantRevert: (ChatMessage) -> Unit = {},
) {
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        replyPresentation?.let { presentation ->
            StatusTag(
                text = if (presentation == ReplyPresentation.FINAL) "Final" else "Draft",
                containerColor = if (presentation == ReplyPresentation.FINAL) {
                    MaterialTheme.colorScheme.primary.copy(alpha = 0.10f)
                } else {
                    MaterialTheme.colorScheme.surfaceVariant
                },
                contentColor = if (presentation == ReplyPresentation.FINAL) {
                    MaterialTheme.colorScheme.primary
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant
                },
            )
        }
        if (message.attachments.isNotEmpty()) {
            MessageAttachmentsPreview(message.attachments)
        }
        RichMessageText(
            text = message.text,
            textColor = MaterialTheme.colorScheme.onSurface,
        )
        if (message.isStreaming) {
            TypingIndicator(modifier = Modifier.padding(top = 2.dp))
        }
        assistantRevertPresentation?.let { presentation ->
            AssistantRevertButton(
                presentation = presentation,
                onClick = { onTapAssistantRevert(message) },
            )
        }
    }
}

@Composable
private fun AssistantRevertButton(
    presentation: AssistantRevertPresentation,
    onClick: () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        InlineActionPill(
            text = if (presentation.isEnabled) "Undo" else presentation.title,
            isEnabled = presentation.isEnabled,
            onClick = onClick,
            icon = {
                Icon(
                    painter = androidx.compose.ui.res.painterResource(id = android.R.drawable.ic_menu_revert),
                    contentDescription = null,
                    modifier = Modifier.size(12.dp),
                    tint = if (presentation.isEnabled) {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.45f)
                    },
                )
            },
        )
        presentation.helperText?.let { text ->
            Text(
                text = text,
                style = MaterialTheme.typography.labelSmall.copy(fontFamily = monoFamily),
                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.72f),
            )
        }
    }
}

@Composable
private fun InlineActionPill(
    text: String,
    isEnabled: Boolean = true,
    onClick: () -> Unit,
    icon: @Composable (() -> Unit)? = null,
) {
    Surface(
        shape = RoundedCornerShape(12.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = if (isEnabled) 0.55f else 0.38f),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.10f)),
        modifier = Modifier.clickable(enabled = isEnabled, onClick = onClick),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            icon?.invoke()
            Text(
                text = text,
                style = MaterialTheme.typography.bodySmall.copy(fontFamily = monoFamily),
                color = if (isEnabled) {
                    MaterialTheme.colorScheme.onSurface
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.55f)
                },
            )
        }
    }
}

@Composable
private fun TypingIndicator(modifier: Modifier = Modifier) {
    val infiniteTransition = rememberInfiniteTransition(label = "typing")
    Row(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        repeat(3) { index ->
            val offsetY by infiniteTransition.animateFloat(
                initialValue = 3f,
                targetValue = -3f,
                animationSpec = infiniteRepeatable(
                    animation = tween(durationMillis = 450, delayMillis = index * 120),
                    repeatMode = RepeatMode.Reverse,
                ),
                label = "typing-offset-$index",
            )
            Box(
                modifier = Modifier
                    .offset(y = offsetY.dp)
                    .size(6.dp)
                    .background(
                        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f),
                        shape = CircleShape,
                    ),
            )
        }
    }
}

@Composable
private fun ConversationBubble(
    message: ChatMessage,
    background: Color,
    contentColor: Color,
    fillFraction: Float,
    shape: Shape,
    replyPresentation: ReplyPresentation? = null,
) {
    val bubbleBorder = when (replyPresentation) {
        ReplyPresentation.FINAL -> BorderStroke(
            1.dp,
            MaterialTheme.colorScheme.primary.copy(alpha = 0.22f),
        )

        ReplyPresentation.DRAFT -> BorderStroke(
            1.dp,
            MaterialTheme.colorScheme.outline.copy(alpha = 0.18f),
        )

        null -> BorderStroke(
            1.dp,
            MaterialTheme.colorScheme.outline.copy(alpha = 0.08f),
        )
    }

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.End,
    ) {
        Column(
            modifier = Modifier.fillMaxWidth(),
            horizontalAlignment = Alignment.End,
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            if (message.attachments.isNotEmpty()) {
                Box(
                    modifier = Modifier.fillMaxWidth(),
                    contentAlignment = Alignment.CenterEnd,
                ) {
                    MessageAttachmentsPreview(message.attachments)
                }
            }

            Surface(
                color = background,
                contentColor = contentColor,
                shape = shape,
                border = bubbleBorder,
                modifier = Modifier
                    .fillMaxWidth(fillFraction)
                    .animateContentSize(),
            ) {
                Column(modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
                    replyPresentation?.let { presentation ->
                        StatusTag(
                            text = if (presentation == ReplyPresentation.FINAL) "Final" else "Draft",
                            containerColor = if (presentation == ReplyPresentation.FINAL) {
                                MaterialTheme.colorScheme.primary.copy(alpha = 0.12f)
                            } else {
                                MaterialTheme.colorScheme.surfaceVariant
                            },
                            contentColor = if (presentation == ReplyPresentation.FINAL) {
                                MaterialTheme.colorScheme.primary
                            } else {
                                MaterialTheme.colorScheme.onSurfaceVariant
                            },
                        )
                        Spacer(Modifier.height(10.dp))
                    }
                    RichMessageText(
                        text = message.text,
                        textColor = contentColor,
                    )
                }
            }
        }
    }
}

@Composable
private fun SystemMessageBlock(
    message: ChatMessage,
    onSubmitStructuredInput: (kotlinx.serialization.json.JsonElement, Map<String, String>) -> Unit,
    onTapSubagentThread: (String) -> Unit,
    aggregatedFileChangePresentation: FileChangeBlockPresentation? = null,
    suppressFileChangeActions: Boolean = false,
) {
    when (message.kind) {
        MessageKind.THINKING -> ThinkingMessageContent(message)
        MessageKind.TOOL_ACTIVITY -> DefaultSystemMessageContent(message)
        MessageKind.FILE_CHANGE -> FileChangeMessageContent(
            message = message,
            aggregatedPresentation = aggregatedFileChangePresentation,
            suppressActions = suppressFileChangeActions,
        )
        MessageKind.COMMAND_EXECUTION -> {
            if (isCommandCompletionPlaceholder(message)) {
                TurnSystemCard(
                    title = "Session complete",
                    showsProgress = false,
                ) {
                    Text(
                        text = "Assistant finished this turn.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            } else {
                CommandExecutionMessageContent(message)
            }
        }
        MessageKind.SUBAGENT_ACTION -> SubagentActionMessageContent(message, onTapSubagentThread)
        MessageKind.PLAN -> PlanMessageContent(message)
        MessageKind.USER_INPUT_PROMPT -> TurnSystemCard(
            title = "Need input",
            showsProgress = message.isStreaming,
        ) {
            UserInputPromptMessageContent(message, onSubmitStructuredInput)
        }

        MessageKind.CHAT -> DefaultSystemMessageContent(message)
    }
}

@Composable
private fun CopyBlockButton(text: String) {
    val context = LocalContext.current
    var copied by remember(text) { mutableStateOf(false) }
    InlineActionPill(
        text = if (copied) "Copied" else "Copy",
        onClick = {
            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(ClipData.newPlainText("assistant-block", text))
            copied = true
        },
        icon = {
            Icon(
                imageVector = if (copied) Icons.Outlined.Check else Icons.Outlined.ContentCopy,
                contentDescription = null,
                modifier = Modifier.size(12.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        },
    )
}

@Composable
private fun ThinkingMessageContent(message: ChatMessage) {
    val thinking = remember(message.id, message.text) { parseThinkingDisclosure(message.text) }
    val activityPreview = remember(thinking.fallbackText) { compactActivityPreview(thinking.fallbackText) }
    var expandedSectionIds by remember(message.id) { mutableStateOf<Set<String>>(emptySet()) }

    val alpha = if (message.isStreaming) {
        val infiniteTransition = rememberInfiniteTransition(label = "thinking")
        infiniteTransition.animateFloat(
            initialValue = 0.5f,
            targetValue = 1f,
            animationSpec = infiniteRepeatable(
                animation = tween(800),
                repeatMode = RepeatMode.Reverse,
            ),
            label = "thinking-alpha",
        ).value
    } else {
        1f
    }

    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            text = "Thinking...",
            style = MaterialTheme.typography.labelMedium.copy(
                fontFamily = monoFamily,
                fontStyle = FontStyle.Italic,
            ),
            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.9f * alpha),
        )

        when {
            activityPreview != null -> {
                Text(
                    text = activityPreview,
                    style = MaterialTheme.typography.bodySmall.copy(
                        fontFamily = monoFamily,
                        fontStyle = FontStyle.Italic,
                    ),
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.85f),
                )
            }

            thinking.sections.isNotEmpty() -> {
                thinking.sections.forEach { section ->
                    val isExpanded = expandedSectionIds.contains(section.id)
                    val hasDetail = section.detail.isNotBlank()
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable(enabled = hasDetail) {
                                    expandedSectionIds = if (isExpanded) {
                                        expandedSectionIds - section.id
                                    } else {
                                        expandedSectionIds + section.id
                                    }
                                },
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                text = if (isExpanded) "▾" else "▸",
                                style = MaterialTheme.typography.labelSmall.copy(fontFamily = monoFamily),
                                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(
                                    alpha = if (hasDetail) 0.82f else 0.35f,
                                ),
                            )
                            Text(
                                text = section.title,
                                style = MaterialTheme.typography.labelMedium.copy(fontFamily = monoFamily),
                                fontWeight = FontWeight.Bold,
                                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.95f),
                            )
                        }
                        if (isExpanded && hasDetail) {
                            Text(
                                text = section.detail,
                                style = MaterialTheme.typography.bodySmall.copy(
                                    fontFamily = monoFamily,
                                    fontStyle = FontStyle.Italic,
                                ),
                                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.85f),
                                modifier = Modifier.padding(start = 18.dp),
                            )
                        }
                    }
                }
            }

            thinking.fallbackText.isNotEmpty() -> {
                Text(
                    text = thinking.fallbackText,
                    style = MaterialTheme.typography.bodySmall.copy(
                        fontFamily = monoFamily,
                        fontStyle = FontStyle.Italic,
                    ),
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.85f),
                )
            }
        }
    }
}

@Composable
private fun SubagentActionMessageContent(
    message: ChatMessage,
    onTapSubagentThread: (String) -> Unit,
) {
    val action = message.subagentAction
    TurnSystemCard(
        title = "Subagents",
        showsProgress = message.isStreaming,
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(
                text = action?.summaryText ?: message.text.trim(),
                style = MaterialTheme.typography.bodyMedium.copy(fontFamily = monoFamily),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            action?.agentRows?.forEach { agent ->
                val resolvedStatus = agent.fallbackStatus?.trim()?.ifEmpty { null }
                    ?: action.status.trim().ifEmpty { "in_progress" }
                val statusColor = subagentStatusColor(resolvedStatus)
                Surface(
                    shape = RoundedCornerShape(16.dp),
                    color = MaterialTheme.colorScheme.surface.copy(alpha = 0.68f),
                    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.08f)),
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable(enabled = agent.threadId.isNotBlank()) {
                            onTapSubagentThread(agent.threadId)
                        },
                ) {
                    Row(
                        modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Box(
                            modifier = Modifier
                                .size(8.dp)
                                .background(statusColor, CircleShape),
                        )
                        Column(
                            modifier = Modifier.weight(1f),
                            verticalArrangement = Arrangement.spacedBy(3.dp),
                        ) {
                            Text(
                                text = agent.displayLabel,
                                style = MaterialTheme.typography.bodyMedium,
                                fontWeight = FontWeight.Medium,
                                color = MaterialTheme.colorScheme.onSurface,
                            )
                            resolvedStatus?.let { status ->
                                Text(
                                    text = status.replace("_", " "),
                                    style = MaterialTheme.typography.labelSmall.copy(fontFamily = monoFamily),
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                        agent.model?.trim()?.takeIf(String::isNotEmpty)?.let { model ->
                            Text(
                                text = model,
                                style = MaterialTheme.typography.labelSmall.copy(fontFamily = monoFamily),
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        if (agent.threadId.isNotBlank()) {
                            Icon(
                                imageVector = Icons.AutoMirrored.Outlined.KeyboardArrowRight,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.75f),
                                modifier = Modifier.size(18.dp),
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun DefaultSystemMessageContent(message: ChatMessage) {
    if (isCommandTranscriptMessage(message)) {
        CommandExecutionMessageContent(
            message = message.copy(kind = MessageKind.COMMAND_EXECUTION),
        )
        return
    }
    RichMessageText(
        text = message.text.trim(),
        textColor = MaterialTheme.colorScheme.onSurfaceVariant,
        textStyle = MaterialTheme.typography.bodyMedium,
    )
}

internal fun systemMessageTitle(kind: MessageKind): String {
    return when (kind) {
        MessageKind.THINKING -> "Thinking"
        MessageKind.TOOL_ACTIVITY -> "Tool"
        MessageKind.FILE_CHANGE -> "File change"
        MessageKind.COMMAND_EXECUTION -> "Command"
        MessageKind.SUBAGENT_ACTION -> "Subagents"
        MessageKind.PLAN -> "Plan"
        MessageKind.USER_INPUT_PROMPT -> "Input needed"
        MessageKind.CHAT -> "System"
    }
}

@Composable
internal fun systemAccentColor(kind: MessageKind): Color {
    return when (kind) {
        MessageKind.THINKING, MessageKind.PLAN -> PlanAccent
        MessageKind.TOOL_ACTIVITY, MessageKind.COMMAND_EXECUTION -> CommandAccent
        MessageKind.SUBAGENT_ACTION -> MaterialTheme.colorScheme.primary
        MessageKind.FILE_CHANGE -> MaterialTheme.colorScheme.secondary
        MessageKind.USER_INPUT_PROMPT -> MaterialTheme.colorScheme.tertiary
        MessageKind.CHAT -> MaterialTheme.colorScheme.outline
    }
}

@Composable
private fun subagentStatusColor(status: String?): Color {
    val normalized = status?.trim()?.lowercase().orEmpty()
    return when {
        "fail" in normalized || "error" in normalized -> Color(0xFFCC5A5A)
        "stop" in normalized || "cancel" in normalized -> Color(0xFFD48A3A)
        "complete" in normalized || "done" in normalized -> Color(0xFF4F9A63)
        else -> PlanAccent
    }
}
