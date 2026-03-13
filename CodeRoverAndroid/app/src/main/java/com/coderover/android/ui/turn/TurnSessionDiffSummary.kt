package com.coderover.android.ui.turn

import com.coderover.android.data.model.ChatMessage
import com.coderover.android.data.model.MessageKind
import com.coderover.android.data.model.MessageRole

data class TurnSessionDiffTotals(
    val additions: Int,
    val deletions: Int,
    val distinctDiffCount: Int,
) {
    val hasChanges: Boolean
        get() = additions > 0 || deletions > 0
}

enum class TurnSessionDiffScope {
    UNPUSHED_SESSION,
    WHOLE_THREAD,
}

object TurnSessionDiffResetMarker {
    const val MANUAL_PUSH_ITEM_ID = "git.push.reset.marker"

    fun text(branch: String, remote: String?): String {
        val normalizedBranch = branch.trim()
        val normalizedRemote = remote?.trim()

        if (!normalizedRemote.isNullOrEmpty() && normalizedBranch.isNotEmpty()) {
            return "Push completed on $normalizedRemote/$normalizedBranch."
        }
        if (normalizedBranch.isNotEmpty()) {
            return "Push completed on $normalizedBranch."
        }
        return "Push completed on remote."
    }

    fun isResetMessage(message: ChatMessage): Boolean {
        if (message.role != MessageRole.SYSTEM) return false
        if (message.itemId == MANUAL_PUSH_ITEM_ID) {
            return true
        }

        val normalizedText = message.text.trim().lowercase()

        return normalizedText.startsWith("push completed on ") ||
            normalizedText.startsWith("commit & push completed.")
    }
}

object TurnSessionDiffSummaryCalculator {
    fun totals(
        messages: List<ChatMessage>,
        scope: TurnSessionDiffScope = TurnSessionDiffScope.UNPUSHED_SESSION,
    ): TurnSessionDiffTotals? {
        val relevantMessages = relevantMessages(messages, scope)
        val seenMessageIds = mutableSetOf<String>()
        var additions = 0
        var deletions = 0
        var distinctDiffCount = 0

        for (message in relevantMessages) {
            if (message.role != MessageRole.SYSTEM || message.kind != MessageKind.FILE_CHANGE) continue
            if (!seenMessageIds.add(message.id)) continue

            val summaryEntries = parseFileChangeEntries(message.text)
            if (summaryEntries.isEmpty()) continue

            additions += summaryEntries.sumOf { it.additions }
            deletions += summaryEntries.sumOf { it.deletions }
            distinctDiffCount += 1
        }

        val totals = TurnSessionDiffTotals(
            additions = additions,
            deletions = deletions,
            distinctDiffCount = distinctDiffCount,
        )
        return if (totals.hasChanges) totals else null
    }

    private fun relevantMessages(
        messages: List<ChatMessage>,
        scope: TurnSessionDiffScope,
    ): List<ChatMessage> {
        return when (scope) {
            TurnSessionDiffScope.UNPUSHED_SESSION -> messagesAfterMostRecentPush(messages)
            TurnSessionDiffScope.WHOLE_THREAD -> messages
        }
    }

    private fun messagesAfterMostRecentPush(messages: List<ChatMessage>): List<ChatMessage> {
        val lastPushIndex = messages.indexOfLast { TurnSessionDiffResetMarker.isResetMessage(it) }
        if (lastPushIndex == -1) {
            return messages
        }
        return messages.subList(lastPushIndex + 1, messages.size)
    }
}
