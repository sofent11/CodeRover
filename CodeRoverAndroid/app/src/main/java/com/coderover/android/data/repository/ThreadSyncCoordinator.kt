package com.coderover.android.data.repository

internal data class ThreadResumeRequestSignature(
    val projectPath: String?,
    val modelIdentifier: String?,
)

internal data class DecodedThreadSyncMetadata(
    val syncEpoch: Int?,
    val sourceKind: String?,
)

internal class ThreadSyncCoordinator {
    private val threadRefreshGenerationByThreadId = mutableMapOf<String, Long>()
    private val threadSyncEpochByThreadId = mutableMapOf<String, Int>()
    private val threadSyncSourceKindByThreadId = mutableMapOf<String, String>()
    private val threadsNeedingCanonicalHistoryReconcile = mutableSetOf<String>()

    fun invalidateRefreshGeneration(threadId: String) {
        threadRefreshGenerationByThreadId[threadId] =
            (threadRefreshGenerationByThreadId[threadId] ?: 0L) + 1L
    }

    fun currentRefreshGeneration(threadId: String): Long {
        return threadRefreshGenerationByThreadId[threadId] ?: 0L
    }

    fun isRefreshCurrent(threadId: String, generation: Long): Boolean {
        return currentRefreshGeneration(threadId) == generation
    }

    fun acceptThreadSyncMetadata(
        threadId: String,
        syncEpoch: Int?,
        sourceKind: String?,
        generation: Long? = null,
    ): Boolean {
        val incomingEpoch = normalizedSyncEpoch(syncEpoch)
        val currentEpoch = normalizedSyncEpoch(threadSyncEpochByThreadId[threadId])

        if (incomingEpoch < currentEpoch) {
            return false
        }

        if (incomingEpoch == currentEpoch &&
            generation != null &&
            !isRefreshCurrent(threadId, generation)
        ) {
            return false
        }

        threadSyncEpochByThreadId[threadId] = incomingEpoch
        val normalizedSourceKind = sourceKind?.trim()?.takeIf { it.isNotEmpty() }
        if (normalizedSourceKind != null) {
            threadSyncSourceKindByThreadId[threadId] = normalizedSourceKind
        }
        return true
    }

    fun markThreadNeedingCanonicalHistoryReconcile(threadId: String) {
        threadsNeedingCanonicalHistoryReconcile += threadId
    }

    fun markThreadCanonicalHistoryReconciled(threadId: String) {
        threadsNeedingCanonicalHistoryReconcile -= threadId
    }

    fun needsCanonicalHistoryReconcile(threadId: String): Boolean {
        return threadId in threadsNeedingCanonicalHistoryReconcile
    }

    fun clearThread(threadId: String) {
        invalidateRefreshGeneration(threadId)
        threadSyncEpochByThreadId.remove(threadId)
        threadSyncSourceKindByThreadId.remove(threadId)
        threadsNeedingCanonicalHistoryReconcile.remove(threadId)
    }

    fun clearAll() {
        (threadRefreshGenerationByThreadId.keys + threadSyncEpochByThreadId.keys + threadSyncSourceKindByThreadId.keys)
            .toSet()
            .forEach(::invalidateRefreshGeneration)
        threadSyncEpochByThreadId.clear()
        threadSyncSourceKindByThreadId.clear()
        threadsNeedingCanonicalHistoryReconcile.clear()
    }

    private fun normalizedSyncEpoch(value: Int?): Int {
        return if (value != null && value >= 1) value else 1
    }
}
