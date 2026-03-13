// FILE: TurnView.swift
// Purpose: Orchestrates turn screen composition, wiring service state to timeline + composer components.
// Layer: View
// Exports: TurnView
// Depends on: CodeRoverService, TurnViewModel, TurnConversationContainerView, TurnComposerHostView, TurnViewAlertModifier, TurnViewLifecycleModifier

import SwiftUI
import PhotosUI

struct TurnView: View {
    let thread: ConversationThread

    @Environment(CodeRoverService.self) private var coderover
    @Environment(\.scenePhase) private var scenePhase
    @State private var viewModel = TurnViewModel()
    @State private var isInputFocused = false
    @State private var isShowingThreadPathSheet = false
    @State private var isLoadingRepositoryDiff = false
    @State private var repositoryDiffPresentation: TurnDiffPresentation?
    @State private var assistantRevertSheetState: AssistantRevertSheetState?
    @State private var alertApprovalRequest: CodeRoverApprovalRequest?
    @State private var reconnectCoordinator = ContentViewModel()
    @State private var isReconnectInFlight = false

    // ─── ENTRY POINT ─────────────────────────────────────────────
    var body: some View {
        let activeTurnID = coderover.activeTurnID(for: thread.id)
        let gitWorkingDirectory = thread.gitWorkingDirectory
        let isThreadRunning = activeTurnID != nil || coderover.runningThreadIDs.contains(thread.id)
        let showsGitControls = coderover.isConnected && gitWorkingDirectory != nil
        let latestTurnTerminalState = coderover.latestTurnTerminalState(for: thread.id)
        let stoppedTurnIDs = coderover.stoppedTurnIDs(for: thread.id)
        let rawMessages = coderover.messages(for: thread.id)
        let timelineChangeToken = coderover.messageRevision(for: thread.id)
        let projectedMessages: [ChatMessage] = {
            viewModel.updateProjectedTimeline(
                threadID: thread.id,
                messages: rawMessages,
                changeToken: timelineChangeToken
            )
            return viewModel.projectedMessages
        }()
        let assistantRevertStatesByMessageID = projectedMessages.reduce(into: [String: AssistantRevertPresentation]()) {
            partialResult, message in
            if let presentation = coderover.assistantRevertPresentation(
                for: message,
                workingDirectory: gitWorkingDirectory
            ) {
                partialResult[message.id] = presentation
            }
        }
        let liveRepoRefreshSignal = repoRefreshSignal(from: rawMessages)

        return TurnConversationContainerView(
            threadID: thread.id,
            messages: projectedMessages,
            timelineChangeToken: timelineChangeToken,
            activeTurnID: activeTurnID,
            isThreadRunning: isThreadRunning,
            latestTurnTerminalState: latestTurnTerminalState,
            stoppedTurnIDs: stoppedTurnIDs,
            assistantRevertStatesByMessageID: assistantRevertStatesByMessageID,
            errorMessage: timelineErrorMessage,
            shouldAnchorToAssistantResponse: shouldAnchorToAssistantResponseBinding,
            isScrolledToBottom: isScrolledToBottomBinding,
            emptyState: AnyView(emptyState),
            composer: AnyView(
                TurnComposerHostView(
                    viewModel: viewModel,
                    coderover: coderover,
                    thread: thread,
                    activeTurnID: activeTurnID,
                    isThreadRunning: isThreadRunning,
                    isInputFocused: $isInputFocused,
                    orderedModelOptions: orderedModelOptions,
                    selectedModelTitle: selectedModelTitle,
                    reasoningDisplayOptions: reasoningDisplayOptions,
                    selectedReasoningTitle: selectedReasoningTitle,
                    isConnected: coderover.isConnected,
                    isReconnectAvailable: coderover.hasSavedBridgePairing,
                    isReconnectInFlight: isReconnectInFlight || coderover.isConnecting,
                    connectionStatusMessage: connectionStatusMessage,
                    showsGitControls: showsGitControls,
                    isGitBranchSelectorEnabled: canRunGitAction(
                        isThreadRunning: isThreadRunning,
                        gitWorkingDirectory: gitWorkingDirectory
                    ),
                    onSelectGitBranch: { branch in
                        guard canRunGitAction(
                            isThreadRunning: isThreadRunning,
                            gitWorkingDirectory: gitWorkingDirectory
                        ) else { return }

                        viewModel.switchGitBranch(
                            to: branch,
                            coderover: coderover,
                            workingDirectory: gitWorkingDirectory,
                            threadID: thread.id,
                            activeTurnID: activeTurnID
                        )
                    },
                    onRefreshGitBranches: {
                        guard showsGitControls else { return }
                        viewModel.refreshGitBranchTargets(
                            coderover: coderover,
                            workingDirectory: gitWorkingDirectory,
                            threadID: thread.id
                        )
                    },
                    onReconnect: handleReconnect,
                    onSend: handleSend
                )
            ),
            repositoryLoadingToastOverlay: AnyView(EmptyView()),
            usageToastOverlay: AnyView(EmptyView()),
            isRepositoryLoadingToastVisible: false,
            onRetryUserMessage: { messageText in
                viewModel.input = messageText
                isInputFocused = true
            },
            onTapAssistantRevert: { message in
                startAssistantRevertPreview(message: message, gitWorkingDirectory: gitWorkingDirectory)
            },
            onTapOutsideComposer: {
                guard isInputFocused else { return }
                isInputFocused = false
                viewModel.clearComposerAutocomplete()
            }
        )
        .environment(\.inlineCommitAndPushAction, showsGitControls ? {
            viewModel.inlineCommitAndPush(
                coderover: coderover,
                workingDirectory: gitWorkingDirectory,
                threadID: thread.id
            )
        } as (() -> Void)? : nil)
        .navigationTitle(thread.displayTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            TurnToolbarContent(
                displayTitle: thread.displayTitle,
                providerTitle: thread.providerBadgeTitle,
                navigationContext: threadNavigationContext,
                repoDiffTotals: viewModel.gitRepoSync?.repoDiffTotals,
                isLoadingRepoDiff: isLoadingRepositoryDiff,
                showsGitActions: showsGitControls,
                isGitActionEnabled: canRunGitAction(
                    isThreadRunning: isThreadRunning,
                    gitWorkingDirectory: gitWorkingDirectory
                ),
                isRunningGitAction: viewModel.isRunningGitAction,
                showsDiscardRuntimeChangesAndSync: viewModel.shouldShowDiscardRuntimeChangesAndSync,
                gitSyncState: viewModel.gitSyncState,
                contextWindowUsage: coderover.contextWindowUsageByThread[thread.id],
                threadId: thread.id,
                isCompacting: coderover.compactingThreadIDs.contains(thread.id),
                onCompactContext: {
                    Task {
                        try? await coderover.compactContext(threadId: thread.id)
                    }
                },
                onTapRepoDiff: showsGitControls ? {
                    presentRepositoryDiff(workingDirectory: gitWorkingDirectory)
                } : nil,
                onGitAction: { action in
                    handleGitActionSelection(
                        action,
                        isThreadRunning: isThreadRunning,
                        gitWorkingDirectory: gitWorkingDirectory
                    )
                },
                isShowingPathSheet: $isShowingThreadPathSheet
            )
        }
        .fullScreenCover(isPresented: isCameraPresentedBinding) {
            CameraImagePicker { data in
                viewModel.enqueueCapturedImageData(data, coderover: coderover)
            }
            .ignoresSafeArea()
        }
        .photosPicker(
            isPresented: isPhotoPickerPresentedBinding,
            selection: photoPickerItemsBinding,
            maxSelectionCount: max(1, viewModel.remainingAttachmentSlots),
            matching: .images,
            preferredItemEncoding: .automatic
        )
        .turnViewLifecycle(
            taskID: thread.id,
            activeTurnID: activeTurnID,
            isThreadRunning: isThreadRunning,
            isConnected: coderover.isConnected,
            scenePhase: scenePhase,
            approvalRequestID: approvalForThread?.id,
            photoPickerItems: viewModel.photoPickerItems,
            onTask: {
                await prepareThreadIfReady(gitWorkingDirectory: gitWorkingDirectory)
            },
            onInitialAppear: {
                handleInitialAppear(activeTurnID: activeTurnID)
            },
            onPhotoPickerItemsChanged: { newItems in
                handlePhotoPickerItemsChanged(newItems)
            },
            onActiveTurnChanged: { newValue in
                if newValue != nil {
                    viewModel.clearComposerAutocomplete()
                }
            },
            onThreadRunningChanged: { wasRunning, isRunning in
                guard wasRunning, !isRunning else { return }
                viewModel.flushQueueIfPossible(coderover: coderover, threadID: thread.id)
                guard showsGitControls else { return }
                viewModel.refreshGitBranchTargets(
                    coderover: coderover,
                    workingDirectory: gitWorkingDirectory,
                    threadID: thread.id
                )
            },
            onConnectionChanged: { wasConnected, isConnected in
                guard !wasConnected, isConnected else { return }
                viewModel.flushQueueIfPossible(coderover: coderover, threadID: thread.id)
                guard showsGitControls else { return }
                viewModel.refreshGitBranchTargets(
                    coderover: coderover,
                    workingDirectory: gitWorkingDirectory,
                    threadID: thread.id
                )
            },
            onScenePhaseChanged: { _ in },
            onApprovalRequestIDChanged: {
                alertApprovalRequest = approvalForThread
            }
        )
        .onChange(of: liveRepoRefreshSignal) { _, _ in
            guard showsGitControls, liveRepoRefreshSignal != nil else { return }
            viewModel.scheduleGitStatusRefresh(
                coderover: coderover,
                workingDirectory: gitWorkingDirectory,
                threadID: thread.id
            )
        }
        .sheet(isPresented: $isShowingThreadPathSheet) {
            if let context = threadNavigationContext {
                TurnThreadPathSheet(context: context)
            }
        }
        .sheet(item: $repositoryDiffPresentation) { presentation in
            TurnDiffSheet(
                title: presentation.title,
                entries: presentation.entries,
                bodyText: presentation.bodyText,
                messageID: presentation.messageID
            )
        }
        .sheet(isPresented: assistantRevertSheetPresentedBinding) {
            if let assistantRevertSheetState {
                AssistantRevertSheet(
                    state: assistantRevertSheetState,
                    onClose: { self.assistantRevertSheetState = nil },
                    onConfirm: {
                        confirmAssistantRevert(gitWorkingDirectory: gitWorkingDirectory)
                    }
                )
            }
        }
        .turnViewAlerts(
            alertApprovalRequest: $alertApprovalRequest,
            isShowingNothingToCommitAlert: isShowingNothingToCommitAlertBinding,
            gitSyncAlert: gitSyncAlertBinding,
            onDeclineApproval: {
                viewModel.decline(coderover: coderover)
            },
            onApproveApproval: {
                viewModel.approve(coderover: coderover)
            },
            onConfirmGitSyncAction: { alertAction in
                viewModel.confirmGitSyncAlertAction(
                    alertAction,
                    coderover: coderover,
                    workingDirectory: gitWorkingDirectory,
                    threadID: thread.id,
                    activeTurnID: coderover.activeTurnID(for: thread.id)
                )
            }
        )
    }

    // MARK: - Bindings

    private var shouldAnchorToAssistantResponseBinding: Binding<Bool> {
        Binding(
            get: { viewModel.shouldAnchorToAssistantResponse },
            set: { viewModel.shouldAnchorToAssistantResponse = $0 }
        )
    }

    private var isScrolledToBottomBinding: Binding<Bool> {
        Binding(
            get: { viewModel.isScrolledToBottom },
            set: { viewModel.isScrolledToBottom = $0 }
        )
    }

    // Fetches the repo-wide local patch on demand so the toolbar pill opens the same diff UI as turn changes.
    private func presentRepositoryDiff(workingDirectory: String?) {
        guard !isLoadingRepositoryDiff else { return }
        isLoadingRepositoryDiff = true

        Task { @MainActor in
            defer { isLoadingRepositoryDiff = false }

            let gitService = GitActionsService(coderover: coderover, workingDirectory: workingDirectory)

            do {
                let result = try await gitService.diff()
                guard let presentation = TurnDiffPresentationBuilder.repositoryPresentation(from: result.patch) else {
                    viewModel.gitSyncAlert = TurnGitSyncAlert(
                        title: "Git Error",
                        message: "There are no repository changes to show.",
                        action: .dismissOnly
                    )
                    return
                }
                repositoryDiffPresentation = presentation
            } catch let error as GitActionsError {
                viewModel.gitSyncAlert = TurnGitSyncAlert(
                    title: "Git Error",
                    message: error.errorDescription ?? "Could not load repository changes.",
                    action: .dismissOnly
                )
            } catch {
                viewModel.gitSyncAlert = TurnGitSyncAlert(
                    title: "Git Error",
                    message: error.localizedDescription,
                    action: .dismissOnly
                )
            }
        }
    }

    private var isShowingNothingToCommitAlertBinding: Binding<Bool> {
        Binding(
            get: { viewModel.isShowingNothingToCommitAlert },
            set: { viewModel.isShowingNothingToCommitAlert = $0 }
        )
    }

    private var gitSyncAlertBinding: Binding<TurnGitSyncAlert?> {
        Binding(
            get: { viewModel.gitSyncAlert },
            set: { viewModel.gitSyncAlert = $0 }
        )
    }

    private var assistantRevertSheetPresentedBinding: Binding<Bool> {
        Binding(
            get: { assistantRevertSheetState != nil },
            set: { isPresented in
                if !isPresented {
                    assistantRevertSheetState = nil
                }
            }
        )
    }

    private func handleSend() {
        isInputFocused = false
        viewModel.clearComposerAutocomplete()
        viewModel.sendTurn(coderover: coderover, threadID: thread.id)
    }

    private func handleReconnect() {
        guard coderover.hasSavedBridgePairing, !isReconnectInFlight, !coderover.isConnecting else {
            return
        }

        isReconnectInFlight = true
        Task { @MainActor in
            defer { isReconnectInFlight = false }

            do {
                await reconnectCoordinator.stopAutoReconnectForManualScan(coderover: coderover)
                try await reconnectCoordinator.connectUsingSavedPairing(
                    coderover: coderover,
                    performAutoRetry: true
                )
            } catch {
                if coderover.lastErrorMessage?.isEmpty ?? true {
                    coderover.lastErrorMessage = coderover.userFacingConnectFailureMessage(error)
                }
            }
        }
    }

    private func handleGitActionSelection(
        _ action: TurnGitActionKind,
        isThreadRunning: Bool,
        gitWorkingDirectory: String?
    ) {
        guard canRunGitAction(isThreadRunning: isThreadRunning, gitWorkingDirectory: gitWorkingDirectory) else { return }
        viewModel.triggerGitAction(
            action,
            coderover: coderover,
            workingDirectory: gitWorkingDirectory,
            threadID: thread.id,
            activeTurnID: coderover.activeTurnID(for: thread.id)
        )
    }

    private func canRunGitAction(isThreadRunning: Bool, gitWorkingDirectory: String?) -> Bool {
        viewModel.canRunGitAction(
            isConnected: coderover.isConnected,
            isThreadRunning: isThreadRunning,
            hasGitWorkingDirectory: gitWorkingDirectory != nil
        )
    }

    private func handleInitialAppear(activeTurnID: String?) {
        alertApprovalRequest = approvalForThread
    }

    private func handlePhotoPickerItemsChanged(_ newItems: [PhotosPickerItem]) {
        viewModel.enqueuePhotoPickerItems(newItems, coderover: coderover)
        viewModel.photoPickerItems = []
    }

    private func startAssistantRevertPreview(message: ChatMessage, gitWorkingDirectory: String?) {
        guard let gitWorkingDirectory,
              let changeSet = coderover.readyChangeSet(forAssistantMessage: message) else {
            return
        }

        assistantRevertSheetState = AssistantRevertSheetState(
            changeSet: changeSet,
            preview: nil,
            isLoadingPreview: true,
            isApplying: false,
            errorMessage: nil
        )

        Task { @MainActor in
            do {
                let preview = try await coderover.previewRevert(
                    changeSet: changeSet,
                    workingDirectory: gitWorkingDirectory
                )
                guard assistantRevertSheetState?.id == changeSet.id else { return }
                assistantRevertSheetState?.preview = preview
                assistantRevertSheetState?.isLoadingPreview = false
            } catch {
                guard assistantRevertSheetState?.id == changeSet.id else { return }
                assistantRevertSheetState?.isLoadingPreview = false
                assistantRevertSheetState?.errorMessage = error.localizedDescription
            }
        }
    }

    private func confirmAssistantRevert(gitWorkingDirectory: String?) {
        guard let gitWorkingDirectory,
              var assistantRevertSheetState,
              let preview = assistantRevertSheetState.preview,
              preview.canRevert else {
            return
        }

        assistantRevertSheetState.isApplying = true
        assistantRevertSheetState.errorMessage = nil
        self.assistantRevertSheetState = assistantRevertSheetState

        let changeSet = assistantRevertSheetState.changeSet
        Task { @MainActor in
            do {
                let applyResult = try await coderover.applyRevert(
                    changeSet: changeSet,
                    workingDirectory: gitWorkingDirectory
                )

                guard self.assistantRevertSheetState?.id == changeSet.id else { return }
                if applyResult.success {
                    if let status = applyResult.status {
                        viewModel.gitRepoSync = status
                    } else {
                        viewModel.scheduleGitStatusRefresh(
                            coderover: coderover,
                            workingDirectory: gitWorkingDirectory,
                            threadID: thread.id
                        )
                    }
                    self.assistantRevertSheetState = nil
                    return
                }

                self.assistantRevertSheetState?.isApplying = false
                let affectedFiles = self.assistantRevertSheetState?.preview?.affectedFiles
                    ?? changeSet.fileChanges.map(\.path)
                self.assistantRevertSheetState?.preview = RevertPreviewResult(
                    canRevert: false,
                    affectedFiles: affectedFiles,
                    conflicts: applyResult.conflicts,
                    unsupportedReasons: applyResult.unsupportedReasons,
                    stagedFiles: applyResult.stagedFiles
                )
                self.assistantRevertSheetState?.errorMessage = applyResult.conflicts.first?.message
                    ?? applyResult.unsupportedReasons.first
            } catch {
                guard self.assistantRevertSheetState?.id == changeSet.id else { return }
                self.assistantRevertSheetState?.isApplying = false
                self.assistantRevertSheetState?.errorMessage = error.localizedDescription
            }
        }
    }

    private func prepareThreadIfReady(gitWorkingDirectory: String?) async {
        coderover.activeThreadId = thread.id
        await coderover.prepareThreadForDisplay(threadId: thread.id)
        viewModel.flushQueueIfPossible(coderover: coderover, threadID: thread.id)
        guard gitWorkingDirectory != nil else { return }
        viewModel.refreshGitBranchTargets(
            coderover: coderover,
            workingDirectory: gitWorkingDirectory,
            threadID: thread.id
        )
    }

    // Tracks the latest repo-affecting system row so git totals can refresh during active runs.
    private func repoRefreshSignal(from messages: [ChatMessage]) -> String? {
        guard let latestRepoMessage = messages.last(where: { message in
            guard message.role == .system else { return false }
            return message.kind == .fileChange || message.kind == .commandExecution
        }) else {
            return nil
        }

        return "\(latestRepoMessage.id)|\(latestRepoMessage.text.count)|\(latestRepoMessage.isStreaming)"
    }

    private var isPhotoPickerPresentedBinding: Binding<Bool> {
        Binding(
            get: { viewModel.isPhotoPickerPresented },
            set: { viewModel.isPhotoPickerPresented = $0 }
        )
    }

    private var isCameraPresentedBinding: Binding<Bool> {
        Binding(
            get: { viewModel.isCameraPresented },
            set: { viewModel.isCameraPresented = $0 }
        )
    }

    private var photoPickerItemsBinding: Binding<[PhotosPickerItem]> {
        Binding(
            get: { viewModel.photoPickerItems },
            set: { viewModel.photoPickerItems = $0 }
        )
    }

    // MARK: - Derived UI state

    private var orderedModelOptions: [ModelOption] {
        TurnComposerMetaMapper.orderedModels(from: coderover.availableModels)
    }

    private var reasoningDisplayOptions: [TurnComposerReasoningDisplayOption] {
        TurnComposerMetaMapper.reasoningDisplayOptions(
            from: coderover.supportedReasoningEffortsForSelectedModel().map(\.reasoningEffort)
        )
    }

    private var selectedReasoningTitle: String {
        guard let selectedReasoningEffort = coderover.selectedReasoningEffortForSelectedModel() else {
            return "Select reasoning"
        }

        return TurnComposerMetaMapper.reasoningTitle(for: selectedReasoningEffort)
    }

    private var selectedModelTitle: String {
        guard let selectedModel = coderover.selectedModelOption() else {
            return "Select model"
        }

        return TurnComposerMetaMapper.modelTitle(for: selectedModel)
    }

    private var connectionStatusMessage: String {
        if coderover.isConnected {
            return ""
        }

        if isReconnectInFlight || coderover.isConnecting {
            return "Reconnecting to your Mac bridge..."
        }

        if case .retrying(_, let message) = coderover.connectionRecoveryState,
           !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return message
        }

        if let errorMessage = coderover.lastErrorMessage?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !errorMessage.isEmpty {
            return errorMessage
        }

        return "History is available offline. Reconnect before sending new messages."
    }

    private var timelineErrorMessage: String? {
        guard let errorMessage = coderover.lastErrorMessage?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !errorMessage.isEmpty else {
            return nil
        }

        if coderover.isConnected, coderover.isTransientConnectionStatusMessage(errorMessage) {
            return nil
        }

        return errorMessage
    }

    private var approvalForThread: CodeRoverApprovalRequest? {
        guard let request = coderover.pendingApproval else {
            return nil
        }

        guard let requestThreadID = request.threadId else {
            return request
        }

        return requestThreadID == thread.id ? request : nil
    }

    private var threadNavigationContext: TurnThreadNavigationContext? {
        guard let path = thread.normalizedProjectPath ?? thread.cwd,
              !path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        let fullPath = path.trimmingCharacters(in: .whitespacesAndNewlines)
        let folderName = (fullPath as NSString).lastPathComponent
        return TurnThreadNavigationContext(
            folderName: folderName.isEmpty ? fullPath : folderName,
            subtitle: fullPath,
            fullPath: fullPath
        )
    }

    // MARK: - Empty State

    private var emptyState: some View {
        VStack(spacing: 12) {
            Spacer()
            Image("AppLogo")
                .resizable()
                .scaledToFit()
                .frame(width: 56, height: 56)
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                .adaptiveGlass(in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            Text("Hi! How can I help you?")
                .font(AppFont.title2(weight: .semibold))
            // Reinforces the secure transport upgrade right where a new chat starts.
            Text("Chats are End-to-end encrypted")
                .font(AppFont.caption())
                .foregroundStyle(.secondary)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }
}

#Preview {
    NavigationStack {
        TurnView(thread: ConversationThread(id: "thread_preview", title: "Preview"))
            .environment(CodeRoverService())
    }
}
