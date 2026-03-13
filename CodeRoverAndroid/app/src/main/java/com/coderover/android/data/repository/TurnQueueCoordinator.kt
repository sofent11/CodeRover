package com.coderover.android.data.repository

import com.coderover.android.data.model.QueuedTurnDraft
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

internal class TurnQueueCoordinator(
    private val scope: CoroutineScope,
    private val removeQueuedDraft: (threadId: String, draftId: String) -> Unit,
    private val prependQueuedDraft: (threadId: String, draft: QueuedTurnDraft) -> Unit,
    private val pauseQueuedDrafts: (threadId: String, message: String) -> Unit,
    private val dispatchDraftTurn: suspend (threadId: String, payload: TurnDraftDispatchPayload) -> Unit,
) {
    fun restoreDeferredAttempt(
        threadId: String,
        attempt: QueuedDraftDrainAttempt,
    ) {
        removeQueuedDraft(threadId, attempt.draft.id)
        prependQueuedDraft(threadId, attempt.draft)
    }

    fun dispatchAttempt(
        threadId: String,
        attempt: QueuedDraftDrainAttempt,
    ) {
        removeQueuedDraft(threadId, attempt.draft.id)
        scope.launch {
            runCatching {
                dispatchDraftTurn(threadId, attempt.payload)
            }.onFailure { failure ->
                recoverFailedAttempt(
                    threadId = threadId,
                    attempt = attempt,
                    message = failure.message ?: "Unable to send queued draft.",
                )
            }
        }
    }

    fun recoverFailedAttempt(
        threadId: String,
        attempt: QueuedDraftDrainAttempt,
        message: String,
    ) {
        prependQueuedDraft(threadId, attempt.draft)
        pauseQueuedDrafts(threadId, message)
    }
}
