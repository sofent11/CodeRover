package com.coderover.android.data.repository

import com.coderover.android.data.model.ChatMessage
import com.coderover.android.data.model.MessageKind
import com.coderover.android.data.model.MessageRole
import com.coderover.android.data.model.ThreadSummary
import com.coderover.android.data.model.ThreadSyncState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ThreadSummaryRefreshTest {
    @Test
    fun refreshThreadSummaryFromMessagesUpdatesPreviewAndSortOrder() {
        val olderThread = ThreadSummary(
            id = "thread-older",
            preview = "Older preview",
            updatedAt = 100L,
            syncState = ThreadSyncState.LIVE,
        )
        val targetThread = ThreadSummary(
            id = "thread-target",
            preview = "Stale preview",
            updatedAt = 50L,
            syncState = ThreadSyncState.LIVE,
        )
        val messages = listOf(
            ChatMessage(
                threadId = "thread-target",
                role = MessageRole.SYSTEM,
                kind = MessageKind.THINKING,
                text = "Thinking...",
                createdAt = 150L,
            ),
            ChatMessage(
                threadId = "thread-target",
                role = MessageRole.ASSISTANT,
                kind = MessageKind.CHAT,
                text = "Fresh assistant reply\nwith wrap",
                createdAt = 200L,
            ),
        )

        val refreshed = listOf(targetThread, olderThread)
            .refreshThreadSummaryFromMessages("thread-target", messages)

        assertEquals("thread-target", refreshed.first().id)
        assertEquals("Fresh assistant reply with wrap", refreshed.first().preview)
        assertEquals(200L, refreshed.first().updatedAt)
    }

    @Test
    fun sidebarPreviewTextPrefersNonSystemContent() {
        val messages = listOf(
            ChatMessage(
                threadId = "thread-1",
                role = MessageRole.SYSTEM,
                kind = MessageKind.COMMAND_EXECUTION,
                text = "command output",
                createdAt = 100L,
            ),
            ChatMessage(
                threadId = "thread-1",
                role = MessageRole.USER,
                kind = MessageKind.CHAT,
                text = "user question",
                createdAt = 101L,
            ),
        )

        assertEquals("user question", messages.sidebarPreviewText())
    }

    @Test
    fun refreshThreadSummaryFromMessagesCreatesPlaceholderThreadWhenMissing() {
        val messages = listOf(
            ChatMessage(
                threadId = "thread-new",
                role = MessageRole.ASSISTANT,
                kind = MessageKind.CHAT,
                text = "Hello from another device",
                createdAt = 300L,
            ),
        )

        val refreshed = emptyList<ThreadSummary>()
            .refreshThreadSummaryFromMessages("thread-new", messages)

        assertEquals(1, refreshed.size)
        assertEquals("thread-new", refreshed.first().id)
        assertEquals("Hello from another device", refreshed.first().preview)
        assertEquals(ThreadSyncState.LIVE, refreshed.first().syncState)
        assertTrue((refreshed.first().updatedAt ?: 0L) >= 300L)
    }
}
