package com.remodex.android.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.remodex.android.app.AppViewModel
import com.remodex.android.data.model.AppState
import com.remodex.android.ui.screens.HomeEmptyScreen
import com.remodex.android.ui.screens.OnboardingScreen
import com.remodex.android.ui.screens.PairingEntryScreen
import com.remodex.android.ui.screens.SettingsScreen
import com.remodex.android.ui.screens.SidebarScreen
import com.remodex.android.ui.shared.AppBackdrop
import com.remodex.android.ui.turn.DiffDetailDialog
import com.remodex.android.ui.turn.TurnScreen
import com.remodex.android.ui.turn.TurnTopBarActions
import com.remodex.android.ui.turn.buildRepositoryDiffFiles
import kotlinx.coroutines.launch

@Composable
fun RemodexApp(
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
            importText = state.importText,
            errorMessage = state.lastErrorMessage,
            pendingTransportSelectionPairing = state.pendingTransportSelectionPairing,
            onImportTextChanged = viewModel::updateImportText,
            onImport = { viewModel.importPairingPayload(state.importText) },
            onScannedPayload = viewModel::importPairingPayload,
            onSelectTransport = viewModel::confirmPendingPairingTransport,
        )
        return
    }

    LaunchedEffect(state.activePairingMacDeviceId, state.connectionPhase, state.pairings.size) {
        if (contentViewModel.shouldAttemptAutoConnect(state)) {
            viewModel.connectActivePairing()
        }
    }

    RemodexAppShell(
        state = state,
        viewModel = viewModel,
        contentViewModel = contentViewModel,
    )
}

@Composable
@OptIn(ExperimentalMaterial3Api::class)
private fun RemodexAppShell(
    state: AppState,
    viewModel: AppViewModel,
    contentViewModel: ContentViewModel,
) {
    val drawerState = rememberDrawerState(initialValue = DrawerValue.Closed)
    val coroutineScope = rememberCoroutineScope()
    val lifecycleOwner = LocalLifecycleOwner.current
    val shellContent = contentViewModel.shellContent(state)
    val selectedThread = state.selectedThread
    val isSelectedThreadRunning = selectedThread?.id?.let { threadId ->
        state.runningThreadIds.contains(threadId)
    } == true
    val shellHeader = remember(
        shellContent,
        state.selectedThreadId,
        state.selectedThread?.displayTitle,
        state.selectedThread?.projectDisplayName,
    ) {
        shellHeader(shellContent, state)
    }
    var messageInput by rememberSaveable(state.selectedThreadId) { mutableStateOf("") }
    var repositoryDiffBody by remember(state.selectedThreadId) { mutableStateOf<String?>(null) }
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

    LaunchedEffect(drawerState.isOpen, state.isConnected) {
        if (drawerState.isOpen && contentViewModel.shouldRequestSidebarFreshSync(state.isConnected)) {
            viewModel.refreshThreadsIfConnected()
        }
    }

    ModalNavigationDrawer(
        drawerState = drawerState,
        drawerContent = {
            ModalDrawerSheet(
                modifier = if (isSidebarSearchActive) {
                    Modifier.fillMaxWidth()
                } else {
                    Modifier.width(330.dp)
                },
                drawerContainerColor = MaterialTheme.colorScheme.surface,
            ) {
                SidebarScreen(
                    state = state,
                    onCreateThread = { projectPath, providerId ->
                        contentViewModel.selectThread()
                        viewModel.createThread(projectPath, providerId)
                        coroutineScope.launch { drawerState.close() }
                    },
                    onSelectProvider = { providerId ->
                        viewModel.setSelectedProviderId(providerId)
                    },
                    onSelectThread = { threadId ->
                        contentViewModel.selectThread()
                        viewModel.selectThread(threadId)
                        coroutineScope.launch { drawerState.close() }
                    },
                    onOpenSettings = {
                        contentViewModel.openSettings()
                        coroutineScope.launch { drawerState.close() }
                    },
                    onDeleteThread = viewModel::deleteThread,
                    onArchiveThread = viewModel::archiveThread,
                    onUnarchiveThread = viewModel::unarchiveThread,
                    onRenameThread = viewModel::renameThread,
                    onSearchActiveChanged = { isSidebarSearchActive = it },
                )
            }
        },
    ) {
        Scaffold(
            contentWindowInsets = WindowInsets.safeDrawing,
            topBar = {
                TopAppBar(
                    title = {
                        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(
                                text = shellHeader.title,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Text(
                                text = shellHeader.subtitle,
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
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
                                onClick = { coroutineScope.launch { drawerState.open() } },
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
                        )

                        AppShellContent.PAIRING -> PairingEntryScreen(
                            importText = state.importText,
                            errorMessage = state.lastErrorMessage,
                            pendingTransportSelectionPairing = state.pendingTransportSelectionPairing,
                            onImportTextChanged = viewModel::updateImportText,
                            onImport = {
                                contentViewModel.markPairingSubmission()
                                viewModel.importPairingPayload(state.importText)
                            },
                            onScannedPayload = { payload ->
                                contentViewModel.markPairingSubmission()
                                viewModel.importPairingPayload(payload)
                            },
                            onSelectTransport = viewModel::confirmPendingPairingTransport,
                        )

                        AppShellContent.THREAD -> TurnScreen(
                            state = state,
                            input = messageInput,
                            onInputChanged = { messageInput = it },
                            onSend = { text, attachments, skillMentions, usePlanMode ->
                                viewModel.sendMessage(text, attachments, skillMentions, usePlanMode)
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

        AppShellContent.THREAD -> ShellHeader(
            title = state.selectedThread?.displayTitle ?: "Remodex",
            subtitle = listOfNotNull(
                state.selectedThread?.providerBadgeTitle,
                state.selectedThread?.projectDisplayName,
            ).joinToString(" · ").ifBlank { "Your paired Mac" },
        )

        AppShellContent.EMPTY -> ShellHeader(
            title = "Remodex",
            subtitle = "Your paired Mac",
        )
    }
}
