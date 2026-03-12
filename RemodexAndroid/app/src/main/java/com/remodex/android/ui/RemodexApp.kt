package com.remodex.android.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.togetherWith
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.PowerSettingsNew
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.animation.animateColorAsState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import com.remodex.android.R
import com.remodex.android.app.AppViewModel
import com.remodex.android.data.model.AccessMode
import com.remodex.android.data.model.AppFontStyle
import com.remodex.android.data.model.AppState
import com.remodex.android.data.model.ChatMessage
import com.remodex.android.data.model.CommandPhase
import com.remodex.android.data.model.ConnectionPhase
import com.remodex.android.data.model.MessageKind
import com.remodex.android.data.model.MessageRole
import com.remodex.android.data.model.ModelOption
import com.remodex.android.data.model.PlanStepStatus
import com.remodex.android.data.model.ThreadSyncState
import com.remodex.android.ui.components.PairingScannerView
import com.remodex.android.ui.screens.OnboardingScreen
import com.remodex.android.ui.screens.SidebarScreen
import com.remodex.android.ui.screens.SettingsScreen

import com.remodex.android.ui.theme.Border
import com.remodex.android.ui.theme.CommandAccent
import com.remodex.android.ui.theme.Danger
import com.remodex.android.ui.theme.PlanAccent
import com.remodex.android.ui.theme.monoFamily
import kotlinx.coroutines.launch
import androidx.compose.animation.core.*
import androidx.compose.ui.graphics.graphicsLayer

@Composable
fun RemodexApp(
    state: AppState,
    viewModel: AppViewModel,
) {
    if (!state.onboardingSeen) {
        OnboardingScreen(onContinue = viewModel::completeOnboarding)
        return
    }

    if (state.pairings.isEmpty()) {
        PairingEntryScreen(
            importText = state.importText,
            errorMessage = state.lastErrorMessage,
            onImportTextChanged = viewModel::updateImportText,
            onImport = { viewModel.importPairingPayload(state.importText) },
            onScannedPayload = viewModel::importPairingPayload,
        )
        return
    }

    MainShell(
        state = state,
        viewModel = viewModel,
    )
}

private enum class MainShellContent {
    SETTINGS,
    PAIRING,
    THREAD,
    EMPTY,
}

@Composable
@OptIn(ExperimentalMaterial3Api::class)
private fun MainShell(
    state: AppState,
    viewModel: AppViewModel,
) {
    val drawerState = rememberDrawerState(initialValue = androidx.compose.material3.DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    var showSettings by rememberSaveable { mutableStateOf(false) }
    var showPairingEntry by rememberSaveable { mutableStateOf(false) }
    var pendingPairingDismiss by rememberSaveable { mutableStateOf(false) }
    var pairingEntryBaselinePhase by rememberSaveable { mutableStateOf(ConnectionPhase.OFFLINE.name) }
    var messageInput by rememberSaveable(state.selectedThreadId) { mutableStateOf("") }
    val shellContent = remember(showSettings, showPairingEntry, state.selectedThreadId) {
        when {
            showSettings -> MainShellContent.SETTINGS
            showPairingEntry -> MainShellContent.PAIRING
            state.selectedThread != null -> MainShellContent.THREAD
            else -> MainShellContent.EMPTY
        }
    }
    LaunchedEffect(
        showPairingEntry,
        pendingPairingDismiss,
        state.connectionPhase,
        state.lastErrorMessage,
        state.activePairingMacDeviceId,
    ) {
        if (!showPairingEntry || !pendingPairingDismiss) {
            return@LaunchedEffect
        }
        when {
            state.lastErrorMessage != null -> pendingPairingDismiss = false
            state.connectionPhase.name != pairingEntryBaselinePhase -> {
                showPairingEntry = false
                pendingPairingDismiss = false
            }
        }
    }

    ModalNavigationDrawer(
        drawerState = drawerState,
        drawerContent = {
            ModalDrawerSheet(
                modifier = Modifier.width(330.dp),
                drawerContainerColor = MaterialTheme.colorScheme.surface,
            ) {
                SidebarScreen(
                    state = state,
                    onCreateThread = { project ->
                        showSettings = false
                        showPairingEntry = false
                        viewModel.createThread(project)
                        scope.launch { drawerState.close() }
                    },
                    onDeleteThread = viewModel::deleteThread,
                    onArchiveThread = viewModel::archiveThread,
                    onUnarchiveThread = viewModel::unarchiveThread,
                    onRenameThread = viewModel::renameThread,
                    onSelectThread = { threadId ->
                        showSettings = false
                        showPairingEntry = false
                        viewModel.selectThread(threadId)
                        scope.launch { drawerState.close() }
                    },
                    onOpenSettings = {
                        showPairingEntry = false
                        showSettings = true
                        scope.launch { drawerState.close() }
                    },
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
                                text = if (showSettings) {
                                    "Settings"
                                } else if (showPairingEntry) {
                                    "Pair Another Mac"
                                } else {
                                    state.selectedThread?.displayTitle ?: "Remodex"
                                },
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Text(
                                text = if (showSettings) {
                                    "Local-first preferences"
                                } else if (showPairingEntry) {
                                    "Scan or paste a local bridge payload"
                                } else {
                                    state.selectedThread?.projectDisplayName ?: "Your paired Mac"
                                },
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    },
                    navigationIcon = {
                        Surface(
                            shape = RoundedCornerShape(14.dp),
                            color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.72f),
                            modifier = Modifier.padding(start = 8.dp),
                        ) {
                            IconButton(onClick = { scope.launch { drawerState.open() } }) {
                                Icon(Icons.Outlined.Menu, contentDescription = "Open drawer")
                            }
                        }
                    },
                    actions = {
                        StatusPill(state = state)
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
                    label = "mainShellContent",
                ) { content ->
                when (content) {
                    MainShellContent.SETTINGS -> SettingsScreen(state = state, viewModel = viewModel)
                    MainShellContent.PAIRING -> PairingEntryScreen(
                        importText = state.importText,
                        errorMessage = state.lastErrorMessage,
                        onImportTextChanged = viewModel::updateImportText,
                        onImport = {
                            pendingPairingDismiss = true
                            viewModel.importPairingPayload(state.importText)
                        },
                        onScannedPayload = { payload ->
                            pendingPairingDismiss = true
                            viewModel.importPairingPayload(payload)
                        },
                    )
                    MainShellContent.THREAD -> TurnScreen(
                        state = state,
                        input = messageInput,
                            onInputChanged = { messageInput = it },
                            onSend = { usePlanMode ->
                                viewModel.sendMessage(messageInput, usePlanMode)
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

                    MainShellContent.EMPTY -> com.remodex.android.ui.screens.HomeEmptyScreen(
                        state = state,
                        onToggleConnection = { if (state.isConnected) viewModel.disconnect() else viewModel.connectActivePairing() },
                        onOpenPairing = {
                            showSettings = false
                            pairingEntryBaselinePhase = state.connectionPhase.name
                            showPairingEntry = true
                        },
                    )
                }
            }
        }
        }
    }
}

@Composable
private fun PairingEntryScreen(
    importText: String,
    errorMessage: String?,
    onImportTextChanged: (String) -> Unit,
    onImport: () -> Unit,
    onScannedPayload: (String) -> Unit,
) {
    var scannerMode by rememberSaveable { mutableStateOf(true) }
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black),
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .statusBarsPadding()
                .navigationBarsPadding()
                .padding(24.dp),
            verticalArrangement = Arrangement.SpaceBetween,
        ) {
            Spacer(Modifier.height(12.dp))
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Surface(
                    shape = RoundedCornerShape(28.dp),
                    color = Color.White.copy(alpha = 0.07f),
                    border = androidx.compose.foundation.BorderStroke(1.dp, Color.White.copy(alpha = 0.16f)),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Column(
                        modifier = Modifier.padding(horizontal = 20.dp, vertical = 20.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        if (scannerMode) {
                            PairingScannerView(
                                modifier = Modifier.size(280.dp),
                                onCodeScanned = onScannedPayload,
                                permissionDeniedContent = {
                                    Box(
                                        modifier = Modifier
                                            .size(250.dp)
                                            .border(2.dp, Color.White.copy(alpha = 0.65f), RoundedCornerShape(20.dp)),
                                        contentAlignment = Alignment.Center,
                                    ) {
                                        Text(
                                            "Camera access needed",
                                            color = Color.White,
                                            style = MaterialTheme.typography.labelLarge,
                                        )
                                    }
                                },
                            )
                        } else {
                            Box(
                                modifier = Modifier
                                    .size(250.dp)
                                    .border(2.dp, Color.White.copy(alpha = 0.65f), RoundedCornerShape(20.dp)),
                                contentAlignment = Alignment.Center,
                            ) {
                                Icon(
                                    Icons.Outlined.QrCodeScanner,
                                    contentDescription = null,
                                    tint = Color.White.copy(alpha = 0.8f),
                                    modifier = Modifier.size(44.dp),
                                )
                            }
                        }
                        Spacer(Modifier.height(24.dp))
                        Text(
                            if (scannerMode) "Scan pairing QR from Remodex CLI" else "Import pairing payload from Remodex CLI",
                            color = Color.White,
                            style = MaterialTheme.typography.titleMedium,
                            textAlign = TextAlign.Center,
                        )
                        Spacer(Modifier.height(10.dp))
                        Text(
                            if (scannerMode) {
                                "Use the QR code generated by the local bridge, like the iOS app."
                            } else {
                                "Paste the pairing JSON if scanning is not convenient."
                            },
                            color = Color.White.copy(alpha = 0.74f),
                            style = MaterialTheme.typography.bodyMedium,
                            textAlign = TextAlign.Center,
                        )
                        Spacer(Modifier.height(16.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            FilterChip(
                                selected = scannerMode,
                                onClick = { scannerMode = true },
                                label = { Text("Scan") },
                            )
                            FilterChip(
                                selected = !scannerMode,
                                onClick = { scannerMode = false },
                                label = { Text("Paste") },
                            )
                        }
                    }
                }
            }

            GlassCard(cornerRadius = 24.dp) {
                Text(
                    text = if (scannerMode) "Waiting for a local bridge QR." else "Paste the secure pairing payload.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (!scannerMode) {
                    Spacer(Modifier.height(14.dp))
                    OutlinedTextField(
                        value = importText,
                        onValueChange = onImportTextChanged,
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(180.dp),
                        label = { Text("Pairing payload") },
                        shape = RoundedCornerShape(20.dp),
                    )
                    Spacer(Modifier.height(16.dp))
                    Button(
                        onClick = onImport,
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(18.dp),
                    ) {
                        Text("Connect to Bridge")
                    }
                }
                if (!errorMessage.isNullOrBlank()) {
                    if (!scannerMode) {
                        Spacer(Modifier.height(12.dp))
                    }
                    Text(
                        text = errorMessage,
                        color = Danger,
                        style = MaterialTheme.typography.labelLarge,
                    )
                }
            }
        }
    }
}





@Composable
private fun PulsingDot(color: Color) {
    val infiniteTransition = rememberInfiniteTransition(label = "pulsing")
    val alpha by infiniteTransition.animateFloat(
        initialValue = 0.4f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(800, easing = LinearEasing),
            repeatMode = RepeatMode.Reverse
        ),
        label = "alpha"
    )
    Box(
        modifier = Modifier
            .size(8.dp)
            .graphicsLayer(alpha = alpha)
            .background(color, CircleShape)
    )
}

@Composable
private fun TurnScreen(
    state: AppState,
    input: String,
    onInputChanged: (String) -> Unit,
    onSend: (Boolean) -> Unit,
    onStop: () -> Unit,
    onReconnect: () -> Unit,
    onSelectModel: (String?) -> Unit,
    onSelectReasoning: (String?) -> Unit,
    onSelectAccessMode: (AccessMode) -> Unit,
    onApprove: () -> Unit,
    onDeny: () -> Unit,
    onSubmitStructuredInput: (kotlinx.serialization.json.JsonElement, Map<String, String>) -> Unit,
    viewModel: AppViewModel,
) {
    val thread = state.selectedThread ?: return
    val messages = remember(state.messagesByThread, thread.id) {
        projectTimelineMessages(
            state.messagesByThread[thread.id].orEmpty().sortedBy(ChatMessage::orderIndex),
        )
    }
    val renderItems = remember(messages) { buildTimelineRenderItems(messages) }
    val listState = rememberLazyListState()
    var autoFollowLatest by rememberSaveable(thread.id) { mutableStateOf(true) }
    val isRunning = state.runningThreadIds.contains(thread.id)
    val pendingApproval = state.pendingApproval?.takeIf { approval ->
        approval.threadId == null || approval.threadId == thread.id
    }
    val latestMessageAnchor = remember(messages) {
        messages.lastOrNull()?.let { message ->
            buildString {
                append(messages.size)
                append('|')
                append(message.id)
                append('|')
                append(message.isStreaming)
                append('|')
                append(message.text.hashCode())
            }
        }
    }
    val isNearBottom by remember(listState, messages.size) {
        derivedStateOf {
            if (messages.isEmpty()) {
                true
            } else {
                val lastVisibleIndex = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: -1
                lastVisibleIndex >= messages.lastIndex - 1
            }
        }
    }

    LaunchedEffect(isNearBottom) {
        if (isNearBottom) {
            autoFollowLatest = true
        }
    }

    LaunchedEffect(listState.isScrollInProgress, isNearBottom) {
        if (listState.isScrollInProgress && !isNearBottom) {
            autoFollowLatest = false
        }
    }

    LaunchedEffect(latestMessageAnchor, isRunning, autoFollowLatest) {
        if (messages.isNotEmpty() && autoFollowLatest) {
            listState.animateScrollToItem(messages.lastIndex)
        }
    }

    Column(modifier = Modifier.fillMaxSize()) {
        Box(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth(),
        ) {
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxSize(),
                verticalArrangement = Arrangement.spacedBy(16.dp),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 140.dp),
            ) {
                if (messages.isEmpty()) {
                    item {
                        GlassCard(modifier = Modifier.fillMaxWidth()) {
                            Text(
                                text = if (isRunning) "Waiting for Codex to respond…" else "Start a conversation with your paired Mac.",
                                style = MaterialTheme.typography.bodyLarge,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
                items(renderItems, key = { it.key }) { item ->
                    when (item) {
                        is TimelineRenderItem.Message -> TurnMessageBubble(
                            message = item.message,
                            onSubmitStructuredInput = onSubmitStructuredInput,
                        )

                        is TimelineRenderItem.TurnSection -> TurnSectionCard(
                            item = item,
                            onSubmitStructuredInput = onSubmitStructuredInput,
                        )
                    }
                }
            }

            if (messages.isNotEmpty() && !isNearBottom) {
                FilledTonalButton(
                    onClick = { autoFollowLatest = true },
                    shape = RoundedCornerShape(999.dp),
                    modifier = Modifier
                        .align(Alignment.BottomCenter)
                        .navigationBarsPadding()
                        .padding(bottom = 12.dp),
                ) {
                    Text(if (isRunning) "Jump to live" else "Jump to latest")
                }
            }
        }

        pendingApproval?.let { approval ->
            ApprovalCard(
                approval = approval,
                onApprove = onApprove,
                onDeny = onDeny,
            )
        }

        com.remodex.android.ui.components.ComposerCard(
            state = state,
            input = input,
            onInputChanged = onInputChanged,
            isRunning = isRunning,
            onSend = onSend,
            onStop = onStop,
            onReconnect = onReconnect,
            onSelectModel = onSelectModel,
            onSelectReasoning = onSelectReasoning,
            onSelectAccessMode = onSelectAccessMode,
            viewModel = viewModel,
        )
    }
}

@Composable
private fun TurnMessageBubble(
    message: ChatMessage,
    onSubmitStructuredInput: (kotlinx.serialization.json.JsonElement, Map<String, String>) -> Unit,
    grouped: Boolean = false,
    replyPresentation: ReplyPresentation? = null,
) {
    when {
        message.role == MessageRole.USER -> {
            ConversationBubble(
                message = message,
                alignment = Alignment.CenterEnd,
                background = MaterialTheme.colorScheme.primary.copy(alpha = 0.95f),
                contentColor = MaterialTheme.colorScheme.onPrimary,
                fillFraction = if (grouped) 1f else 0.86f,
                shape = RoundedCornerShape(22.dp, 22.dp, 4.dp, 22.dp),
            )
        }

        message.role == MessageRole.ASSISTANT && message.kind == MessageKind.CHAT -> {
            ConversationBubble(
                message = message,
                alignment = Alignment.CenterStart,
                background = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.25f),
                contentColor = MaterialTheme.colorScheme.onSurface,
                fillFraction = if (grouped) 1f else 0.92f,
                shape = RoundedCornerShape(20.dp),
                tonalElevation = 0.dp,
                replyPresentation = replyPresentation,
            )
        }

        else -> SystemMessageCard(
            message = message,
            onSubmitStructuredInput = onSubmitStructuredInput,
            grouped = grouped,
        )
    }
}

@Composable
private fun ConversationBubble(
    message: ChatMessage,
    alignment: Alignment,
    background: Color,
    contentColor: Color,
    fillFraction: Float,
    shape: Shape,
    tonalElevation: androidx.compose.ui.unit.Dp = 0.dp,
    replyPresentation: ReplyPresentation? = null,
) {
    val usesRichText = message.role == MessageRole.ASSISTANT && message.kind == MessageKind.CHAT
    val bubbleBorder = when (replyPresentation) {
        ReplyPresentation.FINAL -> androidx.compose.foundation.BorderStroke(
            1.dp,
            MaterialTheme.colorScheme.primary.copy(alpha = 0.22f),
        )

        ReplyPresentation.DRAFT -> androidx.compose.foundation.BorderStroke(
            1.dp,
            MaterialTheme.colorScheme.outline.copy(alpha = 0.55f),
        )

        null -> null
    }
    Box(
        modifier = Modifier.fillMaxWidth(),
        contentAlignment = alignment,
    ) {
        Surface(
            color = background,
            contentColor = contentColor,
            shape = shape,
            tonalElevation = tonalElevation,
            border = bubbleBorder,
            modifier = Modifier
                .fillMaxWidth(fillFraction)
                .animateContentSize(),
        ) {
            Column(modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
                replyPresentation?.let { presentation ->
                    StatusTag(
                        text = if (presentation == ReplyPresentation.FINAL) "Final" else "Draft",
                        containerColor = if (presentation == ReplyPresentation.FINAL) {
                            MaterialTheme.colorScheme.primary.copy(alpha = 0.12f)
                        } else {
                            MaterialTheme.colorScheme.surfaceVariant
                        },
                        contentColor = if (presentation == ReplyPresentation.FINAL) {
                            MaterialTheme.colorScheme.primary
                        } else {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        },
                    )
                    Spacer(Modifier.height(10.dp))
                }
                if (usesRichText) {
                    RichMessageText(
                        text = message.text,
                        textColor = contentColor,
                    )
                } else {
                    Text(
                        text = message.text,
                        style = MaterialTheme.typography.bodyLarge,
                    )
                }
            }
        }
    }
}

@Composable
private fun SystemMessageCard(
    message: ChatMessage,
    onSubmitStructuredInput: (kotlinx.serialization.json.JsonElement, Map<String, String>) -> Unit,
    grouped: Boolean = false,
) {
    val accent = systemAccentColor(message.kind)
    Box(
        modifier = Modifier.fillMaxWidth(),
        contentAlignment = Alignment.CenterStart,
    ) {
        Surface(
            shape = RoundedCornerShape(20.dp),
            color = MaterialTheme.colorScheme.surface.copy(alpha = 0.96f),
            border = androidx.compose.foundation.BorderStroke(1.dp, Border),
            modifier = Modifier.fillMaxWidth(if (grouped) 1f else 0.94f),
        ) {
            Column(modifier = Modifier.padding(horizontal = 16.dp, vertical = 14.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    if (message.isStreaming) {
                        PulsingDot(color = accent)
                    } else {
                        Box(
                            modifier = Modifier
                                .size(8.dp)
                                .background(accent, CircleShape),
                        )
                    }
                    Text(
                        text = systemMessageTitle(message.kind),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Spacer(Modifier.height(12.dp))
                when (message.kind) {
                    MessageKind.THINKING -> ThinkingMessageContent(message)
                    MessageKind.FILE_CHANGE -> FileChangeMessageContent(message)
                    MessageKind.COMMAND_EXECUTION -> CommandExecutionMessageContent(message)
                    MessageKind.PLAN -> PlanMessageContent(message)
                    MessageKind.USER_INPUT_PROMPT -> UserInputPromptMessageContent(message, onSubmitStructuredInput)
                    MessageKind.CHAT -> DefaultSystemMessageContent(message)
                }
            }
        }
    }
}


@Composable
private fun TurnSectionCard(
    item: TimelineRenderItem.TurnSection,
    onSubmitStructuredInput: (kotlinx.serialization.json.JsonElement, Map<String, String>) -> Unit,
) {
    val labels = remember(item.messages) { buildTurnSectionLabels(item.messages) }
    val summary = remember(item.messages) { buildTurnSectionSummary(item.messages) }
    val replyIndex = remember(item.messages) {
        item.messages.indexOfLast { it.role == MessageRole.ASSISTANT && it.kind == MessageKind.CHAT }
    }
    val isLive = item.messages.any(ChatMessage::isStreaming)
    val hasPendingInput = item.messages.any { it.kind == MessageKind.USER_INPUT_PROMPT }
    val isCollapsible = !isLive && !hasPendingInput && item.messages.size > 3
    var isExpanded by rememberSaveable(item.turnId) { mutableStateOf(!isCollapsible) }
    val visibleMessages = remember(item.messages, isExpanded) {
        if (isExpanded || !isCollapsible) {
            item.messages
        } else {
            buildCollapsedTurnMessages(item.messages)
        }
    }
    val hiddenCount = (item.messages.size - visibleMessages.size).coerceAtLeast(0)
    val collapsedPreview = remember(item.messages) { buildCollapsedTurnPreview(item.messages) }
    val liveAccent = item.messages
        .firstOrNull { it.isStreaming }
        ?.let { message ->
            when {
                message.role == MessageRole.ASSISTANT -> MaterialTheme.colorScheme.primary
                else -> systemAccentColor(message.kind)
            }
        }
        ?: MaterialTheme.colorScheme.outline
    LaunchedEffect(isCollapsible, isLive) {
        if (!isCollapsible || isLive) {
            isExpanded = true
        }
    }
    Surface(
        shape = RoundedCornerShape(26.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.22f),
        border = androidx.compose.foundation.BorderStroke(1.dp, Border.copy(alpha = 0.7f)),
        modifier = Modifier
            .fillMaxWidth()
            .animateContentSize(),
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    modifier = Modifier
                        .size(7.dp)
                        .background(liveAccent, CircleShape),
                )
                Text(
                    text = "Turn",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                StatusTag(
                    text = summary.statusLabel,
                    containerColor = liveAccent.copy(alpha = 0.12f),
                    contentColor = liveAccent,
                )
                labels.take(4).forEach { label ->
                    TurnSectionLabelChip(label)
                }
                if (item.messages.any(ChatMessage::isStreaming)) {
                    StatusTag(
                        text = "LIVE",
                        containerColor = liveAccent.copy(alpha = 0.12f),
                        contentColor = liveAccent,
                    )
                }
                Spacer(Modifier.weight(1f))
                if (isCollapsible) {
                    TextButton(onClick = { isExpanded = !isExpanded }) {
                        Text(if (isExpanded) "Collapse" else "Expand")
                    }
                }
            }
            Text(
                text = summary.detail,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            AnimatedVisibility(
                visible = !isExpanded && collapsedPreview != null,
                enter = fadeIn() + expandVertically(),
                exit = fadeOut() + shrinkVertically(),
            ) {
                collapsedPreview?.let { preview ->
                    Surface(
                        shape = RoundedCornerShape(16.dp),
                        color = MaterialTheme.colorScheme.surface.copy(alpha = 0.7f),
                    ) {
                        Column(
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
                            verticalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            Text(
                                text = preview.title,
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Text(
                                text = preview.body,
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurface,
                                maxLines = 4,
                                overflow = TextOverflow.Ellipsis,
                            )
                            if (hiddenCount > 0) {
                                Text(
                                    text = "$hiddenCount earlier item${if (hiddenCount == 1) "" else "s"} hidden",
                                    style = MaterialTheme.typography.labelMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                }
            }
            AnimatedVisibility(
                visible = isExpanded || !isCollapsible,
                enter = fadeIn() + expandVertically(),
                exit = fadeOut() + shrinkVertically(),
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    visibleMessages.forEachIndexed { index, message ->
                        val originalIndex = item.messages.indexOfFirst { it.id == message.id }
                        val replyPresentation = if (originalIndex == replyIndex && message.role == MessageRole.ASSISTANT) {
                            if (message.isStreaming) ReplyPresentation.DRAFT else ReplyPresentation.FINAL
                        } else {
                            null
                        }
                        if (originalIndex == replyIndex && index > 0) {
                            ReplyMarker(
                                isStreaming = message.isStreaming,
                            )
                        }
                        TurnMessageBubble(
                            message = message,
                            onSubmitStructuredInput = onSubmitStructuredInput,
                            grouped = true,
                            replyPresentation = replyPresentation,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun TurnSectionLabelChip(label: TurnSectionLabelUi) {
    val containerColor: Color
    val contentColor: Color
    when {
        label.isAssistantReply -> {
            containerColor = MaterialTheme.colorScheme.primary.copy(alpha = 0.12f)
            contentColor = MaterialTheme.colorScheme.primary
        }

        label.kind != null -> {
            val accent = systemAccentColor(label.kind)
            containerColor = accent.copy(alpha = 0.12f)
            contentColor = accent
        }

        else -> {
            containerColor = MaterialTheme.colorScheme.surface
            contentColor = MaterialTheme.colorScheme.onSurfaceVariant
        }
    }
    StatusTag(
        text = label.text,
        containerColor = containerColor,
        contentColor = contentColor,
    )
}

@Composable
private fun ReplyMarker(
    isStreaming: Boolean,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(
            modifier = Modifier
                .weight(1f)
                .height(1.dp)
                .background(Border.copy(alpha = 0.75f)),
        )
        Text(
            text = if (isStreaming) "Draft reply" else "Final reply",
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun ThinkingMessageContent(message: ChatMessage) {
    val thinking = remember(message.id, message.text) { parseThinkingDisclosure(message.text) }
    var expandedSectionIds by remember(message.id) { mutableStateOf<Set<String>>(emptySet()) }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            text = "Thinking...",
            style = MaterialTheme.typography.labelLarge.copy(fontFamily = monoFamily),
            fontWeight = FontWeight.Normal,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (thinking.sections.isNotEmpty()) {
            thinking.sections.forEach { section ->
                val isExpanded = expandedSectionIds.contains(section.id)
                val hasDetail = section.detail.isNotBlank()
                Surface(
                    shape = RoundedCornerShape(14.dp),
                    color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Column(modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable(enabled = hasDetail) {
                                    expandedSectionIds = if (isExpanded) {
                                        expandedSectionIds - section.id
                                    } else {
                                        expandedSectionIds + section.id
                                    }
                                },
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                text = if (isExpanded) "▾" else "▸",
                                style = MaterialTheme.typography.labelMedium.copy(fontFamily = monoFamily),
                                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = if (hasDetail) 0.9f else 0.4f),
                            )
                            Spacer(Modifier.width(8.dp))
                            Text(
                                text = section.title,
                                style = MaterialTheme.typography.labelMedium.copy(fontFamily = monoFamily),
                                fontWeight = FontWeight.Bold,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        if (isExpanded && hasDetail) {
                            Spacer(Modifier.height(8.dp))
                            Text(
                                text = section.detail,
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.88f),
                            )
                        }
                    }
                }
            }
        } else if (thinking.fallbackText.isNotEmpty()) {
            Text(
                text = thinking.fallbackText,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.88f),
            )
        }
    }
}

@Composable
private fun FileChangeMessageContent(message: ChatMessage) {
    var showDiffDetails by remember(message.id) { mutableStateOf(false) }
    val entries = remember(message.id, message.text, message.fileChanges) {
        if (message.fileChanges.isNotEmpty()) {
            message.fileChanges.map { change ->
                FileChangeEntryUi(
                    path = change.path,
                    actionLabel = fileChangeActionLabel(change.kind),
                    additions = change.additions ?: 0,
                    deletions = change.deletions ?: 0,
                )
            }
        } else {
            parseFileChangeEntries(message.text)
        }
    }
    val groupedEntries = remember(entries) { groupFileChangeEntries(entries) }
    val diffFiles = remember(message.id, message.text, message.fileChanges) {
        buildDiffDetailFiles(message)
    }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (entries.isNotEmpty()) {
            groupedEntries.forEach { group ->
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        text = group.actionLabel,
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    group.entries.take(6).forEach { entry ->
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            val accent = fileChangeAccentColor(entry.actionLabel)
                            StatusTag(
                                text = entry.actionLabel.take(1),
                                containerColor = accent.copy(alpha = 0.12f),
                                contentColor = accent,
                            )
                            Spacer(Modifier.width(10.dp))
                            Text(
                                text = entry.path,
                                style = MaterialTheme.typography.bodyMedium.copy(fontFamily = monoFamily),
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f),
                            )
                            if (entry.additions > 0 || entry.deletions > 0) {
                                Spacer(Modifier.width(8.dp))
                                Text(
                                    text = buildString {
                                        if (entry.additions > 0) append("+${entry.additions}")
                                        if (entry.deletions > 0) {
                                            if (isNotEmpty()) append(" ")
                                            append("-${entry.deletions}")
                                        }
                                    },
                                    style = MaterialTheme.typography.labelMedium.copy(fontFamily = monoFamily),
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                    if (group.entries.size > 6) {
                        Text(
                            text = "+${group.entries.size - 6} more ${group.actionLabel.lowercase()} files",
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            if (message.fileChanges.any { it.diff.isNotBlank() }) {
                OutlinedButton(
                    onClick = { showDiffDetails = true },
                    shape = RoundedCornerShape(999.dp),
                ) {
                    Text("View diff")
                }
            }
        } else if (message.text.isNotBlank()) {
            Text(
                text = message.text.trim(),
                style = MaterialTheme.typography.bodyMedium.copy(fontFamily = monoFamily),
            )
        }
    }
    if (showDiffDetails) {
        DiffDetailDialog(
            title = "Repository changes",
            files = diffFiles,
            fallbackBody = remember(message.id, message.fileChanges, message.text) {
                buildDiffDetailText(message)
            },
            onDismiss = { showDiffDetails = false },
        )
    }
}

@Composable
private fun CommandExecutionMessageContent(message: ChatMessage) {
    var showOutputDetails by remember(message.id) { mutableStateOf(false) }
    val preview = remember(message.id, message.text, message.isStreaming, message.commandState) {
        message.commandState?.let { state ->
            CommandPreviewUi(
                command = state.fullCommand,
                outputLines = buildList {
                    state.cwd?.let { add("cwd: $it") }
                    state.exitCode?.let { add("exit code: $it") }
                    state.durationMs?.let { add("${it}ms") }
                    state.outputTail
                        .lines()
                        .filter(String::isNotBlank)
                        .takeLast(3)
                        .forEach(::add)
                },
                statusLabel = state.phase.statusLabel,
            )
        } ?: parseCommandPreview(message.text, message.isStreaming)
    }
    val accent = commandStatusAccentColor(preview.statusLabel)
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        preview.command?.let { command ->
            Surface(
                shape = RoundedCornerShape(14.dp),
                color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.7f),
            ) {
                Text(
                    text = command,
                    style = MaterialTheme.typography.bodyMedium.copy(fontFamily = monoFamily),
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
                )
            }
        }
        preview.outputLines.forEach { line ->
            Text(
                text = line,
                style = MaterialTheme.typography.bodyMedium.copy(fontFamily = monoFamily),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (preview.command == null && preview.outputLines.isEmpty() && message.text.isNotBlank()) {
            Text(
                text = message.text.trim(),
                style = MaterialTheme.typography.bodyMedium.copy(fontFamily = monoFamily),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        StatusTag(
            text = preview.statusLabel,
            containerColor = accent.copy(alpha = 0.12f),
            contentColor = accent,
        )
        message.commandState?.outputTail
            ?.trim()
            ?.takeIf(String::isNotEmpty)
            ?.let {
                OutlinedButton(
                    onClick = { showOutputDetails = true },
                    shape = RoundedCornerShape(999.dp),
                ) {
                    Text("View output")
                }
            }
    }
    if (showOutputDetails) {
        CommandDetailDialog(
            detail = remember(message.id, message.commandState, message.text, preview.statusLabel, preview.command) {
                buildCommandDetail(message, preview)
            },
            onDismiss = { showOutputDetails = false },
        )
    }
}

@Composable
private fun PlanMessageContent(message: ChatMessage) {
    val plan = remember(message.id, message.text, message.planState) {
        message.planState?.let { state ->
            PlanSummaryUi(
                explanation = state.explanation,
                steps = state.steps.map { step ->
                    PlanStepUi(
                        text = step.step,
                        statusLabel = when (step.status) {
                            PlanStepStatus.PENDING -> "Pending"
                            PlanStepStatus.IN_PROGRESS -> "In progress"
                            PlanStepStatus.COMPLETED -> "Completed"
                        },
                    )
                },
            )
        } ?: parsePlanSummary(message.text)
    }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        plan.explanation?.let {
            Text(
                text = it,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
        if (plan.steps.isNotEmpty()) {
            plan.steps.forEach { step ->
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.Top,
                ) {
                    Box(
                        modifier = Modifier
                            .padding(top = 6.dp)
                            .size(8.dp)
                            .background(planStatusAccentColor(step.statusLabel), CircleShape),
                    )
                    Spacer(Modifier.width(10.dp))
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = step.text,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Spacer(Modifier.height(2.dp))
                        Text(
                            text = step.statusLabel,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        } else if (message.text.isNotBlank()) {
            Text(
                text = message.text.trim(),
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}

@Composable
private fun UserInputPromptMessageContent(
    message: ChatMessage,
    onSubmitStructuredInput: (kotlinx.serialization.json.JsonElement, Map<String, String>) -> Unit,
) {
    val request = message.structuredUserInputRequest
    var selectedOptions by remember(message.id) { mutableStateOf<Map<String, String>>(emptyMap()) }
    var typedAnswers by remember(message.id) { mutableStateOf<Map<String, String>>(emptyMap()) }
    var hasSubmitted by remember(message.id) { mutableStateOf(false) }

    if (request == null) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                text = "Codex needs a decision before it can continue.",
                style = MaterialTheme.typography.bodyMedium,
            )
            if (message.text.isNotBlank()) {
                Text(
                    text = message.text.trim(),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        return
    }

    fun resolvedAnswer(questionId: String): String? {
        val typed = typedAnswers[questionId]?.trim()?.takeIf(String::isNotEmpty)
        if (typed != null) return typed
        return selectedOptions[questionId]?.trim()?.takeIf(String::isNotEmpty)
    }

    val isSubmitDisabled = hasSubmitted || !request.questions.all { question ->
        resolvedAnswer(question.id) != null
    }

    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        request.questions.forEachIndexed { index, question ->
            if (index > 0) {
                Spacer(Modifier.height(2.dp))
            }
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                question.header.trim().takeIf(String::isNotEmpty)?.let { header ->
                    Text(
                        text = header.uppercase(),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Text(
                    text = question.question.trim(),
                    style = MaterialTheme.typography.bodyMedium,
                )
                if (question.options.isNotEmpty()) {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        question.options.forEach { option ->
                            val isSelected = selectedOptions[question.id] == option.label
                            Surface(
                                shape = RoundedCornerShape(14.dp),
                                color = if (isSelected) {
                                    MaterialTheme.colorScheme.tertiary.copy(alpha = 0.12f)
                                } else {
                                    MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.45f)
                                },
                                border = androidx.compose.foundation.BorderStroke(
                                    1.dp,
                                    if (isSelected) MaterialTheme.colorScheme.tertiary else Border,
                                ),
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable(enabled = !hasSubmitted) {
                                        selectedOptions = selectedOptions + (question.id to option.label)
                                    },
                            ) {
                                Column(modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
                                    Text(
                                        text = option.label,
                                        style = MaterialTheme.typography.bodyMedium,
                                        color = if (isSelected) MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.onSurface,
                                    )
                                    option.description.trim().takeIf(String::isNotEmpty)?.let { description ->
                                        Spacer(Modifier.height(2.dp))
                                        Text(
                                            text = description,
                                            style = MaterialTheme.typography.labelMedium,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
                if (question.isOther || question.options.isEmpty()) {
                    OutlinedTextField(
                        value = typedAnswers[question.id].orEmpty(),
                        onValueChange = { typedAnswers = typedAnswers + (question.id to it) },
                        modifier = Modifier.fillMaxWidth(),
                        minLines = if (question.isSecret) 1 else 2,
                        label = { Text(if (question.isSecret) "Secret answer" else "Your answer") },
                        enabled = !hasSubmitted,
                    )
                }
            }
        }

        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            Button(
                onClick = {
                    val answers = request.questions.associate { question ->
                        question.id to resolvedAnswer(question.id).orEmpty()
                    }
                    hasSubmitted = true
                    onSubmitStructuredInput(request.requestId, answers)
                },
                enabled = !isSubmitDisabled,
                shape = RoundedCornerShape(999.dp),
            ) {
                Text(if (hasSubmitted) "Sent" else "Send")
            }
        }
    }
}

@Composable
private fun DefaultSystemMessageContent(message: ChatMessage) {
    RichMessageText(
        text = message.text.trim(),
        textColor = MaterialTheme.colorScheme.onSurfaceVariant,
        textStyle = MaterialTheme.typography.bodyMedium,
    )
}

@Composable
internal fun StatusTag(
    text: String,
    containerColor: Color,
    contentColor: Color,
) {
    Surface(
        shape = RoundedCornerShape(999.dp),
        color = containerColor,
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.labelSmall,
            color = contentColor,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
        )
    }
}

@Composable
private fun DetailDialog(
    title: String,
    body: String,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(onClick = onDismiss) {
                Text("Close")
            }
        },
        title = {
            Text(
                text = title,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        },
        text = {
            Text(
                text = body.ifBlank { "No details available." },
                style = MaterialTheme.typography.bodyMedium.copy(fontFamily = monoFamily),
                modifier = Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState()),
            )
        },
    )
}

@Composable
private fun DiffDetailDialog(
    title: String,
    files: List<DiffFileDetailUi>,
    fallbackBody: String,
    onDismiss: () -> Unit,
) {
    var expandedFileIds by androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf(emptySet<String>()) }
    val allExpanded = files.isNotEmpty() && files.all { expandedFileIds.contains(it.path) }

    Dialog(onDismissRequest = onDismiss) {
        Surface(
            shape = RoundedCornerShape(28.dp),
            color = MaterialTheme.colorScheme.surface,
            modifier = Modifier
                .fillMaxWidth()
                .fillMaxHeight(0.9f),
        ) {
            Column(modifier = Modifier.padding(horizontal = 18.dp, vertical = 18.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = title,
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.weight(1f),
                    )
                    if (files.isNotEmpty()) {
                        TextButton(onClick = {
                            expandedFileIds = if (allExpanded) emptySet() else files.map { it.path }.toSet()
                        }) {
                            Text(if (allExpanded) "Collapse All" else "Expand All")
                        }
                    }
                    TextButton(onClick = onDismiss) {
                        Text("Close")
                    }
                }
                Spacer(Modifier.height(8.dp))
                if (files.isEmpty()) {
                    SelectionContainer {
                        Text(
                            text = fallbackBody.ifBlank { "No details available." },
                            style = MaterialTheme.typography.bodyMedium.copy(fontFamily = monoFamily),
                            modifier = Modifier
                                .fillMaxWidth()
                                .verticalScroll(rememberScrollState()),
                        )
                    }
                } else {
                    LazyColumn(
                        modifier = Modifier.fillMaxSize(),
                        verticalArrangement = Arrangement.spacedBy(14.dp),
                    ) {
                        items(files, key = { "${it.actionLabel}:${it.path}" }) { file ->
                            DiffFileDetailCard(
                                file = file,
                                isExpanded = expandedFileIds.contains(file.path),
                                onToggleExpand = {
                                    expandedFileIds = if (expandedFileIds.contains(file.path)) {
                                        expandedFileIds - file.path
                                    } else {
                                        expandedFileIds + file.path
                                    }
                                }
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun DiffFileDetailCard(
    file: DiffFileDetailUi,
    isExpanded: Boolean,
    onToggleExpand: () -> Unit,
) {
    val accent = fileChangeAccentColor(file.actionLabel)
    Surface(
        shape = RoundedCornerShape(20.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.45f),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clickable { onToggleExpand() }
                .padding(horizontal = 14.dp, vertical = 14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                StatusTag(
                    text = file.actionLabel.take(1),
                    containerColor = accent.copy(alpha = 0.12f),
                    contentColor = accent,
                )
                Text(
                    text = file.path,
                    style = MaterialTheme.typography.bodyMedium.copy(fontFamily = monoFamily),
                    modifier = Modifier.weight(1f),
                )
            }
            if (file.additions > 0 || file.deletions > 0) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = buildString {
                            if (file.additions > 0) append("+${file.additions}")
                            if (file.deletions > 0) {
                                if (isNotEmpty()) append(" ")
                                append("-${file.deletions}")
                            }
                        },
                        style = MaterialTheme.typography.labelMedium.copy(fontFamily = monoFamily),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Icon(
                        imageVector = if (isExpanded) androidx.compose.material.icons.Icons.Filled.KeyboardArrowUp else androidx.compose.material.icons.Icons.Filled.KeyboardArrowDown,
                        contentDescription = null,
                        modifier = Modifier.size(16.dp),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            } else {
                Icon(
                    imageVector = if (isExpanded) androidx.compose.material.icons.Icons.Filled.KeyboardArrowUp else androidx.compose.material.icons.Icons.Filled.KeyboardArrowDown,
                    contentDescription = null,
                    modifier = Modifier.size(16.dp).align(Alignment.End),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            if (isExpanded && file.hunks.isNotEmpty()) {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    file.hunks.forEach { hunk ->
                        Surface(
                            shape = RoundedCornerShape(16.dp),
                            color = MaterialTheme.colorScheme.surface.copy(alpha = 0.92f),
                        ) {
                            SelectionContainer {
                                Column(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .horizontalScroll(rememberScrollState())
                                        .padding(horizontal = 12.dp, vertical = 10.dp),
                                    verticalArrangement = Arrangement.spacedBy(4.dp),
                                ) {
                                    hunk.header?.let { header ->
                                        Text(
                                            text = header,
                                            style = MaterialTheme.typography.labelMedium.copy(fontFamily = monoFamily),
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        )
                                    }
                                    hunk.lines.forEach { line ->
                                        Text(
                                            text = line.text,
                                            style = MaterialTheme.typography.bodySmall.copy(fontFamily = monoFamily),
                                            color = diffLineColor(line.kind),
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            } else if (isExpanded && file.rawBody.isNotBlank()) {
                SelectionContainer {
                    Text(
                        text = file.rawBody,
                        style = MaterialTheme.typography.bodySmall.copy(fontFamily = monoFamily),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

@Composable
private fun CommandDetailDialog(
    detail: CommandDetailUi,
    onDismiss: () -> Unit,
) {
    Dialog(onDismissRequest = onDismiss) {
        Surface(
            shape = RoundedCornerShape(28.dp),
            color = MaterialTheme.colorScheme.surface,
            modifier = Modifier
                .fillMaxWidth()
                .fillMaxHeight(0.88f),
        ) {
            Column(modifier = Modifier.padding(horizontal = 18.dp, vertical = 18.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = detail.command ?: "Command output",
                        style = MaterialTheme.typography.titleMedium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    TextButton(onClick = onDismiss) {
                        Text("Close")
                    }
                }
                Spacer(Modifier.height(10.dp))
                detail.command?.let { command ->
                    Surface(
                        shape = RoundedCornerShape(16.dp),
                        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f),
                    ) {
                        SelectionContainer {
                            Text(
                                text = command,
                                style = MaterialTheme.typography.bodyMedium.copy(fontFamily = monoFamily),
                                modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
                            )
                        }
                    }
                    Spacer(Modifier.height(10.dp))
                }
                Row(
                    modifier = Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    StatusTag(
                        text = detail.statusLabel,
                        containerColor = commandStatusAccentColor(detail.statusLabel).copy(alpha = 0.12f),
                        contentColor = commandStatusAccentColor(detail.statusLabel),
                    )
                    detail.cwd?.let { CommandMetaTag("cwd", it) }
                    detail.exitCode?.let { CommandMetaTag("exit", it.toString()) }
                    detail.durationMs?.let { CommandMetaTag("duration", "${it}ms") }
                }
                Spacer(Modifier.height(12.dp))
                if (detail.outputSections.isEmpty()) {
                    SelectionContainer {
                        Text(
                            text = detail.fallbackBody.ifBlank { "No output available." },
                            style = MaterialTheme.typography.bodyMedium.copy(fontFamily = monoFamily),
                            modifier = Modifier
                                .fillMaxWidth()
                                .verticalScroll(rememberScrollState()),
                        )
                    }
                } else {
                    LazyColumn(
                        modifier = Modifier.fillMaxSize(),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        items(detail.outputSections, key = { it.title ?: "output-${it.lines.size}" }) { section ->
                            CommandOutputSectionCard(section)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun CommandMetaTag(
    label: String,
    value: String,
) {
    Surface(
        shape = RoundedCornerShape(999.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.65f),
    ) {
        Text(
            text = "$label: $value",
            style = MaterialTheme.typography.labelSmall.copy(fontFamily = monoFamily),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
        )
    }
}

@Composable
private fun CommandOutputSectionCard(section: CommandOutputSectionUi) {
    Surface(
        shape = RoundedCornerShape(18.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            section.title?.let { title ->
                Text(
                    text = title,
                    style = MaterialTheme.typography.labelMedium.copy(fontFamily = monoFamily),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Surface(
                shape = RoundedCornerShape(16.dp),
                color = MaterialTheme.colorScheme.surface.copy(alpha = 0.96f),
            ) {
                SelectionContainer {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .horizontalScroll(rememberScrollState())
                            .padding(horizontal = 12.dp, vertical = 10.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        section.lines.forEach { line ->
                            Text(
                                text = line.text.ifEmpty { " " },
                                style = MaterialTheme.typography.bodySmall.copy(fontFamily = monoFamily),
                                color = commandOutputLineColor(line.kind),
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun RichMessageText(
    text: String,
    textColor: Color,
    textStyle: androidx.compose.ui.text.TextStyle = MaterialTheme.typography.bodyLarge,
) {
    val segments = remember(text) { parseMarkdownSegments(text) }
    val linkColor = MaterialTheme.colorScheme.primary
    val pathColor = MaterialTheme.colorScheme.tertiary
    val inlineCodeBackground = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.8f)
    val pathBackground = MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.58f)
    SelectionContainer {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            segments.forEach { segment ->
                when (segment) {
                    is MarkdownSegmentUi.Prose -> {
                        parseMarkdownBlocks(segment.text).forEach { block ->
                            when (block) {
                                is MarkdownBlockUi.Paragraph -> {
                                    RichParagraphText(
                                        paragraph = block.text,
                                        textColor = textColor,
                                        style = textStyle,
                                        isHeading = false,
                                        linkColor = linkColor,
                                        pathColor = pathColor,
                                        inlineCodeBackground = inlineCodeBackground,
                                        pathBackground = pathBackground,
                                    )
                                }

                                is MarkdownBlockUi.Heading -> {
                                    val headingStyle = when (block.level) {
                                        1 -> textStyle.copy(fontWeight = FontWeight.Bold, color = textColor)
                                        2 -> textStyle.copy(fontWeight = FontWeight.SemiBold, color = textColor)
                                        else -> textStyle.copy(fontWeight = FontWeight.SemiBold, color = textColor)
                                    }
                                    RichParagraphText(
                                        paragraph = block.text,
                                        textColor = textColor,
                                        style = headingStyle,
                                        isHeading = true,
                                        linkColor = linkColor,
                                        pathColor = pathColor,
                                        inlineCodeBackground = inlineCodeBackground,
                                        pathBackground = pathBackground,
                                    )
                                }

                                is MarkdownBlockUi.ListBlock -> {
                                    Column(
                                        verticalArrangement = Arrangement.spacedBy(8.dp),
                                        modifier = Modifier.fillMaxWidth(),
                                    ) {
                                        block.items.forEachIndexed { index, item ->
                                            Row(
                                                horizontalArrangement = Arrangement.spacedBy(10.dp),
                                                verticalAlignment = Alignment.Top,
                                                modifier = Modifier.fillMaxWidth(),
                                            ) {
                                                Text(
                                                    text = if (block.ordered) {
                                                        "${block.startIndex + index}."
                                                    } else {
                                                        "•"
                                                    },
                                                    style = textStyle,
                                                    color = textColor.copy(alpha = 0.78f),
                                                    modifier = Modifier.padding(top = 1.dp),
                                                )
                                                RichParagraphText(
                                                    paragraph = item,
                                                    textColor = textColor,
                                                    style = textStyle,
                                                    isHeading = false,
                                                    linkColor = linkColor,
                                                    pathColor = pathColor,
                                                    inlineCodeBackground = inlineCodeBackground,
                                                    pathBackground = pathBackground,
                                                    modifier = Modifier.weight(1f),
                                                )
                                            }
                                        }
                                    }
                                }

                                is MarkdownBlockUi.Quote -> {
                                    Surface(
                                        shape = RoundedCornerShape(16.dp),
                                        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.46f),
                                    ) {
                                        Row(
                                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                                            verticalAlignment = Alignment.Top,
                                            modifier = Modifier
                                                .fillMaxWidth()
                                                .padding(horizontal = 12.dp, vertical = 12.dp),
                                        ) {
                                            Box(
                                                modifier = Modifier
                                                    .width(3.dp)
                                                    .height(24.dp)
                                                    .clip(RoundedCornerShape(999.dp))
                                                    .background(linkColor.copy(alpha = 0.7f)),
                                            )
                                            RichParagraphText(
                                                paragraph = block.text,
                                                textColor = textColor.copy(alpha = 0.92f),
                                                style = textStyle,
                                                isHeading = false,
                                                linkColor = linkColor,
                                                pathColor = pathColor,
                                                inlineCodeBackground = inlineCodeBackground,
                                                pathBackground = pathBackground,
                                                modifier = Modifier.weight(1f),
                                            )
                                        }
                                    }
                                }
                            }
                        }
                    }

                    is MarkdownSegmentUi.CodeBlock -> {
                        Surface(
                            shape = RoundedCornerShape(12.dp),
                            color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.7f),
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Column {
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.85f))
                                        .padding(horizontal = 12.dp, vertical = 6.dp),
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    Text(
                                        text = segment.language?.takeIf(String::isNotEmpty) ?: "text",
                                        style = MaterialTheme.typography.labelSmall.copy(fontFamily = monoFamily),
                                        color = textColor.copy(alpha = 0.72f),
                                    )
                                    val context = androidx.compose.ui.platform.LocalContext.current
                                    val clipboardManager = context.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                                    var copied by androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf(false) }
                                    androidx.compose.runtime.LaunchedEffect(copied) {
                                        if (copied) {
                                            kotlinx.coroutines.delay(1500)
                                            copied = false
                                        }
                                    }
                                    androidx.compose.material3.IconButton(
                                        onClick = {
                                            clipboardManager.setPrimaryClip(android.content.ClipData.newPlainText("code", segment.code.trimEnd()))
                                            copied = true
                                        },
                                        modifier = Modifier.size(24.dp)
                                    ) {
                                        Icon(
                                            imageVector = if (copied) Icons.Outlined.Check else Icons.Outlined.ContentCopy,
                                            contentDescription = "Copy code",
                                            modifier = Modifier.size(14.dp),
                                            tint = if (copied) androidx.compose.ui.graphics.Color.Green else textColor.copy(alpha = 0.72f)
                                        )
                                    }
                                }
                                Box(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .horizontalScroll(rememberScrollState())
                                ) {
                                    Text(
                                        text = segment.code.trimEnd(),
                                        style = MaterialTheme.typography.bodyMedium.copy(fontFamily = monoFamily),
                                        color = textColor,
                                        modifier = Modifier.padding(12.dp),
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun RichParagraphText(
    paragraph: String,
    textColor: Color,
    style: androidx.compose.ui.text.TextStyle,
    isHeading: Boolean,
    linkColor: Color,
    pathColor: Color,
    inlineCodeBackground: Color,
    pathBackground: Color,
    modifier: Modifier = Modifier,
) {
    val annotatedText = remember(
        paragraph,
        textColor,
        isHeading,
        linkColor,
        pathColor,
        inlineCodeBackground,
        pathBackground,
    ) {
        buildRichParagraph(
            paragraph = paragraph,
            textColor = textColor,
            isHeading = isHeading,
            linkColor = linkColor,
            pathColor = pathColor,
            inlineCodeBackground = inlineCodeBackground,
            pathBackground = pathBackground,
        )
    }
    Text(
        text = annotatedText,
        style = style.copy(color = textColor),
        modifier = modifier,
    )
}

@Composable
private fun AppBackdrop(
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier.background(
            brush = Brush.verticalGradient(
                colors = listOf(
                    MaterialTheme.colorScheme.background,
                    MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f),
                    MaterialTheme.colorScheme.background,
                ),
            ),
        ),
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .fillMaxHeight(0.34f)
                .background(
                    brush = Brush.radialGradient(
                        colors = listOf(
                            MaterialTheme.colorScheme.primary.copy(alpha = 0.10f),
                            Color.Transparent,
                        ),
                    ),
                ),
        )
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .fillMaxHeight()
                .padding(top = 220.dp)
                .background(
                    brush = Brush.radialGradient(
                        colors = listOf(
                            MaterialTheme.colorScheme.tertiary.copy(alpha = 0.08f),
                            Color.Transparent,
                        ),
                    ),
                ),
        )
    }
}

@Composable
private fun ApprovalCard(
    approval: com.remodex.android.data.model.ApprovalRequest,
    onApprove: () -> Unit,
    onDeny: () -> Unit,
) {
    GlassCard(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp),
        cornerRadius = 24.dp,
    ) {
        Text("Approval required", style = MaterialTheme.typography.titleSmall)
        Spacer(Modifier.height(6.dp))
        approval.command?.let {
            Text(it, style = MaterialTheme.typography.bodyLarge.copy(fontFamily = monoFamily))
            Spacer(Modifier.height(6.dp))
        }
        approval.reason?.let {
            Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(10.dp))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = onApprove) { Text("Approve") }
            OutlinedButton(onClick = onDeny) { Text("Deny") }
        }
    }
}



@Composable
private fun StatusPill(state: AppState) {
    Surface(
        shape = RoundedCornerShape(999.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.88f),
        modifier = Modifier.padding(end = 8.dp),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Box(
                modifier = Modifier
                    .size(7.dp)
                    .background(
                        when (state.connectionPhase) {
                            ConnectionPhase.CONNECTED -> CommandAccent
                            ConnectionPhase.CONNECTING, ConnectionPhase.LOADING_CHATS, ConnectionPhase.SYNCING -> PlanAccent
                            ConnectionPhase.OFFLINE -> MaterialTheme.colorScheme.outline
                        },
                        CircleShape,
                    ),
            )
            Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Text(
                    text = statusLabel(state.connectionPhase),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                Text(
                    text = state.secureConnectionState.statusLabel,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
internal fun GlassCard(
    modifier: Modifier = Modifier,
    cornerRadius: androidx.compose.ui.unit.Dp = 20.dp,
    content: @Composable ColumnScope.() -> Unit,
) {
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(cornerRadius),
        color = MaterialTheme.colorScheme.surface.copy(alpha = 0.82f),
        border = androidx.compose.foundation.BorderStroke(1.dp, Border),
        tonalElevation = 1.dp,
        shadowElevation = 2.dp,
    ) {
        Column(
            modifier = Modifier
                .background(
                    brush = Brush.verticalGradient(
                        colors = listOf(
                            MaterialTheme.colorScheme.surface.copy(alpha = 0.98f),
                            MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.35f),
                        ),
                    ),
                )
                .padding(16.dp),
            content = content,
        )
    }
}

internal fun statusLabel(phase: ConnectionPhase): String {
    return when (phase) {
        ConnectionPhase.CONNECTING -> "Connecting"
        ConnectionPhase.LOADING_CHATS -> "Loading chats"
        ConnectionPhase.SYNCING -> "Syncing"
        ConnectionPhase.CONNECTED -> "Connected"
        ConnectionPhase.OFFLINE -> "Offline"
    }
}

private fun systemMessageTitle(kind: MessageKind): String {
    return when (kind) {
        MessageKind.THINKING -> "Thinking"
        MessageKind.FILE_CHANGE -> "File change"
        MessageKind.COMMAND_EXECUTION -> "Command"
        MessageKind.PLAN -> "Plan"
        MessageKind.USER_INPUT_PROMPT -> "Input needed"
        MessageKind.CHAT -> "System"
    }
}

@Composable
private fun systemAccentColor(kind: MessageKind): Color {
    return when (kind) {
        MessageKind.THINKING, MessageKind.PLAN -> PlanAccent
        MessageKind.COMMAND_EXECUTION -> CommandAccent
        MessageKind.FILE_CHANGE -> MaterialTheme.colorScheme.secondary
        MessageKind.USER_INPUT_PROMPT -> MaterialTheme.colorScheme.tertiary
        MessageKind.CHAT -> MaterialTheme.colorScheme.outline
    }
}

@Composable
private fun fileChangeAccentColor(actionLabel: String): Color {
    return when (actionLabel) {
        "Added" -> CommandAccent
        "Deleted" -> Danger
        "Moved" -> MaterialTheme.colorScheme.tertiary
        else -> MaterialTheme.colorScheme.secondary
    }
}

@Composable
private fun diffLineColor(kind: DiffLineKind): Color {
    return when (kind) {
        DiffLineKind.ADDED -> CommandAccent
        DiffLineKind.REMOVED -> Danger
        DiffLineKind.CONTEXT -> MaterialTheme.colorScheme.onSurface
        DiffLineKind.META -> MaterialTheme.colorScheme.onSurfaceVariant
    }
}

@Composable
private fun commandStatusAccentColor(statusLabel: String): Color {
    return when (statusLabel) {
        "Needs attention" -> Danger
        else -> CommandAccent
    }
}

@Composable
private fun planStatusAccentColor(statusLabel: String): Color {
    return when (statusLabel) {
        "Completed" -> CommandAccent
        "In progress" -> PlanAccent
        else -> MaterialTheme.colorScheme.outline
    }
}

@Composable
private fun commandOutputLineColor(kind: CommandOutputLineKind): Color {
    return when (kind) {
        CommandOutputLineKind.ERROR -> Danger
        CommandOutputLineKind.WARNING -> MaterialTheme.colorScheme.tertiary
        CommandOutputLineKind.META -> MaterialTheme.colorScheme.onSurfaceVariant
        CommandOutputLineKind.STANDARD -> MaterialTheme.colorScheme.onSurface
    }
}

internal fun relativeTimeLabel(timestamp: Long?): String? {
    val value = timestamp ?: return null
    if (value <= 0L) {
        return null
    }
    val deltaSeconds = ((System.currentTimeMillis() - value) / 1_000L).coerceAtLeast(0L)
    return when {
        deltaSeconds < 60L -> "now"
        deltaSeconds < 3_600L -> "${deltaSeconds / 60L}m"
        deltaSeconds < 86_400L -> "${deltaSeconds / 3_600L}h"
        deltaSeconds < 604_800L -> "${deltaSeconds / 86_400L}d"
        else -> "${deltaSeconds / 604_800L}w"
    }
}

private data class FileChangeEntryUi(
    val path: String,
    val actionLabel: String,
    val additions: Int,
    val deletions: Int,
)

private data class DiffFileDetailUi(
    val path: String,
    val actionLabel: String,
    val additions: Int,
    val deletions: Int,
    val hunks: List<DiffHunkUi>,
    val rawBody: String,
)

private data class DiffHunkUi(
    val header: String?,
    val lines: List<DiffLineUi>,
)

private data class DiffLineUi(
    val text: String,
    val kind: DiffLineKind,
)

private enum class DiffLineKind {
    ADDED,
    REMOVED,
    CONTEXT,
    META,
}

private class MutableFileChangeEntry(
    var path: String,
    var actionLabel: String,
    var additions: Int = 0,
    var deletions: Int = 0,
)

private class MutableDiffFileDetail(
    var path: String,
    var actionLabel: String,
    val rawLines: MutableList<String> = mutableListOf(),
)

private fun parseFileChangeEntries(text: String): List<FileChangeEntryUi> {
    val lines = text.lines()
    val entries = linkedMapOf<String, MutableFileChangeEntry>()
    var currentKey: String? = null

    fun upsert(path: String, actionLabel: String) {
        val normalizedPath = path.trim().removePrefix("a/").removePrefix("b/")
        if (normalizedPath.isEmpty()) {
            return
        }
        val existing = entries[normalizedPath]
        if (existing == null) {
            entries[normalizedPath] = MutableFileChangeEntry(
                path = normalizedPath,
                actionLabel = actionLabel,
            )
        } else if (existing.actionLabel == "Changed" && actionLabel != "Changed") {
            existing.actionLabel = actionLabel
        }
        currentKey = normalizedPath
    }

    lines.forEach { rawLine ->
        val line = rawLine.trimEnd()
        when {
            line.startsWith("*** Add File: ") -> upsert(line.removePrefix("*** Add File: "), "Added")
            line.startsWith("*** Update File: ") -> upsert(line.removePrefix("*** Update File: "), "Updated")
            line.startsWith("*** Delete File: ") -> upsert(line.removePrefix("*** Delete File: "), "Deleted")
            line.startsWith("*** Move to: ") -> {
                val movedTo = line.removePrefix("*** Move to: ").trim()
                val previousKey = currentKey
                if (!previousKey.isNullOrBlank()) {
                    val previous = entries.remove(previousKey)
                    if (previous != null) {
                        previous.path = movedTo
                        previous.actionLabel = "Moved"
                        entries[movedTo] = previous
                    } else {
                        upsert(movedTo, "Moved")
                    }
                    currentKey = movedTo
                } else {
                    upsert(movedTo, "Moved")
                }
            }

            line.startsWith("diff --git ") -> {
                val match = Regex("""diff --git a/(.+) b/(.+)""").find(line)
                val path = match?.groupValues?.getOrNull(2)
                if (path != null) {
                    upsert(path, "Changed")
                }
            }

            line.startsWith("+++ b/") -> upsert(line.removePrefix("+++ b/"), "Changed")
            line.startsWith("Added ") || line.startsWith("Updated ") || line.startsWith("Modified ") ||
                line.startsWith("Deleted ") || line.startsWith("Created ") || line.startsWith("Renamed ") -> {
                val parts = line.split(' ', limit = 2)
                val action = parts.firstOrNull().orEmpty()
                val path = parts.getOrNull(1)?.substringBefore(" (+")?.substringBefore(" (-")?.trim().orEmpty()
                val normalizedAction = when (action) {
                    "Modified" -> "Updated"
                    "Created" -> "Added"
                    "Renamed" -> "Moved"
                    else -> action
                }
                upsert(path, normalizedAction)
            }

            currentKey != null && line.startsWith("+") && !line.startsWith("+++") -> {
                entries[currentKey]?.additions = (entries[currentKey]?.additions ?: 0) + 1
            }

            currentKey != null && line.startsWith("-") && !line.startsWith("---") -> {
                entries[currentKey]?.deletions = (entries[currentKey]?.deletions ?: 0) + 1
            }
        }
    }

    return entries.values.map { entry ->
        FileChangeEntryUi(
            path = entry.path,
            actionLabel = entry.actionLabel,
            additions = entry.additions,
            deletions = entry.deletions,
        )
    }
}

private fun fileChangeActionLabel(kind: String): String {
    return when (kind.trim().lowercase()) {
        "create", "created", "add", "added" -> "Added"
        "delete", "deleted", "remove", "removed" -> "Deleted"
        "rename", "renamed", "move", "moved" -> "Moved"
        else -> "Updated"
    }
}

private fun buildDiffDetailFiles(message: ChatMessage): List<DiffFileDetailUi> {
    if (message.fileChanges.isNotEmpty()) {
        return message.fileChanges.map { change ->
            val hunks = parseDiffHunks(change.diff)
            DiffFileDetailUi(
                path = change.path,
                actionLabel = fileChangeActionLabel(change.kind),
                additions = change.additions ?: countDiffLines(hunks, DiffLineKind.ADDED),
                deletions = change.deletions ?: countDiffLines(hunks, DiffLineKind.REMOVED),
                hunks = hunks,
                rawBody = change.diff.trim(),
            )
        }
    }
    return parseDiffDetailFiles(message.text)
}

private fun parseDiffDetailFiles(text: String): List<DiffFileDetailUi> {
    val lines = text.lines()
    val files = mutableListOf<MutableDiffFileDetail>()
    var current: MutableDiffFileDetail? = null

    fun flushCurrent() {
        current?.let(files::add)
        current = null
    }

    fun startFile(path: String, actionLabel: String) {
        flushCurrent()
        current = MutableDiffFileDetail(
            path = path.trim().removePrefix("a/").removePrefix("b/"),
            actionLabel = actionLabel,
        )
    }

    lines.forEach { rawLine ->
        val line = rawLine.trimEnd()
        when {
            line.startsWith("*** Add File: ") -> {
                startFile(line.removePrefix("*** Add File: "), "Added")
                current?.rawLines?.add(line)
            }

            line.startsWith("*** Update File: ") -> {
                startFile(line.removePrefix("*** Update File: "), "Updated")
                current?.rawLines?.add(line)
            }

            line.startsWith("*** Delete File: ") -> {
                startFile(line.removePrefix("*** Delete File: "), "Deleted")
                current?.rawLines?.add(line)
            }

            line.startsWith("*** Move to: ") -> {
                if (current == null) {
                    startFile(line.removePrefix("*** Move to: "), "Moved")
                } else {
                    current?.path = line.removePrefix("*** Move to: ").trim()
                    current?.actionLabel = "Moved"
                }
                current?.rawLines?.add(line)
            }

            line.startsWith("diff --git ") -> {
                val match = Regex("""diff --git a/(.+) b/(.+)""").find(line)
                val path = match?.groupValues?.getOrNull(2)
                if (path != null) {
                    startFile(path, "Updated")
                    current?.rawLines?.add(line)
                }
            }

            line.startsWith("+++ b/") && current == null -> {
                startFile(line.removePrefix("+++ b/"), "Updated")
                current?.rawLines?.add(line)
            }

            else -> {
                current?.rawLines?.add(line)
            }
        }
    }
    flushCurrent()

    if (files.isEmpty()) {
        return parseFileChangeEntries(text).map { entry ->
            DiffFileDetailUi(
                path = entry.path,
                actionLabel = entry.actionLabel,
                additions = entry.additions,
                deletions = entry.deletions,
                hunks = emptyList(),
                rawBody = "",
            )
        }
    }

    return files.map { file ->
        val rawBody = file.rawLines.joinToString("\n").trim()
        val hunks = parseDiffHunks(rawBody)
        DiffFileDetailUi(
            path = file.path,
            actionLabel = file.actionLabel,
            additions = countDiffLines(hunks, DiffLineKind.ADDED),
            deletions = countDiffLines(hunks, DiffLineKind.REMOVED),
            hunks = hunks,
            rawBody = rawBody,
        )
    }
}

private fun parseDiffHunks(rawBody: String): List<DiffHunkUi> {
    val lines = rawBody.lines().map(String::trimEnd).filterNot { it.isBlank() }
    if (lines.isEmpty()) {
        return emptyList()
    }

    val hunks = mutableListOf<DiffHunkUi>()
    var currentHeader: String? = null
    var currentLines = mutableListOf<DiffLineUi>()
    var pendingMeta = mutableListOf<DiffLineUi>()

    fun flushCurrent() {
        if (currentHeader != null || currentLines.isNotEmpty()) {
            hunks += DiffHunkUi(
                header = currentHeader,
                lines = currentLines.toList(),
            )
            currentHeader = null
            currentLines = mutableListOf()
        }
    }

    lines.forEach { line ->
        when {
            line.startsWith("@@") -> {
                if (pendingMeta.isNotEmpty()) {
                    hunks += DiffHunkUi(header = null, lines = pendingMeta.toList())
                    pendingMeta = mutableListOf()
                }
                flushCurrent()
                currentHeader = line
            }

            currentHeader == null && isDiffMetaLine(line) -> {
                pendingMeta += DiffLineUi(text = line, kind = DiffLineKind.META)
            }

            else -> {
                currentLines += DiffLineUi(
                    text = line,
                    kind = classifyDiffLine(line),
                )
            }
        }
    }

    if (pendingMeta.isNotEmpty()) {
        hunks += DiffHunkUi(header = null, lines = pendingMeta.toList())
    }
    flushCurrent()

    return if (hunks.isEmpty()) {
        listOf(
            DiffHunkUi(
                header = null,
                lines = lines.map { DiffLineUi(text = it, kind = classifyDiffLine(it)) },
            ),
        )
    } else {
        hunks
    }
}

private fun isDiffMetaLine(line: String): Boolean {
    return line.startsWith("diff --git ") ||
        line.startsWith("index ") ||
        line.startsWith("--- ") ||
        line.startsWith("+++ ") ||
        line.startsWith("*** Add File: ") ||
        line.startsWith("*** Update File: ") ||
        line.startsWith("*** Delete File: ") ||
        line.startsWith("*** Move to: ") ||
        line.startsWith("Binary files ")
}

private fun classifyDiffLine(line: String): DiffLineKind {
    return when {
        line.startsWith("+") && !line.startsWith("+++") -> DiffLineKind.ADDED
        line.startsWith("-") && !line.startsWith("---") -> DiffLineKind.REMOVED
        line.startsWith(" ") -> DiffLineKind.CONTEXT
        else -> DiffLineKind.META
    }
}

private fun countDiffLines(hunks: List<DiffHunkUi>, kind: DiffLineKind): Int {
    return hunks.sumOf { hunk -> hunk.lines.count { it.kind == kind } }
}

private fun buildDiffDetailText(message: ChatMessage): String {
    if (message.fileChanges.isNotEmpty()) {
        return message.fileChanges.joinToString("\n\n") { change ->
            buildString {
                append(fileChangeActionLabel(change.kind))
                append(" ")
                append(change.path)
                if (change.additions != null || change.deletions != null) {
                    append("  (+")
                    append(change.additions ?: 0)
                    append(" -")
                    append(change.deletions ?: 0)
                    append(")")
                }
                if (change.diff.isNotBlank()) {
                    append("\n\n")
                    append(change.diff.trim())
                }
            }
        }
    }
    return message.text.trim()
}

private fun buildCommandOutputDetailText(message: ChatMessage): String {
    val commandState = message.commandState
    if (commandState == null) {
        return message.text.trim()
    }
    return buildString {
        append(commandState.phase.statusLabel)
        append(" ")
        append(commandState.fullCommand)
        commandState.cwd?.let {
            append("\n\ncwd: ")
            append(it)
        }
        commandState.exitCode?.let {
            append("\nexit code: ")
            append(it)
        }
        commandState.durationMs?.let {
            append("\nduration: ")
            append(it)
            append("ms")
        }
        if (commandState.outputTail.isNotBlank()) {
            append("\n\n")
            append(commandState.outputTail.trim())
        }
    }
}

private fun buildCommandDetail(
    message: ChatMessage,
    preview: CommandPreviewUi,
): CommandDetailUi {
    val commandState = message.commandState
    val fallbackBody = buildCommandOutputDetailText(message)
    if (commandState == null) {
        val lines = message.text
            .trim()
            .lines()
            .map { line ->
                CommandOutputLineUi(
                    text = line,
                    kind = classifyCommandOutputLine(line),
                )
            }
        return CommandDetailUi(
            command = preview.command,
            statusLabel = preview.statusLabel,
            cwd = null,
            exitCode = null,
            durationMs = null,
            outputSections = listOf(
                CommandOutputSectionUi(
                    title = "Output",
                    lines = lines,
                ),
            ).filter { it.lines.isNotEmpty() },
            fallbackBody = fallbackBody,
        )
    }

    val outputSections = buildList {
        commandState.outputTail
            .trimEnd()
            .takeIf(String::isNotEmpty)
            ?.let { output ->
                add(
                    CommandOutputSectionUi(
                        title = if (commandState.phase == CommandPhase.RUNNING) "Live output" else "Output",
                        lines = output.lines().map { line ->
                            CommandOutputLineUi(
                                text = line,
                                kind = classifyCommandOutputLine(line),
                            )
                        },
                    ),
                )
            }
    }

    return CommandDetailUi(
        command = commandState.fullCommand,
        statusLabel = commandState.phase.statusLabel,
        cwd = commandState.cwd,
        exitCode = commandState.exitCode,
        durationMs = commandState.durationMs,
        outputSections = outputSections,
        fallbackBody = fallbackBody,
    )
}

private fun classifyCommandOutputLine(line: String): CommandOutputLineKind {
    val trimmed = line.trim()
    if (trimmed.isEmpty()) {
        return CommandOutputLineKind.STANDARD
    }
    val lowered = trimmed.lowercase()
    return when {
        trimmed.startsWith("$") || trimmed.startsWith(">") || trimmed.startsWith("#") -> CommandOutputLineKind.META
        lowered.contains("error") || lowered.contains("failed") || lowered.contains("exception") -> CommandOutputLineKind.ERROR
        lowered.contains("warn") -> CommandOutputLineKind.WARNING
        trimmed.startsWith("cwd:") || trimmed.startsWith("exit code:") || trimmed.startsWith("duration:") -> CommandOutputLineKind.META
        else -> CommandOutputLineKind.STANDARD
    }
}

private data class ThinkingSectionUi(
    val id: String,
    val title: String,
    val detail: String,
)

private data class ThinkingContentUi(
    val sections: List<ThinkingSectionUi>,
    val fallbackText: String,
)

private fun parseThinkingDisclosure(rawText: String): ThinkingContentUi {
    val normalized = normalizeThinkingContent(rawText)
    if (normalized.isBlank()) {
        return ThinkingContentUi(sections = emptyList(), fallbackText = "")
    }

    val lines = normalized.split('\n')
    val sections = mutableListOf<ThinkingSectionUi>()
    val preambleLines = mutableListOf<String>()
    var currentTitle: String? = null
    var currentDetailLines = mutableListOf<String>()

    fun flushCurrentSection() {
        val title = currentTitle ?: return
        val detail = currentDetailLines.joinToString("\n").trim()
        sections += ThinkingSectionUi(
            id = "${sections.size}-$title",
            title = title,
            detail = detail,
        )
        currentDetailLines = mutableListOf()
    }

    lines.forEach { line ->
        val summaryTitle = extractThinkingSummaryTitle(line)
        if (summaryTitle != null) {
            flushCurrentSection()
            currentTitle = summaryTitle
        } else if (currentTitle == null) {
            preambleLines += line
        } else {
            currentDetailLines += line
        }
    }
    flushCurrentSection()

    if (sections.isEmpty()) {
        return ThinkingContentUi(sections = emptyList(), fallbackText = normalized)
    }

    val preamble = preambleLines.joinToString("\n").trim()
    val normalizedSections = sections.toMutableList()
    if (preamble.isNotBlank()) {
        val first = normalizedSections.first()
        normalizedSections[0] = first.copy(
            detail = listOf(preamble, first.detail).filter(String::isNotBlank).joinToString("\n\n"),
        )
    }

    return ThinkingContentUi(
        sections = coalesceThinkingSections(normalizedSections),
        fallbackText = normalized,
    )
}

private fun normalizeThinkingContent(rawText: String): String {
    val trimmed = rawText.trim()
    if (trimmed.isBlank()) {
        return ""
    }
    val lowered = trimmed.lowercase()
    return when {
        lowered.startsWith("thinking...") -> trimmed.drop("thinking...".length).trim()
        lowered == "thinking" -> ""
        else -> trimmed
    }
}

private fun extractThinkingSummaryTitle(line: String): String? {
    val match = Regex("""^\s*\*\*(.+?)\*\*\s*$""").matchEntire(line) ?: return null
    return match.groupValues[1].trim().takeIf(String::isNotEmpty)
}

private fun coalesceThinkingSections(sections: List<ThinkingSectionUi>): List<ThinkingSectionUi> {
    val collapsed = mutableListOf<ThinkingSectionUi>()
    sections.forEach { section ->
        val previous = collapsed.lastOrNull()
        if (previous != null && previous.title == section.title) {
            val mergedDetail = when {
                previous.detail == section.detail || section.detail.isBlank() -> previous.detail
                previous.detail.isBlank() || section.detail.contains(previous.detail) -> section.detail
                previous.detail.contains(section.detail) -> previous.detail
                else -> listOf(previous.detail, section.detail).joinToString("\n\n")
            }
            collapsed[collapsed.lastIndex] = previous.copy(detail = mergedDetail)
        } else {
            collapsed += section
        }
    }
    return collapsed
}

private data class FileChangeGroupUi(
    val actionLabel: String,
    val entries: List<FileChangeEntryUi>,
)

private fun groupFileChangeEntries(entries: List<FileChangeEntryUi>): List<FileChangeGroupUi> {
    val order = mutableListOf<String>()
    val grouped = linkedMapOf<String, MutableList<FileChangeEntryUi>>()
    entries.forEach { entry ->
        if (grouped[entry.actionLabel] == null) {
            order += entry.actionLabel
            grouped[entry.actionLabel] = mutableListOf()
        }
        grouped.getValue(entry.actionLabel) += entry
    }
    return order.map { key -> FileChangeGroupUi(actionLabel = key, entries = grouped.getValue(key)) }
}

private fun projectTimelineMessages(messages: List<ChatMessage>): List<ChatMessage> {
    val reordered = enforceIntraTurnOrder(messages)
    val collapsedThinking = collapseConsecutiveThinkingMessages(reordered)
    val dedupedFileChanges = removeDuplicateFileChangeMessages(collapsedThinking)
    return removeDuplicateAssistantMessages(dedupedFileChanges)
}

private sealed interface TimelineRenderItem {
    val key: String

    data class Message(val message: ChatMessage) : TimelineRenderItem {
        override val key: String = "message:${message.id}"
    }

    data class TurnSection(
        val turnId: String,
        val messages: List<ChatMessage>,
    ) : TimelineRenderItem {
        override val key: String = buildString {
            append("turn:")
            append(turnId)
            append(':')
            append(messages.firstOrNull()?.id)
            append(':')
            append(messages.lastOrNull()?.id)
        }
    }
}

private data class TurnSectionLabelUi(
    val text: String,
    val kind: MessageKind? = null,
    val isAssistantReply: Boolean = false,
)

private data class TurnSectionSummaryUi(
    val statusLabel: String,
    val detail: String,
)

private data class CollapsedTurnPreviewUi(
    val title: String,
    val body: String,
)

private enum class ReplyPresentation {
    DRAFT,
    FINAL,
}

private fun buildTimelineRenderItems(messages: List<ChatMessage>): List<TimelineRenderItem> {
    if (messages.isEmpty()) {
        return emptyList()
    }
    val items = mutableListOf<TimelineRenderItem>()
    var index = 0
    while (index < messages.size) {
        val message = messages[index]
        val turnId = normalizedIdentifier(message.turnId)
        if (message.role == MessageRole.USER || turnId == null) {
            items += TimelineRenderItem.Message(message)
            index += 1
            continue
        }

        val sectionMessages = mutableListOf<ChatMessage>()
        var cursor = index
        while (cursor < messages.size) {
            val candidate = messages[cursor]
            if (candidate.role == MessageRole.USER || normalizedIdentifier(candidate.turnId) != turnId) {
                break
            }
            sectionMessages += candidate
            cursor += 1
        }

        if (sectionMessages.size <= 1) {
            items += TimelineRenderItem.Message(message)
            index += 1
        } else {
            items += TimelineRenderItem.TurnSection(turnId = turnId, messages = sectionMessages)
            index = cursor
        }
    }
    return items
}

private fun buildTurnSectionLabels(messages: List<ChatMessage>): List<TurnSectionLabelUi> {
    val labels = mutableListOf<TurnSectionLabelUi>()
    val seen = mutableSetOf<String>()
    messages.forEach { message ->
        val label = when {
            message.role == MessageRole.ASSISTANT && message.kind == MessageKind.CHAT ->
                TurnSectionLabelUi(text = "Reply", isAssistantReply = true)

            message.role == MessageRole.SYSTEM ->
                TurnSectionLabelUi(
                    text = systemMessageTitle(message.kind),
                    kind = message.kind,
                )

            else -> null
        } ?: return@forEach
        val key = "${label.text}:${label.kind}:${label.isAssistantReply}"
        if (seen.add(key)) {
            labels += label
        }
    }
    return labels
}

private fun buildTurnSectionSummary(messages: List<ChatMessage>): TurnSectionSummaryUi {
    val statusLabel = when {
        messages.any(ChatMessage::isStreaming) -> "Running"
        messages.any { it.kind == MessageKind.USER_INPUT_PROMPT } -> "Input needed"
        messages.any { it.commandState?.phase == CommandPhase.FAILED } -> "Needs attention"
        messages.any { it.commandState?.phase == CommandPhase.STOPPED } -> "Stopped"
        else -> "Completed"
    }
    val lastTimestamp = messages.maxOfOrNull(ChatMessage::createdAt)
    val relativeTime = relativeTimeLabel(lastTimestamp)
    val systemCount = messages.count { it.role == MessageRole.SYSTEM }
    val assistantCount = messages.count { it.role == MessageRole.ASSISTANT }
    val detailParts = buildList {
        add("${messages.size} items")
        if (systemCount > 0) {
            add("$systemCount updates")
        }
        if (assistantCount > 0) {
            add("$assistantCount replies")
        }
        relativeTime?.let(::add)
    }
    return TurnSectionSummaryUi(
        statusLabel = statusLabel,
        detail = detailParts.joinToString(" · "),
    )
}

private fun buildCollapsedTurnMessages(messages: List<ChatMessage>): List<ChatMessage> {
    if (messages.size <= 2) {
        return messages
    }
    val preserved = linkedMapOf<String, ChatMessage>()
    messages.lastOrNull()?.let { preserved[it.id] = it }
    messages
        .lastOrNull { it.role == MessageRole.ASSISTANT && it.kind == MessageKind.CHAT }
        ?.let { preserved[it.id] = it }
    return messages.filter { preserved.containsKey(it.id) }
}

private fun buildCollapsedTurnPreview(messages: List<ChatMessage>): CollapsedTurnPreviewUi? {
    val assistantReply = messages.lastOrNull { it.role == MessageRole.ASSISTANT && it.kind == MessageKind.CHAT }
    if (assistantReply != null && assistantReply.text.isNotBlank()) {
        return CollapsedTurnPreviewUi(
            title = if (assistantReply.isStreaming) "Draft reply" else "Final reply",
            body = assistantReply.text.trim(),
        )
    }
    val latestSystem = messages.lastOrNull { it.role == MessageRole.SYSTEM && it.text.isNotBlank() } ?: return null
    return CollapsedTurnPreviewUi(
        title = systemMessageTitle(latestSystem.kind),
        body = latestSystem.text.trim(),
    )
}

private fun enforceIntraTurnOrder(messages: List<ChatMessage>): List<ChatMessage> {
    val indicesByTurn = mutableMapOf<String, MutableList<Int>>()
    messages.forEachIndexed { index, message ->
        val turnId = normalizedIdentifier(message.turnId) ?: return@forEachIndexed
        indicesByTurn.getOrPut(turnId) { mutableListOf() } += index
    }

    val result = messages.toMutableList()
    indicesByTurn.values.forEach { indices ->
        if (indices.size <= 1) {
            return@forEach
        }
        val turnMessages = indices.map { result[it] }
        val sorted = if (hasInterleavedAssistantThinkingFlow(turnMessages)) {
            turnMessages.sortedWith(
                compareBy<ChatMessage> { it.role != MessageRole.USER }
                    .thenBy(ChatMessage::orderIndex),
            )
        } else {
            turnMessages.sortedWith(
                compareBy<ChatMessage> { intraTurnPriority(it) }
                    .thenBy(ChatMessage::orderIndex),
            )
        }
        indices.forEachIndexed { order, originalIndex ->
            result[originalIndex] = sorted[order]
        }
    }
    return result
}

private fun hasInterleavedAssistantThinkingFlow(messages: List<ChatMessage>): Boolean {
    val assistantItemIds = messages
        .filter { it.role == MessageRole.ASSISTANT }
        .mapNotNull { normalizedIdentifier(it.itemId) }
        .toSet()
    if (assistantItemIds.size > 1) {
        return true
    }

    var hasThinkingBeforeAssistant = false
    var seenAssistant = false
    messages.sortedBy(ChatMessage::orderIndex).forEach { message ->
        if (message.role == MessageRole.ASSISTANT) {
            seenAssistant = true
        } else if (message.role == MessageRole.SYSTEM && message.kind == MessageKind.THINKING) {
            if (!seenAssistant) {
                hasThinkingBeforeAssistant = true
            } else if (hasThinkingBeforeAssistant) {
                return true
            }
        }
    }
    return false
}

private fun intraTurnPriority(message: ChatMessage): Int {
    return when (message.role) {
        MessageRole.USER -> 0
        MessageRole.SYSTEM -> when (message.kind) {
            MessageKind.THINKING -> 1
            MessageKind.COMMAND_EXECUTION -> 2
            MessageKind.CHAT, MessageKind.PLAN -> 3
            MessageKind.FILE_CHANGE -> 5
            MessageKind.USER_INPUT_PROMPT -> 6
        }

        MessageRole.ASSISTANT -> 4
    }
}

private fun collapseConsecutiveThinkingMessages(messages: List<ChatMessage>): List<ChatMessage> {
    val result = mutableListOf<ChatMessage>()
    messages.forEach { message ->
        if (message.role != MessageRole.SYSTEM || message.kind != MessageKind.THINKING) {
            result += message
            return@forEach
        }

        val previous = result.lastOrNull()
        if (previous == null ||
            previous.role != MessageRole.SYSTEM ||
            previous.kind != MessageKind.THINKING ||
            !shouldMergeThinkingRows(previous, message)
        ) {
            result += message
            return@forEach
        }

        val mergedText = mergeThinkingText(previous.text, message.text)
        result[result.lastIndex] = previous.copy(
            text = mergedText,
            isStreaming = message.isStreaming,
            turnId = message.turnId ?: previous.turnId,
            itemId = message.itemId ?: previous.itemId,
        )
    }
    return result
}

private fun shouldMergeThinkingRows(previous: ChatMessage, incoming: ChatMessage): Boolean {
    val previousItemId = normalizedIdentifier(previous.itemId)
    val incomingItemId = normalizedIdentifier(incoming.itemId)
    if (previousItemId != null && incomingItemId != null) {
        return previousItemId == incomingItemId
    }
    if (previousItemId != null || incomingItemId != null) {
        return false
    }
    val previousTurnId = normalizedIdentifier(previous.turnId)
    val incomingTurnId = normalizedIdentifier(incoming.turnId)
    return previousTurnId != null && previousTurnId == incomingTurnId
}

private fun mergeThinkingText(existing: String, incoming: String): String {
    val existingTrimmed = existing.trim()
    val incomingTrimmed = incoming.trim()
    if (incomingTrimmed.isEmpty()) {
        return existingTrimmed
    }
    if (existingTrimmed.isEmpty()) {
        return incomingTrimmed
    }
    val placeholders = setOf("thinking...")
    val existingLower = existingTrimmed.lowercase()
    val incomingLower = incomingTrimmed.lowercase()
    if (incomingLower in placeholders) {
        return existingTrimmed
    }
    if (existingLower in placeholders) {
        return incomingTrimmed
    }
    if (incomingLower == existingLower) {
        return incomingTrimmed
    }
    if (incomingTrimmed.contains(existingTrimmed)) {
        return incomingTrimmed
    }
    if (existingTrimmed.contains(incomingTrimmed)) {
        return existingTrimmed
    }
    return "$existingTrimmed\n$incomingTrimmed"
}

private fun removeDuplicateAssistantMessages(messages: List<ChatMessage>): List<ChatMessage> {
    val seenTurnScoped = mutableSetOf<String>()
    val seenNoTurnByText = mutableMapOf<String, Long>()
    val result = mutableListOf<ChatMessage>()
    messages.forEach { message ->
        if (message.role != MessageRole.ASSISTANT) {
            result += message
            return@forEach
        }
        val normalizedText = message.text.trim()
        if (normalizedText.isEmpty()) {
            result += message
            return@forEach
        }
        val turnId = normalizedIdentifier(message.turnId)
        if (turnId != null) {
            val itemScope = normalizedIdentifier(message.itemId) ?: "no-item"
            val key = "$turnId|$itemScope|$normalizedText"
            if (seenTurnScoped.add(key)) {
                result += message
            }
            return@forEach
        }
        val previousTimestamp = seenNoTurnByText[normalizedText]
        if (previousTimestamp != null && kotlin.math.abs(message.createdAt - previousTimestamp) <= 12_000L) {
            return@forEach
        }
        seenNoTurnByText[normalizedText] = message.createdAt
        result += message
    }
    return result
}

private fun removeDuplicateFileChangeMessages(messages: List<ChatMessage>): List<ChatMessage> {
    val latestIndexByKey = mutableMapOf<String, Int>()
    messages.forEachIndexed { index, message ->
        val key = duplicateFileChangeKey(message) ?: return@forEachIndexed
        latestIndexByKey[key] = index
    }
    return messages.filterIndexed { index, message ->
        val key = duplicateFileChangeKey(message) ?: return@filterIndexed true
        latestIndexByKey[key] == index
    }
}

private fun duplicateFileChangeKey(message: ChatMessage): String? {
    if (message.role != MessageRole.SYSTEM || message.kind != MessageKind.FILE_CHANGE) {
        return null
    }
    val normalizedText = message.text.trim()
    val turnId = normalizedIdentifier(message.turnId) ?: return null
    if (normalizedText.isEmpty()) {
        return null
    }
    return "$turnId|$normalizedText"
}

private fun normalizedIdentifier(value: String?): String? {
    val trimmed = value?.trim().orEmpty()
    return trimmed.ifEmpty { null }
}

private sealed interface MarkdownSegmentUi {
    data class Prose(val text: String) : MarkdownSegmentUi
    data class CodeBlock(val language: String?, val code: String) : MarkdownSegmentUi
}

private sealed interface MarkdownBlockUi {
    data class Paragraph(val text: String) : MarkdownBlockUi
    data class Heading(val level: Int, val text: String) : MarkdownBlockUi
    data class Quote(val text: String) : MarkdownBlockUi
    data class ListBlock(
        val items: List<String>,
        val ordered: Boolean,
        val startIndex: Int = 1,
    ) : MarkdownBlockUi
}

private fun buildRichParagraph(
    paragraph: String,
    textColor: Color,
    isHeading: Boolean,
    linkColor: Color,
    pathColor: Color,
    inlineCodeBackground: Color,
    pathBackground: Color,
): AnnotatedString {
    val source = paragraph.trim()
    return buildAnnotatedString {
        val tokenRegex = Regex(
            """(\[[^\]]+]\((?:https?://[^)\s]+|/[^)\s]+)\)|https?://[^\s)]+|`[^`]+`|/[\w.\-@/]+(?:[:#]L?\d+(?::\d+|C\d+)?)?|@[A-Za-z0-9_.\-/]+|#[a-z0-9\-]+)""",
        )
        var lastIndex = 0
        tokenRegex.findAll(source).forEach { match ->
            if (match.range.first > lastIndex) {
                appendStyledInlineText(
                    value = source.substring(lastIndex, match.range.first),
                    textColor = textColor,
                    heading = isHeading,
                )
            }
            val token = match.value
            when {
                token.startsWith("[") && token.contains("](") -> {
                    val linkMatch = Regex("""\[([^\]]+)]\(([^)]+)\)""").matchEntire(token)
                    val label = linkMatch?.groupValues?.getOrNull(1).orEmpty()
                    val target = linkMatch?.groupValues?.getOrNull(2).orEmpty()
                    val isLocalPath = target.startsWith("/")
                    pushStyle(
                        SpanStyle(
                            color = if (isLocalPath) pathColor else linkColor,
                            textDecoration = if (isLocalPath) null else TextDecoration.Underline,
                            fontFamily = if (isLocalPath) monoFamily else null,
                            background = if (isLocalPath) pathBackground else Color.Unspecified,
                            fontWeight = if (isHeading) FontWeight.SemiBold else null,
                        ),
                    )
                    if (target.startsWith("http://") || target.startsWith("https://")) {
                        withLink(
                            LinkAnnotation.Url(
                                url = target,
                                styles = TextLinkStyles(
                                    style = SpanStyle(
                                        color = linkColor,
                                        textDecoration = TextDecoration.Underline,
                                        fontWeight = if (isHeading) FontWeight.SemiBold else null,
                                    ),
                                ),
                            ),
                        ) {
                            append(label)
                        }
                    } else {
                        append(label)
                    }
                    pop()
                }

                token.startsWith("http://") || token.startsWith("https://") -> {
                    withLink(
                        LinkAnnotation.Url(
                            url = token,
                            styles = TextLinkStyles(
                                style = SpanStyle(
                                    color = linkColor,
                                    textDecoration = TextDecoration.Underline,
                                ),
                            ),
                        ),
                    ) {
                        append(token)
                    }
                }

                token.startsWith("`") && token.endsWith("`") -> {
                    pushStyle(
                        SpanStyle(
                            fontFamily = monoFamily,
                            background = inlineCodeBackground,
                            color = textColor,
                        ),
                    )
                    append(token.removePrefix("`").removeSuffix("`"))
                    pop()
                }

                token.startsWith("/") || token.startsWith("@") || token.startsWith("#") -> {
                    pushStyle(
                        SpanStyle(
                            fontFamily = monoFamily,
                            color = pathColor,
                            background = pathBackground,
                        ),
                    )
                    append(token)
                    pop()
                }

                else -> append(token)
            }
            lastIndex = match.range.last + 1
        }
        if (lastIndex < source.length) {
            appendStyledInlineText(
                value = source.substring(lastIndex),
                textColor = textColor,
                heading = isHeading,
            )
        }
    }
}

private fun AnnotatedString.Builder.appendStyledInlineText(
    value: String,
    textColor: Color,
    heading: Boolean,
) {
    if (value.isEmpty()) {
        return
    }
    val emphasisRegex = Regex("""(\*\*.+?\*\*|(?<!\*)\*[^*\n]+?\*(?!\*)|_[^_\n]+?_)""")
    var lastIndex = 0
    emphasisRegex.findAll(value).forEach { match ->
        if (match.range.first > lastIndex) {
            append(value.substring(lastIndex, match.range.first))
        }
        val token = match.value
        pushStyle(
            SpanStyle(
                color = textColor,
                fontWeight = when {
                    token.startsWith("**") && heading -> FontWeight.Bold
                    token.startsWith("**") -> FontWeight.SemiBold
                    else -> null
                },
                fontStyle = when {
                    token.startsWith("*") && !token.startsWith("**") -> FontStyle.Italic
                    token.startsWith("_") -> FontStyle.Italic
                    else -> null
                },
            ),
        )
        append(
            when {
                token.startsWith("**") -> token.removePrefix("**").removeSuffix("**")
                token.startsWith("*") -> token.removePrefix("*").removeSuffix("*")
                token.startsWith("_") -> token.removePrefix("_").removeSuffix("_")
                else -> token
            },
        )
        pop()
        lastIndex = match.range.last + 1
    }
    if (lastIndex < value.length) {
        append(value.substring(lastIndex))
    }
}

private fun parseMarkdownBlocks(text: String): List<MarkdownBlockUi> {
    return text
        .split(Regex("""\n{2,}"""))
        .map(String::trim)
        .filter(String::isNotEmpty)
        .map { block ->
            val lines = block.lines().map(String::trim).filter(String::isNotEmpty)
            when {
                lines.size == 1 && block.startsWith("### ") ->
                    MarkdownBlockUi.Heading(level = 3, text = block.removePrefix("### ").trim())

                lines.size == 1 && block.startsWith("## ") ->
                    MarkdownBlockUi.Heading(level = 2, text = block.removePrefix("## ").trim())

                lines.size == 1 && block.startsWith("# ") ->
                    MarkdownBlockUi.Heading(level = 1, text = block.removePrefix("# ").trim())

                lines.isNotEmpty() && lines.all { it.startsWith(">") } ->
                    MarkdownBlockUi.Quote(
                        text = lines.joinToString("\n") { line ->
                            line.removePrefix(">").trimStart()
                        },
                    )

                lines.isNotEmpty() && lines.all { it.matches(Regex("""[-*+] .+""")) } ->
                    MarkdownBlockUi.ListBlock(
                        items = lines.map { it.drop(2).trim() },
                        ordered = false,
                    )

                lines.isNotEmpty() && lines.all { it.matches(Regex("""\d+\. .+""")) } -> {
                    val startIndex = lines.first().substringBefore('.').toIntOrNull() ?: 1
                    MarkdownBlockUi.ListBlock(
                        items = lines.map { it.substringAfter(". ").trim() },
                        ordered = true,
                        startIndex = startIndex,
                    )
                }

                else -> MarkdownBlockUi.Paragraph(block)
            }
        }
}

private fun parseMarkdownSegments(text: String): List<MarkdownSegmentUi> {
    val regex = Regex("""(?m)^[ \t]{0,3}```([^\n`]*)\n([\s\S]*?)(?:\n[ \t]{0,3}```|$)""")
    val segments = mutableListOf<MarkdownSegmentUi>()
    var lastEnd = 0
    regex.findAll(text).forEach { match ->
        if (match.range.first > lastEnd) {
            val prose = text.substring(lastEnd, match.range.first).trim('\n')
            if (prose.isNotBlank()) {
                segments += MarkdownSegmentUi.Prose(prose)
            }
        }
        val language = match.groupValues[1].trim().ifEmpty { null }
        val code = match.groupValues[2]
        segments += MarkdownSegmentUi.CodeBlock(language = language, code = code)
        lastEnd = match.range.last + 1
    }
    if (lastEnd < text.length) {
        val trailing = text.substring(lastEnd).trim('\n')
        if (trailing.isNotBlank()) {
            segments += MarkdownSegmentUi.Prose(trailing)
        }
    }
    if (segments.isEmpty()) {
        segments += MarkdownSegmentUi.Prose(text)
    }
    return segments
}

private data class CommandPreviewUi(
    val command: String?,
    val outputLines: List<String>,
    val statusLabel: String,
)

private data class CommandDetailUi(
    val command: String?,
    val statusLabel: String,
    val cwd: String?,
    val exitCode: Int?,
    val durationMs: Int?,
    val outputSections: List<CommandOutputSectionUi>,
    val fallbackBody: String,
)

private data class CommandOutputSectionUi(
    val title: String?,
    val lines: List<CommandOutputLineUi>,
)

private data class CommandOutputLineUi(
    val text: String,
    val kind: CommandOutputLineKind,
)

private enum class CommandOutputLineKind {
    STANDARD,
    META,
    WARNING,
    ERROR,
}

private fun parseCommandPreview(text: String, isStreaming: Boolean): CommandPreviewUi {
    val lines = text.lines().map(String::trimEnd).filter(String::isNotBlank)
    val command = lines.firstOrNull()?.take(220)
    val output = lines.drop(if (command == null) 0 else 1).take(4)
    val lowered = text.lowercase()
    val status = when {
        isStreaming -> "Running"
        lowered.contains("error") || lowered.contains("failed") || lowered.contains("exit code") -> "Needs attention"
        else -> "Completed"
    }
    return CommandPreviewUi(
        command = command,
        outputLines = output,
        statusLabel = status,
    )
}

private data class PlanStepUi(
    val text: String,
    val statusLabel: String,
)

private data class PlanSummaryUi(
    val explanation: String?,
    val steps: List<PlanStepUi>,
)

private fun parsePlanSummary(text: String): PlanSummaryUi {
    val lines = text.lines().map(String::trim).filter(String::isNotEmpty)
    val steps = mutableListOf<PlanStepUi>()
    val explanationLines = mutableListOf<String>()
    val bracketRegex = Regex("""^[-*]?\s*\[(x| |>)\]\s*(.+)$""", RegexOption.IGNORE_CASE)
    val numberedRegex = Regex("""^\d+\.\s+(.+)$""")
    val statusRegex = Regex("""^(completed|in_progress|in progress|pending)\s*[:-]\s*(.+)$""", RegexOption.IGNORE_CASE)

    lines.forEach { line ->
        val bracketMatch = bracketRegex.matchEntire(line)
        val statusMatch = statusRegex.matchEntire(line)
        val numberedMatch = numberedRegex.matchEntire(line)
        when {
            bracketMatch != null -> {
                val rawStatus = bracketMatch.groupValues[1].lowercase()
                val statusLabel = when (rawStatus) {
                    "x" -> "Completed"
                    ">" -> "In progress"
                    else -> "Pending"
                }
                steps += PlanStepUi(
                    text = bracketMatch.groupValues[2],
                    statusLabel = statusLabel,
                )
            }

            statusMatch != null -> {
                val normalizedStatus = when (statusMatch.groupValues[1].lowercase()) {
                    "completed" -> "Completed"
                    "in_progress", "in progress" -> "In progress"
                    else -> "Pending"
                }
                steps += PlanStepUi(
                    text = statusMatch.groupValues[2],
                    statusLabel = normalizedStatus,
                )
            }

            line.startsWith("- ") || line.startsWith("* ") || numberedMatch != null -> {
                steps += PlanStepUi(
                    text = numberedMatch?.groupValues?.getOrNull(1) ?: line.drop(2),
                    statusLabel = "Pending",
                )
            }

            else -> explanationLines += line
        }
    }

    return PlanSummaryUi(
        explanation = explanationLines.takeIf { it.isNotEmpty() }?.joinToString(" "),
        steps = steps,
    )
}
