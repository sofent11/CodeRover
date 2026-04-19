// FILE: TurnView.swift
// Purpose: Orchestrates turn screen composition, wiring service state to timeline + composer components.
// Layer: View
// Exports: TurnView
// Depends on: CodeRoverService, TurnViewModel, TurnConversationContainerView, TurnComposerHostView, TurnViewAlertModifier, TurnViewLifecycleModifier

import SwiftUI
import PhotosUI
import Foundation

struct TurnView: View {
    let thread: ConversationThread

    @Environment(CodeRoverService.self) private var coderover
    @Environment(\.scenePhase) private var scenePhase
    @State private var viewModel = TurnViewModel()
    @State private var isInputFocused = false
    @State private var isShowingThreadPathSheet = false
    @State private var isShowingStatusSheet = false
    @State private var isLoadingRepositoryDiff = false
    @State private var repositoryDiffPresentation: TurnDiffPresentation?
    @State private var assistantRevertSheetState: AssistantRevertSheetState?
    @State private var alertApprovalRequest: CodeRoverApprovalRequest?
    @State private var reconnectCoordinator = ContentViewModel()
    @State private var isReconnectInFlight = false
    @State private var isShowingDesktopRestartConfirmation = false
    @State private var isRestartingDesktopApp = false
    @State private var desktopRestartErrorMessage: String?
    @State private var isRoutingThreadProject = false
    @State private var checkedOutElsewhereAlert: CheckedOutElsewhereAlert?

    // ─── ENTRY POINT ─────────────────────────────────────────────
    var body: some View {
        let resolvedThread = currentResolvedThread
        let activeTurnID = coderover.activeTurnID(for: thread.id)
        let gitWorkingDirectory = resolvedThread.gitWorkingDirectory
        let isThreadRunning = activeTurnID != nil || coderover.runningThreadIDs.contains(thread.id)
        let showsGitControls = coderover.isConnected && gitWorkingDirectory != nil
        let threadCapabilities = resolvedThread.capabilities ?? coderover.currentRuntimeProvider().supports
        let isCodexThread = coderover.runtimeProviderID(for: resolvedThread.provider) == "codex"
        let showsDesktopRestart = coderover.isConnected && isCodexThread && threadCapabilities.desktopRestart
        let latestTurnTerminalState = coderover.latestTurnTerminalState(for: thread.id)
        let stoppedTurnIDs = coderover.stoppedTurnIDs(for: thread.id)
        let rawMessages = coderover.messages(for: thread.id)
        let threadDisplayPhase = coderover.threadDisplayPhase(threadId: thread.id)
        let timelineChangeToken = coderover.messageRevision(for: thread.id)
        let historyState = coderover.historyStateByThread[thread.id]
        let hasOlderHistory = historyState?.hasOlderOnServer ?? false
        let projectedMessages = TurnTimelineReducer.project(messages: rawMessages).messages
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
            hasOlderHistory: hasOlderHistory,
            isLoadingOlderHistory: historyState?.isLoadingOlder ?? false,
            shouldAnchorToAssistantResponse: shouldAnchorToAssistantResponseBinding,
            isScrolledToBottom: isScrolledToBottomBinding,
            emptyState: AnyView(resolvedEmptyState(for: threadDisplayPhase)),
            composer: AnyView(
                TurnComposerHostView(
                    viewModel: viewModel,
                    coderover: coderover,
                    thread: resolvedThread,
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

                        if let alert = makeCheckedOutElsewhereAlert(
                            for: branch,
                            currentThread: resolvedThread
                        ) {
                            checkedOutElsewhereAlert = alert
                            return
                        }

                        viewModel.requestSwitchGitBranch(
                            to: branch,
                            coderover: coderover,
                            workingDirectory: gitWorkingDirectory,
                            threadID: thread.id,
                            activeTurnID: activeTurnID
                        )
                    },
                    onCreateGitBranch: { branch in
                        guard canRunGitAction(
                            isThreadRunning: isThreadRunning,
                            gitWorkingDirectory: gitWorkingDirectory
                        ) else { return }

                        viewModel.requestCreateGitBranch(
                            named: branch,
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
                    onShowStatus: presentStatusSheet,
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
            onTapSubagent: { subagent in
                openThread(subagent.threadId)
            },
            onTapOutsideComposer: {
                guard isInputFocused else { return }
                isInputFocused = false
                viewModel.clearComposerAutocomplete()
            },
            onLoadOlderHistory: {
                Task {
                    try? await coderover.loadOlderThreadHistoryIfNeeded(threadId: thread.id)
                }
            }
        )
        .environment(\.inlineCommitAndPushAction, showsGitControls ? {
            viewModel.inlineCommitAndPush(
                coderover: coderover,
                workingDirectory: gitWorkingDirectory,
                threadID: thread.id
            )
        } as (() -> Void)? : nil)
        .navigationTitle(resolvedThread.displayTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            TurnToolbarContent(
                displayTitle: resolvedThread.displayTitle,
                providerTitle: resolvedThread.providerBadgeTitle,
                navigationContext: threadNavigationContext,
                showsDesktopRestart: showsDesktopRestart,
                isRestartingDesktopApp: isRestartingDesktopApp,
                repoDiffTotals: viewModel.gitRepoSync?.repoDiffTotals,
                isLoadingRepoDiff: isLoadingRepositoryDiff,
                showsThreadProjectActions: showsGitControls,
                isThreadProjectActionEnabled: canRunGitAction(
                    isThreadRunning: isThreadRunning,
                    gitWorkingDirectory: gitWorkingDirectory
                ) && !isRoutingThreadProject,
                isRunningThreadProjectAction: isRoutingThreadProject,
                isManagedWorktreeProject: resolvedThread.isManagedWorktreeProject,
                canForkToLocal: WorktreeFlowCoordinator.localForkProjectPath(
                    for: resolvedThread,
                    localCheckoutPath: viewModel.gitLocalCheckoutPath
                ) != nil,
                showsGitActions: showsGitControls,
                isGitActionEnabled: canRunGitAction(
                    isThreadRunning: isThreadRunning,
                    gitWorkingDirectory: gitWorkingDirectory
                ),
                isRunningGitAction: viewModel.isRunningGitAction,
                showsDiscardRuntimeChangesAndSync: viewModel.shouldShowDiscardRuntimeChangesAndSync,
                gitSyncState: viewModel.gitSyncState,
                contextWindowUsage: coderover.contextWindowUsageByThread[thread.id],
                onTapDesktopRestart: showsDesktopRestart ? {
                    isShowingDesktopRestartConfirmation = true
                } : nil,
                onCompactContext: {
                    Task {
                        try? await coderover.compactContext(threadId: thread.id)
                    }
                },
                onTapRepoDiff: showsGitControls ? {
                    presentRepositoryDiff(workingDirectory: gitWorkingDirectory)
                } : nil,
                onThreadProjectAction: showsGitControls ? { action in
                    handleThreadProjectActionSelection(
                        action,
                        currentThread: resolvedThread,
                        isThreadRunning: isThreadRunning,
                        gitWorkingDirectory: gitWorkingDirectory
                    )
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
        .onAppear {
            logTimelineSnapshot(
                reason: "appear",
                rawMessages: rawMessages,
                projectedMessages: projectedMessages,
                timelineChangeToken: timelineChangeToken,
                activeTurnID: activeTurnID,
                isThreadRunning: isThreadRunning
            )
        }
        .onChange(of: timelineChangeToken) { _, newValue in
            logTimelineSnapshot(
                reason: "timelineChange",
                rawMessages: rawMessages,
                projectedMessages: projectedMessages,
                timelineChangeToken: newValue,
                activeTurnID: activeTurnID,
                isThreadRunning: isThreadRunning
            )
        }
        .sheet(isPresented: $isShowingThreadPathSheet) {
            if let context = threadNavigationContext {
                TurnThreadPathSheet(context: context)
            }
        }
        .sheet(isPresented: $isShowingStatusSheet) {
            TurnStatusSheet(
                contextWindowUsage: coderover.contextWindowUsageByThread[thread.id],
                rateLimitBuckets: coderover.rateLimitBuckets,
                isLoadingRateLimits: coderover.isLoadingRateLimits,
                rateLimitsErrorMessage: coderover.rateLimitsErrorMessage
            )
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
            isShowingDesktopRestartConfirmation: $isShowingDesktopRestartConfirmation,
            desktopRestartErrorMessage: $desktopRestartErrorMessage,
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
            },
            onConfirmDesktopRestart: {
                restartDesktopApp()
            }
        )
        .alert(
            checkedOutElsewhereAlert?.title ?? "Branch Open Elsewhere",
            isPresented: Binding(
                get: { checkedOutElsewhereAlert != nil },
                set: { if !$0 { checkedOutElsewhereAlert = nil } }
            ),
            presenting: checkedOutElsewhereAlert
        ) { alert in
            if let threadID = alert.existingThreadID {
                Button("Open Thread") {
                    openThread(threadID)
                }
            }
            Button("Cancel", role: .cancel) {
                checkedOutElsewhereAlert = nil
            }
        } message: { alert in
            Text(alert.message)
        }
    }

    private func restartDesktopApp() {
        guard !isRestartingDesktopApp else { return }
        isRestartingDesktopApp = true

        Task { @MainActor in
            defer { isRestartingDesktopApp = false }

            do {
                let service = DesktopAppRestartService(coderover: coderover)
                try await service.restartApp(provider: thread.provider, threadId: thread.id)
            } catch {
                desktopRestartErrorMessage = error.localizedDescription
            }
        }
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
                    performAutoRetry: true,
                    preferredThreadId: thread.id
                )
            } catch {
                if coderover.lastErrorMessage?.isEmpty ?? true {
                    coderover.lastErrorMessage = coderover.userFacingConnectFailureMessage(error)
                }
            }
        }
    }

    private func presentStatusSheet() {
        guard coderover.runtimeProviderID(for: thread.provider) == "codex" else {
            return
        }

        isShowingStatusSheet = true
        Task {
            await coderover.refreshContextWindowUsage(threadId: thread.id)
            await coderover.refreshRateLimits()
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

    private func handleThreadProjectActionSelection(
        _ action: TurnThreadProjectAction,
        currentThread: ConversationThread,
        isThreadRunning: Bool,
        gitWorkingDirectory: String?
    ) {
        guard canRunGitAction(isThreadRunning: isThreadRunning, gitWorkingDirectory: gitWorkingDirectory),
              !isRoutingThreadProject else {
            return
        }

        switch action {
        case .handoff:
            handleWorktreeHandoffTap(currentThread: currentThread)
        case .forkToLocal:
            startLocalFork(currentThread: currentThread)
        case .forkToWorktree:
            startForkIntoWorktree(currentThread: currentThread)
        }
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
        await coderover.refreshContextWindowUsage(threadId: thread.id)
        viewModel.flushQueueIfPossible(coderover: coderover, threadID: thread.id)
        guard gitWorkingDirectory != nil else { return }
        viewModel.refreshGitBranchTargets(
            coderover: coderover,
            workingDirectory: gitWorkingDirectory,
            threadID: thread.id
        )
    }

    private var currentResolvedThread: ConversationThread {
        coderover.thread(for: thread.id) ?? thread
    }

    private var preferredWorktreeBaseBranch: String {
        let currentBranch = viewModel.currentGitBranch.trimmingCharacters(in: .whitespacesAndNewlines)
        if !currentBranch.isEmpty {
            return currentBranch
        }

        let selectedBaseBranch = viewModel.selectedGitBaseBranch.trimmingCharacters(in: .whitespacesAndNewlines)
        if !selectedBaseBranch.isEmpty {
            return selectedBaseBranch
        }

        let defaultBranch = viewModel.gitDefaultBranch.trimmingCharacters(in: .whitespacesAndNewlines)
        if !defaultBranch.isEmpty {
            return defaultBranch
        }

        return ""
    }

    private func handleWorktreeHandoffTap(currentThread: ConversationThread) {
        Task { @MainActor in
            guard !isRoutingThreadProject else { return }
            isRoutingThreadProject = true
            defer { isRoutingThreadProject = false }

            do {
                if currentThread.isManagedWorktreeProject {
                    let move = try await WorktreeFlowCoordinator.handoffThreadToLocal(
                        thread: currentThread,
                        coderover: coderover
                    )
                    viewModel.refreshGitBranchTargets(
                        coderover: coderover,
                        workingDirectory: move.projectPath,
                        threadID: thread.id
                    )
                    return
                }

                let outcome = try await WorktreeFlowCoordinator.handoffThreadToWorktree(
                    threadID: thread.id,
                    sourceProjectPath: currentThread.gitWorkingDirectory,
                    associatedWorktreePath: coderover.associatedManagedWorktreePath(for: thread.id),
                    baseBranchForNewWorktree: preferredWorktreeBaseBranch,
                    coderover: coderover
                )

                if case .moved(let move) = outcome {
                    viewModel.refreshGitBranchTargets(
                        coderover: coderover,
                        workingDirectory: move.projectPath,
                        threadID: thread.id
                    )
                }
            } catch {
                viewModel.gitSyncAlert = TurnGitSyncAlert(
                    title: currentThread.isManagedWorktreeProject ? "Local Handoff Failed" : "Worktree Handoff Failed",
                    message: error.localizedDescription.isEmpty
                        ? (currentThread.isManagedWorktreeProject
                            ? "Could not hand off the thread back to Local."
                            : "Could not hand off the thread to the managed worktree.")
                        : error.localizedDescription,
                    action: .dismissOnly
                )
            }
        }
    }

    private func startLocalFork(currentThread: ConversationThread) {
        Task { @MainActor in
            guard !isRoutingThreadProject else { return }
            guard WorktreeFlowCoordinator.localForkProjectPath(
                for: currentThread,
                localCheckoutPath: viewModel.gitLocalCheckoutPath
            ) != nil else {
                viewModel.gitSyncAlert = TurnGitSyncAlert(
                    title: "Local Fork Unavailable",
                    message: currentThread.isManagedWorktreeProject
                        ? "Could not resolve the Local checkout for this managed worktree."
                        : "Could not resolve the local project path for this thread.",
                    action: .dismissOnly
                )
                return
            }

            isRoutingThreadProject = true
            defer { isRoutingThreadProject = false }

            do {
                let forkedThread = try await WorktreeFlowCoordinator.forkThreadToLocal(
                    sourceThread: currentThread,
                    localCheckoutPath: viewModel.gitLocalCheckoutPath,
                    coderover: coderover
                )
                openThread(forkedThread.id)
            } catch {
                viewModel.gitSyncAlert = TurnGitSyncAlert(
                    title: "Local Fork Failed",
                    message: error.localizedDescription.isEmpty
                        ? "Could not fork the thread into Local."
                        : error.localizedDescription,
                    action: .dismissOnly
                )
            }
        }
    }

    private func startForkIntoWorktree(currentThread: ConversationThread) {
        Task { @MainActor in
            guard !isRoutingThreadProject else { return }

            let baseBranch = preferredWorktreeBaseBranch
            guard !baseBranch.isEmpty else {
                viewModel.gitSyncAlert = TurnGitSyncAlert(
                    title: "Worktree Fork Failed",
                    message: "Could not determine a base branch for the managed worktree.",
                    action: .dismissOnly
                )
                return
            }

            isRoutingThreadProject = true
            defer { isRoutingThreadProject = false }

            do {
                let forkedThread = try await WorktreeFlowCoordinator.forkThreadToWorktree(
                    sourceThreadId: currentThread.id,
                    sourceProjectPath: currentThread.gitWorkingDirectory,
                    baseBranch: baseBranch,
                    coderover: coderover
                )
                openThread(forkedThread.id)
            } catch {
                viewModel.gitSyncAlert = TurnGitSyncAlert(
                    title: "Worktree Fork Failed",
                    message: error.localizedDescription.isEmpty
                        ? "Could not fork the thread into a managed worktree."
                        : error.localizedDescription,
                    action: .dismissOnly
                )
            }
        }
    }

    private func openThread(_ threadID: String) {
        checkedOutElsewhereAlert = nil
        Task { @MainActor in
            coderover.activeThreadId = threadID
            await coderover.prepareThreadForDisplay(threadId: threadID)
        }
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
        let resolvedThread = currentResolvedThread
        guard let path = resolvedThread.normalizedProjectPath ?? resolvedThread.cwd,
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

    private func makeCheckedOutElsewhereAlert(
        for branch: String,
        currentThread: ConversationThread
    ) -> CheckedOutElsewhereAlert? {
        let trimmedBranch = branch.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedBranch.isEmpty,
              let rawWorktreePath = viewModel.gitWorktreePathsByBranch[trimmedBranch],
              let normalizedWorktreePath = ConversationThreadStartProjectBinding.normalizedProjectPath(rawWorktreePath) else {
            return nil
        }

        let currentPath = comparableProjectPath(currentThread.normalizedProjectPath)
        let targetPath = comparableProjectPath(normalizedWorktreePath)
        guard currentPath != nil, targetPath != nil, currentPath != targetPath else {
            return nil
        }

        let liveThread = WorktreeFlowCoordinator.liveThreadForCheckedOutElsewhereBranch(
            projectPath: normalizedWorktreePath,
            coderover: coderover,
            currentThread: currentThread
        )

        return CheckedOutElsewhereAlert(
            branch: trimmedBranch,
            worktreePath: normalizedWorktreePath,
            existingThreadID: liveThread?.id,
            existingThreadTitle: liveThread?.displayTitle
        )
    }

    private func comparableProjectPath(_ rawPath: String?) -> String? {
        guard let normalizedPath = ConversationThreadStartProjectBinding.normalizedProjectPath(rawPath) else {
            return nil
        }

        return URL(fileURLWithPath: normalizedPath)
            .resolvingSymlinksInPath()
            .standardizedFileURL
            .path
    }

    // MARK: - Empty State

    private var loadingState: some View {
        chatPlaceholderState(
            title: "Loading chat...",
            subtitle: "Fetching the latest messages for this conversation."
        )
    }

    private func resolvedEmptyState(for phase: CodeRoverService.ThreadDisplayPhase) -> some View {
        switch phase {
        case .loading:
            return AnyView(loadingState)
        case .empty, .ready:
            return AnyView(emptyState)
        }
    }

    private var emptyState: some View {
        chatPlaceholderState(
            title: "Hi! How can I help you?",
            subtitle: "Chats are End-to-end encrypted"
        )
    }

    private func chatPlaceholderState(title: String, subtitle: String) -> some View {
        VStack(spacing: 12) {
            Spacer()
            Image("AppLogo")
                .resizable()
                .scaledToFit()
                .frame(width: 56, height: 56)
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                .adaptiveGlass(in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            Text(title)
                .font(AppFont.title2(weight: .semibold))
            Text(subtitle)
                .font(AppFont.caption())
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 28)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }
}

private struct CheckedOutElsewhereAlert: Identifiable {
    let id = UUID()
    let branch: String
    let worktreePath: String
    let existingThreadID: String?
    let existingThreadTitle: String?

    var title: String {
        existingThreadID == nil ? "Branch Open Elsewhere" : "Open Existing Worktree Thread?"
    }

    var message: String {
        if let existingThreadTitle, !existingThreadTitle.isEmpty {
            return "'\(branch)' is already checked out in \(worktreePath). Open \"\(existingThreadTitle)\" instead of switching this checkout."
        }
        return "'\(branch)' is already checked out in \(worktreePath). Open that worktree chat instead of switching this checkout."
    }
}

private extension TurnView {
    func logTimelineSnapshot(
        reason: String,
        rawMessages: [ChatMessage],
        projectedMessages: [ChatMessage],
        timelineChangeToken: Int,
        activeTurnID: String?,
        isThreadRunning: Bool
    ) {
        let rawTail = rawMessages.suffix(3).map(Self.describeMessage).joined(separator: ",")
        let projectedTail = projectedMessages.suffix(3).map(Self.describeMessage).joined(separator: ",")
        coderoverDiagnosticLog(
            "CodeRoverView",
            "TurnView \(reason) thread=\(thread.id) raw=\(rawMessages.count) projected=\(projectedMessages.count) revision=\(timelineChangeToken) activeTurn=\(activeTurnID ?? "nil") running=\(isThreadRunning) rawTail=[\(rawTail)] projectedTail=[\(projectedTail)]"
        )
    }

    static func describeMessage(_ message: ChatMessage) -> String {
        let text = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let preview = String(text.prefix(24)).replacingOccurrences(of: "\n", with: "\\n")
        return "\(message.role.rawValue):\(message.kind.rawValue):\(message.id.prefix(6)):\(preview)"
    }
}

private struct TurnStatusSheet: View {
    let contextWindowUsage: ContextWindowUsage?
    let rateLimitBuckets: [CodeRoverRateLimitBucket]
    let isLoadingRateLimits: Bool
    let rateLimitsErrorMessage: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    statusCard
                    rateLimitsCard
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 16)
            }
            .navigationTitle("Status")
            .navigationBarTitleDisplayMode(.inline)
            .adaptiveNavigationBar()
        }
        .presentationDetents([.fraction(0.4), .medium, .large])
    }

    private var statusCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let contextWindowUsage {
                let percentRemaining = max(0, 100 - contextWindowUsage.percentUsed)
                metricRow(
                    label: "Context",
                    value: "\(percentRemaining)% left",
                    detail: "(\(compactTokenCount(contextWindowUsage.tokensUsed)) used / \(compactTokenCount(contextWindowUsage.tokenLimit)))"
                )
                progressBar(progress: contextWindowUsage.fractionUsed)
            } else {
                metricRow(label: "Context", value: "Unavailable", detail: "Waiting for token usage")
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .adaptiveGlass(.regular, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
    }

    private var rateLimitsCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Rate limits")
                    .font(AppFont.subheadline(weight: .semibold))
                Spacer(minLength: 12)
                if isLoadingRateLimits {
                    ProgressView()
                        .controlSize(.small)
                }
            }

            if !rateLimitRows.isEmpty {
                VStack(alignment: .leading, spacing: 14) {
                    ForEach(rateLimitRows) { row in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack(alignment: .firstTextBaseline, spacing: 10) {
                                Text(row.label)
                                    .font(AppFont.mono(.callout))
                                    .foregroundStyle(.secondary)

                                Spacer(minLength: 12)

                                Text("\(row.window.remainingPercent)% left")
                                    .font(AppFont.mono(.callout))

                                if let resetText = resetLabel(for: row.window) {
                                    Text("(\(resetText))")
                                        .font(AppFont.mono(.caption))
                                        .foregroundStyle(.secondary)
                                }
                            }

                            progressBar(progress: Double(row.window.clampedUsedPercent) / 100)
                        }
                    }
                }
            } else if let rateLimitsErrorMessage, !rateLimitsErrorMessage.isEmpty {
                Text(rateLimitsErrorMessage)
                    .font(AppFont.caption())
                    .foregroundStyle(.secondary)
            } else if isLoadingRateLimits {
                Text("Loading current limits...")
                    .font(AppFont.caption())
                    .foregroundStyle(.secondary)
            } else {
                Text("Rate limits are unavailable for this account.")
                    .font(AppFont.caption())
                    .foregroundStyle(.secondary)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .adaptiveGlass(.regular, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
    }

    private var rateLimitRows: [CodeRoverRateLimitDisplayRow] {
        let rows = rateLimitBuckets.flatMap(\.displayRows)
        var dedupedByLabel: [String: CodeRoverRateLimitDisplayRow] = [:]

        for row in rows {
            if let existing = dedupedByLabel[row.label] {
                dedupedByLabel[row.label] = preferredRateLimitRow(existing, row)
            } else {
                dedupedByLabel[row.label] = row
            }
        }

        return dedupedByLabel.values.sorted { lhs, rhs in
            let lhsDuration = lhs.window.windowDurationMins ?? Int.max
            let rhsDuration = rhs.window.windowDurationMins ?? Int.max
            if lhsDuration == rhsDuration {
                return lhs.label.localizedCaseInsensitiveCompare(rhs.label) == .orderedAscending
            }
            return lhsDuration < rhsDuration
        }
    }

    private func preferredRateLimitRow(
        _ current: CodeRoverRateLimitDisplayRow,
        _ candidate: CodeRoverRateLimitDisplayRow
    ) -> CodeRoverRateLimitDisplayRow {
        if candidate.window.clampedUsedPercent != current.window.clampedUsedPercent {
            return candidate.window.clampedUsedPercent > current.window.clampedUsedPercent ? candidate : current
        }

        switch (current.window.resetsAt, candidate.window.resetsAt) {
        case (.none, .some):
            return candidate
        case (.some, .none):
            return current
        case let (.some(currentReset), .some(candidateReset)):
            return candidateReset < currentReset ? candidate : current
        case (.none, .none):
            return current
        }
    }

    private func metricRow(label: String, value: String, detail: String? = nil) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 14) {
            Text("\(label):")
                .font(AppFont.mono(.callout))
                .foregroundStyle(.secondary)
                .frame(width: 72, alignment: .leading)
            Text(value)
                .font(AppFont.headline(weight: .semibold))
            if let detail {
                Text(detail)
                    .font(AppFont.mono(.caption))
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
    }

    private func progressBar(progress: Double) -> some View {
        let clampedProgress = min(max(progress, 0), 1)

        return GeometryReader { geometry in
            let totalWidth = max(geometry.size.width, 1)

            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Color.primary.opacity(0.1))

                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Color.primary)
                    .frame(width: totalWidth * CGFloat(clampedProgress))
            }
        }
        .frame(height: 14)
    }

    private func compactTokenCount(_ count: Int) -> String {
        switch count {
        case 1_000_000...:
            let value = Double(count) / 1_000_000
            return value.truncatingRemainder(dividingBy: 1) == 0 ? "\(Int(value))M" : String(format: "%.1fM", value)
        case 1_000...:
            let value = Double(count) / 1_000
            return value.truncatingRemainder(dividingBy: 1) == 0 ? "\(Int(value))K" : String(format: "%.1fK", value)
        default:
            let formatter = NumberFormatter()
            formatter.numberStyle = .decimal
            return formatter.string(from: NSNumber(value: count)) ?? "\(count)"
        }
    }

    private func resetLabel(for window: CodeRoverRateLimitWindow) -> String? {
        guard let resetsAt = window.resetsAt else { return nil }

        let calendar = Calendar.current
        let now = Date()

        if calendar.isDate(resetsAt, inSameDayAs: now) {
            let formatter = DateFormatter()
            formatter.dateFormat = "HH:mm"
            return "resets \(formatter.string(from: resetsAt))"
        }

        let formatter = DateFormatter()
        formatter.dateFormat = "d MMM HH:mm"
        return "resets \(formatter.string(from: resetsAt))"
    }
}

#Preview {
    NavigationStack {
        TurnView(thread: ConversationThread(id: "thread_preview", title: "Preview"))
            .environment(CodeRoverService())
    }
}
