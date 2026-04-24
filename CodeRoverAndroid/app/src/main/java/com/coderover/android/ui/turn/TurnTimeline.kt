package com.coderover.android.ui.turn

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.clickable
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.unit.dp
import com.coderover.android.data.model.AssistantRevertPresentation
import com.coderover.android.data.model.ChatMessage
import com.coderover.android.data.model.CommandPhase
import com.coderover.android.data.model.MessageRole
import com.coderover.android.ui.theme.monoFamily
import com.coderover.android.ui.theme.Border
import kotlinx.coroutines.launch

private enum class TurnAutoScrollMode {
    FOLLOW_BOTTOM,
    ANCHOR_ASSISTANT_RESPONSE,
    MANUAL,
}

@Composable
internal fun TurnTimeline(
    modifier: Modifier = Modifier,
    messages: List<ChatMessage>,
    renderItems: List<TimelineRenderItem>,
    suppressEmptyState: Boolean = false,
    hasEarlierMessages: Boolean,
    onLoadEarlierMessages: () -> Unit,
    hasOlderHistory: Boolean,
    isLoadingOlderHistory: Boolean,
    onLoadOlderHistory: () -> Unit,
    isRunning: Boolean,
    activeTurnId: String?,
    assistantRevertPresentationByMessageId: Map<String, AssistantRevertPresentation>,
    onTapAssistantRevert: (ChatMessage) -> Unit,
    onTapSubagentThread: (String) -> Unit,
    turnViewModel: TurnViewModel,
    onSubmitStructuredInput: (kotlinx.serialization.json.JsonElement, Map<String, String>) -> Unit,
) {
    val listState = rememberLazyListState()
    val coroutineScope = rememberCoroutineScope()
    var autoScrollMode by rememberSaveable(messages.lastOrNull()?.id) {
        mutableStateOf(TurnAutoScrollMode.FOLLOW_BOTTOM)
    }
    val latestRenderAnchor = remember(renderItems) { renderItems.lastOrNull()?.key }
    val copyBlockTextByMessageId = remember(messages, activeTurnId, isRunning) {
        buildCopyBlockTextByMessageId(
            messages = messages,
            activeTurnId = activeTurnId,
            isThreadRunning = isRunning,
        )
    }
    val aggregatedFileChangeInfo = remember(messages) {
        buildAggregatedFileChangeInfo(messages)
    }
    val isNearBottom by remember(listState, renderItems.size) {
        derivedStateOf {
            if (renderItems.isEmpty()) {
                true
            } else {
                val lastVisibleIndex = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: -1
                lastVisibleIndex >= renderItems.lastIndex - 1
            }
        }
    }

    LaunchedEffect(isNearBottom) {
        turnViewModel.isScrolledToBottom = isNearBottom
        if (isNearBottom && autoScrollMode != TurnAutoScrollMode.ANCHOR_ASSISTANT_RESPONSE) {
            autoScrollMode = TurnAutoScrollMode.FOLLOW_BOTTOM
        }
    }

    LaunchedEffect(listState.isScrollInProgress, isNearBottom) {
        if (shouldEnterManualTimelineScrollMode(
                isScrollInProgress = listState.isScrollInProgress,
                isNearBottom = isNearBottom,
            )
        ) {
            autoScrollMode = TurnAutoScrollMode.MANUAL
        }
    }

    LaunchedEffect(listState.firstVisibleItemIndex, hasOlderHistory, isLoadingOlderHistory) {
        if (listState.firstVisibleItemIndex == 0 && hasOlderHistory && !isLoadingOlderHistory) {
            onLoadOlderHistory()
        }
    }

    LaunchedEffect(turnViewModel.shouldAnchorToAssistantResponse, latestRenderAnchor) {
        if (!turnViewModel.shouldAnchorToAssistantResponse || renderItems.isEmpty()) {
            return@LaunchedEffect
        }
        val anchorId = assistantResponseAnchorMessageId(messages, activeTurnId)
        if (anchorId != null) {
            val anchorIndex = renderItems.indexOfLast { item ->
                renderItemContainsMessage(item, anchorId)
            }
            if (anchorIndex >= 0) {
                autoScrollMode = TurnAutoScrollMode.ANCHOR_ASSISTANT_RESPONSE
                listState.animateScrollToItem(anchorIndex)
                autoScrollMode = TurnAutoScrollMode.MANUAL
            }
        }
        turnViewModel.shouldAnchorToAssistantResponse = false
    }

    LaunchedEffect(latestRenderAnchor, isRunning, autoScrollMode, turnViewModel.isScrolledToBottom) {
        if (renderItems.isEmpty() || autoScrollMode != TurnAutoScrollMode.FOLLOW_BOTTOM || !turnViewModel.isScrolledToBottom) {
            return@LaunchedEffect
        }
        listState.animateScrollToItem(renderItems.lastIndex)
    }

    Box(
        modifier = modifier
            .fillMaxWidth(),
    ) {
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize(),
            verticalArrangement = Arrangement.spacedBy(20.dp),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 148.dp),
        ) {
            if (messages.isEmpty() && !suppressEmptyState) {
                item {
                    TurnTimelineEmptyState(isRunning = isRunning)
                }
            }
            if (hasEarlierMessages) {
                item(key = "load-earlier") {
                    TextButton(
                        onClick = onLoadEarlierMessages,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(
                            text = "Load earlier messages",
                            style = MaterialTheme.typography.labelLarge,
                            color = MaterialTheme.colorScheme.primary,
                        )
                    }
                }
            }
            if (hasOlderHistory || isLoadingOlderHistory) {
                item(key = "load-older-history") {
                    Box(modifier = Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                        Text(
                            text = if (isLoadingOlderHistory) "Loading earlier messages…" else "Earlier messages",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            items(renderItems, key = { it.key }) { item ->
                when (item) {
                    is TimelineRenderItem.Message -> {
                        val message = item.message
                        TurnMessageBubble(
                            message = message,
                            onSubmitStructuredInput = onSubmitStructuredInput,
                            onTapSubagentThread = onTapSubagentThread,
                            copyBlockText = copyBlockTextByMessageId[message.id],
                            aggregatedFileChangePresentation = aggregatedFileChangeInfo.presentationByMessageId[message.id],
                            suppressFileChangeActions = aggregatedFileChangeInfo.suppressedMessageIds.contains(message.id),
                            assistantRevertPresentation = assistantRevertPresentationByMessageId[message.id],
                            onTapAssistantRevert = onTapAssistantRevert,
                        )
                    }

                    is TimelineRenderItem.CommandBurst -> {
                        TurnCommandBurst(
                            item = item,
                            copyBlockTextByMessageId = copyBlockTextByMessageId,
                            assistantRevertPresentationByMessageId = assistantRevertPresentationByMessageId,
                            onTapAssistantRevert = onTapAssistantRevert,
                            onTapSubagentThread = onTapSubagentThread,
                            onSubmitStructuredInput = onSubmitStructuredInput,
                            aggregatedFileChangeInfo = aggregatedFileChangeInfo,
                        )
                    }

                }
            }
        }

        if (renderItems.isNotEmpty() && !isNearBottom) {
            Surface(
                shape = CircleShape,
                tonalElevation = 4.dp,
                shadowElevation = 4.dp,
                color = MaterialTheme.colorScheme.surface.copy(alpha = 0.94f),
                border = BorderStroke(1.dp, Border.copy(alpha = 0.45f)),
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .navigationBarsPadding()
                    .padding(bottom = 74.dp),
            ) {
                IconButton(
                    onClick = {
                        turnViewModel.shouldAnchorToAssistantResponse = false
                        autoScrollMode = TurnAutoScrollMode.FOLLOW_BOTTOM
                        coroutineScope.launch {
                            listState.animateScrollToItem(renderItems.lastIndex)
                        }
                    },
                ) {
                    Icon(
                        Icons.Outlined.KeyboardArrowDown,
                        contentDescription = "Scroll to latest message",
                        modifier = Modifier.padding(1.dp),
                    )
                }
            }
        }
    }
}

internal fun shouldEnterManualTimelineScrollMode(
    isScrollInProgress: Boolean,
    isNearBottom: Boolean,
): Boolean = isScrollInProgress && !isNearBottom

private fun renderItemContainsMessage(item: TimelineRenderItem, messageId: String): Boolean {
    return when (item) {
        is TimelineRenderItem.Message -> item.message.id == messageId
        is TimelineRenderItem.CommandBurst -> item.messages.any { it.id == messageId }
    }
}

@Composable
private fun TurnCommandBurst(
    item: TimelineRenderItem.CommandBurst,
    copyBlockTextByMessageId: Map<String, String>,
    assistantRevertPresentationByMessageId: Map<String, AssistantRevertPresentation>,
    onTapAssistantRevert: (ChatMessage) -> Unit,
    onTapSubagentThread: (String) -> Unit,
    onSubmitStructuredInput: (kotlinx.serialization.json.JsonElement, Map<String, String>) -> Unit,
    aggregatedFileChangeInfo: AggregatedFileChangeInfo,
) {
    var isExpanded by rememberSaveable(item.key) { mutableStateOf(false) }
    val pinnedMessages = remember(item.messages) { item.messages.take(COMMAND_BURST_COLLAPSED_VISIBLE_COUNT) }
    val overflowMessages = remember(item.messages) { item.messages.drop(COMMAND_BURST_COLLAPSED_VISIBLE_COUNT) }

    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        pinnedMessages.forEach { message ->
            TurnMessageBubble(
                message = message,
                onSubmitStructuredInput = onSubmitStructuredInput,
                onTapSubagentThread = onTapSubagentThread,
                copyBlockText = copyBlockTextByMessageId[message.id],
                aggregatedFileChangePresentation = aggregatedFileChangeInfo.presentationByMessageId[message.id],
                suppressFileChangeActions = aggregatedFileChangeInfo.suppressedMessageIds.contains(message.id),
                assistantRevertPresentation = assistantRevertPresentationByMessageId[message.id],
                onTapAssistantRevert = onTapAssistantRevert,
            )
        }

        if (overflowMessages.isNotEmpty()) {
            Surface(
                shape = RoundedCornerShape(12.dp),
                color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.35f),
                border = BorderStroke(1.dp, Border.copy(alpha = 0.22f)),
                modifier = Modifier.clickable { isExpanded = !isExpanded },
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 12.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Icon(
                        imageVector = Icons.AutoMirrored.Outlined.KeyboardArrowRight,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier
                            .rotate(if (isExpanded) 90f else 0f),
                    )
                    Text(
                        text = "+${overflowMessages.size} command steps",
                        style = MaterialTheme.typography.bodySmall.copy(fontFamily = monoFamily),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.weight(1f),
                    )
                    Text(
                        text = if (isExpanded) "Hide" else "Show",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.padding(start = 8.dp),
                    )
                }
            }
        }

        if (isExpanded) {
            overflowMessages.forEach { message ->
                TurnMessageBubble(
                    message = message,
                    onSubmitStructuredInput = onSubmitStructuredInput,
                    onTapSubagentThread = onTapSubagentThread,
                    copyBlockText = copyBlockTextByMessageId[message.id],
                    aggregatedFileChangePresentation = aggregatedFileChangeInfo.presentationByMessageId[message.id],
                    suppressFileChangeActions = aggregatedFileChangeInfo.suppressedMessageIds.contains(message.id),
                    assistantRevertPresentation = assistantRevertPresentationByMessageId[message.id],
                    onTapAssistantRevert = onTapAssistantRevert,
                )
            }
        }
    }
}

internal fun buildCopyBlockTextByMessageId(
    messages: List<ChatMessage>,
    activeTurnId: String?,
    isThreadRunning: Boolean,
): Map<String, String> {
    if (messages.isEmpty()) {
        return emptyMap()
    }
    val result = mutableMapOf<String, String>()
    val stoppedTurnIds = messages
        .filter { it.commandState?.phase == CommandPhase.STOPPED }
        .mapNotNull { it.turnId?.trim()?.takeIf(String::isNotEmpty) }
        .toSet()
    val latestTerminalPhase = messages
        .lastOrNull { it.commandState != null }
        ?.commandState
        ?.phase
    val latestBlockEnd = messages.indexOfLast { it.role != MessageRole.USER }
    var index = messages.lastIndex
    while (index >= 0) {
        if (messages[index].role == MessageRole.USER) {
            index -= 1
            continue
        }
        val blockEnd = index
        var blockStart = index
        while (blockStart > 0 && messages[blockStart - 1].role != MessageRole.USER) {
            blockStart -= 1
        }
        val blockMessages = messages.subList(blockStart, blockEnd + 1)
        val blockText = blockMessages
            .map { it.text.trim() }
            .filter(String::isNotEmpty)
            .joinToString(separator = "\n\n")
        val blockTurnId = blockMessages
            .asReversed()
            .firstNotNullOfOrNull { message -> message.turnId?.trim()?.takeIf(String::isNotEmpty) }
        val isLatestBlock = blockEnd == latestBlockEnd
        val shouldShowCopyButton = when {
            blockText.isBlank() -> false
            blockTurnId != null && stoppedTurnIds.contains(blockTurnId) -> false
            isLatestBlock && latestTerminalPhase == CommandPhase.STOPPED -> false
            !isThreadRunning -> true
            blockTurnId != null && activeTurnId != null -> blockTurnId != activeTurnId
            else -> !isLatestBlock
        }
        if (shouldShowCopyButton) {
            result[messages[blockEnd].id] = blockText
        }
        index = blockStart - 1
    }
    return result
}
