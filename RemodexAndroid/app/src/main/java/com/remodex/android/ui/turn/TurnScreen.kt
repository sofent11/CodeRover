package com.remodex.android.ui.turn

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.togetherWith
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.remodex.android.app.AppViewModel
import com.remodex.android.data.model.AccessMode
import com.remodex.android.data.model.AppState
import com.remodex.android.data.model.CodexImageAttachment
import com.remodex.android.data.model.CodexTurnSkillMention
import com.remodex.android.data.model.ChatMessage
import com.remodex.android.ui.theme.monoFamily
import androidx.compose.animation.core.*
import androidx.compose.ui.graphics.graphicsLayer

@Composable
internal fun PulsingDot(color: Color) {
    val infiniteTransition = rememberInfiniteTransition(label = "pulsing")
    val alpha by infiniteTransition.animateFloat(
        initialValue = 0.4f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(800, easing = LinearEasing),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "alpha",
    )
    Box(
        modifier = Modifier
            .size(8.dp)
            .graphicsLayer(alpha = alpha)
            .background(color, CircleShape),
    )
}

@Composable
fun TurnScreen(
    state: AppState,
    input: String,
    onInputChanged: (String) -> Unit,
    onSend: (String, List<CodexImageAttachment>, List<CodexTurnSkillMention>, Boolean) -> Unit,
    onStop: () -> Unit,
    onReconnect: () -> Unit,
    onSelectModel: (String?) -> Unit,
    onSelectReasoning: (String?) -> Unit,
    onSelectAccessMode: (AccessMode) -> Unit,
    onApprove: () -> Unit,
    onDeny: () -> Unit,
    onSubmitStructuredInput: (kotlinx.serialization.json.JsonElement, Map<String, String>) -> Unit,
    viewModel: AppViewModel,
) {
    val thread = state.selectedThread ?: return
    val turnViewModel = rememberTurnViewModel(thread.id)
    val messages = remember(state.messagesByThread, thread.id) {
        projectTimelineMessages(
            state.messagesByThread[thread.id].orEmpty().sortedBy(ChatMessage::orderIndex),
        )
    }
    val visibleMessages = remember(messages, turnViewModel.visibleTailCount) {
        val startIndex = (messages.size - turnViewModel.visibleTailCount).coerceAtLeast(0)
        messages.drop(startIndex)
    }
    val renderItems = remember(visibleMessages) { buildTimelineRenderItems(visibleMessages) }
    val isRunning = state.runningThreadIds.contains(thread.id)
    val pendingApproval = state.pendingApproval?.takeIf { approval ->
        approval.threadId == null || approval.threadId == thread.id
    }
    TurnConversationContainer(
        state = state,
        input = input,
        messages = visibleMessages,
        renderItems = renderItems,
        hasEarlierMessages = turnViewModel.visibleTailCount < messages.size,
        onLoadEarlierMessages = { turnViewModel.loadEarlierMessages(messages.size) },
        isRunning = isRunning,
        activeTurnId = state.activeTurnIdByThread[thread.id],
        assistantRevertPresentationByMessageId = state.assistantRevertPresentationByMessageId,
        turnViewModel = turnViewModel,
        pendingApproval = pendingApproval,
        onInputChanged = onInputChanged,
        onSend = onSend,
        onStop = onStop,
        onReconnect = onReconnect,
        onSelectModel = onSelectModel,
        onSelectReasoning = onSelectReasoning,
        onSelectAccessMode = onSelectAccessMode,
        onApprove = onApprove,
        onDeny = onDeny,
        onSubmitStructuredInput = onSubmitStructuredInput,
        onTapAssistantRevert = { message ->
            viewModel.revertAssistantMessage(message.id)
        },
        viewModel = viewModel,
    )
}

@Composable
internal fun DetailDialog(
    title: String,
    body: String,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(onClick = onDismiss) {
                Text("Close")
            }
        },
        title = {
            Text(
                text = title,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        },
        text = {
            Text(
                text = body.ifBlank { "No details available." },
                style = MaterialTheme.typography.bodyMedium.copy(fontFamily = monoFamily),
                modifier = Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState()),
            )
        },
    )
}
