package com.coderover.android.ui.turn

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
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.coderover.android.app.AppViewModel
import com.coderover.android.data.model.AccessMode
import com.coderover.android.data.model.AppState
import com.coderover.android.data.model.CodeRoverRateLimitBucket
import com.coderover.android.data.model.CodeRoverRateLimitDisplayRow
import com.coderover.android.data.model.CodeRoverRateLimitWindow
import com.coderover.android.data.model.CodeRoverReviewTarget
import com.coderover.android.data.model.ContextWindowUsage
import com.coderover.android.data.model.ImageAttachment
import com.coderover.android.data.model.TurnSkillMention
import com.coderover.android.data.model.ChatMessage
import com.coderover.android.ui.theme.monoFamily
import androidx.compose.animation.core.*
import androidx.compose.ui.graphics.graphicsLayer
import kotlinx.coroutines.launch

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
    onSend: (String, List<ImageAttachment>, List<TurnSkillMention>, Boolean) -> Unit,
    onStartReview: (String, CodeRoverReviewTarget, String?) -> Unit,
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
    val coroutineScope = rememberCoroutineScope()
    var isShowingStatusSheet by remember(thread.id) { mutableStateOf(false) }
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
    val historyState = state.historyStateByThread[thread.id]
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
        hasOlderHistory = historyState?.hasOlderOnServer == true,
        isLoadingOlderHistory = historyState?.isLoadingOlder == true,
        onLoadOlderHistory = {
            coroutineScope.launch {
                viewModel.loadOlderThreadHistory(thread.id)
            }
        },
        isRunning = isRunning,
        activeTurnId = state.activeTurnIdByThread[thread.id],
        assistantRevertPresentationByMessageId = state.assistantRevertPresentationByMessageId,
        turnViewModel = turnViewModel,
        pendingApproval = pendingApproval,
        onInputChanged = onInputChanged,
        onSend = onSend,
        onStartReview = onStartReview,
        onShowStatus = {
            isShowingStatusSheet = true
            viewModel.refreshContextWindowUsage(thread.id)
            viewModel.refreshRateLimits()
        },
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

    if (isShowingStatusSheet && state.activeRuntimeProviderId == "codex") {
        TurnStatusSheet(
            contextWindowUsage = state.contextWindowUsage,
            rateLimitBuckets = state.rateLimitBuckets,
            isLoadingRateLimits = state.isLoadingRateLimits,
            rateLimitsErrorMessage = state.rateLimitsErrorMessage,
            onDismiss = { isShowingStatusSheet = false },
        )
    }
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

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TurnStatusSheet(
    contextWindowUsage: ContextWindowUsage?,
    rateLimitBuckets: List<CodeRoverRateLimitBucket>,
    isLoadingRateLimits: Boolean,
    rateLimitsErrorMessage: String?,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        containerColor = Color.Transparent,
        dragHandle = null,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 18.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Surface(
                modifier = Modifier.fillMaxWidth(),
                shape = androidx.compose.foundation.shape.RoundedCornerShape(30.dp),
                color = MaterialTheme.colorScheme.surface.copy(alpha = 0.96f),
                tonalElevation = 8.dp,
                shadowElevation = 10.dp,
            ) {
                Column(
                    modifier = Modifier.padding(horizontal = 18.dp, vertical = 18.dp),
                    verticalArrangement = Arrangement.spacedBy(18.dp),
                ) {
                    Text("Status", style = MaterialTheme.typography.titleMedium)

                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        val percentRemaining = contextWindowUsage?.let { (100 - it.percentUsed).coerceAtLeast(0) }
                        MetricRow(
                            label = "Context",
                            value = percentRemaining?.let { "$it% left" } ?: "Unavailable",
                            detail = contextWindowUsage?.let {
                                "(${it.tokensUsedFormatted} used / ${it.tokenLimitFormatted})"
                            } ?: "Waiting for token usage",
                        )
                        LinearProgressIndicator(
                            progress = { contextWindowUsage?.fractionUsed ?: 0f },
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }

                    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text("Rate limits", style = MaterialTheme.typography.titleSmall)
                        val rows = dedupeRateLimitRows(rateLimitBuckets)
                        when {
                            rows.isNotEmpty() -> {
                                rows.forEach { row ->
                                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                        MetricRow(
                                            label = row.label,
                                            value = "${row.window.remainingPercent}% left",
                                            detail = resetLabel(row.window),
                                        )
                                        LinearProgressIndicator(
                                            progress = { row.window.clampedUsedPercent / 100f },
                                            modifier = Modifier.fillMaxWidth(),
                                        )
                                    }
                                }
                            }
                            !rateLimitsErrorMessage.isNullOrBlank() -> {
                                Text(
                                    text = rateLimitsErrorMessage,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            isLoadingRateLimits -> {
                                Text(
                                    text = "Loading current limits...",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            else -> {
                                Text(
                                    text = "Rate limits are unavailable for this account.",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun MetricRow(
    label: String,
    value: String,
    detail: String?,
) {
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(
            text = "$label:",
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(text = value, style = MaterialTheme.typography.bodyLarge)
        if (!detail.isNullOrBlank()) {
            Text(
                text = detail,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

private fun dedupeRateLimitRows(buckets: List<CodeRoverRateLimitBucket>): List<CodeRoverRateLimitDisplayRow> {
    val deduped = linkedMapOf<String, CodeRoverRateLimitDisplayRow>()
    buckets.flatMap { it.displayRows }.forEach { row ->
        val existing = deduped[row.label]
        deduped[row.label] = if (existing == null) {
            row
        } else {
            preferredRateLimitRow(existing, row)
        }
    }
    return deduped.values.sortedWith(
        compareBy<CodeRoverRateLimitDisplayRow>({ it.window.windowDurationMins ?: Int.MAX_VALUE }, { it.label.lowercase() }),
    )
}

private fun preferredRateLimitRow(
    current: CodeRoverRateLimitDisplayRow,
    candidate: CodeRoverRateLimitDisplayRow,
): CodeRoverRateLimitDisplayRow {
    if (candidate.window.clampedUsedPercent != current.window.clampedUsedPercent) {
        return if (candidate.window.clampedUsedPercent > current.window.clampedUsedPercent) candidate else current
    }
    val currentReset = current.window.resetsAtMillis
    val candidateReset = candidate.window.resetsAtMillis
    return when {
        currentReset == null && candidateReset != null -> candidate
        currentReset != null && candidateReset == null -> current
        currentReset != null && candidateReset != null && candidateReset < currentReset -> candidate
        else -> current
    }
}

private fun resetLabel(window: CodeRoverRateLimitWindow): String? {
    val resetsAtMillis = window.resetsAtMillis ?: return null
    val minutes = ((resetsAtMillis - System.currentTimeMillis()) / 60_000L).coerceAtLeast(0)
    return when {
        minutes >= 24 * 60 -> "resets in ${minutes / (24 * 60)}d"
        minutes >= 60 -> "resets in ${minutes / 60}h"
        else -> "resets in ${minutes}m"
    }
}
