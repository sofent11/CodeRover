package com.coderover.android.app

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import com.coderover.android.data.model.AccessMode
import com.coderover.android.data.model.AppFontStyle
import com.coderover.android.data.model.CodeRoverReviewTarget
import com.coderover.android.data.repository.CodeRoverRepository
import com.coderover.android.data.model.ImageAttachment
import com.coderover.android.data.model.TurnSkillMention
import kotlinx.serialization.json.JsonElement
import kotlinx.coroutines.flow.StateFlow

class AppViewModel(application: Application) : AndroidViewModel(application) {
    private val repository = CodeRoverRepository(application.applicationContext)
    val state: StateFlow<com.coderover.android.data.model.AppState> = repository.state

    fun toggleProjectGroupCollapsed(projectId: String) = repository.toggleProjectGroupCollapsed(projectId)

    fun completeOnboarding() = repository.completeOnboarding()

    fun markWhatsNewSeen(version: String) = repository.markWhatsNewSeen(version)

    fun setFontStyle(fontStyle: AppFontStyle) = repository.setFontStyle(fontStyle)

    fun setAccessMode(accessMode: AccessMode) = repository.setAccessMode(accessMode)

    fun setSelectedProviderId(providerId: String) = repository.setSelectedProviderId(providerId)

    fun setSelectedModelId(modelId: String?) = repository.setSelectedModelId(modelId)

    fun setSelectedReasoningEffort(reasoningEffort: String?) = repository.setSelectedReasoningEffort(reasoningEffort)

    fun updateImportText(value: String) = repository.updateImportText(value)

    fun clearLastErrorMessage() = repository.clearLastErrorMessage()

    fun importPairingPayload(rawText: String, resetScanLock: (() -> Unit)? = null) =
        repository.importPairingPayload(rawText, resetScanLock)

    fun confirmPendingPairingTransport(macDeviceId: String, url: String) =
        repository.confirmPendingPairingTransport(macDeviceId, url)

    fun connectActivePairing() = repository.connectActivePairing()

    fun disconnect() = repository.disconnect()

    fun refreshBridgeMetadata() = repository.refreshBridgeMetadata()

    fun setBridgeKeepAwakeEnabled(enabled: Boolean) = repository.setBridgeKeepAwakeEnabled(enabled)

    fun removePairing(macDeviceId: String) = repository.removePairing(macDeviceId)

    fun selectPairing(macDeviceId: String) = repository.selectPairing(macDeviceId)

    fun setPreferredTransport(macDeviceId: String, url: String) = repository.setPreferredTransport(macDeviceId, url)

    fun selectThread(threadId: String) = repository.selectThread(threadId)

    fun clearSelectedThread() = repository.clearSelectedThread()

    fun createThread(preferredProjectPath: String? = null, providerId: String? = null) =
        repository.createThread(preferredProjectPath, providerId)

    fun createManagedWorktreeThread(preferredProjectPath: String, providerId: String? = null) =
        repository.createManagedWorktreeThread(preferredProjectPath, providerId)

    fun deleteThread(threadId: String) = repository.deleteThread(threadId)

    fun archiveThread(threadId: String) = repository.archiveThread(threadId)

    fun unarchiveThread(threadId: String) = repository.unarchiveThread(threadId)

    fun renameThread(threadId: String, name: String) = repository.renameThread(threadId, name)

    fun refreshThreadsIfConnected() = repository.refreshThreadsIfConnected()

    suspend fun loadMoreThreadsForProject(projectKey: String, minimumVisibleCount: Int) =
        repository.loadMoreThreadsForProject(projectKey, minimumVisibleCount)

    fun removeQueuedDraft(threadId: String, draftId: String) = repository.removeQueuedDraft(threadId, draftId)

    fun resumeQueuedDrafts(threadId: String) = repository.resumeQueuedDrafts(threadId)

    fun steerQueuedDraft(threadId: String, draftId: String) = repository.steerQueuedDraft(threadId, draftId)

    fun sendMessage(
        text: String,
        attachments: List<ImageAttachment> = emptyList(),
        skillMentions: List<TurnSkillMention> = emptyList(),
        usePlanMode: Boolean = false,
    ) = repository.sendMessage(text, attachments, skillMentions, usePlanMode)

    fun startReview(
        threadId: String,
        target: CodeRoverReviewTarget,
        baseBranch: String? = null,
    ) = repository.startReview(threadId, target, baseBranch)

    fun refreshContextWindowUsage(threadId: String) = repository.refreshContextWindowUsage(threadId)

    fun refreshRateLimits() = repository.refreshRateLimits()

    fun interruptActiveTurn() = repository.interruptActiveTurn()

    suspend fun loadOlderThreadHistory(threadId: String) = repository.loadOlderThreadHistory(threadId)

    fun approvePendingRequest(approve: Boolean) = repository.approvePendingRequest(approve)

    fun respondToStructuredUserInput(requestId: JsonElement, answersByQuestionId: Map<String, String>) =
        repository.respondToStructuredUserInput(requestId, answersByQuestionId)

    suspend fun fuzzyFileSearch(query: String, threadId: String) = repository.fuzzyFileSearch(query, threadId)

    suspend fun listSkills() = repository.listSkills()

    suspend fun gitStatus(cwd: String) = repository.gitStatus(cwd)

    suspend fun gitBranchesWithStatus(cwd: String) = repository.gitBranchesWithStatus(cwd)

    suspend fun checkoutGitBranch(cwd: String, branch: String) = repository.checkoutGitBranch(cwd, branch)

    suspend fun handoffThreadToManagedWorktree(threadId: String, baseBranch: String? = null) =
        repository.handoffThreadToManagedWorktree(threadId, baseBranch)

    suspend fun handoffThreadToLocal(threadId: String) = repository.handoffThreadToLocal(threadId)

    suspend fun forkThreadToLocal(threadId: String) = repository.forkThreadToLocal(threadId)

    suspend fun forkThreadToManagedWorktree(threadId: String, baseBranch: String? = null) =
        repository.forkThreadToManagedWorktree(threadId, baseBranch)

    fun findLiveThreadForProjectPath(projectPath: String, currentThreadId: String? = null) =
        repository.findLiveThreadForProjectPath(projectPath, currentThreadId)

    fun selectGitBaseBranch(threadId: String, branch: String) = repository.selectGitBaseBranch(threadId, branch)

    suspend fun gitCommit(cwd: String, message: String) = repository.gitCommit(cwd, message)

    suspend fun gitDiff(cwd: String) = repository.gitDiff(cwd)

    fun revertAssistantMessage(messageId: String) = repository.revertAssistantMessage(messageId)

    fun compactThreadContext(threadId: String) = repository.compactThreadContext(threadId)

    suspend fun performGitAction(cwd: String, action: com.coderover.android.data.model.TurnGitActionKind, threadId: String) = repository.performGitAction(cwd, action, threadId)

    suspend fun restartDesktopApp(providerId: String, threadId: String) = repository.restartDesktopApp(providerId, threadId)
}
