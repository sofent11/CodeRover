package com.coderover.android.ui.turn

import com.coderover.android.data.model.ChatMessage
import com.coderover.android.data.model.MessageKind
import com.coderover.android.data.model.MessageRole

internal sealed interface TimelineRenderItem {
    val key: String

    data class Message(val message: ChatMessage) : TimelineRenderItem {
        override val key: String = "message:${message.id}"
    }

    data class CommandBurst(val messages: List<ChatMessage>) : TimelineRenderItem {
        override val key: String = buildString {
            append("command-burst:")
            append(messages.firstOrNull()?.id ?: "unknown")
        }
    }
}

internal enum class ReplyPresentation {
    DRAFT,
    FINAL,
}

internal fun projectTimelineMessages(messages: List<ChatMessage>): List<ChatMessage> {
    val visibleMessages = removeHiddenSystemMarkers(messages)
    val suppressedCommandMetadata = removeDuplicateCommandMetadataMessages(visibleMessages)
    val reordered = enforceIntraTurnOrder(suppressedCommandMetadata)
    val collapsedThinking = collapseConsecutiveThinkingMessages(reordered)
    val dedupedFileChanges = removeDuplicateFileChangeMessages(collapsedThinking)
    val dedupedSubagentActions = removeDuplicateSubagentActionMessages(dedupedFileChanges)
    return removeDuplicateAssistantMessages(dedupedSubagentActions)
}

internal fun assistantResponseAnchorMessageId(
    messages: List<ChatMessage>,
    activeTurnId: String?,
): String? {
    if (activeTurnId != null) {
        val message = messages.lastOrNull { it.role == MessageRole.ASSISTANT && it.turnId == activeTurnId }
        if (message != null) {
            return message.id
        }
    }
    return messages.lastOrNull { it.role == MessageRole.ASSISTANT && it.isStreaming }?.id
}

internal fun buildTimelineRenderItems(messages: List<ChatMessage>): List<TimelineRenderItem> {
    if (messages.isEmpty()) {
        return emptyList()
    }

    val items = mutableListOf<TimelineRenderItem>()
    val bufferedCommandMessages = mutableListOf<ChatMessage>()

    fun flushBufferedCommandMessages() {
        if (bufferedCommandMessages.isEmpty()) {
            return
        }
        if (bufferedCommandMessages.size > COMMAND_BURST_COLLAPSED_VISIBLE_COUNT) {
            items += TimelineRenderItem.CommandBurst(bufferedCommandMessages.toList())
        } else {
            items += bufferedCommandMessages.map(TimelineRenderItem::Message)
        }
        bufferedCommandMessages.clear()
    }

    messages.forEach { message ->
        if (!isCommandBurstCandidate(message)) {
            flushBufferedCommandMessages()
            items += TimelineRenderItem.Message(message)
            return@forEach
        }

        val previous = bufferedCommandMessages.lastOrNull()
        if (previous != null && !canShareCommandBurst(previous, message)) {
            flushBufferedCommandMessages()
        }
        bufferedCommandMessages += message
    }

    flushBufferedCommandMessages()
    return items
}

internal const val COMMAND_BURST_COLLAPSED_VISIBLE_COUNT = 5

private fun isCommandBurstCandidate(message: ChatMessage): Boolean {
    return message.role == MessageRole.SYSTEM && message.kind == MessageKind.COMMAND_EXECUTION
}

private fun canShareCommandBurst(previous: ChatMessage, incoming: ChatMessage): Boolean {
    val previousTurnId = normalizedIdentifier(previous.turnId)
    val incomingTurnId = normalizedIdentifier(incoming.turnId)
    if (previousTurnId == null || incomingTurnId == null) {
        return true
    }
    return previousTurnId == incomingTurnId
}

private fun enforceIntraTurnOrder(messages: List<ChatMessage>): List<ChatMessage> {
    val indicesByTurn = mutableMapOf<String, MutableList<Int>>()
    messages.forEachIndexed { index, message ->
        val turnId = normalizedIdentifier(message.turnId) ?: return@forEachIndexed
        indicesByTurn.getOrPut(turnId) { mutableListOf() } += index
    }

    val result = messages.toMutableList()
    indicesByTurn.values.forEach { indices ->
        if (indices.size <= 1) {
            return@forEach
        }
        val turnMessages = indices.map { result[it] }
        val sorted = if (hasInterleavedAssistantThinkingFlow(turnMessages)) {
            turnMessages.sortedWith(
                compareBy<ChatMessage> { it.role != MessageRole.USER }
                    .thenBy(ChatMessage::orderIndex),
            )
        } else {
            turnMessages.sortedWith(
                compareBy<ChatMessage> { intraTurnPriority(it) }
                    .thenBy(ChatMessage::orderIndex),
            )
        }
        indices.forEachIndexed { order, originalIndex ->
            result[originalIndex] = sorted[order]
        }
    }
    return result
}

private fun hasInterleavedAssistantThinkingFlow(messages: List<ChatMessage>): Boolean {
    val assistantItemIds = messages
        .filter { it.role == MessageRole.ASSISTANT }
        .mapNotNull { normalizedIdentifier(it.itemId) }
        .toSet()
    if (assistantItemIds.size > 1) {
        return true
    }

    var hasThinkingBeforeAssistant = false
    var seenAssistant = false
    messages.sortedBy(ChatMessage::orderIndex).forEach { message ->
        if (message.role == MessageRole.ASSISTANT) {
            seenAssistant = true
        } else if (message.role == MessageRole.SYSTEM && message.kind == MessageKind.THINKING) {
            if (!seenAssistant) {
                hasThinkingBeforeAssistant = true
            } else if (hasThinkingBeforeAssistant) {
                return true
            }
        }
    }
    return false
}

private fun intraTurnPriority(message: ChatMessage): Int {
    return when (message.role) {
        MessageRole.USER -> 0
        MessageRole.SYSTEM -> when (message.kind) {
            MessageKind.THINKING -> 1
            MessageKind.COMMAND_EXECUTION -> 2
            MessageKind.SUBAGENT_ACTION -> 3
            MessageKind.CHAT, MessageKind.PLAN -> 4
            MessageKind.FILE_CHANGE -> 5
            MessageKind.USER_INPUT_PROMPT -> 6
        }

        MessageRole.ASSISTANT -> 4
    }
}

private fun removeDuplicateSubagentActionMessages(messages: List<ChatMessage>): List<ChatMessage> {
    val result = mutableListOf<ChatMessage>()
    messages.forEach { message ->
        val action = message.subagentAction
        if (message.role != MessageRole.SYSTEM || message.kind != MessageKind.SUBAGENT_ACTION || action == null) {
            result += message
            return@forEach
        }

        val previous = result.lastOrNull()
        val previousAction = previous?.subagentAction
        if (previous == null ||
            previousAction == null ||
            !shouldMergeSubagentActionMessages(
                previous = previous,
                previousAction = previousAction,
                incoming = message,
                incomingAction = action,
            )
        ) {
            result += message
            return@forEach
        }

        result[result.lastIndex] = preferredSubagentActionMessage(previous, message)
    }
    return result
}

private fun shouldMergeSubagentActionMessages(
    previous: ChatMessage,
    previousAction: com.coderover.android.data.model.SubagentAction,
    incoming: ChatMessage,
    incomingAction: com.coderover.android.data.model.SubagentAction,
): Boolean {
    if (previous.role != MessageRole.SYSTEM ||
        previous.kind != MessageKind.SUBAGENT_ACTION ||
        previous.threadId != incoming.threadId ||
        normalizedIdentifier(previous.turnId) != normalizedIdentifier(incoming.turnId) ||
        previousAction.normalizedTool != incomingAction.normalizedTool ||
        previous.text != incoming.text
    ) {
        return false
    }

    val previousItemId = normalizedIdentifier(previous.itemId)
    val incomingItemId = normalizedIdentifier(incoming.itemId)
    if (previousItemId == null || incomingItemId == null || previousItemId != incomingItemId) {
        return false
    }

    val previousRows = previousAction.agentRows
    val incomingRows = incomingAction.agentRows
    if (previousRows.isEmpty() && incomingRows.isNotEmpty()) {
        return true
    }
    return previousRows == incomingRows
}

private fun preferredSubagentActionMessage(previous: ChatMessage, incoming: ChatMessage): ChatMessage {
    val previousRows = previous.subagentAction?.agentRows.orEmpty()
    val incomingRows = incoming.subagentAction?.agentRows.orEmpty()
    if (previousRows.isEmpty() && incomingRows.isNotEmpty()) {
        return incoming
    }
    if (incoming.isStreaming != previous.isStreaming) {
        return if (incoming.isStreaming) previous else incoming
    }
    return if (incoming.orderIndex >= previous.orderIndex) incoming else previous
}

private fun removeHiddenSystemMarkers(messages: List<ChatMessage>): List<ChatMessage> {
    return messages.filterNot { message ->
        message.role == MessageRole.SYSTEM && message.itemId == TurnSessionDiffResetMarker.MANUAL_PUSH_ITEM_ID
    }
}

private fun removeDuplicateCommandMetadataMessages(messages: List<ChatMessage>): List<ChatMessage> {
    val commandTurnIds = messages
        .filter { it.role == MessageRole.SYSTEM && it.kind == MessageKind.COMMAND_EXECUTION }
        .mapNotNull { normalizedIdentifier(it.turnId) }
        .toSet()
    if (commandTurnIds.isEmpty()) {
        return messages
    }
    return messages.filterNot { message ->
        val turnId = normalizedIdentifier(message.turnId) ?: return@filterNot false
        turnId in commandTurnIds && isCommandMetadataTranscript(message)
    }
}

private fun isCommandMetadataTranscript(message: ChatMessage): Boolean {
    if (message.role != MessageRole.SYSTEM || message.kind != MessageKind.CHAT) {
        return false
    }
    val text = message.text.trim()
    if (text.isEmpty()) {
        return false
    }
    val normalized = text.lowercase()
    val hasCommandHeader = normalized.startsWith("output:")
    val hasMetadataMarkers = COMMAND_METADATA_MARKERS.any(normalized::contains)
    val hasTranscriptCommands = text
        .lineSequence()
        .map(String::trim)
        .count { line -> COMMAND_TRANSCRIPT_LINE_PREFIXES.any(line::startsWith) } >= 1
    return hasCommandHeader && (hasMetadataMarkers || hasTranscriptCommands)
}

private val COMMAND_METADATA_MARKERS = listOf(
    "chunk id:",
    "wall time:",
    "original token count:",
    "process running with session id",
    "process exited with code",
)

private val COMMAND_TRANSCRIPT_LINE_PREFIXES = listOf("| <>", "|<", "<>", "$", ">")

private fun collapseConsecutiveThinkingMessages(messages: List<ChatMessage>): List<ChatMessage> {
    val result = mutableListOf<ChatMessage>()
    messages.forEach { message ->
        if (message.role != MessageRole.SYSTEM || message.kind != MessageKind.THINKING) {
            result += message
            return@forEach
        }

        val previous = result.lastOrNull()
        if (previous == null ||
            previous.role != MessageRole.SYSTEM ||
            previous.kind != MessageKind.THINKING ||
            !shouldMergeThinkingRows(previous, message)
        ) {
            result += message
            return@forEach
        }

        val mergedText = mergeThinkingText(previous.text, message.text)
        result[result.lastIndex] = previous.copy(
            text = mergedText,
            isStreaming = message.isStreaming,
            turnId = message.turnId ?: previous.turnId,
            itemId = message.itemId ?: previous.itemId,
        )
    }
    return result
}

private fun shouldMergeThinkingRows(previous: ChatMessage, incoming: ChatMessage): Boolean {
    val previousItemId = normalizedIdentifier(previous.itemId)
    val incomingItemId = normalizedIdentifier(incoming.itemId)
    if (previousItemId != null && incomingItemId != null) {
        return previousItemId == incomingItemId
    }
    if (previousItemId != null || incomingItemId != null) {
        return false
    }
    val previousTurnId = normalizedIdentifier(previous.turnId)
    val incomingTurnId = normalizedIdentifier(incoming.turnId)
    return previousTurnId != null && previousTurnId == incomingTurnId
}

private fun mergeThinkingText(existing: String, incoming: String): String {
    val existingTrimmed = existing.trim()
    val incomingTrimmed = incoming.trim()
    if (incomingTrimmed.isEmpty()) {
        return existingTrimmed
    }
    if (existingTrimmed.isEmpty()) {
        return incomingTrimmed
    }
    val placeholders = setOf("thinking...")
    val existingLower = existingTrimmed.lowercase()
    val incomingLower = incomingTrimmed.lowercase()
    if (incomingLower in placeholders) {
        return existingTrimmed
    }
    if (existingLower in placeholders) {
        return incomingTrimmed
    }
    if (incomingLower == existingLower) {
        return incomingTrimmed
    }
    if (incomingTrimmed.contains(existingTrimmed)) {
        return incomingTrimmed
    }
    if (existingTrimmed.contains(incomingTrimmed)) {
        return existingTrimmed
    }
    return "$existingTrimmed\n$incomingTrimmed"
}

private fun removeDuplicateAssistantMessages(messages: List<ChatMessage>): List<ChatMessage> {
    val seenTurnScoped = mutableSetOf<String>()
    val firstIndexByTurnTextWithoutConcreteItem = mutableMapOf<String, Int>()
    val seenNoTurnByText = mutableMapOf<String, Long>()
    val result = mutableListOf<ChatMessage>()
    messages.forEach { message ->
        if (message.role != MessageRole.ASSISTANT) {
            result += message
            return@forEach
        }
        val normalizedText = message.text.trim()
        if (normalizedText.isEmpty()) {
            result += message
            return@forEach
        }
        val turnId = normalizedIdentifier(message.turnId)
        if (turnId != null) {
            val itemScope = normalizedIdentifier(message.itemId)
            val key = "$turnId|${itemScope ?: "no-item"}|$normalizedText"
            if (key in seenTurnScoped) {
                return@forEach
            }

            val turnTextKey = "$turnId|$normalizedText"
            if (itemScope != null) {
                val existingIndex = firstIndexByTurnTextWithoutConcreteItem[turnTextKey]
                if (existingIndex != null) {
                    result[existingIndex] = message
                    seenTurnScoped += key
                    firstIndexByTurnTextWithoutConcreteItem -= turnTextKey
                    return@forEach
                }
            } else if ("$turnId|no-item|$normalizedText" in seenTurnScoped) {
                return@forEach
            } else {
                firstIndexByTurnTextWithoutConcreteItem[turnTextKey] = result.size
            }

            seenTurnScoped += key
            result += message
            return@forEach
        }
        val previousTimestamp = seenNoTurnByText[normalizedText]
        if (previousTimestamp != null && kotlin.math.abs(message.createdAt - previousTimestamp) <= 12_000L) {
            return@forEach
        }
        seenNoTurnByText[normalizedText] = message.createdAt
        result += message
    }
    return result
}

private fun removeDuplicateFileChangeMessages(messages: List<ChatMessage>): List<ChatMessage> {
    val latestIndexByKey = mutableMapOf<String, Int>()
    messages.forEachIndexed { index, message ->
        val key = duplicateFileChangeKey(message) ?: return@forEachIndexed
        latestIndexByKey[key] = index
    }
    return messages.filterIndexed { index, message ->
        val key = duplicateFileChangeKey(message) ?: return@filterIndexed true
        latestIndexByKey[key] == index
    }
}

private fun duplicateFileChangeKey(message: ChatMessage): String? {
    if (message.role != MessageRole.SYSTEM || message.kind != MessageKind.FILE_CHANGE) {
        return null
    }
    val turnId = normalizedIdentifier(message.turnId) ?: return null
    val summaryKey = fileChangeDedupeKey(message.text)
    if (summaryKey != null) {
        return "$turnId|$summaryKey"
    }
    val normalizedText = message.text.trim()
    if (normalizedText.isEmpty()) {
        return null
    }
    return "$turnId|$normalizedText"
}

private fun normalizedIdentifier(value: String?): String? {
    val trimmed = value?.trim().orEmpty()
    return trimmed.ifEmpty { null }
}
