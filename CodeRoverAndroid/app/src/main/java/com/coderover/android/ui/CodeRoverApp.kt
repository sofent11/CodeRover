package com.coderover.android.ui

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
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.coderover.android.app.AppViewModel
import com.coderover.android.data.model.AppState
import com.coderover.android.ui.screens.ArchivedChatsScreen
import com.coderover.android.ui.screens.HomeEmptyScreen
import com.coderover.android.ui.screens.OnboardingScreen
import com.coderover.android.ui.screens.PairingEntryScreen
import com.coderover.android.ui.screens.SettingsScreen
import com.coderover.android.ui.screens.SidebarScreen
import com.coderover.android.ui.shared.AppBackdrop
import com.coderover.android.ui.shared.HapticFeedback
import com.coderover.android.ui.shared.StatusTag
import com.coderover.android.ui.theme.monoFamily
import com.coderover.android.ui.turn.DiffDetailDialog
import com.coderover.android.ui.turn.TurnScreen
import com.coderover.android.ui.turn.TurnThreadPathSheet
import com.coderover.android.ui.turn.TurnTopBarActions
import com.coderover.android.ui.turn.buildRepositoryDiffFiles
import kotlinx.coroutines.launch
import kotlin.math.max
import kotlin.math.min

@Composable
fun CodeRoverApp(
    state: AppState,
    viewModel: AppViewModel,
) {
    val contentViewModel = remember { ContentViewModel() }

    if (!state.onboardingSeen) {
        OnboardingScreen(onContinue = viewModel::completeOnboarding)
        return
    }

    if (state.pairings.isEmpty() || state.pendingTransportSelectionPairing != null) {
        PairingEntryScreen(
            errorMessage = state.lastErrorMessage,
            pendingTransportSelectionPairing = state.pendingTransportSelectionPairing,
            onScannedPayload = viewModel::importPairingPayload,
            onSelectTransport = viewModel::confirmPendingPairingTransport,
            onErrorDismissed = viewModel::clearLastErrorMessage,
        )
        return
    }

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
        contentViewModel.showPairingEntry,
        contentViewModel.pendingPairingDismiss,
        state.connectionPhase,
        state.lastErrorMessage,
        state.activePairingMacDeviceId,
    ) {
        contentViewModel.maybeDismissPairingEntry(state)
    }

    LaunchedEffect(isSidebarOpen, state.isConnected) {
        if (isSidebarOpen && contentViewModel.shouldRequestSidebarFreshSync(state.isConnected)) {
            viewModel.refreshThreadsIfConnected()
        }
    }

    val density = LocalDensity.current
    val screenWidth = LocalConfiguration.current.screenWidthDp.dp
    val effectiveSidebarWidthDp = if (isSidebarSearchActive) screenWidth else 280.dp
    val effectiveSidebarWidthPx = with(density) { effectiveSidebarWidthDp.toPx() }

    val animatedOffset = remember { Animatable(0f) }

    LaunchedEffect(isSidebarOpen, effectiveSidebarWidthPx) {
        val target = if (isSidebarOpen) effectiveSidebarWidthPx else 0f
        animatedOffset.animateTo(
            targetValue = target,
            animationSpec = spring(stiffness = Spring.StiffnessMediumLow, dampingRatio = 0.85f)
        )
    }

    val edgeDragWidthPx = with(density) { 30.dp.toPx() }
    var dragStartedValidly by remember { mutableStateOf(false) }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .pointerInput(isSidebarOpen, effectiveSidebarWidthPx) {
                detectHorizontalDragGestures(
                    onDragStart = { offset ->
                        dragStartedValidly = isSidebarOpen || offset.x < edgeDragWidthPx
                    },
                    onDragEnd = {
                        if (!dragStartedValidly) return@detectHorizontalDragGestures
                        coroutineScope.launch {
                            val threshold = effectiveSidebarWidthPx * 0.4f
                            val currentOffset = animatedOffset.value
                            if (!isSidebarOpen) {
                                if (currentOffset > threshold) {
                                    isSidebarOpen = true
                                } else {
                                    animatedOffset.animateTo(0f, spring(stiffness = Spring.StiffnessMediumLow, dampingRatio = 0.85f))
                                }
                            } else {
                                if (effectiveSidebarWidthPx - currentOffset > threshold) {
                                    isSidebarOpen = false
                                } else {
                                    animatedOffset.animateTo(effectiveSidebarWidthPx, spring(stiffness = Spring.StiffnessMediumLow, dampingRatio = 0.85f))
                                }
                            }
                        }
                    },
                    onDragCancel = {
                        if (!dragStartedValidly) return@detectHorizontalDragGestures
                        coroutineScope.launch {
                            animatedOffset.animateTo(
                                targetValue = if (isSidebarOpen) effectiveSidebarWidthPx else 0f,
                                animationSpec = spring(stiffness = Spring.StiffnessMediumLow, dampingRatio = 0.85f)
                            )
                        }
                    },
                    onHorizontalDrag = { change, dragAmount ->
                        if (!dragStartedValidly) return@detectHorizontalDragGestures
                        change.consume()
                        coroutineScope.launch {
                            val newOffset = max(0f, min(effectiveSidebarWidthPx, animatedOffset.value + dragAmount))
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
                .background(MaterialTheme.colorScheme.surface)
        ) {
            SidebarScreen(
                state = state,
                onCreateThread = { projectPath, providerId ->
                    contentViewModel.selectThread()
                    viewModel.createThread(projectPath, providerId)
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
                    TopAppBar(
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
                                    if (shellContent == AppShellContent.THREAD && selectedThread != null) {
                                        StatusTag(
                                            text = selectedThread.providerBadgeTitle,
                                            containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.75f),
                                            contentColor = MaterialTheme.colorScheme.onSurfaceVariant,
                                        )
                                        Text(
                                            text = selectedThread.normalizedProjectPath ?: "Your paired Mac",
                                            style = MaterialTheme.typography.labelMedium.copy(fontFamily = monoFamily),
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                            maxLines = 1,
                                            overflow = TextOverflow.Ellipsis,
                                            modifier = Modifier.clickable {
                                                haptic.triggerImpactFeedback()
                                                selectedThread.cwd?.let { cwd ->
                                                    repositoryPathToShowInSheet = cwd
                                                }
                                            },
                                        )
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
                            Surface(
                                color = MaterialTheme.colorScheme.surface.copy(alpha = 0.88f),
                                modifier = Modifier
                                    .padding(start = 10.dp)
                                    .clip(androidx.compose.foundation.shape.CircleShape),
                            ) {
                                IconButton(
                                    onClick = { isSidebarOpen = true },
                                    modifier = Modifier.padding(2.dp),
                                ) {
                                    Icon(Icons.Outlined.Menu, contentDescription = "Open drawer")
                                }
                            }
                        },
                        actions = {
                            if (shellContent == AppShellContent.THREAD) {
                                TurnTopBarActions(
                                    gitRepoSyncResult = state.gitRepoSyncResult,
                                    contextWindowUsage = state.contextWindowUsage,
                                    enabled = state.isConnected &&
                                        selectedThread?.cwd != null &&
                                        !isSelectedThreadRunning,
                                    onShowRepoDiff = {
                                        val cwd = selectedThread?.cwd ?: return@TurnTopBarActions
                                        coroutineScope.launch {
                                            repositoryDiffBody = viewModel.gitDiff(cwd)
                                        }
                                    },
                                    onSelectGitAction = { action ->
                                        val cwd = selectedThread?.cwd ?: return@TurnTopBarActions
                                        coroutineScope.launch {
                                            viewModel.performGitAction(cwd, action)
                                            viewModel.gitStatus(cwd)
                                        }
                                    },
                                    onCompactContext = {
                                        selectedThread?.id?.let { threadId ->
                                            viewModel.compactThreadContext(threadId)
                                        }
                                    },
                                )
                            } else {
                                Surface(
                                    color = MaterialTheme.colorScheme.surface.copy(alpha = 0.88f),
                                    modifier = Modifier.padding(end = 10.dp),
                                ) {
                                    IconButton(onClick = {}) {
                                        Icon(Icons.Outlined.Tune, contentDescription = null)
                                    }
                                }
                            }
                        },
                    )
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
                                onScannedPayload = { payload ->
                                    contentViewModel.markPairingSubmission()
                                    viewModel.importPairingPayload(payload)
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
                            color = MaterialTheme.colorScheme.scrim.copy(alpha = 0.08f * progress)
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

private data class ShellHeader(
    val title: String,
    val subtitle: String,
)

private fun shellHeader(
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
            subtitle = listOfNotNull(
                state.selectedThread?.providerBadgeTitle,
                state.selectedThread?.projectDisplayName,
            ).joinToString(" · ").ifBlank { "Your paired Mac" },
        )

        AppShellContent.EMPTY -> ShellHeader(
            title = "CodeRover",
            subtitle = "Your paired Mac",
        )
    }
}
