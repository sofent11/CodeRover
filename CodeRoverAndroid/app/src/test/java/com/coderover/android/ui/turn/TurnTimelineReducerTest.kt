package com.coderover.android.ui.turn

import com.coderover.android.data.model.ChatMessage
import com.coderover.android.data.model.MessageKind
import com.coderover.android.data.model.MessageRole
import com.coderover.android.data.model.SubagentAction
import org.junit.Assert.assertEquals
import org.junit.Test

class TurnTimelineReducerTest {
    @Test
    fun projectTimelineMessagesPrefersSubagentActionRowWithResolvedAgents() {
        val placeholderAction = SubagentAction(
            tool = "spawnAgent",
            status = "in_progress",
        )
        val resolvedAction = SubagentAction(
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
                itemId = "item-1",
                subagentAction = placeholderAction,
            ),
            ChatMessage(
                id = "subagent-2",
                threadId = "thread-1",
                role = MessageRole.SYSTEM,
                kind = MessageKind.SUBAGENT_ACTION,
                text = "Spawning 1 agent",
                turnId = "turn-1",
                orderIndex = 2,
                itemId = "item-1",
                subagentAction = resolvedAction,
            ),
        )

        val projected = projectTimelineMessages(messages)

        assertEquals(listOf("subagent-2"), projected.map { it.id })
        assertEquals(listOf("child-1"), projected.single().subagentAction?.agentRows?.map { it.threadId })
    }

    @Test
    fun projectTimelineMessagesDedupesEquivalentFileChangeSummariesWithinTurn() {
        val messages = listOf(
            ChatMessage(
                id = "file-1",
                threadId = "thread-1",
                role = MessageRole.SYSTEM,
                kind = MessageKind.FILE_CHANGE,
                text = "Edited app/src/A.kt +2 -1",
                turnId = "turn-1",
                orderIndex = 1,
            ),
            ChatMessage(
                id = "file-2",
                threadId = "thread-1",
                role = MessageRole.SYSTEM,
                kind = MessageKind.FILE_CHANGE,
                text = "Updated app/src/A.kt +2 -1",
                turnId = "turn-1",
                orderIndex = 2,
            ),
        )

        val projected = projectTimelineMessages(messages)

        assertEquals(listOf("file-2"), projected.map { it.id })
    }

    @Test
    fun projectTimelineMessagesDedupesFileChangesByFallbackTextWhenSummaryKeyIsMissing() {
        val messages = listOf(
            ChatMessage(
                id = "file-1",
                threadId = "thread-1",
                role = MessageRole.SYSTEM,
                kind = MessageKind.FILE_CHANGE,
                text = "Updated file list:\nfoo.txt",
                turnId = "turn-1",
                orderIndex = 1,
            ),
            ChatMessage(
                id = "file-2",
                threadId = "thread-1",
                role = MessageRole.SYSTEM,
                kind = MessageKind.FILE_CHANGE,
                text = "Updated file list:\nfoo.txt",
                turnId = "turn-1",
                orderIndex = 2,
            ),
        )

        val projected = projectTimelineMessages(messages)

        assertEquals(listOf("file-2"), projected.map { it.id })
    }

    @Test
    fun projectTimelineMessagesReplacesTurnScopedAssistantPlaceholderWithConcreteItemMessage() {
        val messages = listOf(
            ChatMessage(
                id = "assistant-1",
                threadId = "thread-1",
                role = MessageRole.ASSISTANT,
                kind = MessageKind.CHAT,
                text = "Final answer",
                turnId = "turn-1",
                orderIndex = 1,
            ),
            ChatMessage(
                id = "assistant-2",
                threadId = "thread-1",
                role = MessageRole.ASSISTANT,
                kind = MessageKind.CHAT,
                text = "Final answer",
                turnId = "turn-1",
                itemId = "item-1",
                orderIndex = 2,
            ),
        )

        val projected = projectTimelineMessages(messages)

        assertEquals(listOf("assistant-2"), projected.map { it.id })
    }

    @Test
    fun projectTimelineMessagesPreservesInterleavedThinkingAssistantOrderWithinTurn() {
        val messages = listOf(
            ChatMessage(
                id = "assistant-1",
                threadId = "thread-1",
                role = MessageRole.ASSISTANT,
                kind = MessageKind.CHAT,
                text = "First answer",
                turnId = "turn-1",
                itemId = "assistant-item-1",
                orderIndex = 3,
            ),
            ChatMessage(
                id = "thinking-1",
                threadId = "thread-1",
                role = MessageRole.SYSTEM,
                kind = MessageKind.THINKING,
                text = "Thinking...",
                turnId = "turn-1",
                itemId = "thinking-item-1",
                orderIndex = 2,
            ),
            ChatMessage(
                id = "thinking-2",
                threadId = "thread-1",
                role = MessageRole.SYSTEM,
                kind = MessageKind.THINKING,
                text = "More thinking",
                turnId = "turn-1",
                itemId = "thinking-item-2",
                orderIndex = 4,
            ),
            ChatMessage(
                id = "assistant-2",
                threadId = "thread-1",
                role = MessageRole.ASSISTANT,
                kind = MessageKind.CHAT,
                text = "Second answer",
                turnId = "turn-1",
                itemId = "assistant-item-2",
                orderIndex = 5,
            ),
            ChatMessage(
                id = "user-1",
                threadId = "thread-1",
                role = MessageRole.USER,
                kind = MessageKind.CHAT,
                text = "Question",
                turnId = "turn-1",
                orderIndex = 1,
            ),
        )

        val projected = projectTimelineMessages(messages)

        assertEquals(
            listOf("user-1", "thinking-1", "assistant-1", "thinking-2", "assistant-2"),
            projected.map { it.id },
        )
    }

    @Test
    fun projectTimelineMessagesPlacesToolActivityBeforeAssistantAndFileChangeWithinTurn() {
        val messages = listOf(
            ChatMessage(
                id = "assistant-1",
                threadId = "thread-1",
                role = MessageRole.ASSISTANT,
                kind = MessageKind.CHAT,
                text = "Answer",
                turnId = "turn-1",
                orderIndex = 3,
            ),
            ChatMessage(
                id = "tool-1",
                threadId = "thread-1",
                role = MessageRole.SYSTEM,
                kind = MessageKind.TOOL_ACTIVITY,
                text = "Read app/src/A.kt",
                turnId = "turn-1",
                orderIndex = 2,
            ),
            ChatMessage(
                id = "file-1",
                threadId = "thread-1",
                role = MessageRole.SYSTEM,
                kind = MessageKind.FILE_CHANGE,
                text = "Edited app/src/A.kt +2 -1",
                turnId = "turn-1",
                orderIndex = 4,
            ),
            ChatMessage(
                id = "user-1",
                threadId = "thread-1",
                role = MessageRole.USER,
                kind = MessageKind.CHAT,
                text = "Question",
                turnId = "turn-1",
                orderIndex = 1,
            ),
        )

        val projected = projectTimelineMessages(messages)

        assertEquals(listOf("user-1", "tool-1", "assistant-1", "file-1"), projected.map { it.id })
    }

    @Test
    fun projectTimelineMessagesMergesDuplicateUserRowsFromRealtimeAndHistory() {
        val messages = listOf(
            ChatMessage(
                id = "user-realtime",
                threadId = "thread-1",
                role = MessageRole.USER,
                kind = MessageKind.CHAT,
                text = "Question",
                turnId = "turn-1",
                orderIndex = 1,
                createdAt = 1_000L,
            ),
            ChatMessage(
                id = "user-history",
                threadId = "thread-1",
                role = MessageRole.USER,
                kind = MessageKind.CHAT,
                text = "Question",
                turnId = "turn-1",
                itemId = "user-item-1",
                orderIndex = 2,
                createdAt = 3_000L,
            ),
            ChatMessage(
                id = "assistant-1",
                threadId = "thread-1",
                role = MessageRole.ASSISTANT,
                kind = MessageKind.CHAT,
                text = "Answer",
                turnId = "turn-1",
                orderIndex = 3,
            ),
        )

        val projected = projectTimelineMessages(messages)

        assertEquals(listOf("user-realtime", "assistant-1"), projected.map { it.id })
        assertEquals("user-item-1", projected.first().itemId)
    }

    @Test
    fun buildAggregatedFileChangeInfoPinsDiffActionsToLastStableFileChangeMessageInBlock() {
        val messages = listOf(
            ChatMessage(
                id = "user-1",
                threadId = "thread-1",
                role = MessageRole.USER,
                kind = MessageKind.CHAT,
                text = "Fix this",
                turnId = "turn-1",
                orderIndex = 1,
            ),
            ChatMessage(
                id = "file-1",
                threadId = "thread-1",
                role = MessageRole.SYSTEM,
                kind = MessageKind.FILE_CHANGE,
                text = "Edited app/src/A.kt +2 -1",
                turnId = "turn-1",
                orderIndex = 2,
            ),
            ChatMessage(
                id = "file-2",
                threadId = "thread-1",
                role = MessageRole.SYSTEM,
                kind = MessageKind.FILE_CHANGE,
                text = "Edited app/src/B.kt +3 -0",
                turnId = "turn-1",
                orderIndex = 3,
            ),
        )

        val aggregated = buildAggregatedFileChangeInfo(messages)

        assertEquals(setOf("file-1"), aggregated.suppressedMessageIds)
        assertEquals(listOf("file-2"), aggregated.presentationByMessageId.keys.toList())
        assertEquals(2, aggregated.presentationByMessageId["file-2"]?.entries?.size)
    }

    @Test
    fun projectTimelineMessagesSuppressesRawCommandMetadataTranscriptWhenCommandRowsExist() {
        val messages = listOf(
            ChatMessage(
                id = "meta-1",
                threadId = "thread-1",
                role = MessageRole.SYSTEM,
                kind = MessageKind.CHAT,
                text = """
                    Output:
                    | <> ls -lh /repo completed
                    Chunk ID: abc123
                    Wall time: 2.1 seconds
                    Process exited with code 0
                    Original token count: 0
                """.trimIndent(),
                turnId = "turn-1",
                orderIndex = 1,
            ),
            ChatMessage(
                id = "command-1",
                threadId = "thread-1",
                role = MessageRole.SYSTEM,
                kind = MessageKind.COMMAND_EXECUTION,
                text = "completed ls -lh /repo",
                turnId = "turn-1",
                orderIndex = 2,
            ),
        )

        val projected = projectTimelineMessages(messages)

        assertEquals(listOf("command-1"), projected.map { it.id })
    }

    @Test
    fun buildTimelineRenderItemsGroupsToolActivityAndCommandExecutionIntoOneBurst() {
        val messages = (1..6).map { index ->
            ChatMessage(
                id = "msg-$index",
                threadId = "thread-1",
                role = MessageRole.SYSTEM,
                kind = if (index.isOdd()) MessageKind.TOOL_ACTIVITY else MessageKind.COMMAND_EXECUTION,
                text = "Tool $index",
                turnId = "turn-1",
                orderIndex = index,
            )
        }

        val items = buildTimelineRenderItems(messages)

        assertEquals(1, items.size)
        val burst = items.single() as TimelineRenderItem.CommandBurst
        assertEquals(messages.map { it.id }, burst.messages.map { it.id })
    }
}

private fun Int.isOdd(): Boolean = this % 2 == 1
