package com.coderover.android.ui.turn

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.coderover.android.data.model.ChatMessage
import com.coderover.android.data.model.MessageRole
import com.coderover.android.ui.shared.StatusTag
import com.coderover.android.ui.theme.Border

@Composable
internal fun TurnSectionCard(
    item: TimelineRenderItem.TurnSection,
    copyBlockTextByMessageId: Map<String, String>,
    onSubmitStructuredInput: (kotlinx.serialization.json.JsonElement, Map<String, String>) -> Unit,
) {
    val labels = remember(item.messages) { buildTurnSectionLabels(item.messages) }
    val summary = remember(item.messages) { buildTurnSectionSummary(item.messages) }
    val replyIndex = remember(item.messages) {
        item.messages.indexOfLast { it.role == MessageRole.ASSISTANT && it.kind == com.coderover.android.data.model.MessageKind.CHAT }
    }
    val isLive = item.messages.any(ChatMessage::isStreaming)
    val hasPendingInput = item.messages.any { it.kind == com.coderover.android.data.model.MessageKind.USER_INPUT_PROMPT }
    val isCollapsible = !isLive && !hasPendingInput && item.messages.size > 3
    var isExpanded by rememberSaveable(item.turnId) { mutableStateOf(!isCollapsible) }
    val visibleMessages = remember(item.messages, isExpanded) {
        if (isExpanded || !isCollapsible) item.messages else buildCollapsedTurnMessages(item.messages)
    }
    val hiddenCount = (item.messages.size - visibleMessages.size).coerceAtLeast(0)
    val collapsedPreview = remember(item.messages) { buildCollapsedTurnPreview(item.messages) }
    val liveAccent = item.messages
        .firstOrNull { it.isStreaming }
        ?.let { message ->
            when {
                message.role == MessageRole.ASSISTANT -> MaterialTheme.colorScheme.primary
                else -> systemAccentColor(message.kind)
            }
        }
        ?: MaterialTheme.colorScheme.outline
    LaunchedEffect(isCollapsible, isLive) {
        if (!isCollapsible || isLive) {
            isExpanded = true
        }
    }
    Surface(
        shape = RoundedCornerShape(26.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.22f),
        border = androidx.compose.foundation.BorderStroke(1.dp, Border.copy(alpha = 0.7f)),
        modifier = Modifier
            .fillMaxWidth()
            .animateContentSize(),
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    modifier = Modifier
                        .size(7.dp)
                        .background(liveAccent, CircleShape),
                )
                Text(
                    text = "Turn",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                StatusTag(
                    text = summary.statusLabel,
                    containerColor = liveAccent.copy(alpha = 0.12f),
                    contentColor = liveAccent,
                )
                labels.take(4).forEach { label ->
                    TurnSectionLabelChip(label)
                }
                if (item.messages.any(ChatMessage::isStreaming)) {
                    StatusTag(
                        text = "LIVE",
                        containerColor = liveAccent.copy(alpha = 0.12f),
                        contentColor = liveAccent,
                    )
                }
                Spacer(Modifier.weight(1f))
                if (isCollapsible) {
                    TextButton(onClick = { isExpanded = !isExpanded }) {
                        Text(if (isExpanded) "Collapse" else "Expand")
                    }
                }
            }
            Text(
                text = summary.detail,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            AnimatedVisibility(
                visible = !isExpanded && collapsedPreview != null,
                enter = fadeIn() + expandVertically(),
                exit = fadeOut() + shrinkVertically(),
            ) {
                collapsedPreview?.let { preview ->
                    Surface(
                        shape = RoundedCornerShape(16.dp),
                        color = MaterialTheme.colorScheme.surface.copy(alpha = 0.7f),
                    ) {
                        Column(
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
                            verticalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            Text(
                                text = preview.title,
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Text(
                                text = preview.body,
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurface,
                                maxLines = 4,
                                overflow = TextOverflow.Ellipsis,
                            )
                            if (hiddenCount > 0) {
                                Text(
                                    text = "$hiddenCount earlier item${if (hiddenCount == 1) "" else "s"} hidden",
                                    style = MaterialTheme.typography.labelMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                }
            }
            AnimatedVisibility(
                visible = isExpanded || !isCollapsible,
                enter = fadeIn() + expandVertically(),
                exit = fadeOut() + shrinkVertically(),
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    visibleMessages.forEachIndexed { index, message ->
                        val originalIndex = item.messages.indexOfFirst { it.id == message.id }
                        val replyPresentation = if (originalIndex == replyIndex && message.role == MessageRole.ASSISTANT) {
                            if (message.isStreaming) ReplyPresentation.DRAFT else ReplyPresentation.FINAL
                        } else {
                            null
                        }
                        if (originalIndex == replyIndex && index > 0) {
                            ReplyMarker(isStreaming = message.isStreaming)
                        }
                        TurnMessageBubble(
                            message = message,
                            onSubmitStructuredInput = onSubmitStructuredInput,
                            grouped = true,
                            replyPresentation = replyPresentation,
                            copyBlockText = copyBlockTextByMessageId[message.id],
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun TurnSectionLabelChip(label: TurnSectionLabelUi) {
    val containerColor: Color
    val contentColor: Color
    when {
        label.isAssistantReply -> {
            containerColor = MaterialTheme.colorScheme.primary.copy(alpha = 0.12f)
            contentColor = MaterialTheme.colorScheme.primary
        }

        label.kind != null -> {
            val accent = systemAccentColor(label.kind)
            containerColor = accent.copy(alpha = 0.12f)
            contentColor = accent
        }

        else -> {
            containerColor = MaterialTheme.colorScheme.surface
            contentColor = MaterialTheme.colorScheme.onSurfaceVariant
        }
    }
    StatusTag(
        text = label.text,
        containerColor = containerColor,
        contentColor = contentColor,
    )
}

@Composable
private fun ReplyMarker(isStreaming: Boolean) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(
            modifier = Modifier
                .weight(1f)
                .height(1.dp)
                .background(Border.copy(alpha = 0.75f)),
        )
        Text(
            text = if (isStreaming) "Draft reply" else "Final reply",
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
