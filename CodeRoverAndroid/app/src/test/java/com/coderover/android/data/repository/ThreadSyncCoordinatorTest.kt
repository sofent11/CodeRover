package com.coderover.android.data.repository

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ThreadSyncCoordinatorTest {
    @Test
    fun lowerSyncEpochIsRejected() {
        val coordinator = ThreadSyncCoordinator()
        val threadId = "thread-1"

        assertTrue(
            coordinator.acceptThreadSyncMetadata(
                threadId = threadId,
                syncEpoch = 3,
                sourceKind = "managed_runtime",
                generation = coordinator.currentRefreshGeneration(threadId),
            ),
        )
        assertFalse(
            coordinator.acceptThreadSyncMetadata(
                threadId = threadId,
                syncEpoch = 2,
                sourceKind = "thread_read_fallback",
                generation = coordinator.currentRefreshGeneration(threadId),
            ),
        )
    }

    @Test
    fun staleGenerationIsRejectedWhenEpochMatches() {
        val coordinator = ThreadSyncCoordinator()
        val threadId = "thread-2"
        val initialGeneration = coordinator.currentRefreshGeneration(threadId)

        assertTrue(
            coordinator.acceptThreadSyncMetadata(
                threadId = threadId,
                syncEpoch = 4,
                sourceKind = "rollout_observer",
                generation = initialGeneration,
            ),
        )

        coordinator.invalidateRefreshGeneration(threadId)

        assertFalse(
            coordinator.acceptThreadSyncMetadata(
                threadId = threadId,
                syncEpoch = 4,
                sourceKind = "rollout_observer",
                generation = initialGeneration,
            ),
        )
        assertTrue(
            coordinator.acceptThreadSyncMetadata(
                threadId = threadId,
                syncEpoch = 4,
                sourceKind = "rollout_observer",
                generation = coordinator.currentRefreshGeneration(threadId),
            ),
        )
    }

    @Test
    fun canonicalReconcileMarkersCanBeSetAndCleared() {
        val coordinator = ThreadSyncCoordinator()
        val threadId = "thread-3"

        coordinator.markThreadNeedingCanonicalHistoryReconcile(threadId)
        assertTrue(coordinator.needsCanonicalHistoryReconcile(threadId))

        coordinator.markThreadCanonicalHistoryReconciled(threadId)
        assertFalse(coordinator.needsCanonicalHistoryReconcile(threadId))
    }
}
