package com.remodex.android.ui.turn

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.remodex.android.data.model.AssistantRevertPresentation
import com.remodex.android.data.model.ChatMessage
import com.remodex.android.data.model.MessageKind
import com.remodex.android.data.model.MessageRole
import androidx.compose.ui.platform.LocalContext
import com.remodex.android.ui.shared.StatusTag
import com.remodex.android.ui.theme.Border
import com.remodex.android.ui.theme.CommandAccent
import com.remodex.android.ui.theme.PlanAccent
import com.remodex.android.ui.theme.monoFamily

@Composable
internal fun TurnMessageBubble(
    message: ChatMessage,
    onSubmitStructuredInput: (kotlinx.serialization.json.JsonElement, Map<String, String>) -> Unit,
    grouped: Boolean = false,
    replyPresentation: ReplyPresentation? = null,
    copyBlockText: String? = null,
    assistantRevertPresentation: AssistantRevertPresentation? = null,
    onTapAssistantRevert: (ChatMessage) -> Unit = {},
) {
    when {
        message.role == MessageRole.USER -> {
            ConversationBubble(
                message = message,
                alignment = Alignment.CenterEnd,
                background = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.72f),
                contentColor = MaterialTheme.colorScheme.onSurface,
                fillFraction = if (grouped) 1f else 0.84f,
                shape = RoundedCornerShape(24.dp, 24.dp, 6.dp, 24.dp),
            )
        }

        message.role == MessageRole.ASSISTANT && message.kind == MessageKind.CHAT -> {
            NonUserMessageBlock(copyBlockText = copyBlockText) {
                AssistantMessageBlock(
                    message = message,
                    replyPresentation = replyPresentation,
                    assistantRevertPresentation = assistantRevertPresentation,
                    onTapAssistantRevert = onTapAssistantRevert,
                )
            }
        }

        else -> SystemMessageCard(
            message = message,
            onSubmitStructuredInput = onSubmitStructuredInput,
            grouped = grouped,
            copyBlockText = copyBlockText,
        )
    }
}

@Composable
private fun NonUserMessageBlock(
    copyBlockText: String?,
    content: @Composable () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
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
        modifier = Modifier
            .fillMaxWidth()
            .wrapContentWidth(Alignment.Start)
            .padding(top = 2.dp, end = 24.dp),
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
        assistantRevertPresentation?.let { presentation ->
            AssistantRevertButton(
                presentation = presentation,
                onClick = { onTapAssistantRevert(message) },
            )
        }
        if (message.isStreaming) {
            TypingIndicator(modifier = Modifier.padding(top = 4.dp))
        }
    }
}

@Composable
private fun AssistantRevertButton(
    presentation: AssistantRevertPresentation,
    onClick: () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        OutlinedButton(
            onClick = onClick,
            enabled = presentation.isEnabled,
            shape = RoundedCornerShape(12.dp),
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp),
            modifier = Modifier.height(32.dp)
        ) {
            Icon(
                painter = androidx.compose.ui.res.painterResource(id = android.R.drawable.ic_menu_revert),
                contentDescription = null,
                modifier = Modifier.size(14.dp)
            )
            Spacer(Modifier.width(6.dp))
            Text(
                text = presentation.title,
                style = MaterialTheme.typography.labelMedium
            )
        }
        presentation.helperText?.let { text ->
            Text(
                text = text,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
                modifier = Modifier.padding(horizontal = 4.dp)
            )
        }
    }
}

@Composable
private fun TypingIndicator(modifier: Modifier = Modifier) {
    val infiniteTransition = androidx.compose.animation.core.rememberInfiniteTransition(label = "typing")
    val dotCount = 3
    Row(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        repeat(dotCount) { index ->
            val delay = index * 200
            val alpha by infiniteTransition.animateFloat(
                initialValue = 0.2f,
                targetValue = 1f,
                animationSpec = infiniteRepeatable(
                    animation = tween(600, delayMillis = delay),
                    repeatMode = RepeatMode.Reverse
                ),
                label = "alpha"
            )
            Box(
                modifier = Modifier
                    .size(6.dp)
                    .background(
                        MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = alpha),
                        CircleShape
                    )
            )
        }
    }
}

@Composable
private fun ConversationBubble(
    message: ChatMessage,
    alignment: Alignment,
    background: Color,
    contentColor: Color,
    fillFraction: Float,
    shape: Shape,
    tonalElevation: androidx.compose.ui.unit.Dp = 0.dp,
    replyPresentation: ReplyPresentation? = null,
) {
    val bubbleBorder = when (replyPresentation) {
        ReplyPresentation.FINAL -> androidx.compose.foundation.BorderStroke(
            1.dp,
            MaterialTheme.colorScheme.primary.copy(alpha = 0.22f),
        )

        ReplyPresentation.DRAFT -> androidx.compose.foundation.BorderStroke(
            1.dp,
            MaterialTheme.colorScheme.outline.copy(alpha = 0.55f),
        )

        null -> null
    }
    Box(
        modifier = Modifier.fillMaxWidth(),
        contentAlignment = alignment,
    ) {
        Surface(
            color = background,
            contentColor = contentColor,
            shape = shape,
            tonalElevation = tonalElevation,
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
                if (message.attachments.isNotEmpty()) {
                    MessageAttachmentsPreview(message.attachments)
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

@Composable
private fun SystemMessageCard(
    message: ChatMessage,
    onSubmitStructuredInput: (kotlinx.serialization.json.JsonElement, Map<String, String>) -> Unit,
    grouped: Boolean = false,
    copyBlockText: String? = null,
) {
    val accent = systemAccentColor(message.kind)
    NonUserMessageBlock(copyBlockText = copyBlockText) {
        Box(
            modifier = Modifier.fillMaxWidth(),
            contentAlignment = Alignment.CenterStart,
        ) {
            Surface(
                shape = RoundedCornerShape(20.dp),
                color = MaterialTheme.colorScheme.surface.copy(alpha = 0.92f),
                border = androidx.compose.foundation.BorderStroke(1.dp, Border.copy(alpha = 0.5f)),
                modifier = Modifier.fillMaxWidth(if (grouped) 1f else 0.94f),
            ) {
                Column(modifier = Modifier.padding(horizontal = 16.dp, vertical = 14.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        if (message.isStreaming) {
                            PulsingDot(color = accent)
                        } else {
                            Box(
                                modifier = Modifier
                                    .size(8.dp)
                                    .background(accent, CircleShape),
                            )
                        }
                        Text(
                            text = systemMessageTitle(message.kind),
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Spacer(Modifier.height(12.dp))
                    when (message.kind) {
                        MessageKind.THINKING -> ThinkingMessageContent(message)
                        MessageKind.FILE_CHANGE -> FileChangeMessageContent(message)
                        MessageKind.COMMAND_EXECUTION -> CommandExecutionMessageContent(message)
                        MessageKind.PLAN -> PlanMessageContent(message)
                        MessageKind.USER_INPUT_PROMPT -> UserInputPromptMessageContent(message, onSubmitStructuredInput)
                        MessageKind.CHAT -> DefaultSystemMessageContent(message)
                    }
                }
            }
        }
    }
}

@Composable
private fun CopyBlockButton(text: String) {
    val context = LocalContext.current
    var copied by remember(text) { mutableStateOf(false) }
    TextButton(
        onClick = {
            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(ClipData.newPlainText("assistant-block", text))
            copied = true
        },
    ) {
        Text(
            text = if (copied) "Copied" else "Copy",
            style = MaterialTheme.typography.labelMedium,
        )
    }
}


@Composable
private fun ThinkingMessageContent(message: ChatMessage) {
    val thinking = remember(message.id, message.text) { parseThinkingDisclosure(message.text) }
    var expandedSectionIds by remember(message.id) { mutableStateOf<Set<String>>(emptySet()) }

    val alpha = if (message.isStreaming) {
        val infiniteTransition = rememberInfiniteTransition(label = "shimmer")
        infiniteTransition.animateFloat(
            initialValue = 0.4f,
            targetValue = 1f,
            animationSpec = infiniteRepeatable(
                animation = tween(800),
                repeatMode = RepeatMode.Reverse
            ),
            label = "alpha"
        ).value
    } else {
        1f
    }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            text = "Thinking...",
            style = MaterialTheme.typography.labelLarge.copy(fontFamily = monoFamily),
            fontWeight = FontWeight.Normal,
            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = alpha),
        )
        if (thinking.sections.isNotEmpty()) {
            thinking.sections.forEach { section ->
                val isExpanded = expandedSectionIds.contains(section.id)
                val hasDetail = section.detail.isNotBlank()
                Surface(
                    shape = RoundedCornerShape(14.dp),
                    color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Column(modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable(enabled = hasDetail) {
                                    expandedSectionIds = if (isExpanded) expandedSectionIds - section.id else expandedSectionIds + section.id
                                },
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                text = if (isExpanded) "▾" else "▸",
                                style = MaterialTheme.typography.labelMedium.copy(fontFamily = monoFamily),
                                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = if (hasDetail) 0.9f else 0.4f),
                            )
                            Spacer(Modifier.width(8.dp))
                            Text(
                                text = section.title,
                                style = MaterialTheme.typography.labelMedium.copy(fontFamily = monoFamily),
                                fontWeight = FontWeight.Bold,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        if (isExpanded && hasDetail) {
                            Spacer(Modifier.height(8.dp))
                            Text(
                                text = section.detail,
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.88f),
                            )
                        }
                    }
                }
            }
        } else if (thinking.fallbackText.isNotEmpty()) {
            Text(
                text = thinking.fallbackText,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.88f),
            )
        }
    }
}

@Composable
private fun DefaultSystemMessageContent(message: ChatMessage) {
    RichMessageText(
        text = message.text.trim(),
        textColor = MaterialTheme.colorScheme.onSurfaceVariant,
        textStyle = MaterialTheme.typography.bodyMedium,
    )
}

internal fun systemMessageTitle(kind: MessageKind): String {
    return when (kind) {
        MessageKind.THINKING -> "Thinking"
        MessageKind.FILE_CHANGE -> "File change"
        MessageKind.COMMAND_EXECUTION -> "Command"
        MessageKind.PLAN -> "Plan"
        MessageKind.USER_INPUT_PROMPT -> "Input needed"
        MessageKind.CHAT -> "System"
    }
}

@Composable
internal fun systemAccentColor(kind: MessageKind): Color {
    return when (kind) {
        MessageKind.THINKING, MessageKind.PLAN -> PlanAccent
        MessageKind.COMMAND_EXECUTION -> CommandAccent
        MessageKind.FILE_CHANGE -> MaterialTheme.colorScheme.secondary
        MessageKind.USER_INPUT_PROMPT -> MaterialTheme.colorScheme.tertiary
        MessageKind.CHAT -> MaterialTheme.colorScheme.outline
    }
}
