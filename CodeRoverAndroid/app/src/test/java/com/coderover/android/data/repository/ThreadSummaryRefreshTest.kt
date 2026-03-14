package com.coderover.android.data.repository

import com.coderover.android.data.model.AppState
import com.coderover.android.data.model.ChatMessage
import com.coderover.android.data.model.ConnectionPhase
import com.coderover.android.data.model.MessageKind
import com.coderover.android.data.model.MessageRole
import com.coderover.android.data.model.ThreadHistoryState
import com.coderover.android.data.model.ThreadSummary
import com.coderover.android.data.model.ThreadSyncState
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
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

    @Test
    fun selectedCodexThreadIdForTailSyncRequiresConnectedRunningSelectedThread() {
        val runningThread = ThreadSummary(id = "thread-running", provider = "claude")
        val connectedState = AppState(
            connectionPhase = ConnectionPhase.CONNECTED,
            threads = listOf(runningThread),
            selectedThreadId = runningThread.id,
            runningThreadIds = setOf(runningThread.id),
        )

        assertEquals("thread-running", connectedState.selectedCodexThreadIdForTailSync())
        assertNull(connectedState.copy(connectionPhase = ConnectionPhase.OFFLINE).selectedCodexThreadIdForTailSync())
        assertNull(connectedState.copy(runningThreadIds = emptySet()).selectedCodexThreadIdForTailSync())
    }

    @Test
    fun shouldRequestRealtimeHistoryCatchUpSkipsNoGapAndSameTailItem() {
        assertFalse(
            shouldRequestRealtimeHistoryCatchUp(
                latestItemId = "item-10",
                incomingItemId = "item-10",
                previousItemId = null,
            ),
        )
        assertFalse(
            shouldRequestRealtimeHistoryCatchUp(
                latestItemId = "item-10",
                incomingItemId = "item-11",
                previousItemId = "item-10",
            ),
        )
        assertTrue(
            shouldRequestRealtimeHistoryCatchUp(
                latestItemId = "item-10",
                incomingItemId = "item-42",
                previousItemId = "item-12",
            ),
        )
    }

    @Test
    fun resolveOlderHistoryLoadRequestBootstrapsWhenCursorMissing() {
        val request = resolveOlderHistoryLoadRequest(
            historyState = null,
            localMessages = emptyList(),
        )

        assertTrue(request.shouldBootstrapTail)
        assertNull(request.cursor)
    }

    @Test
    fun resolveOlderHistoryLoadRequestUsesOldestCursorWhenAvailable() {
        val request = resolveOlderHistoryLoadRequest(
            historyState = ThreadHistoryState(
                oldestCursor = "cursor-11",
                newestCursor = "cursor-20",
                hasOlderOnServer = true,
            ),
            localMessages = listOf(
                ChatMessage(
                    threadId = "thread-1",
                    role = MessageRole.ASSISTANT,
                    kind = MessageKind.CHAT,
                    text = "stale",
                    createdAt = 20L,
                    itemId = "item-20",
                ),
            ),
        )

        assertFalse(request.shouldBootstrapTail)
        assertEquals("cursor-11", request.cursor)
    }

    @Test
    fun normalizedHistoryCursorTrimsWhitespace() {
        assertEquals("cursor-20", normalizedHistoryCursor("  cursor-20 \n"))
        assertNull(normalizedHistoryCursor(" \n "))
    }

    @Test
    fun resolveCursorAndPreviousCursorReadNestedEventPayloads() {
        val payload = JsonObject(
            mapOf(
                "event" to JsonObject(
                    mapOf(
                        "item" to JsonObject(
                            mapOf(
                                "cursor" to JsonPrimitive("cursor-22"),
                                "previousCursor" to JsonPrimitive("cursor-21"),
                            ),
                        ),
                    ),
                ),
            ),
        )

        assertEquals("cursor-22", payload.resolveCursor())
        assertEquals("cursor-21", payload.resolvePreviousCursor())
    }

    @Test
    fun hasOptimisticLocalUserTailMessageMatchesLatestLocalUserForTurn() {
        val messages = listOf(
            ChatMessage(
                threadId = "thread-1",
                role = MessageRole.ASSISTANT,
                kind = MessageKind.CHAT,
                text = "older",
                createdAt = 10L,
                itemId = "item-10",
            ),
            ChatMessage(
                threadId = "thread-1",
                role = MessageRole.USER,
                kind = MessageKind.CHAT,
                text = "hello",
                createdAt = 11L,
            ),
        )

        assertTrue(messages.hasOptimisticLocalUserTailMessage("turn-11"))
        assertFalse(messages.dropLast(1).hasOptimisticLocalUserTailMessage("turn-11"))
    }

    @Test
    fun shouldBypassRealtimeHistoryCatchUpForLocallyStartedTurnWhenServerSeedsUserCursor() {
        val threadId = "thread-1"
        val turnId = "turn-11"
        val state = AppState(
            connectionPhase = ConnectionPhase.CONNECTED,
            selectedThreadId = threadId,
            messagesByThread = mapOf(
                threadId to listOf(
                    ChatMessage(
                        threadId = threadId,
                        role = MessageRole.ASSISTANT,
                        kind = MessageKind.CHAT,
                        text = "older",
                        createdAt = 10L,
                        itemId = "item-10",
                    ),
                    ChatMessage(
                        threadId = threadId,
                        role = MessageRole.USER,
                        kind = MessageKind.CHAT,
                        text = "hello",
                        createdAt = 11L,
                    ),
                ),
            ),
            historyStateByThread = mapOf(
                threadId to ThreadHistoryState(
                    oldestCursor = "cursor-1",
                    newestCursor = "cursor-10",
                ),
            ),
            activeTurnIdByThread = mapOf(threadId to turnId),
            pendingRealtimeSeededTurnIdByThread = mapOf(threadId to turnId),
            runningThreadIds = setOf(threadId),
        )

        assertTrue(
            state.shouldBypassRealtimeHistoryCatchUpForLocallyStartedTurn(
                threadId = threadId,
                turnId = turnId,
                cursor = "cursor-11",
                previousCursor = "cursor-user-11",
            ),
        )
    }

    @Test
    fun shouldBypassRealtimeHistoryCatchUpForLocallyStartedTurnSkipsWithoutPendingSeedState() {
        val threadId = "thread-1"
        val turnId = "turn-11"
        val state = AppState(
            connectionPhase = ConnectionPhase.CONNECTED,
            selectedThreadId = threadId,
            messagesByThread = mapOf(
                threadId to listOf(
                    ChatMessage(
                        threadId = threadId,
                        role = MessageRole.USER,
                        kind = MessageKind.CHAT,
                        text = "hello",
                        createdAt = 11L,
                    ),
                ),
            ),
            activeTurnIdByThread = mapOf(threadId to turnId),
            runningThreadIds = setOf(threadId),
        )

        assertFalse(
            state.shouldBypassRealtimeHistoryCatchUpForLocallyStartedTurn(
                threadId = threadId,
                turnId = turnId,
                cursor = "cursor-11",
                previousCursor = "cursor-user-11",
            ),
        )
    }
}
