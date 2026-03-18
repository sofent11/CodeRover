package com.coderover.android.ui.turn

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import com.coderover.android.app.AppViewModel
import com.coderover.android.data.model.AppState
import com.coderover.android.data.model.CodeRoverReviewTarget
import com.coderover.android.data.model.ImageAttachment
import com.coderover.android.data.model.TurnSkillMention
import com.coderover.android.data.model.FuzzyFileMatch
import com.coderover.android.data.model.SkillMetadata
import com.coderover.android.data.model.TurnComposerMentionedFile
import com.coderover.android.data.model.TurnComposerMentionedSkill
import java.util.UUID

data class TurnComposerPresentationState(
    val queuedDraftCount: Int,
    val isQueuePaused: Boolean,
    val hasComposerContent: Boolean,
    val canSend: Boolean,
    val hasPendingReviewSelection: Boolean,
    val hasSubagentsSelection: Boolean,
)

data class TurnQueuePresentationState(
    val draftCount: Int,
    val isPaused: Boolean,
    val pauseMessage: String?,
    val canResume: Boolean,
    val isResuming: Boolean,
    val canSteerDrafts: Boolean,
    val steeringDraftId: String?,
)

data class TurnComposerAttachmentIntakePlan(
    val reservedAttachmentIds: List<String>,
    val droppedCount: Int,
) {
    val acceptedCount: Int
        get() = reservedAttachmentIds.size

    val hasOverflow: Boolean
        get() = droppedCount > 0
}

enum class TurnComposerSlashCommand {
    CODE_REVIEW,
    STATUS,
    SUBAGENTS,
}

enum class TurnComposerReviewTarget {
    UNCOMMITTED_CHANGES,
    BASE_BRANCH,
    ;

    val title: String
        get() = when (this) {
            UNCOMMITTED_CHANGES -> "Uncommitted changes"
            BASE_BRANCH -> "Base branch"
        }

    val serviceTarget: CodeRoverReviewTarget
        get() = when (this) {
            UNCOMMITTED_CHANGES -> CodeRoverReviewTarget.UNCOMMITTED_CHANGES
            BASE_BRANCH -> CodeRoverReviewTarget.BASE_BRANCH
        }
}

data class TurnComposerReviewSelection(
    val command: TurnComposerSlashCommand,
    val target: TurnComposerReviewTarget?,
)

sealed interface TurnComposerSlashCommandPanelState {
    data object Hidden : TurnComposerSlashCommandPanelState
    data class Commands(val query: String) : TurnComposerSlashCommandPanelState
    data object CodeReviewTargets : TurnComposerSlashCommandPanelState
}

data class TurnTrailingSlashCommandToken(
    val query: String,
    val tokenRange: IntRange,
)

class TurnViewModel {
    var isPlanModeArmed by mutableStateOf(false)
    var plusMenuExpanded by mutableStateOf(false)
    var modelMenuExpanded by mutableStateOf(false)
    var reasoningMenuExpanded by mutableStateOf(false)
    var runtimeMenuExpanded by mutableStateOf(false)
    var accessMenuExpanded by mutableStateOf(false)
    var gitMenuExpanded by mutableStateOf(false)
    var steeringDraftId by mutableStateOf<String?>(null)
    var isQueueResuming by mutableStateOf(false)
    var isFocused by mutableStateOf(false)
    var shouldAnchorToAssistantResponse by mutableStateOf(false)
    var isScrolledToBottom by mutableStateOf(true)
    var composerNoticeMessage by mutableStateOf<String?>(null)
    var autocompleteFiles by mutableStateOf<List<FuzzyFileMatch>>(emptyList())
    var autocompleteSkills by mutableStateOf<List<SkillMetadata>>(emptyList())
    var composerMentionedFiles by mutableStateOf<List<TurnComposerMentionedFile>>(emptyList())
    var composerMentionedSkills by mutableStateOf<List<TurnComposerMentionedSkill>>(emptyList())
    var composerAttachments by mutableStateOf<List<TurnComposerImageAttachment>>(emptyList())
    var composerReviewSelection by mutableStateOf<TurnComposerReviewSelection?>(null)
    var isSubagentsSelectionArmed by mutableStateOf(false)
    var slashCommandPanelState by mutableStateOf<TurnComposerSlashCommandPanelState>(TurnComposerSlashCommandPanelState.Hidden)
    var visibleTailCount by mutableStateOf(40)

    var runningGitAction: com.coderover.android.data.model.TurnGitActionKind? by mutableStateOf(null)
    val isRunningGitAction: Boolean
        get() = runningGitAction != null

    val hasConfirmedReviewSelection: Boolean
        get() = composerReviewSelection?.target != null

    val hasPendingReviewSelection: Boolean
        get() = composerReviewSelection != null && composerReviewSelection?.target == null

    val hasComposerContentConflictingWithReview: Boolean
        get() = composerMentionedFiles.isNotEmpty() ||
            composerMentionedSkills.isNotEmpty() ||
            composerAttachments.isNotEmpty() ||
            isSubagentsSelectionArmed

    val hasBlockingAttachmentState: Boolean
        get() = composerAttachments.any {
            it.state == TurnComposerImageAttachmentState.Loading ||
                it.state == TurnComposerImageAttachmentState.Failed
        }

    val readyComposerAttachments: List<ImageAttachment>
        get() = composerAttachments.mapNotNull { attachment ->
            when (val state = attachment.state) {
                is TurnComposerImageAttachmentState.Ready -> state.value
                else -> null
            }
        }

    val remainingAttachmentSlots: Int
        get() = (4 - composerAttachments.size).coerceAtLeast(0)

    val readySkillMentions: List<TurnSkillMention>
        get() = composerMentionedSkills.map { mention ->
            TurnSkillMention(
                id = mention.skillId,
                name = mention.name,
                path = mention.path,
            )
        }

    fun queuePresentation(
        queuedDraftCount: Int,
        queuePauseMessage: String?,
    ): TurnQueuePresentationState {
        val isPaused = queuePauseMessage != null && queuedDraftCount > 0
        val hasQueueActionsInFlight = isQueueResuming || steeringDraftId != null
        return TurnQueuePresentationState(
            draftCount = queuedDraftCount,
            isPaused = isPaused,
            pauseMessage = queuePauseMessage,
            canResume = isPaused && !hasQueueActionsInFlight,
            isResuming = isQueueResuming,
            canSteerDrafts = !isQueueResuming,
            steeringDraftId = steeringDraftId,
        )
    }

    fun composerPresentation(
        input: String,
        isConnected: Boolean,
        queuedDraftCount: Int,
        queuePauseMessage: String?,
    ): TurnComposerPresentationState {
        val hasComposerContent = input.isNotBlank() ||
            composerMentionedFiles.isNotEmpty() ||
            composerMentionedSkills.isNotEmpty() ||
            composerAttachments.isNotEmpty() ||
            hasConfirmedReviewSelection ||
            isSubagentsSelectionArmed
        return TurnComposerPresentationState(
            queuedDraftCount = queuedDraftCount,
            isQueuePaused = queuePauseMessage != null && queuedDraftCount > 0,
            hasComposerContent = hasComposerContent,
            canSend = isConnected && !hasBlockingAttachmentState && hasComposerContent && !hasPendingReviewSelection,
            hasPendingReviewSelection = hasPendingReviewSelection,
            hasSubagentsSelection = isSubagentsSelectionArmed,
        )
    }

    fun clearAutocomplete() {
        autocompleteFiles = emptyList()
        autocompleteSkills = emptyList()
    }

    fun setComposerNotice(message: String?) {
        composerNoticeMessage = message?.trim()?.takeIf(String::isNotEmpty)
    }

    fun togglePlanMode() {
        isPlanModeArmed = !isPlanModeArmed
    }

    fun disablePlanMode() {
        isPlanModeArmed = false
    }

    fun requestAssistantResponseAnchor() {
        shouldAnchorToAssistantResponse = true
    }

    fun beginSteeringDraft(id: String) {
        steeringDraftId = id
    }

    fun beginResumingQueue() {
        isQueueResuming = true
    }

    suspend fun performQueueResume(
        action: suspend () -> Unit,
    ) {
        beginResumingQueue()
        try {
            action()
        } finally {
            finishResumingQueue()
        }
    }

    fun finishResumingQueue() {
        isQueueResuming = false
    }

    fun resetForThread() {
        visibleTailCount = 40
        isPlanModeArmed = false
        plusMenuExpanded = false
        steeringDraftId = null
        isQueueResuming = false
        isFocused = false
        shouldAnchorToAssistantResponse = false
        isScrolledToBottom = true
        composerNoticeMessage = null
        runningGitAction = null
        isSubagentsSelectionArmed = false
        clearComposerSelections()
        resetSlashCommandState(clearPendingSelection = true, clearConfirmedSelection = true)
    }

    fun loadEarlierMessages(totalMessages: Int) {
        visibleTailCount = (visibleTailCount + 40).coerceAtMost(totalMessages)
    }

    suspend fun performDraftSteer(
        draftId: String,
        action: suspend () -> Unit,
    ) {
        beginSteeringDraft(draftId)
        try {
            action()
        } finally {
            finishSteeringDraft(draftId)
        }
    }

    fun finishSteeringDraft(id: String? = null) {
        if (id == null || steeringDraftId == id) {
            steeringDraftId = null
        }
    }

    private fun currentAutocompleteToken(input: String): String {
        val lastWordStartIndex = input.lastIndexOfAny(charArrayOf(' ', '\n')) + 1
        return input.substring(lastWordStartIndex)
    }

    private fun replaceCurrentAutocompleteToken(input: String, replacement: String): String {
        val lastWordStartIndex = input.lastIndexOfAny(charArrayOf(' ', '\n')) + 1
        clearAutocomplete()
        return input.substring(0, lastWordStartIndex) + replacement
    }

    fun addMentionedFile(input: String, file: FuzzyFileMatch): String {
        clearComposerReviewSelectionIfNeededForNonReviewContent()
        if (composerMentionedFiles.none { it.path == file.path }) {
            composerMentionedFiles = composerMentionedFiles + TurnComposerMentionedFile(
                fileName = file.fileName,
                path = file.path,
            )
        }
        return replaceCurrentAutocompleteToken(input, "@${file.fileName}")
    }

    fun addMentionedSkill(input: String, skill: SkillMetadata): String {
        clearComposerReviewSelectionIfNeededForNonReviewContent()
        val normalizedName = skill.name.trim()
        if (normalizedName.isEmpty()) {
            clearAutocomplete()
            return input
        }
        if (composerMentionedSkills.none { it.name.equals(skill.name, ignoreCase = true) }) {
            composerMentionedSkills = composerMentionedSkills + TurnComposerMentionedSkill(
                skillId = skill.id,
                name = normalizedName,
                path = skill.path,
                description = skill.description,
            )
        }
        val prefix = if (currentAutocompleteToken(input).startsWith("$")) "$" else "#"
        return replaceCurrentAutocompleteToken(input, prefix + normalizedName)
    }

    fun removeMentionedFile(input: String, id: String): String {
        val mention = composerMentionedFiles.firstOrNull { it.id == id }
        composerMentionedFiles = composerMentionedFiles.filterNot { it.id == id }
        if (mention == null) {
            return input
        }
        return input
            .replace("@${mention.fileName}", "")
            .replace("@${mention.path}", "")
            .replace("  ", " ")
            .trimEnd()
    }

    fun removeMentionedSkill(input: String, id: String): String {
        val mention = composerMentionedSkills.firstOrNull { it.id == id }
        composerMentionedSkills = composerMentionedSkills.filterNot { it.id == id }
        if (mention == null) {
            return input
        }
        return input
            .replace("\$${mention.name}", "")
            .replace("#${mention.name}", "")
            .replace("  ", " ")
            .trimEnd()
    }

    fun composeSendText(input: String): String {
        var output = input.trim()
        composerMentionedFiles.forEach { mention ->
            output = output.replace("@${mention.fileName}", "@${mention.path}")
        }
        return applySubagentsSelection(output)
    }

    fun clearComposerSelections() {
        composerMentionedFiles = emptyList()
        composerMentionedSkills = emptyList()
        composerAttachments = emptyList()
        composerNoticeMessage = null
        isSubagentsSelectionArmed = false
        resetSlashCommandState(clearPendingSelection = true, clearConfirmedSelection = true)
    }

    fun addComposerAttachment(sourceData: ByteArray): Boolean {
        clearComposerReviewSelectionIfNeededForNonReviewContent()
        if (remainingAttachmentSlots <= 0) {
            return false
        }
        val attachment = TurnAttachmentPipeline.makeAttachment(sourceData) ?: return false
        composerAttachments = composerAttachments + TurnComposerImageAttachment(
            state = TurnComposerImageAttachmentState.Ready(attachment),
        )
        return true
    }

    fun addComposerAttachments(sourceDataItems: List<ByteArray>): Int {
        var acceptedCount = 0
        sourceDataItems.forEach { sourceData ->
            if (addComposerAttachment(sourceData)) {
                acceptedCount += 1
            }
        }
        return acceptedCount
    }

    fun prepareAttachmentIntake(requestedCount: Int): TurnComposerAttachmentIntakePlan {
        if (requestedCount > 0) {
            clearComposerReviewSelectionIfNeededForNonReviewContent()
        }
        val acceptedCount = requestedCount.coerceAtMost(remainingAttachmentSlots)
        val droppedCount = (requestedCount - acceptedCount).coerceAtLeast(0)
        composerNoticeMessage = when {
            droppedCount > 0 -> "Only $acceptedCount image slot${if (acceptedCount == 1) "" else "s"} available."
            else -> null
        }
        if (acceptedCount <= 0) {
            return TurnComposerAttachmentIntakePlan(
                reservedAttachmentIds = emptyList(),
                droppedCount = droppedCount,
            )
        }
        val loadingAttachments = List(acceptedCount) {
            TurnComposerImageAttachment(
                id = UUID.randomUUID().toString(),
                state = TurnComposerImageAttachmentState.Loading,
            )
        }
        composerAttachments = composerAttachments + loadingAttachments
        return TurnComposerAttachmentIntakePlan(
            reservedAttachmentIds = loadingAttachments.map(TurnComposerImageAttachment::id),
            droppedCount = droppedCount,
        )
    }

    fun resolveComposerAttachment(id: String, sourceData: ByteArray?) {
        composerAttachments = composerAttachments.map { attachment ->
            if (attachment.id != id) {
                attachment
            } else {
                val resolved = sourceData?.let(TurnAttachmentPipeline::makeAttachment)
                attachment.copy(
                    state = if (resolved != null) {
                        TurnComposerImageAttachmentState.Ready(resolved)
                    } else {
                        TurnComposerImageAttachmentState.Failed
                    },
                )
            }
        }
        composerNoticeMessage = when {
            composerAttachments.any { it.state == TurnComposerImageAttachmentState.Failed } -> {
                "One or more images could not be loaded."
            }
            composerAttachments.none { it.state == TurnComposerImageAttachmentState.Loading } -> {
                null
            }
            else -> composerNoticeMessage
        }
    }

    fun removeComposerAttachment(id: String) {
        composerAttachments = composerAttachments.filterNot { it.id == id }
        if (composerAttachments.none { it.state == TurnComposerImageAttachmentState.Failed }) {
            composerNoticeMessage = null
        }
    }

    suspend fun refreshGitStatus(
        appViewModel: AppViewModel,
        state: AppState,
    ) {
        val currentCwd = state.selectedThread?.cwd
        if (currentCwd != null && currentCwd.isNotBlank() && state.isConnected) {
            appViewModel.gitStatus(currentCwd)
        }
    }

    suspend fun refreshAutocomplete(
        appViewModel: AppViewModel,
        input: String,
        selectedThreadId: String?,
    ) {
        val lastWordStartIndex = input.lastIndexOfAny(charArrayOf(' ', '\n')) + 1
        val currentWord = input.substring(lastWordStartIndex)
        when {
            currentWord.startsWith("@") -> {
                autocompleteSkills = emptyList()
                autocompleteFiles = selectedThreadId?.let { threadId ->
                    appViewModel.fuzzyFileSearch(currentWord.substring(1), threadId)
                }.orEmpty()
            }

            currentWord.startsWith("#") -> {
                autocompleteFiles = emptyList()
                autocompleteSkills = appViewModel.listSkills().filter { skill ->
                    skill.name.contains(currentWord.substring(1), ignoreCase = true)
                }
            }

            currentWord.startsWith("$") -> {
                autocompleteFiles = emptyList()
                autocompleteSkills = appViewModel.listSkills().filter { skill ->
                    skill.name.contains(currentWord.substring(1), ignoreCase = true)
                }
            }

            else -> clearAutocomplete()
        }
    }

    fun onInputChangedForSlashCommandAutocomplete(input: String, isEnabled: Boolean) {
        if (!isEnabled) {
            disablePlanMode()
            resetSlashCommandState(clearPendingSelection = true, clearConfirmedSelection = true)
            return
        }

        clearComposerReviewSelectionIfNeededForInput(input)

        if (slashCommandPanelState is TurnComposerSlashCommandPanelState.CodeReviewTargets) {
            return
        }

        val token = trailingSlashCommandToken(input)
        slashCommandPanelState = if (token == null) {
            TurnComposerSlashCommandPanelState.Hidden
        } else {
            clearAutocomplete()
            TurnComposerSlashCommandPanelState.Commands(token.query)
        }
    }

    // These are called from TurnComposerHost which handles the coroutine scope
    // The actual async refresh happens via refreshAutocomplete in LaunchedEffect
    fun onInputChangedForFileAutocomplete(input: String, appViewModel: AppViewModel, selectedThreadId: String?) {
        val lastWordStartIndex = input.lastIndexOfAny(charArrayOf(' ', '\n')) + 1
        val currentWord = input.substring(lastWordStartIndex)
        if (!currentWord.startsWith("@")) {
            if (autocompleteFiles.isNotEmpty()) {
                autocompleteFiles = emptyList()
            }
        }
        // The actual async refresh is handled by TurnComposerHost's LaunchedEffect
    }

    fun onInputChangedForSkillAutocomplete(input: String, appViewModel: AppViewModel) {
        val lastWordStartIndex = input.lastIndexOfAny(charArrayOf(' ', '\n')) + 1
        val currentWord = input.substring(lastWordStartIndex)
        if (!currentWord.startsWith("#") && !currentWord.startsWith("$")) {
            if (autocompleteSkills.isNotEmpty()) {
                autocompleteSkills = emptyList()
            }
        }
        // The actual async refresh is handled by TurnComposerHost's LaunchedEffect
    }

    fun onSelectSlashCommand(input: String, command: TurnComposerSlashCommand): String {
        val updatedInput = removingTrailingSlashCommandToken(input) ?: input
        when (command) {
            TurnComposerSlashCommand.CODE_REVIEW -> {
                if (hasComposerContentConflictingWithReview) {
                    resetSlashCommandState(clearPendingSelection = true)
                    return updatedInput
                }
                composerReviewSelection = TurnComposerReviewSelection(
                    command = command,
                    target = null,
                )
                slashCommandPanelState = TurnComposerSlashCommandPanelState.CodeReviewTargets
            }

            TurnComposerSlashCommand.STATUS -> {
                resetSlashCommandState(clearPendingSelection = true)
            }

            TurnComposerSlashCommand.SUBAGENTS -> {
                clearComposerReviewSelectionIfNeededForNonReviewContent()
                isSubagentsSelectionArmed = true
                resetSlashCommandState(clearPendingSelection = true)
            }
        }
        return updatedInput.trim()
    }

    fun onSelectCodeReviewTarget(input: String, target: TurnComposerReviewTarget): String {
        val updatedInput = removingTrailingSlashCommandToken(input) ?: input
        if (inputHasConflictingContentForReview(updatedInput) ||
            composerMentionedFiles.isNotEmpty() ||
            composerMentionedSkills.isNotEmpty() ||
            composerAttachments.isNotEmpty()
        ) {
            resetSlashCommandState(clearPendingSelection = true)
            return updatedInput
        }
        composerReviewSelection = TurnComposerReviewSelection(
            command = TurnComposerSlashCommand.CODE_REVIEW,
            target = target,
        )
        slashCommandPanelState = TurnComposerSlashCommandPanelState.Hidden
        return updatedInput.trim()
    }

    fun clearComposerReviewSelection() {
        composerReviewSelection = null
        resetSlashCommandState()
    }

    fun clearSubagentsSelection() {
        isSubagentsSelectionArmed = false
        resetSlashCommandState(clearPendingSelection = true)
    }

    fun reviewBaseBranchName(state: AppState): String? {
        return state.selectedGitBaseBranch?.trim()?.takeIf(String::isNotEmpty)
    }

    fun applySubagentsSelection(input: String): String {
        val trimmed = input.trim()
        if (!isSubagentsSelectionArmed) {
            return trimmed
        }
        val cannedPrompt = "Use subagents to help with this task when it makes sense."
        return if (trimmed.isEmpty()) cannedPrompt else "$cannedPrompt\n\n$trimmed"
    }

    private fun resetSlashCommandState(
        clearPendingSelection: Boolean = false,
        clearConfirmedSelection: Boolean = false,
    ) {
        slashCommandPanelState = TurnComposerSlashCommandPanelState.Hidden
        if (clearConfirmedSelection) {
            composerReviewSelection = null
            return
        }
        if (clearPendingSelection && composerReviewSelection?.target == null) {
            composerReviewSelection = null
        }
    }

    private fun clearComposerReviewSelectionIfNeededForInput(input: String) {
        if (composerReviewSelection?.target != null && inputHasConflictingContentForReview(input)) {
            clearComposerReviewSelection()
        }
    }

    private fun clearComposerReviewSelectionIfNeededForNonReviewContent() {
        if (composerReviewSelection?.target != null) {
            clearComposerReviewSelection()
        }
    }

    private fun inputHasConflictingContentForReview(input: String): Boolean {
        val draftText = (removingTrailingSlashCommandToken(input) ?: input).trim()
        return draftText.isNotEmpty()
    }

    private fun trailingSlashCommandToken(input: String): TurnTrailingSlashCommandToken? {
        if (input.isEmpty()) return null
        val slashIndex = input.lastIndexOf('/')
        if (slashIndex < 0) return null
        if (slashIndex > 0 && !input[slashIndex - 1].isWhitespace()) return null
        val query = input.substring(slashIndex + 1)
        if (query.any(Char::isWhitespace)) return null
        return TurnTrailingSlashCommandToken(query = query, tokenRange = slashIndex..input.lastIndex)
    }

    private fun removingTrailingSlashCommandToken(input: String): String? {
        val token = trailingSlashCommandToken(input) ?: return null
        return buildString {
            append(input.substring(0, token.tokenRange.first))
            if (token.tokenRange.last < input.lastIndex) {
                append(input.substring(token.tokenRange.last + 1))
            }
        }.trim()
    }
}

@Composable
fun rememberTurnViewModel(threadId: String?): TurnViewModel {
    val viewModel = remember { TurnViewModel() }
    androidx.compose.runtime.LaunchedEffect(threadId) {
        viewModel.resetForThread()
    }
    return viewModel
}
