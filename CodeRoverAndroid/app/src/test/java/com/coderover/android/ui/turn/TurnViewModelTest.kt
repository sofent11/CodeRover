package com.coderover.android.ui.turn

import com.coderover.android.data.model.ImageAttachment
import com.coderover.android.data.model.FuzzyFileMatch
import com.coderover.android.data.model.ChatMessage
import com.coderover.android.data.model.MessageRole
import com.coderover.android.data.model.SkillMetadata
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlinx.coroutines.runBlocking

class TurnViewModelTest {
    @Test
    fun addMentionedFileStoresChipAndComposeSendTextUsesFullPath() {
        val viewModel = TurnViewModel()

        val updatedInput = viewModel.addMentionedFile(
            input = "Please inspect @src/ma",
            file = FuzzyFileMatch(path = "src/main/App.kt", root = "/tmp/project"),
        )

        assertEquals("Please inspect @App.kt", updatedInput)
        assertEquals(1, viewModel.composerMentionedFiles.size)
        assertEquals(
            "Please inspect @src/main/App.kt",
            viewModel.composeSendText(updatedInput),
        )
    }

    @Test
    fun addMentionedSkillDeduplicatesByNameIgnoringCase() {
        val viewModel = TurnViewModel()

        val firstInput = viewModel.addMentionedSkill(
            input = "Use \$tes",
            skill = SkillMetadata(id = "1", name = "test-skill", description = null),
        )
        viewModel.addMentionedSkill(
            input = "Use \$tes",
            skill = SkillMetadata(id = "2", name = "TEST-SKILL", description = null),
        )

        assertEquals(1, viewModel.composerMentionedSkills.size)
        assertEquals("Use \$test-skill", firstInput)
        assertEquals("1", viewModel.readySkillMentions.single().id)
    }

    @Test
    fun clearComposerSelectionsRemovesMentions() {
        val viewModel = TurnViewModel()
        viewModel.addMentionedFile("See @foo", FuzzyFileMatch(path = "src/Foo.kt", root = "/tmp"))
        viewModel.addMentionedSkill("Use #bar", SkillMetadata(id = "1", name = "bar", description = null))
        viewModel.composerAttachments = listOf(
            TurnComposerImageAttachment(
                state = TurnComposerImageAttachmentState.Ready(fakeAttachment()),
            ),
        )

        viewModel.clearComposerSelections()

        assertTrue(viewModel.composerMentionedFiles.isEmpty())
        assertTrue(viewModel.composerMentionedSkills.isEmpty())
        assertTrue(viewModel.composerAttachments.isEmpty())
    }

    @Test
    fun removeMentionedFileRemovesInlineAliasFromInput() {
        val viewModel = TurnViewModel()
        val updatedInput = viewModel.addMentionedFile(
            input = "Inspect @src/ma",
            file = FuzzyFileMatch(path = "src/main/App.kt", root = "/tmp/project"),
        )

        val mentionId = viewModel.composerMentionedFiles.firstOrNull()?.id
        assertNotNull(mentionId)

        val clearedInput = viewModel.removeMentionedFile(updatedInput, mentionId!!)

        assertEquals("Inspect", clearedInput)
        assertTrue(viewModel.composerMentionedFiles.isEmpty())
    }

    @Test
    fun removeMentionedSkillRemovesInlineAliasFromInput() {
        val viewModel = TurnViewModel()
        val updatedInput = viewModel.addMentionedSkill(
            input = "Use \$tes",
            skill = SkillMetadata(id = "1", name = "test-skill", description = null),
        )

        val mentionId = viewModel.composerMentionedSkills.firstOrNull()?.id
        assertNotNull(mentionId)

        val clearedInput = viewModel.removeMentionedSkill(updatedInput, mentionId!!)

        assertEquals("Use", clearedInput)
        assertTrue(viewModel.composerMentionedSkills.isEmpty())
    }

    @Test
    fun attachmentDerivedStateReflectsReadyAttachments() {
        val viewModel = TurnViewModel()
        viewModel.composerAttachments = listOf(
            TurnComposerImageAttachment(
                state = TurnComposerImageAttachmentState.Ready(fakeAttachment()),
            ),
        )

        assertEquals(1, viewModel.composerAttachments.size)
        assertEquals(3, viewModel.remainingAttachmentSlots)
        assertFalse(viewModel.hasBlockingAttachmentState)
        assertEquals(1, viewModel.readyComposerAttachments.size)
    }

    @Test
    fun attachmentDerivedStateBlocksWhileLoadingOrFailed() {
        val viewModel = TurnViewModel()
        viewModel.composerAttachments = listOf(
            TurnComposerImageAttachment(state = TurnComposerImageAttachmentState.Loading),
            TurnComposerImageAttachment(state = TurnComposerImageAttachmentState.Failed),
            TurnComposerImageAttachment(
                state = TurnComposerImageAttachmentState.Ready(fakeAttachment()),
            ),
            TurnComposerImageAttachment(
                state = TurnComposerImageAttachmentState.Ready(fakeAttachment()),
            ),
        )

        assertEquals(4, viewModel.composerAttachments.size)
        assertEquals(0, viewModel.remainingAttachmentSlots)
        assertTrue(viewModel.hasBlockingAttachmentState)
        assertEquals(2, viewModel.readyComposerAttachments.size)
    }

    @Test
    fun remainingAttachmentSlotsReflectsNearLimitState() {
        val viewModel = TurnViewModel()
        viewModel.composerAttachments = List(3) {
            TurnComposerImageAttachment(
                state = TurnComposerImageAttachmentState.Ready(fakeAttachment()),
            )
        }

        assertEquals(1, viewModel.remainingAttachmentSlots)
        assertEquals(3, viewModel.composerAttachments.size)
    }

    @Test
    fun prepareAttachmentIntakeAddsLoadingEntries() {
        val viewModel = TurnViewModel()

        val intakePlan = viewModel.prepareAttachmentIntake(2)

        assertEquals(2, intakePlan.acceptedCount)
        assertEquals(0, intakePlan.droppedCount)
        assertEquals(2, viewModel.composerAttachments.size)
        assertTrue(viewModel.composerAttachments.all { it.state == TurnComposerImageAttachmentState.Loading })
        assertTrue(viewModel.hasBlockingAttachmentState)
    }

    @Test
    fun prepareAttachmentIntakeStoresOverflowNotice() {
        val viewModel = TurnViewModel()
        viewModel.composerAttachments = List(3) {
            TurnComposerImageAttachment(
                state = TurnComposerImageAttachmentState.Ready(fakeAttachment()),
            )
        }

        val intakePlan = viewModel.prepareAttachmentIntake(2)

        assertEquals(1, intakePlan.acceptedCount)
        assertEquals(1, intakePlan.droppedCount)
        assertEquals("Only 1 image slot available.", viewModel.composerNoticeMessage)
    }

    @Test
    fun resolveComposerAttachmentMarksEntryFailedWhenPayloadMissing() {
        val viewModel = TurnViewModel()
        val reservedId = viewModel.prepareAttachmentIntake(1).reservedAttachmentIds.single()

        viewModel.resolveComposerAttachment(reservedId, null)

        assertEquals(TurnComposerImageAttachmentState.Failed, viewModel.composerAttachments.single().state)
        assertEquals("One or more images could not be loaded.", viewModel.composerNoticeMessage)
    }

    @Test
    fun composerPresentationCalculatesSendAndQueueState() {
        val viewModel = TurnViewModel()
        viewModel.composerAttachments = listOf(
            TurnComposerImageAttachment(
                state = TurnComposerImageAttachmentState.Ready(fakeAttachment()),
            ),
        )

        val presentation = viewModel.composerPresentation(
            input = "",
            isConnected = true,
            queuedDraftCount = 2,
            queuePauseMessage = "busy",
        )

        assertTrue(presentation.hasComposerContent)
        assertTrue(presentation.canSend)
        assertTrue(presentation.isQueuePaused)
        assertEquals(2, presentation.queuedDraftCount)
    }

    @Test
    fun slashCommandInputShowsCommandPanelForCodex() {
        val viewModel = TurnViewModel()

        viewModel.onInputChangedForSlashCommandAutocomplete("/rev", isEnabled = true)

        assertEquals(
            TurnComposerSlashCommandPanelState.Commands("rev"),
            viewModel.slashCommandPanelState,
        )
    }

    @Test
    fun selectingReviewTargetArmsConfirmedReviewSelection() {
        val viewModel = TurnViewModel()

        val updatedInput = viewModel.onSelectSlashCommand("/review", TurnComposerSlashCommand.CODE_REVIEW)
        val finalInput = viewModel.onSelectCodeReviewTarget(
            updatedInput,
            TurnComposerReviewTarget.UNCOMMITTED_CHANGES,
        )

        assertEquals("", finalInput)
        assertEquals(
            TurnComposerReviewSelection(
                command = TurnComposerSlashCommand.CODE_REVIEW,
                target = TurnComposerReviewTarget.UNCOMMITTED_CHANGES,
            ),
            viewModel.composerReviewSelection,
        )
        assertEquals(TurnComposerSlashCommandPanelState.Hidden, viewModel.slashCommandPanelState)
    }

    @Test
    fun pendingReviewSelectionDisablesSend() {
        val viewModel = TurnViewModel()
        viewModel.composerReviewSelection = TurnComposerReviewSelection(
            command = TurnComposerSlashCommand.CODE_REVIEW,
            target = null,
        )

        val presentation = viewModel.composerPresentation(
            input = "",
            isConnected = true,
            queuedDraftCount = 0,
            queuePauseMessage = null,
        )

        assertTrue(presentation.hasPendingReviewSelection)
        assertFalse(presentation.canSend)
    }

    @Test
    fun selectingSubagentsArmsDelegationAndAllowsCommandOnlySend() {
        val viewModel = TurnViewModel()

        val updatedInput = viewModel.onSelectSlashCommand("/subagents", TurnComposerSlashCommand.SUBAGENTS)
        val presentation = viewModel.composerPresentation(
            input = updatedInput,
            isConnected = true,
            queuedDraftCount = 0,
            queuePauseMessage = null,
        )

        assertEquals("", updatedInput)
        assertTrue(viewModel.isSubagentsSelectionArmed)
        assertTrue(presentation.hasComposerContent)
        assertTrue(presentation.hasSubagentsSelection)
        assertTrue(presentation.canSend)
        assertEquals(
            "Use subagents to help with this task when it makes sense.",
            viewModel.composeSendText(updatedInput),
        )
    }

    @Test
    fun subagentsSelectionClearsConfirmedReviewSelection() {
        val viewModel = TurnViewModel()
        viewModel.composerReviewSelection = TurnComposerReviewSelection(
            command = TurnComposerSlashCommand.CODE_REVIEW,
            target = TurnComposerReviewTarget.UNCOMMITTED_CHANGES,
        )

        viewModel.onSelectSlashCommand("/subagents", TurnComposerSlashCommand.SUBAGENTS)

        assertTrue(viewModel.isSubagentsSelectionArmed)
        assertEquals(null, viewModel.composerReviewSelection)
    }

    @Test
    fun removeComposerAttachmentClearsFailureNoticeWhenNoFailedRemain() {
        val viewModel = TurnViewModel()
        viewModel.composerAttachments = listOf(
            TurnComposerImageAttachment(
                id = "failed",
                state = TurnComposerImageAttachmentState.Failed,
            ),
            TurnComposerImageAttachment(
                id = "ready",
                state = TurnComposerImageAttachmentState.Ready(fakeAttachment()),
            ),
        )
        viewModel.setComposerNotice("One or more images could not be loaded.")

        viewModel.removeComposerAttachment("failed")

        assertEquals(1, viewModel.composerAttachments.size)
        assertEquals(null, viewModel.composerNoticeMessage)
    }

    @Test
    fun queuePresentationReflectsPauseAndSteeringState() {
        val viewModel = TurnViewModel()
        viewModel.beginSteeringDraft("draft-1")

        val presentation = viewModel.queuePresentation(
            queuedDraftCount = 3,
            queuePauseMessage = "busy",
        )

        assertEquals(3, presentation.draftCount)
        assertTrue(presentation.isPaused)
        assertEquals("busy", presentation.pauseMessage)
        assertFalse(presentation.canResume)
        assertFalse(presentation.isResuming)
        assertTrue(presentation.canSteerDrafts)
        assertEquals("draft-1", presentation.steeringDraftId)
    }

    @Test
    fun queuePresentationReflectsResumeInFlightState() {
        val viewModel = TurnViewModel()
        viewModel.beginResumingQueue()

        val presentation = viewModel.queuePresentation(
            queuedDraftCount = 2,
            queuePauseMessage = "busy",
        )

        assertTrue(presentation.isPaused)
        assertFalse(presentation.canResume)
        assertTrue(presentation.isResuming)
        assertFalse(presentation.canSteerDrafts)
        assertEquals(null, presentation.steeringDraftId)
    }

    @Test
    fun finishSteeringDraftClearsOnlyMatchingDraft() {
        val viewModel = TurnViewModel()
        viewModel.beginSteeringDraft("draft-1")

        viewModel.finishSteeringDraft("other")
        assertEquals("draft-1", viewModel.steeringDraftId)

        viewModel.finishSteeringDraft("draft-1")
        assertEquals(null, viewModel.steeringDraftId)
    }

    @Test
    fun finishResumingQueueClearsResumeBusyState() {
        val viewModel = TurnViewModel()
        viewModel.beginResumingQueue()

        viewModel.finishResumingQueue()

        val presentation = viewModel.queuePresentation(
            queuedDraftCount = 1,
            queuePauseMessage = "busy",
        )
        assertTrue(presentation.canResume)
        assertFalse(presentation.isResuming)
    }

    @Test
    fun performQueueResumeClearsBusyStateAfterFailure() = runBlocking {
        val viewModel = TurnViewModel()

        runCatching {
            viewModel.performQueueResume {
                throw IllegalStateException("boom")
            }
        }

        val presentation = viewModel.queuePresentation(
            queuedDraftCount = 1,
            queuePauseMessage = "busy",
        )
        assertFalse(presentation.isResuming)
        assertTrue(presentation.canResume)
    }

    @Test
    fun performDraftSteerClearsSteeringStateAfterFailure() = runBlocking {
        val viewModel = TurnViewModel()

        runCatching {
            viewModel.performDraftSteer("draft-1") {
                throw IllegalStateException("boom")
            }
        }

        assertEquals(null, viewModel.steeringDraftId)
    }

    @Test
    fun requestAssistantResponseAnchorArmsTimelineAnchor() {
        val viewModel = TurnViewModel()

        viewModel.requestAssistantResponseAnchor()

        assertTrue(viewModel.shouldAnchorToAssistantResponse)
    }

    @Test
    fun resetForThreadClearsMenusAndAutocomplete() {
        val viewModel = TurnViewModel()
        viewModel.plusMenuExpanded = true
        viewModel.modelMenuExpanded = true
        viewModel.reasoningMenuExpanded = true
        viewModel.runtimeMenuExpanded = true
        viewModel.accessMenuExpanded = true
        viewModel.gitMenuExpanded = true
        viewModel.autocompleteFiles = listOf(FuzzyFileMatch(path = "src/App.kt", root = "/tmp/project"))
        viewModel.autocompleteSkills = listOf(SkillMetadata(id = "skill-1", name = "review", description = null))
        viewModel.slashCommandPanelState = TurnComposerSlashCommandPanelState.Commands("rev")
        viewModel.composerNoticeMessage = "notice"
        viewModel.requestAssistantResponseAnchor()

        viewModel.resetForThread()

        assertFalse(viewModel.plusMenuExpanded)
        assertFalse(viewModel.modelMenuExpanded)
        assertFalse(viewModel.reasoningMenuExpanded)
        assertFalse(viewModel.runtimeMenuExpanded)
        assertFalse(viewModel.accessMenuExpanded)
        assertFalse(viewModel.gitMenuExpanded)
        assertTrue(viewModel.autocompleteFiles.isEmpty())
        assertTrue(viewModel.autocompleteSkills.isEmpty())
        assertEquals(TurnComposerSlashCommandPanelState.Hidden, viewModel.slashCommandPanelState)
        assertEquals(null, viewModel.composerNoticeMessage)
        assertFalse(viewModel.shouldAnchorToAssistantResponse)
    }

    @Test
    fun autocompleteRequestParsesTrailingTokens() {
        val viewModel = TurnViewModel()

        assertEquals(null, viewModel.autocompleteRequest("plain text", "thread-1"))
        assertEquals(
            TurnAutocompleteRequest(
                kind = TurnAutocompleteKind.FILE,
                query = "src/ma",
                threadId = "thread-1",
            ),
            viewModel.autocompleteRequest("inspect @src/ma", "thread-1"),
        )
        assertEquals(
            TurnAutocompleteRequest(
                kind = TurnAutocompleteKind.SKILL,
                query = "andr",
            ),
            viewModel.autocompleteRequest("use #andr", "thread-1"),
        )
        assertEquals(
            TurnAutocompleteRequest(
                kind = TurnAutocompleteKind.SKILL,
                query = "andr",
            ),
            viewModel.autocompleteRequest("use \$andr", "thread-1"),
        )
    }

    @Test
    fun skillAutocompleteCachesSkillListAcrossQueries() = runBlocking {
        val viewModel = TurnViewModel()
        var fetchCount = 0
        val fetchSkills: suspend () -> List<SkillMetadata> = {
            fetchCount += 1
            listOf(
                SkillMetadata(id = "1", name = "android-jetpack-compose", description = null),
                SkillMetadata(id = "2", name = "swiftui-expert", description = null),
            )
        }

        viewModel.refreshAutocomplete(
            request = TurnAutocompleteRequest(TurnAutocompleteKind.SKILL, "android"),
            fuzzyFileSearch = { _, _ -> emptyList() },
            listSkills = fetchSkills,
        )
        viewModel.refreshAutocomplete(
            request = TurnAutocompleteRequest(TurnAutocompleteKind.SKILL, "swift"),
            fuzzyFileSearch = { _, _ -> emptyList() },
            listSkills = fetchSkills,
        )

        assertEquals(1, fetchCount)
        assertEquals(listOf("swiftui-expert"), viewModel.autocompleteSkills.map { it.name })
    }

    @Test
    fun buildCopyBlockTextByMessageIdHidesLatestRunningBlock() {
        val result = buildCopyBlockTextByMessageId(
            messages = listOf(
                ChatMessage(
                    threadId = "thread-1",
                    role = MessageRole.USER,
                    text = "question",
                    orderIndex = 1,
                ),
                ChatMessage(
                    threadId = "thread-1",
                    role = MessageRole.ASSISTANT,
                    text = "draft reply",
                    turnId = "turn-live",
                    orderIndex = 2,
                ),
            ),
            activeTurnId = "turn-live",
            isThreadRunning = true,
        )

        assertTrue(result.isEmpty())
    }

    @Test
    fun buildCopyBlockTextByMessageIdShowsCompletedEarlierBlock() {
        val earlierAssistant = ChatMessage(
            id = "assistant-1",
            threadId = "thread-1",
            role = MessageRole.ASSISTANT,
            text = "stable reply",
            turnId = "turn-old",
            orderIndex = 2,
        )

        val result = buildCopyBlockTextByMessageId(
            messages = listOf(
                ChatMessage(
                    threadId = "thread-1",
                    role = MessageRole.USER,
                    text = "question",
                    orderIndex = 1,
                ),
                earlierAssistant,
                ChatMessage(
                    threadId = "thread-1",
                    role = MessageRole.USER,
                    text = "follow-up",
                    orderIndex = 3,
                ),
                ChatMessage(
                    threadId = "thread-1",
                    role = MessageRole.ASSISTANT,
                    text = "live reply",
                    turnId = "turn-live",
                    orderIndex = 4,
                ),
            ),
            activeTurnId = "turn-live",
            isThreadRunning = true,
        )

        assertEquals(mapOf("assistant-1" to "stable reply"), result)
    }

    private fun fakeAttachment(): ImageAttachment {
        return ImageAttachment(
            thumbnailBase64JPEG = "thumb",
            payloadDataURL = "data:image/jpeg;base64,payload",
        )
    }
}
