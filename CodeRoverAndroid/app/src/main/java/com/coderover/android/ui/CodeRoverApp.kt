package com.coderover.android.ui

import com.coderover.android.AppInfo
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import kotlin.math.roundToInt
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.coderover.android.app.AppViewModel
import com.coderover.android.data.model.AppState
import com.coderover.android.data.model.ConnectionPhase
import com.coderover.android.ui.screens.ArchivedChatsScreen
import com.coderover.android.ui.screens.HomeEmptyScreen
import com.coderover.android.ui.screens.OnboardingScreen
import com.coderover.android.ui.screens.PairingEntryScreen
import com.coderover.android.ui.screens.SettingsScreen
import com.coderover.android.ui.screens.SidebarScreen
import com.coderover.android.ui.shared.AppBackdrop
import com.coderover.android.ui.shared.HapticFeedback
import com.coderover.android.ui.shared.ParityToolbarItemSurface
import com.coderover.android.ui.shared.StatusTag
import com.coderover.android.ui.shared.WhatsNewDialog
import com.coderover.android.ui.theme.BorderStrong
import com.coderover.android.ui.theme.monoFamily
import com.coderover.android.ui.turn.DiffDetailDialog
import com.coderover.android.ui.turn.TurnScreen
import com.coderover.android.ui.turn.TurnThreadProjectAction
import com.coderover.android.ui.turn.TurnThreadPathSheet
import com.coderover.android.ui.turn.TurnTopBarActions
import com.coderover.android.ui.turn.buildRepositoryDiffFiles
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.max
import kotlin.math.min

@Composable
fun CodeRoverApp(
    state: AppState,
    viewModel: AppViewModel,
) {
    val contentViewModel = remember { ContentViewModel() }
    var isShowingWhatsNew by rememberSaveable { mutableStateOf(false) }

    if (!state.onboardingSeen) {
        OnboardingScreen(onContinue = viewModel::completeOnboarding)
        return
    }

    LaunchedEffect(state.onboardingSeen, state.lastPresentedWhatsNewVersion) {
        if (state.onboardingSeen && state.lastPresentedWhatsNewVersion != AppInfo.VERSION_NAME) {
            isShowingWhatsNew = true
        }
    }

    Box {
        if (state.pairings.isEmpty() || state.pendingTransportSelectionPairing != null) {
            PairingEntryScreen(
                errorMessage = state.lastErrorMessage,
                pendingTransportSelectionPairing = state.pendingTransportSelectionPairing,
                onScannedPayload = { payload, resetScanLock ->
                    viewModel.importPairingPayload(payload, resetScanLock)
                },
                onSelectTransport = viewModel::confirmPendingPairingTransport,
                onErrorDismissed = viewModel::clearLastErrorMessage,
            )
        } else {
            LaunchedEffect(state.activePairingMacDeviceId, state.connectionPhase, state.pairings.size) {
                if (contentViewModel.shouldAttemptAutoConnect(state)) {
                    viewModel.connectActivePairing()
                }
            }

            CodeRoverAppShell(
                state = state,
                viewModel = viewModel,
                contentViewModel = contentViewModel,
            )
        }

        if (isShowingWhatsNew) {
            WhatsNewDialog(version = AppInfo.VERSION_NAME) {
                viewModel.markWhatsNewSeen(AppInfo.VERSION_NAME)
                isShowingWhatsNew = false
            }
        }
    }
}

@Composable
@OptIn(ExperimentalMaterial3Api::class)
private fun CodeRoverAppShell(
    state: AppState,
    viewModel: AppViewModel,
    contentViewModel: ContentViewModel,
) {
    val haptic = HapticFeedback.rememberHapticFeedback()
    var isSidebarOpen by rememberSaveable { mutableStateOf(false) }
    val coroutineScope = rememberCoroutineScope()
    val lifecycleOwner = LocalLifecycleOwner.current
    val shellContent = contentViewModel.shellContent(state)
    val selectedThread = state.selectedThread
    val isSelectedThreadRunning = selectedThread?.id?.let { threadId ->
        state.runningThreadIds.contains(threadId)
    } == true
    val currentShellHeader = remember(
        shellContent,
        state.selectedThreadId,
        state.selectedThread?.displayTitle,
        state.selectedThread?.projectDisplayName,
    ) {
        shellHeader(shellContent, state)
    }
    var messageInput by rememberSaveable(state.selectedThreadId) { mutableStateOf("") }
    var repositoryDiffBody by remember(state.selectedThreadId) { mutableStateOf<String?>(null) }
    var repositoryPathToShowInSheet by remember { mutableStateOf<String?>(null) }
    var isSidebarSearchActive by rememberSaveable { mutableStateOf(false) }
    var isShowingDesktopRestartConfirmation by rememberSaveable(state.selectedThreadId) { mutableStateOf(false) }
    var isRestartingDesktopApp by remember(state.selectedThreadId) { mutableStateOf(false) }
    var desktopRestartErrorMessage by rememberSaveable(state.selectedThreadId) { mutableStateOf<String?>(null) }
    var isRoutingThreadProject by remember(state.selectedThreadId) { mutableStateOf(false) }

    DisposableEffect(
        lifecycleOwner,
        state.pairings.size,
        state.connectionPhase,
        state.activePairingMacDeviceId,
        contentViewModel.showSettings,
    ) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME &&
                contentViewModel.shouldReconnectOnForegroundResume(state)
            ) {
                viewModel.connectActivePairing()
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
        }
    }

    LaunchedEffect(
        state.activePairingMacDeviceId,
        state.connectionPhase,
        state.secureConnectionState,
        contentViewModel.showSettings,
        contentViewModel.showPairingEntry,
    ) {
        if (!contentViewModel.shouldRunForegroundReconnectLoop(state) ||
            !contentViewModel.beginForegroundReconnectLoop()
        ) {
            return@LaunchedEffect
        }

        try {
            var attempt = 0
            while (contentViewModel.hasRemainingForegroundReconnectAttempts(attempt)) {
                val currentState = viewModel.state.value
                if (!contentViewModel.shouldRunForegroundReconnectLoop(currentState)) {
                    break
                }
                if (currentState.isConnected) {
                    break
                }

                when (currentState.connectionPhase) {
                    ConnectionPhase.CONNECTED -> break
                    ConnectionPhase.CONNECTING,
                    ConnectionPhase.LOADING_CHATS,
                    ConnectionPhase.SYNCING -> delay(300)
                    ConnectionPhase.OFFLINE -> {
                        viewModel.connectActivePairing()
                        delay(contentViewModel.foregroundReconnectDelayMs(attempt))
                        attempt += 1
                    }
                }
            }
        } finally {
            contentViewModel.finishForegroundReconnectLoop()
        }
    }

    LaunchedEffect(
        contentViewModel.showPairingEntry,
        contentViewModel.pendingPairingDismiss,
        state.connectionPhase,
        state.lastErrorMessage,
        state.activePairingMacDeviceId,
    ) {
        contentViewModel.maybeDismissPairingEntry(state)
    }

    LaunchedEffect(state.secureConnectionState) {
        if (contentViewModel.syncSecureRouting(state)) {
            isSidebarOpen = false
            isSidebarSearchActive = false
        }
    }

    LaunchedEffect(isSidebarOpen, state.isConnected) {
        if (isSidebarOpen && contentViewModel.shouldRequestSidebarFreshSync(state.isConnected)) {
            viewModel.refreshThreadsIfConnected()
        }
    }

    val density = LocalDensity.current
    val screenWidth = LocalConfiguration.current.screenWidthDp.dp
    val effectiveSidebarWidthDp = if (isSidebarSearchActive) screenWidth else 330.dp
    val effectiveSidebarWidthPx = with(density) { effectiveSidebarWidthDp.toPx() }

    val animatedOffset = remember { Animatable(0f) }

    LaunchedEffect(isSidebarOpen, effectiveSidebarWidthPx) {
        val target = if (isSidebarOpen) effectiveSidebarWidthPx else 0f
        animatedOffset.animateTo(
            targetValue = target,
            animationSpec = spring(stiffness = 350f, dampingRatio = 0.85f)
        )
    }

    val edgeDragWidthPx = with(density) { 30.dp.toPx() }
    var dragStartX by remember { mutableStateOf(0f) }
    var dragTotalAmount by remember { mutableStateOf(0f) }
    var dragStartedValidly by remember { mutableStateOf(false) }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .pointerInput(isSidebarOpen, effectiveSidebarWidthPx) {
                detectHorizontalDragGestures(
                    onDragStart = { offset ->
                        dragStartX = offset.x
                        dragTotalAmount = 0f
                        dragStartedValidly = isSidebarOpen || offset.x < edgeDragWidthPx
                    },
                    onDragEnd = {
                        if (!dragStartedValidly) return@detectHorizontalDragGestures
                        coroutineScope.launch {
                            val threshold = effectiveSidebarWidthPx * 0.4f
                            val predictedVelocityThreshold = effectiveSidebarWidthPx * 0.5f
                            val currentOffset = animatedOffset.value
                            if (!isSidebarOpen) {
                                val shouldOpen = currentOffset > threshold || dragTotalAmount > predictedVelocityThreshold
                                if (shouldOpen) {
                                    isSidebarOpen = true
                                } else {
                                    animatedOffset.animateTo(0f, spring(stiffness = 350f, dampingRatio = 0.85f))
                                }
                            } else {
                                val shouldClose = (effectiveSidebarWidthPx - currentOffset) > threshold || -dragTotalAmount > predictedVelocityThreshold
                                if (shouldClose) {
                                    isSidebarOpen = false
                                } else {
                                    animatedOffset.animateTo(effectiveSidebarWidthPx, spring(stiffness = 350f, dampingRatio = 0.85f))
                                }
                            }
                        }
                    },
                    onDragCancel = {
                        if (!dragStartedValidly) return@detectHorizontalDragGestures
                        coroutineScope.launch {
                            animatedOffset.animateTo(
                                targetValue = if (isSidebarOpen) effectiveSidebarWidthPx else 0f,
                                animationSpec = spring(stiffness = 350f, dampingRatio = 0.85f)
                            )
                        }
                    },
                    onHorizontalDrag = { change, dragAmount ->
                        if (!dragStartedValidly) return@detectHorizontalDragGestures
                        change.consume()
                        dragTotalAmount += dragAmount
                        coroutineScope.launch {
                            val newOffset = if (isSidebarOpen) {
                                max(0f, min(effectiveSidebarWidthPx, effectiveSidebarWidthPx + dragTotalAmount))
                            } else {
                                max(0f, min(effectiveSidebarWidthPx, dragTotalAmount))
                            }
                            animatedOffset.snapTo(newOffset)
                        }
                    }
                )
            }
    ) {
        // Sidebar Content
        Box(
            modifier = Modifier
                .width(effectiveSidebarWidthDp)
                .fillMaxSize()
                .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.96f))
        ) {
            AppBackdrop(modifier = Modifier.fillMaxSize())
            SidebarScreen(
                state = state,
                onCreateThread = { projectPath, providerId ->
                    contentViewModel.selectThread()
                    viewModel.createThread(projectPath, providerId)
                    isSidebarOpen = false
                },
                onCreateManagedWorktreeThread = { projectPath, providerId ->
                    contentViewModel.selectThread()
                    viewModel.createManagedWorktreeThread(projectPath, providerId)
                    isSidebarOpen = false
                },
                onLoadMoreThreadsForProject = viewModel::loadMoreThreadsForProject,
                onSelectProvider = { providerId ->
                    viewModel.setSelectedProviderId(providerId)
                },
                onSelectThread = { threadId ->
                    contentViewModel.selectThread()
                    viewModel.selectThread(threadId)
                    isSidebarOpen = false
                },
                onOpenSettings = {
                    contentViewModel.openSettings()
                    isSidebarOpen = false
                },
                onDeleteThread = viewModel::deleteThread,
                onArchiveThread = viewModel::archiveThread,
                onUnarchiveThread = viewModel::unarchiveThread,
                onRenameThread = viewModel::renameThread,
                onSearchActiveChanged = { isSidebarSearchActive = it },
                onToggleProjectGroupCollapsed = viewModel::toggleProjectGroupCollapsed,
            )
        }

        // Main App Content Layer
        Box(
            modifier = Modifier
                .fillMaxSize()
                .offset { IntOffset(animatedOffset.value.roundToInt(), 0) }
        ) {
            Scaffold(
                modifier = Modifier.fillMaxSize(),
                contentWindowInsets = WindowInsets.safeDrawing,
                topBar = {
                    val navigationAction: (() -> Unit)? = when (shellContent) {
                        AppShellContent.SETTINGS -> contentViewModel::closeSettings
                        AppShellContent.ARCHIVED_CHATS -> contentViewModel::closeArchivedChats
                        AppShellContent.PAIRING -> contentViewModel::closePairingFlow
                        AppShellContent.THREAD, AppShellContent.EMPTY -> null
                    }
                    Surface(
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                        shape = androidx.compose.foundation.shape.RoundedCornerShape(28.dp),
                        color = MaterialTheme.colorScheme.surface.copy(alpha = 0.9f),
                        border = androidx.compose.foundation.BorderStroke(1.dp, BorderStrong),
                        shadowElevation = 3.dp,
                    ) {
                        TopAppBar(
                            colors = TopAppBarDefaults.topAppBarColors(
                                containerColor = androidx.compose.ui.graphics.Color.Transparent,
                                scrolledContainerColor = androidx.compose.ui.graphics.Color.Transparent,
                            ),
                            title = {
                                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                    Text(
                                        text = currentShellHeader.title,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                        style = MaterialTheme.typography.titleMedium,
                                    )
                                    Row(
                                        verticalAlignment = Alignment.CenterVertically,
                                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                                    ) {
                                        if (currentShellHeader.providerTitle != null || currentShellHeader.pathSubtitle != null) {
                                            currentShellHeader.providerTitle?.let { providerTitle ->
                                                StatusTag(
                                                    text = providerTitle,
                                                    containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.78f),
                                                    contentColor = MaterialTheme.colorScheme.onSurfaceVariant,
                                                )
                                            }
                                            val pathLabel = currentShellHeader.pathSubtitle
                                            if (pathLabel != null) {
                                                Text(
                                                    text = pathLabel,
                                                    style = MaterialTheme.typography.labelMedium.copy(fontFamily = monoFamily),
                                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                                    maxLines = 1,
                                                    overflow = TextOverflow.Ellipsis,
                                                    modifier = Modifier.clickable(enabled = currentShellHeader.fullPath != null) {
                                                        haptic.triggerImpactFeedback()
                                                        repositoryPathToShowInSheet = currentShellHeader.fullPath
                                                    },
                                                )
                                            }
                                        } else {
                                            Text(
                                                text = currentShellHeader.subtitle,
                                                style = MaterialTheme.typography.labelMedium,
                                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                                maxLines = 1,
                                                overflow = TextOverflow.Ellipsis,
                                            )
                                        }
                                    }
                                }
                            },
                            navigationIcon = {
                                ParityToolbarItemSurface(
                                    modifier = Modifier.padding(start = 10.dp),
                                    onClick = navigationAction ?: { isSidebarOpen = true },
                                ) {
                                    Icon(
                                        imageVector = if (navigationAction == null) Icons.Outlined.Menu else Icons.AutoMirrored.Outlined.ArrowBack,
                                        contentDescription = if (navigationAction == null) "Open drawer" else "Back",
                                    )
                                }
                            },
                            actions = {
                                if (shellContent == AppShellContent.THREAD) {
                                    TurnTopBarActions(
                                        showsDesktopRestart = state.isConnected &&
                                            state.activeRuntimeProviderId == "codex" &&
                                            state.activeRuntimeCapabilities.desktopRestart,
                                        isRestartingDesktopApp = isRestartingDesktopApp,
                                        gitRepoSyncResult = state.gitRepoSyncResult,
                                        gitSyncState = state.gitSyncState,
                                        currentThread = selectedThread,
                                        canForkToLocal = when {
                                            selectedThread == null -> false
                                            selectedThread.isManagedWorktreeProject ->
                                                !state.gitBranchTargets?.localCheckoutPath.isNullOrBlank()
                                            else -> !selectedThread.normalizedProjectPath.isNullOrBlank()
                                        },
                                        isRunningThreadProjectAction = isRoutingThreadProject,
                                        isRunningGitAction = state.isRunningGitAction,
                                        showsDiscardRuntimeChangesAndSync = state.shouldShowDiscardRuntimeChangesAndSync,
                                        contextWindowUsage = state.contextWindowUsage,
                                        enabled = state.isConnected &&
                                            selectedThread?.cwd != null &&
                                            !isSelectedThreadRunning &&
                                            !state.isRunningGitAction &&
                                            !isRoutingThreadProject,
                                        onTapDesktopRestart = {
                                            haptic.triggerImpactFeedback()
                                            isShowingDesktopRestartConfirmation = true
                                        },
                                        onShowRepoDiff = {
                                            val cwd = selectedThread?.cwd ?: return@TurnTopBarActions
                                            coroutineScope.launch {
                                                repositoryDiffBody = viewModel.gitDiff(cwd)
                                            }
                                        },
                                        onSelectGitAction = { action ->
                                            val cwd = selectedThread?.cwd ?: return@TurnTopBarActions
                                            val threadId = selectedThread?.id ?: return@TurnTopBarActions
                                            coroutineScope.launch {
                                                viewModel.performGitAction(cwd, action, threadId)
                                                viewModel.gitStatus(cwd)
                                            }
                                        },
                                        onSelectThreadProjectAction = { action ->
                                            val threadId = selectedThread?.id ?: return@TurnTopBarActions
                                            val targetThread = selectedThread ?: return@TurnTopBarActions
                                            coroutineScope.launch {
                                                if (isRoutingThreadProject) {
                                                    return@launch
                                                }
                                                isRoutingThreadProject = true
                                                try {
                                                    val movedOrForkedThread = when (action) {
                                                        TurnThreadProjectAction.HANDOFF -> {
                                                            if (targetThread.isManagedWorktreeProject) {
                                                                viewModel.handoffThreadToLocal(threadId)
                                                            } else {
                                                                viewModel.handoffThreadToManagedWorktree(
                                                                    threadId = threadId,
                                                                    baseBranch = state.gitBranchTargets?.currentBranch
                                                                        ?.trim()
                                                                        ?.takeIf(String::isNotEmpty)
                                                                        ?: state.gitBranchTargets?.defaultBranch,
                                                                )
                                                            }
                                                        }
                                                        TurnThreadProjectAction.FORK_TO_LOCAL -> {
                                                            viewModel.forkThreadToLocal(threadId)
                                                        }
                                                        TurnThreadProjectAction.FORK_TO_WORKTREE -> {
                                                            viewModel.forkThreadToManagedWorktree(
                                                                threadId = threadId,
                                                                baseBranch = state.gitBranchTargets?.currentBranch
                                                                    ?.trim()
                                                                    ?.takeIf(String::isNotEmpty)
                                                                    ?: state.gitBranchTargets?.defaultBranch,
                                                            )
                                                        }
                                                    }
                                                    movedOrForkedThread?.cwd?.let { movedCwd ->
                                                        viewModel.gitBranchesWithStatus(movedCwd)
                                                        viewModel.gitStatus(movedCwd)
                                                    }
                                                } catch (_: Throwable) {
                                                    // Repository surfaces the failure through app state.
                                                } finally {
                                                    isRoutingThreadProject = false
                                                }
                                            }
                                        },
                                        onCompactContext = {
                                            selectedThread?.id?.let { threadId ->
                                                viewModel.compactThreadContext(threadId)
                                            }
                                        },
                                    )
                                }
                            },
                        )
                    }
                },
            ) { paddingValues ->
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(paddingValues),
                ) {
                    AppBackdrop(modifier = Modifier.fillMaxSize())
                    AnimatedContent(
                        targetState = shellContent,
                        transitionSpec = { fadeIn() togetherWith fadeOut() },
                        modifier = Modifier.fillMaxSize(),
                        label = "appShellContent",
                    ) { content ->
                        when (content) {
                            AppShellContent.SETTINGS -> SettingsScreen(
                                state = state,
                                viewModel = viewModel,
                                onDisconnect = {
                                    contentViewModel.closeSettings()
                                    viewModel.clearSelectedThread()
                                    viewModel.disconnect()
                                },
                                onOpenArchivedChats = contentViewModel::openArchivedChats,
                            )

                            AppShellContent.ARCHIVED_CHATS -> ArchivedChatsScreen(
                                archivedThreads = state.threads.filter { it.syncState == com.coderover.android.data.model.ThreadSyncState.ARCHIVED_LOCAL }
                                    .sortedByDescending { it.updatedAt ?: it.createdAt ?: 0L },
                                onUnarchiveThread = viewModel::unarchiveThread,
                                onDeleteThread = viewModel::deleteThread,
                                onBack = contentViewModel::closeArchivedChats,
                            )

                            AppShellContent.PAIRING -> PairingEntryScreen(
                                errorMessage = state.lastErrorMessage,
                                pendingTransportSelectionPairing = state.pendingTransportSelectionPairing,
                                onScannedPayload = { payload, resetScanLock ->
                                    contentViewModel.markPairingSubmission()
                                    viewModel.importPairingPayload(payload, resetScanLock)
                                },
                                onSelectTransport = viewModel::confirmPendingPairingTransport,
                                onErrorDismissed = viewModel::clearLastErrorMessage,
                            )

                            AppShellContent.THREAD -> TurnScreen(
                                state = state,
                                input = messageInput,
                                onInputChanged = { messageInput = it },
                                onSend = { text, attachments, skillMentions, usePlanMode ->
                                    viewModel.sendMessage(text, attachments, skillMentions, usePlanMode)
                                    messageInput = ""
                                },
                                onStartReview = { threadId, target, baseBranch ->
                                    viewModel.startReview(threadId, target, baseBranch)
                                    messageInput = ""
                                },
                                onStop = viewModel::interruptActiveTurn,
                                onReconnect = viewModel::connectActivePairing,
                                onSelectModel = viewModel::setSelectedModelId,
                                onSelectReasoning = viewModel::setSelectedReasoningEffort,
                                onSelectAccessMode = viewModel::setAccessMode,
                                onApprove = { viewModel.approvePendingRequest(true) },
                                onDeny = { viewModel.approvePendingRequest(false) },
                                onSubmitStructuredInput = viewModel::respondToStructuredUserInput,
                                viewModel = viewModel,
                            )

                            AppShellContent.EMPTY -> HomeEmptyScreen(
                                state = state,
                                onToggleConnection = {
                                    if (state.isConnected) {
                                        viewModel.disconnect()
                                    } else {
                                        viewModel.connectActivePairing()
                                    }
                                },
                                onOpenPairing = {
                                    contentViewModel.startPairingFlow(state.connectionPhase)
                                },
                            )
            }
        }

        if (shellContent == AppShellContent.THREAD && isShowingDesktopRestartConfirmation && selectedThread != null) {
            AlertDialog(
                onDismissRequest = { isShowingDesktopRestartConfirmation = false },
                title = { Text("Restart Codex Desktop App") },
                text = {
                    Text("Force close and reopen the Codex desktop app on your Mac, then reopen this conversation there.")
                },
                dismissButton = {
                    TextButton(onClick = { isShowingDesktopRestartConfirmation = false }) {
                        Text("Cancel")
                    }
                },
                confirmButton = {
                    TextButton(
                        enabled = !isRestartingDesktopApp,
                        onClick = {
                            val thread = selectedThread ?: return@TextButton
                            isShowingDesktopRestartConfirmation = false
                            coroutineScope.launch {
                                isRestartingDesktopApp = true
                                try {
                                    viewModel.restartDesktopApp(thread.provider, thread.id)
                                } catch (error: IllegalStateException) {
                                    desktopRestartErrorMessage = error.message ?: "Could not restart the desktop app on your Mac."
                                } catch (error: IllegalArgumentException) {
                                    desktopRestartErrorMessage = error.message ?: "Could not restart the desktop app on your Mac."
                                } finally {
                                    isRestartingDesktopApp = false
                                }
                            }
                        },
                    ) {
                        Text("Restart")
                    }
                },
            )
        }

        desktopRestartErrorMessage?.let { message ->
            AlertDialog(
                onDismissRequest = { desktopRestartErrorMessage = null },
                title = { Text("Desktop Restart Failed") },
                text = { Text(message) },
                confirmButton = {
                    TextButton(onClick = { desktopRestartErrorMessage = null }) {
                        Text("OK")
                    }
                },
            )
        }

        repositoryPathToShowInSheet?.let { path ->
            TurnThreadPathSheet(
                path = path,
                            onDismiss = { repositoryPathToShowInSheet = null }
                        )
                    }

                    repositoryDiffBody?.let { patch ->
                        DiffDetailDialog(
                            title = "Repository changes",
                            files = remember(patch) { buildRepositoryDiffFiles(patch) },
                            fallbackBody = patch,
                            onDismiss = { repositoryDiffBody = null },
                        )
                    }
                }
            }
            // Dim Layer for Main Content when Sidebar is open
            if (isSidebarOpen || animatedOffset.value > 0f) {
                val progress = min(1f, animatedOffset.value / effectiveSidebarWidthPx)
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(
                            color = MaterialTheme.colorScheme.scrim.copy(alpha = 0.14f * progress)
                        )
                        .clickable(
                            interactionSource = remember { androidx.compose.foundation.interaction.MutableInteractionSource() },
                            indication = null
                        ) {
                            isSidebarOpen = false
                        }
                )
            }
        }
    }
}

internal data class ShellHeader(
    val title: String,
    val subtitle: String,
    val providerTitle: String? = null,
    val pathSubtitle: String? = null,
    val fullPath: String? = null,
)

internal fun shellHeader(
    shellContent: AppShellContent,
    state: AppState,
): ShellHeader {
    return when (shellContent) {
        AppShellContent.SETTINGS -> ShellHeader(
            title = "Settings",
            subtitle = "Local-first preferences",
        )

        AppShellContent.PAIRING -> ShellHeader(
            title = "Pair Another Mac",
            subtitle = "Scan or paste a local bridge payload",
        )

        AppShellContent.ARCHIVED_CHATS -> ShellHeader(
            title = "Archived Chats",
            subtitle = "Local device history",
        )

        AppShellContent.THREAD -> ShellHeader(
            title = state.selectedThread?.displayTitle ?: "CodeRover",
            subtitle = "Your paired Mac",
            providerTitle = state.selectedThread?.providerBadgeTitle,
            pathSubtitle = state.selectedThread?.normalizedProjectPath ?: "Your paired Mac",
            fullPath = state.selectedThread?.cwd,
        )

        AppShellContent.EMPTY -> ShellHeader(
            title = "CodeRover",
            subtitle = "Your paired Mac",
        )
    }
}
