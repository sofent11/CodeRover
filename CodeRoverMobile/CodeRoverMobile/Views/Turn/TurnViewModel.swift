// FILE: TurnViewModel.swift
// Purpose: Owns local TurnView state and user actions while keeping UI components lightweight.
// Layer: View Model
// Exports: TurnViewModel, TurnComposerSendAvailability, TurnComposerAttachmentIntakePlan
// Depends on: SwiftUI, Observation, PhotosUI, CodeRoverService

import SwiftUI
import Observation
import PhotosUI

struct TurnComposerSendAvailability {
    let isSending: Bool
    let isConnected: Bool
    let trimmedInput: String
    let hasReadyImages: Bool
    let hasBlockingAttachmentState: Bool

    // Evaluates whether sending is allowed for the current composer state.
    var isSendDisabled: Bool {
        isSending
            || !isConnected
            || (trimmedInput.isEmpty && !hasReadyImages)
            || hasBlockingAttachmentState
    }
}

struct TurnComposerAttachmentIntakePlan {
    let acceptedCount: Int
    let droppedCount: Int

    var hasOverflow: Bool {
        droppedCount > 0
    }

    // Computes how many picker items can be accepted without exceeding attachment slots.
    static func make(requestedCount: Int, remainingSlots: Int) -> TurnComposerAttachmentIntakePlan {
        let safeRequestedCount = max(0, requestedCount)
        let safeRemainingSlots = max(0, remainingSlots)
        let acceptedCount = min(safeRequestedCount, safeRemainingSlots)
        let droppedCount = safeRequestedCount - acceptedCount
        return TurnComposerAttachmentIntakePlan(acceptedCount: acceptedCount, droppedCount: droppedCount)
    }
}

struct QueuedTurnDraft: Identifiable {
    let id: String
    let text: String
    let attachments: [ImageAttachment]
    let skillMentions: [TurnSkillMention]
    let createdAt: Date
}

enum QueuePauseState: Equatable {
    case active
    case paused(errorMessage: String)
}

enum TurnComposerSlashCommand: String, Identifiable, Equatable {
    case status

    var id: String { rawValue }

    var title: String {
        switch self {
        case .status:
            return "Status"
        }
    }

    var subtitle: String {
        switch self {
        case .status:
            return "Show context usage"
        }
    }

    var symbolName: String {
        switch self {
        case .status:
            return "speedometer"
        }
    }

    var commandToken: String {
        switch self {
        case .status:
            return "/status"
        }
    }

    private var searchBlob: String {
        "\(title) \(subtitle) \(commandToken)".lowercased()
    }

    static func filtered(matching query: String) -> [TurnComposerSlashCommand] {
        let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let allCases: [TurnComposerSlashCommand] = [.status]
        guard !trimmedQuery.isEmpty else {
            return allCases
        }
        return allCases.filter { $0.searchBlob.contains(trimmedQuery) }
    }
}

enum TurnComposerSlashCommandPanelState: Equatable {
    case hidden
    case commands(query: String)
}

struct TurnTrailingSlashCommandToken: Equatable {
    let query: String
    let tokenRange: Range<String.Index>
}

enum TurnComposerCommandLogic {
    static func trailingSlashCommandToken(in text: String) -> TurnTrailingSlashCommandToken? {
        guard !text.isEmpty,
              let slashIndex = text.lastIndex(of: "/") else {
            return nil
        }

        if slashIndex > text.startIndex {
            let previousIndex = text.index(before: slashIndex)
            guard text[previousIndex].isWhitespace else {
                return nil
            }
        }

        let queryStart = text.index(after: slashIndex)
        let query = String(text[queryStart..<text.endIndex])
        guard !query.contains(where: { $0.isWhitespace }) else {
            return nil
        }

        return TurnTrailingSlashCommandToken(query: query, tokenRange: slashIndex..<text.endIndex)
    }

    static func removingTrailingSlashCommandToken(in text: String) -> String? {
        guard let token = trailingSlashCommandToken(in: text) else {
            return nil
        }

        var updated = text
        updated.replaceSubrange(token.tokenRange, with: "")
        return updated.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

@MainActor
@Observable
final class TurnViewModel {
    // Preserves the exact composer payload so stale-busy recovery can retry cleanly.
    private struct PendingTurnSend {
        let payload: String
        let attachments: [ImageAttachment]
        let skillMentions: [TurnSkillMention]
        let collaborationMode: CollaborationModeModeKind?
        let rawInput: String
        let rawAttachments: [TurnComposerImageAttachment]
    }

    // Splits contiguous filename segments into search-friendly word chunks.
    private static let fileMentionSegmentRegex = try? NSRegularExpression(
        pattern: #"[A-Z]+(?=$|[A-Z][a-z]|\d)|[A-Z]?[a-z]+|\d+"#
    )

    var input = ""
    var isSending = false
    var isHandlingApproval = false
    var isPlanModeArmed = false
    var steeringDraftID: String?
    var shouldAnchorToAssistantResponse = false
    var isScrolledToBottom = true
    var isPhotoPickerPresented = false
    var isCameraPresented = false
    var photoPickerItems: [PhotosPickerItem] = []
    var composerAttachments: [TurnComposerImageAttachment] = []
    var slashCommandPanelState: TurnComposerSlashCommandPanelState = .hidden
    // MARK: - Git state

    var runningGitAction: TurnGitActionKind? = nil
    var isRunningGitAction: Bool { runningGitAction != nil }
    var isShowingNothingToCommitAlert = false
    var gitSyncAlert: TurnGitSyncAlert? = nil
    var isLoadingGitBranchTargets = false
    var isSwitchingGitBranch = false
    var selectedGitBaseBranch = ""
    var currentGitBranch = ""
    var availableGitBranchTargets: [String] = []
    var gitDefaultBranch = ""
    var gitRepoSync: GitRepoSyncResult? = nil
    var gitSyncState: String? { gitRepoSync?.state }
    var shouldShowDiscardRuntimeChangesAndSync: Bool {
        guard let sync = gitRepoSync else { return false }
        let dangerousStates = ["dirty", "dirty_and_behind", "diverged"]
        return dangerousStates.contains(sync.state) || (sync.isDirty && sync.state == "no_upstream")
    }

    // Keeps git mutations scoped to an idle, explicitly bound local repo.
    func canRunGitAction(
        isConnected: Bool,
        isThreadRunning: Bool,
        hasGitWorkingDirectory: Bool
    ) -> Bool {
        isConnected
            && hasGitWorkingDirectory
            && !isThreadRunning
            && !isRunningGitAction
            && !isSwitchingGitBranch
    }

    @ObservationIgnored private var threadActivationTask: Task<Void, Never>?

    @ObservationIgnored private var gitStatusRefreshTask: Task<Void, Never>?

    let maxComposerImages = 4
    private let gitStatusRefreshDebounceNanoseconds: UInt64 = 350_000_000

    init() {}

    // MARK: - Cancellable Thread Activation

    func cancelThreadActivation() { threadActivationTask?.cancel() }

    func activateThread(threadID: String, coderover: CodeRoverService, onComplete: @escaping () -> Void) {
        threadActivationTask?.cancel()
        threadActivationTask = Task { @MainActor [weak self] in
            guard !Task.isCancelled else { return }
            await coderover.prepareThreadForDisplay(threadId: threadID)
            guard !Task.isCancelled else { return }
            self?.flushQueueIfPossible(coderover: coderover, threadID: threadID)
            onComplete()
        }
    }

    // Normalized composer input reused by send validation and turn creation.
    var trimmedComposerInput: String {
        input.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // Any loading/failed attachment must block send to avoid partial payloads.
    var hasBlockingAttachmentState: Bool {
        composerAttachments.contains(where: { $0.state == .loading || $0.state == .failed })
    }

    var readyComposerAttachments: [ImageAttachment] {
        composerAttachments.compactMap { attachment in
            if case .ready(let value) = attachment.state {
                return value
            }
            return nil
        }
    }

    var hasReadyImages: Bool {
        !readyComposerAttachments.isEmpty
    }

    var remainingAttachmentSlots: Int {
        max(0, maxComposerImages - composerAttachments.count)
    }

    func queuedCount(coderover: CodeRoverService, threadID: String) -> Int {
        queuedDrafts(coderover: coderover, threadID: threadID).count
    }

    func isQueuePaused(coderover: CodeRoverService, threadID: String) -> Bool {
        if case .paused = queuePauseState(coderover: coderover, threadID: threadID) {
            return true
        }
        return false
    }

    func queuedDraftsList(coderover: CodeRoverService, threadID: String) -> [QueuedTurnDraft] {
        queuedDrafts(coderover: coderover, threadID: threadID)
    }

    func removeQueuedDraft(id: String, coderover: CodeRoverService, threadID: String) {
        var drafts = queuedDrafts(coderover: coderover, threadID: threadID)
        drafts.removeAll { $0.id == id }
        setQueuedDrafts(drafts, coderover: coderover, threadID: threadID)
    }

    func isSteeringQueuedDraft(_ draftID: String) -> Bool {
        steeringDraftID == draftID
    }

    func queuePauseMessage(coderover: CodeRoverService, threadID: String) -> String? {
        if case .paused(let errorMessage) = queuePauseState(coderover: coderover, threadID: threadID) {
            return errorMessage
        }
        return nil
    }

    func isComposerInteractionLocked(activeTurnID: String?) -> Bool {
        _ = activeTurnID
        return isSending
    }

    func isSendDisabled(isConnected: Bool, activeTurnID: String?) -> Bool {
        _ = activeTurnID
        return TurnComposerSendAvailability(
            isSending: isSending,
            isConnected: isConnected,
            trimmedInput: trimmedComposerInput,
            hasReadyImages: hasReadyImages,
            hasBlockingAttachmentState: hasBlockingAttachmentState
        ).isSendDisabled
    }

    func clearComposer() {
        resetSlashCommandState()
        input = ""
        composerAttachments.removeAll()
    }

    func setPlanModeArmed(_ isArmed: Bool) {
        isPlanModeArmed = isArmed
    }

    func clearComposerAutocomplete() {
        resetSlashCommandState()
    }

    func removeComposerAttachment(id: String) {
        composerAttachments.removeAll(where: { $0.id == id })
    }

    func onInputChangedForSlashCommandAutocomplete(
        _ text: String,
        activeTurnID: String?,
        isEnabled: Bool
    ) {
        guard isEnabled else {
            resetSlashCommandState()
            return
        }

        guard !isComposerInteractionLocked(activeTurnID: activeTurnID) else {
            resetSlashCommandState()
            return
        }

        guard let token = Self.trailingSlashCommandToken(in: text) else {
            if case .commands = slashCommandPanelState {
                resetSlashCommandState()
            }
            return
        }

        slashCommandPanelState = .commands(query: token.query)
    }

    func onSelectSlashCommand(_ command: TurnComposerSlashCommand) {
        _ = command
        removeTrailingSlashCommandTokenFromInputIfNeeded()
        resetSlashCommandState()
    }

    func openCamera(coderover: CodeRoverService) {
        guard remainingAttachmentSlots > 0 else {
            coderover.lastErrorMessage = "You can attach up to \(maxComposerImages) images per message."
            return
        }
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
            coderover.lastErrorMessage = "Camera is not available on this device."
            return
        }
        isCameraPresented = true
    }

    func enqueueCapturedImageData(_ data: Data, coderover: CodeRoverService) {
        enqueuePastedImageData([data], coderover: coderover)
    }

    func openPhotoLibraryPicker(coderover: CodeRoverService) {
        guard remainingAttachmentSlots > 0 else {
            coderover.lastErrorMessage = "You can attach up to \(maxComposerImages) images per message."
            return
        }

        isPhotoPickerPresented = true
    }

    // Converts the picker results into loading slots and async image pipeline jobs.
    func enqueuePhotoPickerItems(_ items: [PhotosPickerItem], coderover: CodeRoverService) {
        guard !items.isEmpty else {
            return
        }

        let intakePlan = TurnComposerAttachmentIntakePlan.make(
            requestedCount: items.count,
            remainingSlots: remainingAttachmentSlots
        )

        guard intakePlan.acceptedCount > 0 else {
            coderover.lastErrorMessage = "You can attach up to \(maxComposerImages) images per message."
            return
        }

        let acceptedItems = Array(items.prefix(intakePlan.acceptedCount))
        if intakePlan.hasOverflow {
            coderover.lastErrorMessage = "Only \(maxComposerImages) images are allowed per message."
        }

        for item in acceptedItems {
            let attachmentID = UUID().uuidString
            composerAttachments.append(TurnComposerImageAttachment(id: attachmentID, state: .loading))

            Task {
                let state = await Self.loadComposerAttachmentState(from: item)
                await MainActor.run {
                    self.updateComposerAttachment(id: attachmentID, state: state)
                }
            }
        }
    }

    // Reuses the picker intake pipeline so pasted images obey the same limits and processing.
    func enqueuePastedImageData(_ imageDataItems: [Data], coderover: CodeRoverService) {
        guard !imageDataItems.isEmpty else {
            return
        }

        let intakePlan = TurnComposerAttachmentIntakePlan.make(
            requestedCount: imageDataItems.count,
            remainingSlots: remainingAttachmentSlots
        )

        guard intakePlan.acceptedCount > 0 else {
            coderover.lastErrorMessage = "You can attach up to \(maxComposerImages) images per message."
            return
        }

        let acceptedItems = Array(imageDataItems.prefix(intakePlan.acceptedCount))
        if intakePlan.hasOverflow {
            coderover.lastErrorMessage = "Only \(maxComposerImages) images are allowed per message."
        }

        for imageData in acceptedItems {
            let attachmentID = UUID().uuidString
            composerAttachments.append(TurnComposerImageAttachment(id: attachmentID, state: .loading))

            Task {
                let state = Self.loadComposerAttachmentState(fromData: imageData)
                await MainActor.run {
                    self.updateComposerAttachment(id: attachmentID, state: state)
                }
            }
        }
    }

    private func updateComposerAttachment(id: String, state: TurnComposerImageAttachmentState) {
        guard let index = composerAttachments.firstIndex(where: { $0.id == id }) else {
            return
        }

        composerAttachments[index].state = state
    }

    // Sends a standard turn while preserving all existing preflight guards.
    func sendTurn(coderover: CodeRoverService, threadID: String) {
        let payload = trimmedComposerInput
        let attachments = readyComposerAttachments
        let skillMentions: [TurnSkillMention] = []

        guard (!payload.isEmpty || !attachments.isEmpty),
              !isSending,
              coderover.isConnected,
              !hasBlockingAttachmentState else {
            return
        }

        let queuedDraft = QueuedTurnDraft(
            id: UUID().uuidString,
            text: payload,
            attachments: attachments,
            skillMentions: skillMentions,
            createdAt: Date()
        )
        let pendingSend = PendingTurnSend(
            payload: payload,
            attachments: attachments,
            skillMentions: skillMentions,
            collaborationMode: isPlanModeArmed ? .plan : nil,
            rawInput: input,
            rawAttachments: composerAttachments
        )
        let threadBusy = isThreadBusy(coderover: coderover, threadID: threadID)
        let queuePaused = isQueuePaused(coderover: coderover, threadID: threadID)

        isSending = true
        Task { @MainActor in
            defer { isSending = false }

            let stillBusy = await refreshBusyStateIfNeeded(coderover: coderover, threadID: threadID, wasBusy: threadBusy)
            if stillBusy {
                await performBusyThreadSend(
                    pendingSend,
                    coderover: coderover,
                    threadID: threadID
                )
                return
            }

            if queuePaused {
                appendQueuedDraft(queuedDraft, coderover: coderover, threadID: threadID)
                shouldAnchorToAssistantResponse = true
                clearComposer()
                resumeQueueAndFlushIfPossible(coderover: coderover, threadID: threadID)
                return
            }

            await performTurnSend(pendingSend, coderover: coderover, threadID: threadID)
        }
    }

    func flushQueueIfPossible(coderover: CodeRoverService, threadID: String) {
        guard !queuedDrafts(coderover: coderover, threadID: threadID).isEmpty,
              !isSending,
              steeringDraftID == nil,
              coderover.isConnected,
              !isQueuePaused(coderover: coderover, threadID: threadID),
              !isThreadBusy(coderover: coderover, threadID: threadID) else {
            return
        }

        guard let nextDraft = dequeueQueuedDraft(coderover: coderover, threadID: threadID) else {
            return
        }
        isSending = true
        shouldAnchorToAssistantResponse = true

        Task { @MainActor in
            defer { isSending = false }

            do {
                try await coderover.startTurn(
                    userInput: nextDraft.text,
                    threadId: threadID,
                    attachments: nextDraft.attachments,
                    skillMentions: nextDraft.skillMentions
                )
            } catch {
                shouldAnchorToAssistantResponse = false
                prependQueuedDraft(nextDraft, coderover: coderover, threadID: threadID)
                let queueErrorMessage = coderover.userFacingTurnErrorMessage(from: error)
                setQueuePauseState(.paused(errorMessage: queueErrorMessage), coderover: coderover, threadID: threadID)
                coderover.lastErrorMessage = "Queue paused: \(queueErrorMessage)"
            }
        }
    }

    private func shouldRearmPlanModeAfterSendFailure(_ error: Error) -> Bool {
        guard let serviceError = error as? CodeRoverServiceError else {
            return false
        }

        guard case .invalidResponse(let reason) = serviceError else {
            return false
        }

        return reason.localizedCaseInsensitiveContains("plan mode requires an available model")
    }

    // Sends one queued draft into the active turn without disturbing the rest of the queue.
    func steerQueuedDraft(id: String, coderover: CodeRoverService, threadID: String) {
        guard coderover.isConnected,
              steeringDraftID == nil,
              isThreadBusy(coderover: coderover, threadID: threadID),
              let draft = queuedDrafts(coderover: coderover, threadID: threadID).first(where: { $0.id == id }) else {
            return
        }

        steeringDraftID = id
        shouldAnchorToAssistantResponse = true

        Task { @MainActor in
            defer { steeringDraftID = nil }

            do {
                let stillBusy = await refreshBusyStateIfNeeded(coderover: coderover, threadID: threadID, wasBusy: true)
                if !stillBusy {
                    try await coderover.startTurn(
                        userInput: draft.text,
                        threadId: threadID,
                        attachments: draft.attachments,
                        skillMentions: draft.skillMentions
                    )
                    removeQueuedDraft(id: id, coderover: coderover, threadID: threadID)
                    return
                }

                let expectedTurnID = try await resolveSteerExpectedTurnID(
                    coderover: coderover,
                    threadID: threadID
                )
                try await coderover.steerTurn(
                    userInput: draft.text,
                    threadId: threadID,
                    expectedTurnId: expectedTurnID,
                    attachments: draft.attachments,
                    skillMentions: draft.skillMentions,
                    shouldAppendUserMessage: true
                )
                removeQueuedDraft(id: id, coderover: coderover, threadID: threadID)
            } catch {
                shouldAnchorToAssistantResponse = false
                coderover.removeLatestFailedUserMessage(
                    threadId: threadID,
                    matchingText: draft.text,
                    matchingAttachments: draft.attachments
                )
                coderover.lastErrorMessage = coderover.userFacingTurnErrorMessage(from: error)
            }
        }
    }

    func resumeQueueAndFlushIfPossible(coderover: CodeRoverService, threadID: String) {
        setQueuePauseState(.active, coderover: coderover, threadID: threadID)
        flushQueueIfPossible(coderover: coderover, threadID: threadID)
    }

    func interruptTurn(_ turnID: String?, coderover: CodeRoverService, threadID: String) {
        Task { @MainActor in
            do {
                try await coderover.interruptTurn(turnId: turnID, threadId: threadID)
            } catch {
                // Error message already stored in CodeRoverService.
            }
        }
    }

    func approve(coderover: CodeRoverService) {
        Task { @MainActor in
            isHandlingApproval = true
            defer { isHandlingApproval = false }

            do {
                try await coderover.approvePendingRequest()
            } catch {
                // Error message already stored in CodeRoverService.
            }
        }
    }

    func decline(coderover: CodeRoverService) {
        Task { @MainActor in
            isHandlingApproval = true
            defer { isHandlingApproval = false }

            do {
                try await coderover.declinePendingRequest()
            } catch {
                // Error message already stored in CodeRoverService.
            }
        }
    }

    private static func loadComposerAttachmentState(from item: PhotosPickerItem) async -> TurnComposerImageAttachmentState {
        do {
            guard let data = try await item.loadTransferable(type: Data.self),
                  !data.isEmpty else {
                return .failed
            }
            return loadComposerAttachmentState(fromData: data)
        } catch {
            return .failed
        }
    }

    private static func loadComposerAttachmentState(fromData data: Data) -> TurnComposerImageAttachmentState {
        guard let attachment = TurnAttachmentPipeline.makeAttachment(from: data) else {
            return .failed
        }
        return .ready(attachment)
    }

    // Extracts only a final `@query` token at the end of composer text.
    static func trailingFileAutocompleteToken(in text: String) -> TurnTrailingFileAutocompleteToken? {
        guard let token = trailingFileToken(in: text) else {
            return nil
        }

        return TurnTrailingFileAutocompleteToken(
            query: token.query,
            tokenRange: token.tokenRange
        )
    }

    // Extracts only a final `$query` token at the end of composer text.
    static func trailingSkillAutocompleteToken(in text: String) -> TurnTrailingSkillAutocompleteToken? {
        guard let token = trailingToken(in: text, trigger: "$") else {
            return nil
        }

        // Reject pure-numeric queries like `$100`, `$42` — not skill names.
        guard token.query.contains(where: { $0.isLetter }) else {
            return nil
        }

        return TurnTrailingSkillAutocompleteToken(
            query: token.query,
            tokenRange: token.tokenRange
        )
    }

    static func trailingSlashCommandToken(in text: String) -> TurnTrailingSlashCommandToken? {
        TurnComposerCommandLogic.trailingSlashCommandToken(in: text)
    }

    static func replacingTrailingFileAutocompleteToken(in text: String, with selectedPath: String) -> String? {
        let trimmedPath = selectedPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedPath.isEmpty,
              let token = trailingFileAutocompleteToken(in: text) else {
            return nil
        }

        var updated = text
        updated.replaceSubrange(token.tokenRange, with: "@\(trimmedPath) ")
        return updated
    }

    // Resolves file mentions from either the exact path or normalized alias forms.
    static func replacingFileMentionAliases(
        in text: String,
        with mention: TurnComposerMentionedFile,
        allowFileNameAliases: Bool = true
    ) -> String {
        let replacement = "@\(mention.path)"
        let placeholder = "__coderover_file_mention__\(mention.path.hashValue)__"
        let replacedText = fileMentionAliases(
            fileName: mention.fileName,
            path: mention.path,
            allowFileNameAliases: allowFileNameAliases
        )
            .reduce(text) { partialText, alias in
                // Replace into a placeholder first so shorter aliases cannot re-match inside the canonical path.
                replaceBoundedToken(
                    "@\(alias)",
                    with: placeholder,
                    in: partialText,
                    caseInsensitive: true
                )
            }
        return replacedText.replacingOccurrences(of: placeholder, with: replacement)
    }

    // Removes any alias form for a selected file mention so chip deletion stays in sync with text.
    static func removingFileMentionAliases(
        for mention: TurnComposerMentionedFile,
        from text: String,
        allowFileNameAliases: Bool = true
    ) -> String {
        fileMentionAliases(
            fileName: mention.fileName,
            path: mention.path,
            allowFileNameAliases: allowFileNameAliases
        )
            .reduce(text) { partialText, alias in
                removeBoundedToken(
                    "@\(alias)",
                    from: partialText,
                    caseInsensitive: true
                )
            }
    }

    // Generates raw and normalized aliases so matching survives spaces, separators, and casing changes.
    static func fileMentionAliases(
        fileName: String,
        path: String,
        allowFileNameAliases: Bool = true
    ) -> [String] {
        var aliases: Set<String> = []
        var seeds = [path, deletingPathExtension(from: path)]

        if allowFileNameAliases {
            seeds.insert(fileName, at: 0)
            seeds.append(deletingPathExtension(from: fileName))
        }

        for seed in seeds {
            let trimmedSeed = seed.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmedSeed.isEmpty else {
                continue
            }

            aliases.insert(trimmedSeed)
            appendNormalizedFileMentionAliases(for: trimmedSeed, into: &aliases)
        }

        return aliases
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .sorted {
                if $0.count == $1.count {
                    return $0.localizedCaseInsensitiveCompare($1) == .orderedAscending
                }
                return $0.count > $1.count
            }
    }

    // When multiple mentions normalize to the same basename, only folder-aware aliases are safe.
    static func ambiguousFileNameAliasKeys(in mentions: [TurnComposerMentionedFile]) -> Set<String> {
        let groupedKeys = Dictionary(grouping: mentions.compactMap { mention in
            fileNameAliasCollisionKey(for: mention.fileName)
        }) { $0 }

        return Set(groupedKeys.compactMap { key, bucket in
            bucket.count > 1 ? key : nil
        })
    }

    static func replacingTrailingSkillAutocompleteToken(in text: String, with selectedSkill: String) -> String? {
        let trimmedSkill = selectedSkill.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedSkill.isEmpty,
              let token = trailingSkillAutocompleteToken(in: text) else {
            return nil
        }

        var updated = text
        updated.replaceSubrange(token.tokenRange, with: "$\(trimmedSkill) ")
        return updated
    }

    static func removingTrailingSlashCommandToken(in text: String) -> String? {
        TurnComposerCommandLogic.removingTrailingSlashCommandToken(in: text)
    }

    // Allows file autocomplete queries to span spaces once they already look like a file or path.
    private static func trailingFileToken(in text: String) -> TurnTrailingToken? {
        guard !text.isEmpty,
              let lastCharacter = text.last,
              !lastCharacter.isWhitespace,
              let triggerIndex = text.lastIndex(of: "@") else {
            return nil
        }

        if triggerIndex > text.startIndex {
            let previousCharacter = text[text.index(before: triggerIndex)]
            guard previousCharacter.isWhitespace else {
                return nil
            }
        }

        let queryStart = text.index(after: triggerIndex)
        let rawQuery = String(text[queryStart..<text.endIndex])
        let query = rawQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty,
              !query.contains(where: \.isNewline) else {
            return nil
        }

        if query.contains(where: \.isWhitespace) {
            let looksFileLike = query.contains("/")
                || query.contains("\\")
                || query.contains(".")
            guard looksFileLike else {
                return nil
            }
        }

        return TurnTrailingToken(query: query, tokenRange: triggerIndex..<text.endIndex)
    }

    // Shared parser for final-token autocomplete triggers (`@`, `$`).
    private static func trailingToken(in text: String, trigger: Character) -> TurnTrailingToken? {
        guard !text.isEmpty else {
            return nil
        }

        let tokenStart: String.Index
        if let lastWhitespaceIndex = text.lastIndex(where: { $0.isWhitespace }) {
            tokenStart = text.index(after: lastWhitespaceIndex)
        } else {
            tokenStart = text.startIndex
        }

        guard tokenStart < text.endIndex else {
            return nil
        }

        guard text[tokenStart] == trigger else {
            return nil
        }

        let queryStart = text.index(after: tokenStart)
        let query = String(text[queryStart..<text.endIndex])
        guard !query.contains(where: { $0.isWhitespace }),
              !query.isEmpty else {
            return nil
        }

        return TurnTrailingToken(query: query, tokenRange: tokenStart..<text.endIndex)
    }

    private static func appendNormalizedFileMentionAliases(
        for seed: String,
        into aliases: inout Set<String>
    ) {
        let trimmedSeed = seed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedSeed.isEmpty else {
            return
        }

        let pathExtension = (trimmedSeed as NSString).pathExtension
        let normalizedExtension = pathExtension.lowercased()
        let stem = normalizedExtension.isEmpty
            ? trimmedSeed
            : (trimmedSeed as NSString).deletingPathExtension
        let tokens = mentionSearchTokens(from: stem)
        guard !tokens.isEmpty else {
            return
        }

        var baseVariants: Set<String> = [
            tokens.joined(separator: " "),
            tokens.joined(separator: "-"),
            tokens.joined(separator: "_"),
            tokens.joined(),
            lowerCamelCase(from: tokens),
            upperCamelCase(from: tokens),
        ]
        baseVariants = baseVariants.filter { !$0.isEmpty }

        for variant in baseVariants {
            aliases.insert(variant)
            if !normalizedExtension.isEmpty {
                aliases.insert("\(variant).\(normalizedExtension)")
            }
        }
    }

    private static func mentionSearchTokens(from value: String) -> [String] {
        let trimmedValue = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedValue.isEmpty else {
            return []
        }

        return trimmedValue
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty }
            .flatMap(tokensFromMentionSegment)
    }

    // Keeps Apple-style prefixes like `iOS` together so alias variants stay natural.
    private static func tokensFromMentionSegment(_ segment: String) -> [String] {
        let trimmedSegment = segment.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedSegment.isEmpty else {
            return []
        }

        guard let regex = fileMentionSegmentRegex else {
            return [trimmedSegment.lowercased()]
        }

        let range = NSRange(trimmedSegment.startIndex..., in: trimmedSegment)
        let rawTokens = regex.matches(in: trimmedSegment, range: range).compactMap { match in
            Range(match.range, in: trimmedSegment).map { String(trimmedSegment[$0]) }
        }
        guard !rawTokens.isEmpty else {
            return [trimmedSegment.lowercased()]
        }

        var normalizedTokens: [String] = []
        var index = 0

        while index < rawTokens.count {
            let token = rawTokens[index]

            if token.count == 1,
               token == token.lowercased(),
               index + 1 < rawTokens.count,
               isAllCapsAcronym(rawTokens[index + 1]) {
                normalizedTokens.append((token + rawTokens[index + 1]).lowercased())
                index += 2
                continue
            }

            normalizedTokens.append(token.lowercased())
            index += 1
        }

        return normalizedTokens
    }

    private static func isAllCapsAcronym(_ token: String) -> Bool {
        token.count > 1
            && token.unicodeScalars.allSatisfy {
                CharacterSet.uppercaseLetters.contains($0) || CharacterSet.decimalDigits.contains($0)
            }
    }

    private static func lowerCamelCase(from tokens: [String]) -> String {
        guard let first = tokens.first else {
            return ""
        }

        let tail = tokens.dropFirst().map(capitalizedToken).joined()
        return first + tail
    }

    private static func upperCamelCase(from tokens: [String]) -> String {
        tokens.map(capitalizedToken).joined()
    }

    private static func capitalizedToken(_ token: String) -> String {
        guard let first = token.first else {
            return token
        }

        return first.uppercased() + token.dropFirst()
    }

    private static func deletingPathExtension(from value: String) -> String {
        let trimmedValue = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedValue.isEmpty else {
            return ""
        }
        return (trimmedValue as NSString).deletingPathExtension
    }

    private static func fileNameAliasCollisionKey(for fileName: String) -> String? {
        let trimmedName = fileName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty else {
            return nil
        }

        let normalizedExtension = (trimmedName as NSString).pathExtension.lowercased()
        let stem = deletingPathExtension(from: trimmedName)
        let tokens = mentionSearchTokens(from: stem)
        guard !tokens.isEmpty else {
            return normalizedExtension.isEmpty ? nil : ".\(normalizedExtension)"
        }

        let tokenKey = tokens.joined(separator: "|")
        return normalizedExtension.isEmpty ? tokenKey : "\(tokenKey).\(normalizedExtension)"
    }

    // Reuses the stop-button refresh path so queued sends do not trust stale running flags.
    private func refreshBusyStateIfNeeded(
        coderover: CodeRoverService,
        threadID: String,
        wasBusy: Bool
    ) async -> Bool {
        guard wasBusy,
              coderover.activeTurnID(for: threadID) == nil,
              coderover.runningThreadIDs.contains(threadID) else {
            return wasBusy
        }

        _ = await coderover.refreshInFlightTurnState(threadId: threadID)
        return isThreadBusy(coderover: coderover, threadID: threadID)
    }

    private func isThreadBusy(coderover: CodeRoverService, threadID: String) -> Bool {
        coderover.activeTurnID(for: threadID) != nil || coderover.runningThreadIDs.contains(threadID)
    }

    private func performBusyThreadSend(
        _ pendingSend: PendingTurnSend,
        coderover: CodeRoverService,
        threadID: String
    ) async {
        let queuedDraft = QueuedTurnDraft(
            id: UUID().uuidString,
            text: pendingSend.payload,
            attachments: pendingSend.attachments,
            skillMentions: pendingSend.skillMentions,
            createdAt: Date()
        )
        appendQueuedDraft(queuedDraft, coderover: coderover, threadID: threadID)
        shouldAnchorToAssistantResponse = true
        clearComposer()
    }

    // Sends the prepared payload and restores the exact raw composer state if startTurn fails.
    private func performTurnSend(
        _ pendingSend: PendingTurnSend,
        coderover: CodeRoverService,
        threadID: String
    ) async {
        isPlanModeArmed = false
        shouldAnchorToAssistantResponse = true
        clearComposer()

        do {
            try await coderover.startTurn(
                userInput: pendingSend.payload,
                threadId: threadID,
                attachments: pendingSend.attachments,
                skillMentions: pendingSend.skillMentions,
                collaborationMode: pendingSend.collaborationMode
            )
        } catch {
            shouldAnchorToAssistantResponse = false
            restoreComposerState(from: pendingSend)
            if pendingSend.collaborationMode == .plan,
               shouldRearmPlanModeAfterSendFailure(error) {
                isPlanModeArmed = true
            }
            if coderover.lastErrorMessage?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true {
                coderover.lastErrorMessage = error.localizedDescription
            }
        }
    }

    private func restoreComposerState(from pendingSend: PendingTurnSend) {
        input = pendingSend.rawInput
        composerAttachments = pendingSend.rawAttachments
    }

    // Resolves the active turn id for manual steer without relying on async autoclosure operators.
    private func resolveSteerExpectedTurnID(
        coderover: CodeRoverService,
        threadID: String
    ) async throws -> String? {
        if let activeTurnID = coderover.activeTurnID(for: threadID) {
            return activeTurnID
        }

        return try await coderover.resolveInFlightTurnID(threadId: threadID)
    }

    private func queuedDrafts(coderover: CodeRoverService, threadID: String) -> [QueuedTurnDraft] {
        coderover.queuedTurnDraftsByThread[threadID] ?? []
    }

    private func setQueuedDrafts(_ drafts: [QueuedTurnDraft], coderover: CodeRoverService, threadID: String) {
        if drafts.isEmpty {
            coderover.queuedTurnDraftsByThread.removeValue(forKey: threadID)
            return
        }
        coderover.queuedTurnDraftsByThread[threadID] = drafts
    }

    private func appendQueuedDraft(_ draft: QueuedTurnDraft, coderover: CodeRoverService, threadID: String) {
        var drafts = queuedDrafts(coderover: coderover, threadID: threadID)
        drafts.append(draft)
        setQueuedDrafts(drafts, coderover: coderover, threadID: threadID)
    }

    private func prependQueuedDraft(_ draft: QueuedTurnDraft, coderover: CodeRoverService, threadID: String) {
        var drafts = queuedDrafts(coderover: coderover, threadID: threadID)
        drafts.insert(draft, at: 0)
        setQueuedDrafts(drafts, coderover: coderover, threadID: threadID)
    }

    private func dequeueQueuedDraft(coderover: CodeRoverService, threadID: String) -> QueuedTurnDraft? {
        var drafts = queuedDrafts(coderover: coderover, threadID: threadID)
        guard !drafts.isEmpty else { return nil }
        let nextDraft = drafts.removeFirst()
        setQueuedDrafts(drafts, coderover: coderover, threadID: threadID)
        return nextDraft
    }

    private func queuePauseState(coderover: CodeRoverService, threadID: String) -> QueuePauseState {
        coderover.queuePauseStateByThread[threadID] ?? .active
    }

    private func setQueuePauseState(_ state: QueuePauseState, coderover: CodeRoverService, threadID: String) {
        switch state {
        case .active:
            coderover.queuePauseStateByThread.removeValue(forKey: threadID)
        case .paused:
            coderover.queuePauseStateByThread[threadID] = state
        }
    }

    private func resetSlashCommandState() {
        slashCommandPanelState = .hidden
    }

    private func removeTrailingSlashCommandTokenFromInputIfNeeded() {
        if let updatedInput = Self.removingTrailingSlashCommandToken(in: input) {
            input = updatedInput
        }
    }

    /// Removes the first occurrence of `token` that sits at a word boundary
    /// (followed by whitespace, punctuation, or end-of-string). Consumes one trailing space when present.
    static func removeBoundedToken(
        _ token: String,
        from text: String,
        caseInsensitive: Bool = false
    ) -> String {
        let escaped = NSRegularExpression.escapedPattern(for: token)
        let options: NSRegularExpression.Options = caseInsensitive ? [.caseInsensitive] : []
        guard let regex = try? NSRegularExpression(
            pattern: escaped + "(?:[\\s,.;:!?)\\]}>]|$)",
            options: options
        ) else {
            return text
        }
        let range = NSRange(text.startIndex..., in: text)
        guard let match = regex.firstMatch(in: text, range: range) else {
            return text
        }
        var result = text
        let matchRange = Range(match.range, in: text)!
        result.replaceSubrange(matchRange, with: "")
        return result
    }

    /// Replaces all boundary-safe occurrences of `token` with `replacement`.
    /// Boundary = followed by whitespace, punctuation, or end-of-string.
    static func replaceBoundedToken(
        _ token: String,
        with replacement: String,
        in text: String,
        caseInsensitive: Bool = false
    ) -> String {
        let escaped = NSRegularExpression.escapedPattern(for: token)
        let options: NSRegularExpression.Options = caseInsensitive ? [.caseInsensitive] : []
        guard let regex = try? NSRegularExpression(
            pattern: escaped + "(?=[\\s,.;:!?)\\]}>]|$)",
            options: options
        ) else {
            return text
        }
        let range = NSRange(text.startIndex..., in: text)
        let safeReplacement = NSRegularExpression.escapedTemplate(for: replacement)
        return regex.stringByReplacingMatches(in: text, range: range, withTemplate: safeReplacement)
    }

    // MARK: - Git Actions

    func triggerGitAction(
        _ action: TurnGitActionKind,
        coderover: CodeRoverService,
        workingDirectory: String?,
        threadID: String,
        activeTurnID: String?
    ) {
        guard !isRunningGitAction else { return }
        runningGitAction = action

        Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.runningGitAction = nil }

            let gitService = GitActionsService(coderover: coderover, workingDirectory: workingDirectory)

            do {
                switch action {
                case .syncNow:
                    let result = try await gitService.status()
                    applyGitRepoSync(result)
                    if result.state == "behind_only" || result.state == "diverged" || result.state == "dirty_and_behind" {
                        gitSyncAlert = TurnGitSyncAlert(
                            title: "Branch is behind remote",
                            message: "Pull with rebase to update?",
                            action: .pullRebase
                        )
                    }

                case .commit:
                    let result = try await gitService.commit(message: nil)
                    let statusAfter = try? await gitService.status()
                    if let statusAfter { applyGitRepoSync(statusAfter) }
                    _ = result // commit succeeded

                case .push:
                    let result = try await gitService.push()
                    handleSuccessfulPush(
                        result,
                        coderover: coderover,
                        workingDirectory: workingDirectory,
                        threadID: threadID
                    )

                case .commitAndPush:
                    _ = try await gitService.commit(message: nil)
                    let pushResult = try await gitService.push()
                    handleSuccessfulPush(
                        pushResult,
                        coderover: coderover,
                        workingDirectory: workingDirectory,
                        threadID: threadID
                    )

                case .createPR:
                    let remoteResult = try await getRemoteURL(coderover: coderover, workingDirectory: workingDirectory)
                    guard let ownerRepo = remoteResult.ownerRepo else {
                        throw GitActionsError.bridgeError(code: "no_remote", message: "Could not determine repository from remote URL.")
                    }
                    let branch = gitRepoSync?.currentBranch ?? currentGitBranch.nilIfEmpty ?? ""
                    guard !branch.isEmpty else {
                        throw GitActionsError.bridgeError(code: "no_branch", message: "No current branch found.")
                    }
                    let base = selectedGitBaseBranch.nilIfEmpty ?? gitDefaultBranch
                    let prURL = buildPRURL(ownerRepo: ownerRepo, branch: branch, base: base)
                    if let url = URL(string: prURL) {
                        await UIApplication.shared.open(url)
                    }

                case .discardRuntimeChangesAndSync:
                    let result = try await gitService.resetToRemote()
                    if let status = result.status { applyGitRepoSync(status) }
                }
            } catch let error as GitActionsError {
                switch error {
                case .bridgeError(let code, _) where code == "nothing_to_commit":
                    isShowingNothingToCommitAlert = true
                default:
                    gitSyncAlert = TurnGitSyncAlert(
                        title: "Git Error",
                        message: error.errorDescription ?? "Operation failed.",
                        action: .dismissOnly
                    )
                }
            } catch {
                gitSyncAlert = TurnGitSyncAlert(
                    title: "Git Error",
                    message: error.localizedDescription,
                    action: .dismissOnly
                )
            }
        }
    }

    func inlineCommitAndPush(coderover: CodeRoverService, workingDirectory: String?, threadID: String) {
        guard !isRunningGitAction else { return }
        runningGitAction = .commitAndPush

        Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.runningGitAction = nil }

            let gitService = GitActionsService(coderover: coderover, workingDirectory: workingDirectory)
            do {
                _ = try await gitService.commit(message: nil)
                let pushResult = try await gitService.push()
                handleSuccessfulPush(
                    pushResult,
                    coderover: coderover,
                    workingDirectory: workingDirectory,
                    threadID: threadID
                )
            } catch let error as GitActionsError {
                switch error {
                case .bridgeError(let code, _) where code == "nothing_to_commit":
                    isShowingNothingToCommitAlert = true
                default:
                    gitSyncAlert = TurnGitSyncAlert(
                        title: "Git Error",
                        message: error.errorDescription ?? "Operation failed.",
                        action: .dismissOnly
                    )
                }
            } catch {
                gitSyncAlert = TurnGitSyncAlert(
                    title: "Git Error",
                    message: error.localizedDescription,
                    action: .dismissOnly
                )
            }
        }
    }

    func refreshGitBranchTargets(coderover: CodeRoverService, workingDirectory: String?, threadID: String) {
        guard !isLoadingGitBranchTargets else { return }
        isLoadingGitBranchTargets = true

        Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.isLoadingGitBranchTargets = false }

            let gitService = GitActionsService(coderover: coderover, workingDirectory: workingDirectory)
            do {
                let result = try await gitService.branchesWithStatus()
                availableGitBranchTargets = result.branches
                if let current = result.currentBranch, !current.isEmpty {
                    currentGitBranch = current
                }
                if let defaultBranch = result.defaultBranch, !defaultBranch.isEmpty {
                    gitDefaultBranch = defaultBranch
                    if selectedGitBaseBranch.isEmpty {
                        selectedGitBaseBranch = defaultBranch
                    }
                }
                if let status = result.status {
                    applyObservedGitRepoSync(
                        status,
                        coderover: coderover,
                        workingDirectory: workingDirectory,
                        threadID: threadID
                    )
                }
            } catch {
                // Silently fail — branches will just be empty
            }
        }
    }

    // Debounces repo status refreshes so live file-change streams can update the topbar safely.
    func scheduleGitStatusRefresh(coderover: CodeRoverService, workingDirectory: String?, threadID: String) {
        gitStatusRefreshTask?.cancel()
        gitStatusRefreshTask = Task { @MainActor [weak self] in
            guard let self else { return }

            do {
                try await Task.sleep(nanoseconds: gitStatusRefreshDebounceNanoseconds)
            } catch {
                return
            }

            let gitService = GitActionsService(coderover: coderover, workingDirectory: workingDirectory)
            do {
                let result = try await gitService.status()
                applyObservedGitRepoSync(
                    result,
                    coderover: coderover,
                    workingDirectory: workingDirectory,
                    threadID: threadID
                )
            } catch {
                // Non-fatal: the next lifecycle refresh/manual action can recover the badge.
            }
        }
    }

    func switchGitBranch(
        to branch: String,
        coderover: CodeRoverService,
        workingDirectory: String?,
        threadID: String,
        activeTurnID: String?
    ) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            guard activeTurnID == nil,
                  !coderover.runningThreadIDs.contains(threadID),
                  !self.isRunningGitAction,
                  !self.isSwitchingGitBranch else { return }

            self.isSwitchingGitBranch = true
            defer { self.isSwitchingGitBranch = false }

            let gitService = GitActionsService(coderover: coderover, workingDirectory: workingDirectory)
            do {
                let result = try await gitService.checkout(branch: branch)
                currentGitBranch = result.currentBranch
                if let status = result.status { applyGitRepoSync(status) }
            } catch let error as GitActionsError {
                gitSyncAlert = TurnGitSyncAlert(
                    title: "Branch Switch Failed",
                    message: error.errorDescription ?? "Could not switch branch.",
                    action: .dismissOnly
                )
            } catch {
                gitSyncAlert = TurnGitSyncAlert(
                    title: "Branch Switch Failed",
                    message: error.localizedDescription,
                    action: .dismissOnly
                )
            }
        }
    }

    func selectGitBaseBranch(_ branch: String) {
        selectedGitBaseBranch = branch
    }

    func applyGitRepoSync(_ result: GitRepoSyncResult) {
        gitRepoSync = result
        if let branch = result.currentBranch, !branch.isEmpty {
            currentGitBranch = branch
        }
    }

    // Detects push-like repo transitions that happen outside the toolbar callback path.
    private func applyObservedGitRepoSync(
        _ result: GitRepoSyncResult,
        coderover: CodeRoverService,
        workingDirectory: String?,
        threadID: String
    ) {
        let previousSync = gitRepoSync
        applyGitRepoSync(result)

        guard let previousSync else {
            return
        }

        let branchStayedStable = previousSync.currentBranch == result.currentBranch
        let didClearAheadQueue = previousSync.aheadCount > 0 && result.aheadCount == 0
        guard branchStayedStable, didClearAheadQueue else {
            return
        }

        coderover.appendHiddenPushResetMarkers(
            threadId: threadID,
            workingDirectory: workingDirectory,
            branch: result.currentBranch ?? "",
            remote: trackingRemoteName(from: result.trackingBranch)
        )
    }

    // Keeps repo totals fresh and resets the per-chat sidebar badge after a manual push.
    private func handleSuccessfulPush(
        _ result: GitPushResult,
        coderover: CodeRoverService,
        workingDirectory: String?,
        threadID: String
    ) {
        if let status = result.status {
            applyGitRepoSync(status)
        }

        coderover.appendHiddenPushResetMarkers(
            threadId: threadID,
            workingDirectory: workingDirectory,
            branch: result.branch,
            remote: result.remote
        )
    }

    private func trackingRemoteName(from trackingBranch: String?) -> String? {
        guard let trackingBranch else {
            return nil
        }

        let trimmed = trackingBranch.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return nil
        }

        return trimmed.split(separator: "/", maxSplits: 1, omittingEmptySubsequences: true).first.map(String.init)
    }

    func dismissGitSyncAlert() {
        gitSyncAlert = nil
    }

    func confirmGitSyncAlertAction(
        _ alertAction: TurnGitSyncAlertAction,
        coderover: CodeRoverService,
        workingDirectory: String?,
        threadID: String,
        activeTurnID: String?
    ) {
        gitSyncAlert = nil
        guard alertAction == .pullRebase else { return }

        Task { @MainActor [weak self] in
            guard let self else { return }
            guard activeTurnID == nil,
                  !coderover.runningThreadIDs.contains(threadID),
                  !self.isRunningGitAction,
                  !self.isSwitchingGitBranch else { return }

            self.runningGitAction = .syncNow
            defer { self.runningGitAction = nil }

            let gitService = GitActionsService(coderover: coderover, workingDirectory: workingDirectory)
            do {
                let result = try await gitService.pull()
                if let status = result.status { applyGitRepoSync(status) }
            } catch {
                gitSyncAlert = TurnGitSyncAlert(
                    title: "Pull Failed",
                    message: error.localizedDescription,
                    action: .dismissOnly
                )
            }
        }
    }

    private func getRemoteURL(coderover: CodeRoverService, workingDirectory: String?) async throws -> GitRemoteUrlResult {
        let gitService = GitActionsService(coderover: coderover, workingDirectory: workingDirectory)
        return try await gitService.remoteUrl()
    }

    private func buildPRURL(ownerRepo: String, branch: String, base: String) -> String {
        let encodedBranch = branch.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? branch
        let encodedBase = base.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? base
        return "https://github.com/\(ownerRepo)/compare/\(encodedBase)...\(encodedBranch)?expand=1"
    }
}

struct TurnComposerMentionedFile: Identifiable, Equatable {
    let id = UUID().uuidString
    let fileName: String
    let path: String
}

struct TurnComposerMentionedSkill: Identifiable, Equatable {
    let id = UUID().uuidString
    let name: String
    let path: String?
    let description: String?
}

struct TurnTrailingFileAutocompleteToken: Equatable {
    let query: String
    let tokenRange: Range<String.Index>
}

struct TurnTrailingSkillAutocompleteToken: Equatable {
    let query: String
    let tokenRange: Range<String.Index>
}

private struct TurnTrailingToken: Equatable {
    let query: String
    let tokenRange: Range<String.Index>
}

private extension String {
    var nilIfEmpty: String? {
        isEmpty ? nil : self
    }
}
