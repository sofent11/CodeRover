package com.coderover.android.data.repository

import com.coderover.android.data.model.AppState
import com.coderover.android.data.model.ImageAttachment
import com.coderover.android.data.model.TurnSkillMention
import com.coderover.android.data.model.QueuedTurnDraft

internal data class ThreadQueueStatus(
    val isPaused: Boolean,
    val isRunning: Boolean,
) {
    val blocksImmediateSend: Boolean
        get() = isPaused || isRunning

    val shouldSurfacePausedNotice: Boolean
        get() = isPaused && !isRunning
}

internal data class TurnDraftDispatchPayload(
    val text: String,
    val attachments: List<ImageAttachment>,
    val skillMentions: List<TurnSkillMention>,
    val usePlanMode: Boolean,
)

internal data class QueuedDraftDrainAttempt(
    val draft: QueuedTurnDraft,
    val payload: TurnDraftDispatchPayload,
)

internal sealed interface QueueDrainDecision {
    data object Skip : QueueDrainDecision
    data class Defer(val attempt: QueuedDraftDrainAttempt) : QueueDrainDecision
    data class Dispatch(val attempt: QueuedDraftDrainAttempt) : QueueDrainDecision
}

internal data class QueuePauseOutcome(
    val threadId: String,
    val message: String,
    val userVisibleError: String,
)

internal fun AppState.threadQueueStatus(threadId: String): ThreadQueueStatus {
    return ThreadQueueStatus(
        isPaused = queuePauseMessageByThread.containsKey(threadId),
        isRunning = runningThreadIds.contains(threadId),
    )
}

internal fun AppState.nextQueuedDraftAttempt(
    threadId: String,
): QueuedDraftDrainAttempt? {
    val draft = queuedTurnDraftsByThread[threadId]?.firstOrNull() ?: return null
    return QueuedDraftDrainAttempt(
        draft = draft,
        payload = draft.toDispatchPayload(),
    )
}

internal fun ThreadQueueStatus.shouldDeferQueuedDrain(
    hasActiveTurnId: Boolean,
): Boolean {
    return isRunning || hasActiveTurnId
}

internal fun AppState.queueDrainDecision(
    threadId: String,
): QueueDrainDecision {
    val queueStatus = threadQueueStatus(threadId)
    if (queueStatus.isPaused) {
        return QueueDrainDecision.Skip
    }
    val attempt = nextQueuedDraftAttempt(threadId) ?: return QueueDrainDecision.Skip
    val hasActiveTurnId = activeTurnIdByThread[threadId] != null
    return if (queueStatus.shouldDeferQueuedDrain(hasActiveTurnId = hasActiveTurnId)) {
        QueueDrainDecision.Defer(attempt)
    } else {
        QueueDrainDecision.Dispatch(attempt)
    }
}

internal fun AppState.restoreQueuedDraft(
    threadId: String,
    draft: QueuedTurnDraft,
): Map<String, List<QueuedTurnDraft>> {
    val currentQueue = queuedTurnDraftsByThread[threadId].orEmpty()
    return queuedTurnDraftsByThread + (threadId to listOf(draft) + currentQueue)
}

internal fun queuePauseOutcome(
    threadId: String,
    message: String,
): QueuePauseOutcome {
    return QueuePauseOutcome(
        threadId = threadId,
        message = message,
        userVisibleError = "Queue paused: $message",
    )
}

internal fun QueuedTurnDraft.toDispatchPayload(): TurnDraftDispatchPayload {
    return TurnDraftDispatchPayload(
        text = text,
        attachments = attachments,
        skillMentions = skillMentions,
        usePlanMode = usePlanMode,
    )
}
