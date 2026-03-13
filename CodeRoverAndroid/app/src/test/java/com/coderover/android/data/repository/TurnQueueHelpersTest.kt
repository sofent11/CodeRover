package com.coderover.android.data.repository

import com.coderover.android.data.model.AppState
import com.coderover.android.data.model.ImageAttachment
import com.coderover.android.data.model.TurnSkillMention
import com.coderover.android.data.model.QueuedTurnDraft
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TurnQueueHelpersTest {
    @Test
    fun threadQueueStatusSurfacesPausedNoticeOnlyWhenThreadIsNotRunning() {
        val pausedOnly = AppState(
            queuePauseMessageByThread = mapOf("thread-1" to "busy"),
        ).threadQueueStatus("thread-1")
        val pausedAndRunning = AppState(
            queuePauseMessageByThread = mapOf("thread-1" to "busy"),
            runningThreadIds = setOf("thread-1"),
        ).threadQueueStatus("thread-1")

        assertTrue(pausedOnly.blocksImmediateSend)
        assertTrue(pausedOnly.shouldSurfacePausedNotice)
        assertTrue(pausedAndRunning.blocksImmediateSend)
        assertFalse(pausedAndRunning.shouldSurfacePausedNotice)
    }

    @Test
    fun queuedDraftToDispatchPayloadPreservesStructuredInputs() {
        val attachment = ImageAttachment(
            thumbnailBase64JPEG = "thumb",
            payloadDataURL = "data:image/jpeg;base64,abc",
            sourceUrl = null,
        )
        val skillMention = TurnSkillMention(
            id = "skill-1",
            name = "review",
            path = "/tmp/review",
        )
        val draft = QueuedTurnDraft(
            text = "Inspect this",
            attachments = listOf(attachment),
            skillMentions = listOf(skillMention),
            usePlanMode = true,
        )

        val payload = draft.toDispatchPayload()

        assertEquals("Inspect this", payload.text)
        assertEquals(listOf(attachment), payload.attachments)
        assertEquals(listOf(skillMention), payload.skillMentions)
        assertTrue(payload.usePlanMode)
    }

    @Test
    fun nextQueuedDraftAttemptBuildsDrainPayloadFromFirstDraft() {
        val firstDraft = QueuedTurnDraft(
            text = "First",
            usePlanMode = false,
        )
        val secondDraft = QueuedTurnDraft(
            text = "Second",
            usePlanMode = true,
        )
        val state = AppState(
            queuedTurnDraftsByThread = mapOf("thread-1" to listOf(firstDraft, secondDraft)),
        )

        val attempt = state.nextQueuedDraftAttempt("thread-1")

        assertEquals(firstDraft, attempt?.draft)
        assertEquals("First", attempt?.payload?.text)
        assertFalse(attempt?.payload?.usePlanMode ?: true)
    }

    @Test
    fun queueStatusDefersDrainWhenRunningOrActiveTurnExists() {
        val idle = ThreadQueueStatus(isPaused = false, isRunning = false)
        val running = ThreadQueueStatus(isPaused = false, isRunning = true)

        assertFalse(idle.shouldDeferQueuedDrain(hasActiveTurnId = false))
        assertTrue(idle.shouldDeferQueuedDrain(hasActiveTurnId = true))
        assertTrue(running.shouldDeferQueuedDrain(hasActiveTurnId = false))
    }

    @Test
    fun restoreQueuedDraftPrependsToExistingQueue() {
        val existing = QueuedTurnDraft(text = "Second", usePlanMode = false)
        val restored = QueuedTurnDraft(text = "First", usePlanMode = true)
        val state = AppState(
            queuedTurnDraftsByThread = mapOf("thread-1" to listOf(existing)),
        )

        val updatedQueue = state.restoreQueuedDraft("thread-1", restored)

        assertEquals(listOf(restored, existing), updatedQueue["thread-1"])
    }

    @Test
    fun queuePauseOutcomeBuildsUserVisibleError() {
        val outcome = queuePauseOutcome(
            threadId = "thread-1",
            message = "Unable to send queued draft.",
        )

        assertEquals("thread-1", outcome.threadId)
        assertEquals("Unable to send queued draft.", outcome.message)
        assertEquals("Queue paused: Unable to send queued draft.", outcome.userVisibleError)
    }

    @Test
    fun queueDrainDecisionSkipsWhenThreadIsPaused() {
        val state = AppState(
            queuePauseMessageByThread = mapOf("thread-1" to "busy"),
            queuedTurnDraftsByThread = mapOf("thread-1" to listOf(QueuedTurnDraft(text = "Draft", usePlanMode = false))),
        )

        val decision = state.queueDrainDecision("thread-1")

        assertTrue(decision is QueueDrainDecision.Skip)
    }

    @Test
    fun queueDrainDecisionDefersWhenThreadHasActiveTurn() {
        val draft = QueuedTurnDraft(text = "Draft", usePlanMode = false)
        val state = AppState(
            queuedTurnDraftsByThread = mapOf("thread-1" to listOf(draft)),
            activeTurnIdByThread = mapOf("thread-1" to "turn-1"),
        )

        val decision = state.queueDrainDecision("thread-1")

        assertTrue(decision is QueueDrainDecision.Defer)
        assertEquals(draft, (decision as QueueDrainDecision.Defer).attempt.draft)
    }

    @Test
    fun queueDrainDecisionDispatchesWhenThreadIsIdle() {
        val draft = QueuedTurnDraft(text = "Draft", usePlanMode = true)
        val state = AppState(
            queuedTurnDraftsByThread = mapOf("thread-1" to listOf(draft)),
        )

        val decision = state.queueDrainDecision("thread-1")

        assertTrue(decision is QueueDrainDecision.Dispatch)
        assertEquals(draft, (decision as QueueDrainDecision.Dispatch).attempt.draft)
    }

    @Test
    fun queueDrainDecisionDispatchCarriesStructuredPayload() {
        val attachment = ImageAttachment(
            thumbnailBase64JPEG = "thumb",
            payloadDataURL = "data:image/jpeg;base64,abc",
            sourceUrl = null,
        )
        val draft = QueuedTurnDraft(
            text = "Draft",
            attachments = listOf(attachment),
            skillMentions = listOf(
                TurnSkillMention(
                    id = "skill-1",
                    name = "review",
                    path = "/tmp/review",
                ),
            ),
            usePlanMode = true,
        )
        val state = AppState(
            queuedTurnDraftsByThread = mapOf("thread-1" to listOf(draft)),
        )

        val decision = state.queueDrainDecision("thread-1")

        assertTrue(decision is QueueDrainDecision.Dispatch)
        val attempt = (decision as QueueDrainDecision.Dispatch).attempt
        assertEquals("Draft", attempt.payload.text)
        assertEquals(listOf(attachment), attempt.payload.attachments)
        assertTrue(attempt.payload.usePlanMode)
    }
}
