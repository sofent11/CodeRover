package com.coderover.android.ui.turn

import com.coderover.android.data.model.ChatMessage
import com.coderover.android.data.model.MessageKind
import com.coderover.android.data.model.MessageRole
import com.coderover.android.data.model.SubagentAction
import org.junit.Assert.assertEquals
import org.junit.Test

class TurnTimelineReducerTest {
    @Test
    fun projectTimelineMessagesKeepsLatestDuplicateSubagentActionPerTurn() {
        val baseAction = SubagentAction(
            tool = "spawnAgent",
            status = "in_progress",
            receiverThreadIds = listOf("child-1"),
        )
        val messages = listOf(
            ChatMessage(
                id = "subagent-1",
                threadId = "thread-1",
                role = MessageRole.SYSTEM,
                kind = MessageKind.SUBAGENT_ACTION,
                text = "Spawning 1 agent",
                turnId = "turn-1",
                orderIndex = 1,
                subagentAction = baseAction,
            ),
            ChatMessage(
                id = "subagent-2",
                threadId = "thread-1",
                role = MessageRole.SYSTEM,
                kind = MessageKind.SUBAGENT_ACTION,
                text = "Spawning 1 agent",
                turnId = "turn-1",
                orderIndex = 2,
                subagentAction = baseAction,
            ),
        )

        val projected = projectTimelineMessages(messages)

        assertEquals(listOf("subagent-2"), projected.map { it.id })
    }
}
