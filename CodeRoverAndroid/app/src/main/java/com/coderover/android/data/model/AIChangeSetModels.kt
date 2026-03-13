package com.coderover.android.data.model

import kotlinx.serialization.Serializable
import java.util.UUID

@Serializable
enum class AIFileChangeKind {
    CREATE, UPDATE, DELETE
}

@Serializable
data class AIFileChange(
    val path: String,
    val kind: AIFileChangeKind,
    val additions: Int,
    val deletions: Int,
    val isBinary: Boolean,
    val isRenameOrModeOnly: Boolean,
    val beforeContentHash: String? = null,
    val afterContentHash: String? = null,
)

@Serializable
enum class AIChangeSetStatus {
    COLLECTING, READY, REVERTED, FAILED, NOT_REVERTABLE
}

@Serializable
enum class AIChangeSetSource {
    TURN_DIFF, FILE_CHANGE_FALLBACK
}

@Serializable
data class AIRevertMetadata(
    val revertedAt: Long? = null,
    val revertAttemptedAt: Long? = null,
    val lastRevertError: String? = null,
)

@Serializable
data class AIChangeSet(
    val id: String = UUID.randomUUID().toString(),
    val repoRoot: String? = null,
    val threadId: String,
    val turnId: String,
    val assistantMessageId: String? = null,
    val createdAt: Long = System.currentTimeMillis(),
    val finalizedAt: Long? = null,
    val status: AIChangeSetStatus = AIChangeSetStatus.COLLECTING,
    val source: AIChangeSetSource,
    val forwardUnifiedPatch: String = "",
    val inverseUnifiedPatch: String? = null,
    val patchHash: String = "",
    val fileChanges: List<AIFileChange> = emptyList(),
    val unsupportedReasons: List<String> = emptyList(),
    val revertMetadata: AIRevertMetadata = AIRevertMetadata(),
    val fallbackPatchCount: Int = 0,
)

@Serializable
data class RevertConflict(
    val path: String,
    val message: String,
)

@Serializable
data class RevertPreviewResult(
    val canRevert: Boolean,
    val affectedFiles: List<String>,
    val conflicts: List<RevertConflict>,
    val unsupportedReasons: List<String>,
    val stagedFiles: List<String>,
)

@Serializable
data class RevertApplyResult(
    val success: Boolean,
    val revertedFiles: List<String>,
    val conflicts: List<RevertConflict>,
    val unsupportedReasons: List<String>,
    val stagedFiles: List<String>,
    val status: GitRepoSyncResult? = null,
)

@Serializable
data class AssistantRevertPresentation(
    val title: String,
    val isEnabled: Boolean,
    val helperText: String? = null,
)
