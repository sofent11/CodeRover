package com.coderover.android.data.repository

import com.coderover.android.data.model.ChatMessage
import com.coderover.android.data.model.MessageKind
import com.coderover.android.data.model.MessageRole
import com.coderover.android.data.model.SubagentAction
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CodeRoverTimelineSemanticsTest {
    @Test
    fun mergeStreamingSnapshotTextAvoidsDuplicateOverlapForAppendUpdates() {
        val merged = mergeStreamingSnapshotText(
            existingText = "Thinking about a plan",
            incomingText = " plan and next steps",
        )

        assertEquals("Thinking about a plan and next steps", merged)
    }

    @Test
    fun finalizeCompletedTurnMessagesPrunesPlaceholderThinkingButKeepsRealReasoning() {
        val finalized = finalizeCompletedTurnMessages(
            messages = listOf(
                ChatMessage(
                    id = "thinking-placeholder",
                    threadId = "thread-1",
                    role = MessageRole.SYSTEM,
                    kind = MessageKind.THINKING,
                    text = "Thinking...",
                    turnId = "turn-1",
                    isStreaming = true,
                    orderIndex = 1,
                ),
                ChatMessage(
                    id = "thinking-real",
                    threadId = "thread-1",
                    role = MessageRole.SYSTEM,
                    kind = MessageKind.THINKING,
                    text = "Considering edge cases",
                    turnId = "turn-1",
                    isStreaming = true,
                    orderIndex = 2,
                ),
                ChatMessage(
                    id = "assistant-1",
                    threadId = "thread-1",
                    role = MessageRole.ASSISTANT,
                    kind = MessageKind.CHAT,
                    text = "Done",
                    turnId = "turn-1",
                    isStreaming = true,
                    orderIndex = 3,
                ),
            ),
            turnId = "turn-1",
        )

        assertEquals(listOf("thinking-real", "assistant-1"), finalized.map { it.id })
        assertFalse(finalized.first { it.id == "thinking-real" }.isStreaming)
        assertFalse(finalized.first { it.id == "assistant-1" }.isStreaming)
    }

    @Test
    fun seedCanonicalMessagesForHistoryMergeRetainsItemsOutsideTailCoverage() {
        val existing = listOf(
            ChatMessage(
                id = "item-1",
                threadId = "thread-1",
                role = MessageRole.ASSISTANT,
                text = "first",
                itemId = "item-1",
                timelineOrdinal = 1,
                orderIndex = 1,
            ),
            ChatMessage(
                id = "item-2",
                threadId = "thread-1",
                role = MessageRole.ASSISTANT,
                text = "second",
                itemId = "item-2",
                timelineOrdinal = 2,
                orderIndex = 2,
            ),
            ChatMessage(
                id = "item-3",
                threadId = "thread-1",
                role = MessageRole.ASSISTANT,
                text = "third-local",
                itemId = "item-3",
                timelineOrdinal = 3,
                orderIndex = 3,
            ),
        )
        val incoming = listOf(
            ChatMessage(
                id = "item-3",
                threadId = "thread-1",
                role = MessageRole.ASSISTANT,
                text = "third-server",
                itemId = "item-3",
                timelineOrdinal = 3,
                orderIndex = 3,
            ),
            ChatMessage(
                id = "item-4",
                threadId = "thread-1",
                role = MessageRole.ASSISTANT,
                text = "fourth",
                itemId = "item-4",
                timelineOrdinal = 4,
                orderIndex = 4,
            ),
        )

        val seeded = seedCanonicalMessagesForHistoryMerge(existing, incoming, mode = "tail")

        assertEquals(listOf("item-1", "item-2", "item-3"), seeded.map { it.id })
    }

    @Test
    fun reconcileExistingTimelineMessagePreservesRicherLocalStreamingSnapshot() {
        val reconciled = reconcileExistingTimelineMessage(
            localMessage = ChatMessage(
                id = "thinking-1",
                threadId = "thread-1",
                role = MessageRole.SYSTEM,
                kind = MessageKind.THINKING,
                text = "Thinking about the full solution",
                turnId = "turn-1",
                itemId = "thinking-1",
                isStreaming = true,
                orderIndex = 3,
            ),
            serverMessage = ChatMessage(
                id = "thinking-1",
                threadId = "thread-1",
                role = MessageRole.SYSTEM,
                kind = MessageKind.THINKING,
                text = "Thinking about the full",
                turnId = "turn-1",
                itemId = "thinking-1",
                isStreaming = false,
                timelineStatus = "completed",
                orderIndex = 3,
            ),
            activeThreadIds = setOf("thread-1"),
            runningThreadIds = setOf("thread-1"),
        )

        assertEquals("Thinking about the full solution", reconciled.text)
        assertTrue(reconciled.isStreaming)
        assertEquals("completed", reconciled.timelineStatus)
    }

    @Test
    fun reconcileExistingTimelineMessageCarriesServerSubagentStateIntoLocalMessage() {
        val reconciled = reconcileExistingTimelineMessage(
            localMessage = ChatMessage(
                id = "subagent-1",
                threadId = "thread-1",
                role = MessageRole.SYSTEM,
                kind = MessageKind.SUBAGENT_ACTION,
                text = "Spawning 1 agent",
                turnId = "turn-1",
                itemId = "subagent-1",
                orderIndex = 1,
            ),
            serverMessage = ChatMessage(
                id = "subagent-1",
                threadId = "thread-1",
                role = MessageRole.SYSTEM,
                kind = MessageKind.SUBAGENT_ACTION,
                text = "Spawning 1 agent",
                turnId = "turn-1",
                itemId = "subagent-1",
                subagentAction = SubagentAction(
                    tool = "spawnAgent",
                    status = "completed",
                    receiverThreadIds = listOf("child-1"),
                ),
                orderIndex = 1,
            ),
            activeThreadIds = emptySet(),
            runningThreadIds = emptySet(),
        )

        assertNotNull(reconciled.subagentAction)
        assertEquals(listOf("child-1"), reconciled.subagentAction?.agentRows?.map { it.threadId })
    }
}
