package com.coderover.android.data.repository

import com.coderover.android.data.model.QueuedTurnDraft
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import org.junit.Assert.assertEquals
import org.junit.Test

class TurnQueueCoordinatorTest {
    @Test
    fun restoreDeferredAttemptRemovesThenPrependsDraft() {
        val operations = mutableListOf<String>()
        val draft = QueuedTurnDraft(text = "Draft", usePlanMode = false)
        val coordinator = TurnQueueCoordinator(
            scope = CoroutineScope(Dispatchers.Unconfined),
            removeQueuedDraft = { threadId, draftId -> operations += "remove:$threadId:$draftId" },
            prependQueuedDraft = { threadId, restored -> operations += "prepend:$threadId:${restored.id}" },
            pauseQueuedDrafts = { _, _ -> operations += "pause" },
            dispatchDraftTurn = { _, _ -> operations += "dispatch" },
        )

        coordinator.restoreDeferredAttempt(
            threadId = "thread-1",
            attempt = QueuedDraftDrainAttempt(
                draft = draft,
                payload = draft.toDispatchPayload(),
            ),
        )

        assertEquals(
            listOf("remove:thread-1:${draft.id}", "prepend:thread-1:${draft.id}"),
            operations,
        )
    }

    @Test
    fun dispatchAttemptRemovesThenDispatchesPayload() {
        val operations = mutableListOf<String>()
        val draft = QueuedTurnDraft(text = "Draft", usePlanMode = true)
        val coordinator = TurnQueueCoordinator(
            scope = CoroutineScope(Dispatchers.Unconfined),
            removeQueuedDraft = { threadId, draftId -> operations += "remove:$threadId:$draftId" },
            prependQueuedDraft = { threadId, restored -> operations += "prepend:$threadId:${restored.id}" },
            pauseQueuedDrafts = { _, _ -> operations += "pause" },
            dispatchDraftTurn = { threadId, payload -> operations += "dispatch:$threadId:${payload.text}:${payload.usePlanMode}" },
        )

        coordinator.dispatchAttempt(
            threadId = "thread-1",
            attempt = QueuedDraftDrainAttempt(
                draft = draft,
                payload = draft.toDispatchPayload(),
            ),
        )

        assertEquals(
            listOf("remove:thread-1:${draft.id}", "dispatch:thread-1:Draft:true"),
            operations,
        )
    }

    @Test
    fun dispatchAttemptRecoversFailedDrain() {
        val operations = mutableListOf<String>()
        val draft = QueuedTurnDraft(text = "Draft", usePlanMode = false)
        val coordinator = TurnQueueCoordinator(
            scope = CoroutineScope(Dispatchers.Unconfined),
            removeQueuedDraft = { threadId, draftId -> operations += "remove:$threadId:$draftId" },
            prependQueuedDraft = { threadId, restored -> operations += "prepend:$threadId:${restored.id}" },
            pauseQueuedDrafts = { threadId, message -> operations += "pause:$threadId:$message" },
            dispatchDraftTurn = { _, _ -> error("boom") },
        )

        coordinator.dispatchAttempt(
            threadId = "thread-1",
            attempt = QueuedDraftDrainAttempt(
                draft = draft,
                payload = draft.toDispatchPayload(),
            ),
        )

        assertEquals(
            listOf(
                "remove:thread-1:${draft.id}",
                "prepend:thread-1:${draft.id}",
                "pause:thread-1:boom",
            ),
            operations,
        )
    }
}
