package com.coderover.android.ui.turn

import com.coderover.android.data.model.ChatMessage
import com.coderover.android.data.model.CommandPhase
import com.coderover.android.data.model.MessageKind
import com.coderover.android.data.model.MessageRole
import com.coderover.android.ui.shared.relativeTimeLabel

internal sealed interface TimelineRenderItem {
    val key: String

    data class Message(val message: ChatMessage) : TimelineRenderItem {
        override val key: String = "message:${message.id}"
    }

    data class TurnSection(
        val turnId: String,
        val messages: List<ChatMessage>,
    ) : TimelineRenderItem {
        override val key: String = buildString {
            append("turn:")
            append(turnId)
            append(':')
            append(messages.firstOrNull()?.id)
            append(':')
            append(messages.lastOrNull()?.id)
        }
    }
}

internal data class TurnSectionLabelUi(
    val text: String,
    val kind: MessageKind? = null,
    val isAssistantReply: Boolean = false,
)

internal data class TurnSectionSummaryUi(
    val statusLabel: String,
    val detail: String,
)

internal data class CollapsedTurnPreviewUi(
    val title: String,
    val body: String,
)

internal enum class ReplyPresentation {
    DRAFT,
    FINAL,
}

internal fun projectTimelineMessages(messages: List<ChatMessage>): List<ChatMessage> {
    val reordered = enforceIntraTurnOrder(messages)
    val collapsedThinking = collapseConsecutiveThinkingMessages(reordered)
    val dedupedFileChanges = removeDuplicateFileChangeMessages(collapsedThinking)
    return removeDuplicateAssistantMessages(dedupedFileChanges)
}

internal fun buildTimelineRenderItems(messages: List<ChatMessage>): List<TimelineRenderItem> {
    return messages.map(TimelineRenderItem::Message)
}

internal fun buildTurnSectionLabels(messages: List<ChatMessage>): List<TurnSectionLabelUi> {
    val labels = mutableListOf<TurnSectionLabelUi>()
    val seen = mutableSetOf<String>()
    messages.forEach { message ->
        val label = when {
            message.role == MessageRole.ASSISTANT && message.kind == MessageKind.CHAT ->
                TurnSectionLabelUi(text = "Reply", isAssistantReply = true)

            message.role == MessageRole.SYSTEM ->
                TurnSectionLabelUi(
                    text = systemMessageTitle(message.kind),
                    kind = message.kind,
                )

            else -> null
        } ?: return@forEach
        val key = "${label.text}:${label.kind}:${label.isAssistantReply}"
        if (seen.add(key)) {
            labels += label
        }
    }
    return labels
}

internal fun buildTurnSectionSummary(messages: List<ChatMessage>): TurnSectionSummaryUi {
    val statusLabel = when {
        messages.any(ChatMessage::isStreaming) -> "Running"
        messages.any { it.kind == MessageKind.USER_INPUT_PROMPT } -> "Input needed"
        messages.any { it.commandState?.phase == CommandPhase.FAILED } -> "Needs attention"
        messages.any { it.commandState?.phase == CommandPhase.STOPPED } -> "Stopped"
        else -> "Completed"
    }
    val lastTimestamp = messages.maxOfOrNull(ChatMessage::createdAt)
    val relativeTime = relativeTimeLabel(lastTimestamp)
    val systemCount = messages.count { it.role == MessageRole.SYSTEM }
    val assistantCount = messages.count { it.role == MessageRole.ASSISTANT }
    val detailParts = buildList {
        add("${messages.size} items")
        if (systemCount > 0) {
            add("$systemCount updates")
        }
        if (assistantCount > 0) {
            add("$assistantCount replies")
        }
        relativeTime?.let(::add)
    }
    return TurnSectionSummaryUi(
        statusLabel = statusLabel,
        detail = detailParts.joinToString(" · "),
    )
}

internal fun buildCollapsedTurnMessages(messages: List<ChatMessage>): List<ChatMessage> {
    if (messages.size <= 2) {
        return messages
    }
    val preserved = linkedMapOf<String, ChatMessage>()
    messages.lastOrNull()?.let { preserved[it.id] = it }
    messages
        .lastOrNull { it.role == MessageRole.ASSISTANT && it.kind == MessageKind.CHAT }
        ?.let { preserved[it.id] = it }
    return messages.filter { preserved.containsKey(it.id) }
}

internal fun buildCollapsedTurnPreview(messages: List<ChatMessage>): CollapsedTurnPreviewUi? {
    val assistantReply = messages.lastOrNull { it.role == MessageRole.ASSISTANT && it.kind == MessageKind.CHAT }
    if (assistantReply != null && assistantReply.text.isNotBlank()) {
        return CollapsedTurnPreviewUi(
            title = if (assistantReply.isStreaming) "Draft reply" else "Final reply",
            body = assistantReply.text.trim(),
        )
    }
    val latestSystem = messages.lastOrNull { it.role == MessageRole.SYSTEM && it.text.isNotBlank() } ?: return null
    return CollapsedTurnPreviewUi(
        title = systemMessageTitle(latestSystem.kind),
        body = latestSystem.text.trim(),
    )
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
            MessageKind.CHAT, MessageKind.PLAN -> 3
            MessageKind.FILE_CHANGE -> 5
            MessageKind.USER_INPUT_PROMPT -> 6
        }

        MessageRole.ASSISTANT -> 4
    }
}

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
            val itemScope = normalizedIdentifier(message.itemId) ?: "no-item"
            val key = "$turnId|$itemScope|$normalizedText"
            if (seenTurnScoped.add(key)) {
                result += message
            }
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
    val normalizedText = message.text.trim()
    val turnId = normalizedIdentifier(message.turnId) ?: return null
    if (normalizedText.isEmpty()) {
        return null
    }
    return "$turnId|$normalizedText"
}

private fun normalizedIdentifier(value: String?): String? {
    val trimmed = value?.trim().orEmpty()
    return trimmed.ifEmpty { null }
}
