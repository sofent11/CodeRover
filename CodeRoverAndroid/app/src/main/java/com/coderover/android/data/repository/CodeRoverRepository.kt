package com.coderover.android.data.repository

import android.content.Context
import android.util.Log
import com.coderover.android.AppInfo
import com.coderover.android.data.model.AccessMode
import com.coderover.android.data.model.AppFontStyle
import com.coderover.android.data.model.AppState
import com.coderover.android.data.model.ApprovalRequest
import com.coderover.android.data.model.BridgeStatus
import com.coderover.android.data.model.BridgeUpdatePrompt
import com.coderover.android.data.model.CLOCK_SKEW_TOLERANCE_MS
import com.coderover.android.data.model.CommandPhase
import com.coderover.android.data.model.CommandState
import com.coderover.android.data.model.ConnectionPhase
import com.coderover.android.data.model.CodeRoverRateLimitBucket
import com.coderover.android.data.model.CodeRoverRateLimitWindow
import com.coderover.android.data.model.CodeRoverReviewTarget
import com.coderover.android.data.model.ImageAttachment
import com.coderover.android.data.model.TurnSkillMention
import com.coderover.android.data.model.FileChangeEntry
import com.coderover.android.data.model.FuzzyFileMatch
import com.coderover.android.data.model.GitBranchTargets
import com.coderover.android.data.model.GitCreateManagedWorktreeResult
import com.coderover.android.data.model.GitManagedHandoffTransferResult
import com.coderover.android.data.model.GitWorktreeChangeTransferMode
import com.coderover.android.data.model.MessageKind
import com.coderover.android.data.model.MessageRole
import com.coderover.android.data.model.ModelOption
import com.coderover.android.data.model.PAIRING_QR_VERSION
import com.coderover.android.data.model.PairingPayload
import com.coderover.android.data.model.PairingRecord
import com.coderover.android.data.model.PhoneIdentityState
import com.coderover.android.data.model.PlanState
import com.coderover.android.data.model.PlanStep
import com.coderover.android.data.model.PlanStepStatus
import com.coderover.android.data.model.QueuedTurnDraft
import com.coderover.android.data.model.SECURE_PROTOCOL_VERSION
import com.coderover.android.data.model.SecureConnectionState
import com.coderover.android.data.model.SkillMetadata
import com.coderover.android.data.model.StructuredUserInputOption
import com.coderover.android.data.model.StructuredUserInputQuestion
import com.coderover.android.data.model.StructuredUserInputRequest
import com.coderover.android.data.model.ThreadHistoryAnchor
import com.coderover.android.data.model.ThreadHistoryGap
import com.coderover.android.data.model.ThreadHistorySegment
import com.coderover.android.data.model.ThreadHistoryState
import com.coderover.android.data.model.ThreadSummary
import com.coderover.android.data.model.ThreadSyncState
import com.coderover.android.data.model.ThreadTimelineState
import com.coderover.android.data.model.TrustedMacRecord
import com.coderover.android.data.model.ThreadRunBadgeState
import com.coderover.android.data.model.TransportCandidate
import com.coderover.android.data.model.TrustedMacRegistry
import com.coderover.android.data.model.RuntimeProvider
import com.coderover.android.data.model.SubagentAction
import com.coderover.android.data.model.SubagentRef
import com.coderover.android.data.model.SubagentState
import com.coderover.android.data.model.array
import com.coderover.android.data.model.asIntOrNull
import com.coderover.android.data.model.bool
import com.coderover.android.data.model.copyWith
import com.coderover.android.data.model.int
import com.coderover.android.data.model.parseTimestamp
import com.coderover.android.data.model.responseKey
import com.coderover.android.data.model.string
import com.coderover.android.data.model.stringOrNull
import com.coderover.android.data.model.timestamp
import com.coderover.android.data.model.ChatMessage
import com.coderover.android.data.network.CodeRoverServiceException
import com.coderover.android.data.network.SecureBridgeClient
import com.coderover.android.data.network.SecureCrypto
import com.coderover.android.data.network.TransportCandidatePrioritizer
import com.coderover.android.data.storage.PairingStore
import com.coderover.android.data.storage.UserPreferencesStore
import java.util.Comparator
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.yield
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

class CodeRoverRepository(context: Context) {
    private enum class CanonicalTimelineEventKind {
        STARTED,
        TEXT_UPDATED,
        COMPLETED,
    }

    private companion object {
        const val TAG = "CodeRoverRepo"
        const val SELECTED_THREAD_SYNC_INTERVAL_MS = 3_000L
        const val MAX_CACHED_THREADS = 40
        const val MAX_CACHED_THREADS_WITH_MESSAGES = 6
        const val MAX_CACHED_MESSAGES_PER_THREAD = 120
        const val MAX_CACHED_MESSAGE_TEXT_CHARS = 8_000
        const val MAX_CACHED_COMMAND_CHARS = 1_500
        const val MAX_CACHED_COMMAND_OUTPUT_CHARS = 4_000
        const val MAX_CACHED_FILE_CHANGES = 12
        const val MAX_CACHED_FILE_DIFF_CHARS = 2_000
        const val MAX_CACHED_ATTACHMENT_THUMBNAIL_CHARS = 32_000
    }

    private data class ThreadListPage(
        val threads: List<ThreadSummary>,
        val nextCursor: JsonElement?,
        val hasMore: Boolean,
    )

    data class HistoryWindowState(
        val olderCursor: String?,
        val newerCursor: String?,
        val hasOlder: Boolean,
        val hasNewer: Boolean,
        val servedFromProjection: Boolean,
        val projectionSource: String?,
        val syncEpoch: Int,
    )

    data class NewerHistoryResult(
        val newestCursor: String?,
        val hasNewer: Boolean,
        val didAdvance: Boolean,
        val itemCount: Int,
    )

    private val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
    }
    private val store = PairingStore(context)
    private val prefs = UserPreferencesStore(context)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val clientMutex = Mutex()
    private val threadHistoryRefreshMutex = Mutex()
    private val olderHistoryBackfillMutex = Mutex()
    private val realtimeHistoryCatchUpMutex = Mutex()
    private val threadSyncCoordinator = ThreadSyncCoordinator()
    private val orderCounter = AtomicInteger(0)
    private val connectionEpoch = AtomicLong(0)
    private val nextClientGeneration = AtomicLong(0)
    private val activeClientGeneration = AtomicLong(0)
    private val isConnectInFlight = AtomicBoolean(false)
    internal val threadTimelineStateByThread = ConcurrentHashMap<String, ThreadTimelineState>()
    private val threadHistoryRefreshInFlight = mutableSetOf<String>()
    private val threadHistoryRefreshPending = mutableSetOf<String>()
    private val pendingRealtimeHistoryCatchUpThreadIds = mutableSetOf<String>()
    private val realtimeHistoryCatchUpTaskByThread = mutableMapOf<String, Job>()
    private val olderHistoryBackfillTaskByThread = mutableMapOf<String, Job>()
    private val pendingHistoryChangedRefreshThreadIds = mutableSetOf<String>()
    private val historyChangedRefreshTaskByThread = mutableMapOf<String, Job>()
    private val threadResumeTaskByThreadId = mutableMapOf<String, Deferred<ThreadSummary?>>()
    private val threadResumeRequestSignatureByThreadId = mutableMapOf<String, ThreadResumeRequestSignature>()
    private val threadHistoryLoadTaskByThreadId = mutableMapOf<String, Job>()
    private val canonicalHistoryReconcileTaskByThreadId = mutableMapOf<String, Job>()
    private val resumeSeededHistoryThreadIds = mutableSetOf<String>()
    private var selectedThreadSyncJob: Job? = null
    private val associatedManagedWorktreePathByThreadId = mutableMapOf<String, String>()
    private val authoritativeProjectPathByThreadId = mutableMapOf<String, String>()
    private var activeThreadListNextCursor: JsonElement? = JsonNull
    private var activeThreadListHasMore = false
    private var client: SecureBridgeClient? = null

    // For suppressing duplicate scan errors
    private var lastRejectedCode: String? = null
    private var lastRejectedMessage: String? = null
    private val queueCoordinator by lazy {
        TurnQueueCoordinator(
            scope = scope,
            removeQueuedDraft = ::removeQueuedDraft,
            prependQueuedDraft = ::prependQueuedDraft,
            pauseQueuedDrafts = ::pauseQueuedDrafts,
            dispatchDraftTurn = { threadId, payload ->
                dispatchDraftTurn(
                    threadId = threadId,
                    text = payload.text,
                    attachments = payload.attachments,
                    skillMentions = payload.skillMentions,
                    usePlanMode = payload.usePlanMode,
                )
            },
        )
    }

    private val _state = MutableStateFlow(
        AppState(
            onboardingSeen = store.loadOnboardingSeen(),
            fontStyle = store.loadFontStyle(),
            availableProviders = listOf(RuntimeProvider.CODEX_DEFAULT),
            selectedProviderId = normalizeProviderId(store.loadSelectedProviderId()),
            accessMode = store.loadAccessMode(normalizeProviderId(store.loadSelectedProviderId())),
            pairings = store.loadPairings(),
            activePairingMacDeviceId = store.loadActivePairingMacDeviceId(),
            phoneIdentityState = loadOrCreatePhoneIdentityState(),
            trustedMacRegistry = store.loadTrustedMacRegistry(),
            threads = store.loadCachedThreads(),
            selectedThreadId = store.loadCachedSelectedThreadId(),
            messagesByThread = store.loadCachedMessagesByThread(),
            historyStateByThread = store.loadCachedHistoryStateByThread(),
            selectedModelId = store.loadSelectedModelId(normalizeProviderId(store.loadSelectedProviderId())),
            selectedReasoningEffort = store.loadSelectedReasoningEffort(normalizeProviderId(store.loadSelectedProviderId())),
            lastPresentedWhatsNewVersion = prefs.getLastPresentedWhatsNewVersion(),
            collapsedProjectGroupIds = prefs.getCollapsedProjectGroupIds(),
        ),
    )
    val state: StateFlow<AppState> = _state.asStateFlow()

    init {
        val currentState = _state.value
        associatedManagedWorktreePathByThreadId.putAll(
            prefs.getAssociatedManagedWorktreePaths().mapNotNull { (threadId, projectPath) ->
                val normalizedThreadId = normalizedIdentifier(threadId) ?: return@mapNotNull null
                val normalizedProjectPath = normalizedProjectPath(projectPath) ?: return@mapNotNull null
                normalizedThreadId to normalizedProjectPath
            },
        )
        val activePairing = currentState.pairings.firstOrNull { it.macDeviceId == currentState.activePairingMacDeviceId }
        currentState.messagesByThread.forEach { (threadId, messages) ->
            val canonicalMessages = messages.filter(::isCanonicalTimelineMessage)
            if (canonicalMessages.isNotEmpty()) {
                threadTimelineStateByThread[threadId] = ThreadTimelineState(canonicalMessages)
            }
        }
        _state.value = currentState.copy(
            activePairingMacDeviceId = activePairing?.macDeviceId
                ?: currentState.pairings.maxByOrNull(PairingRecord::lastPairedAt)?.macDeviceId,
            selectedThreadId = currentState.selectedThreadId
                ?.takeIf { selectedId -> currentState.threads.any { it.id == selectedId } }
                ?: currentState.threads.firstOrNull()?.id,
            secureConnectionState = resolveSecureConnectionState(
                activePairingMacDeviceId = activePairing?.macDeviceId ?: currentState.activePairingMacDeviceId,
                trustedRegistry = currentState.trustedMacRegistry,
            ),
            secureMacFingerprint = activePairing?.macIdentityPublicKey?.let(SecureCrypto::fingerprint),
        )
    }

    fun toggleProjectGroupCollapsed(projectId: String) {
        val current = _state.value.collapsedProjectGroupIds.toMutableSet()
        if (current.contains(projectId)) {
            current.remove(projectId)
        } else {
            current.add(projectId)
        }
        prefs.setCollapsedProjectGroupIds(current)
        updateState { copy(collapsedProjectGroupIds = current) }
    }

    fun revertAssistantMessage(messageId: String) {
        Log.d(TAG, "revertAssistantMessage: $messageId (Not implemented yet)")
    }

    fun compactThreadContext(threadId: String) {
        Log.d(TAG, "compactThreadContext: $threadId (Not implemented yet)")
    }

    fun completeOnboarding() {
        store.saveOnboardingSeen(true)
        updateState { copy(onboardingSeen = true) }
    }

    fun markWhatsNewSeen(version: String) {
        prefs.setLastPresentedWhatsNewVersion(version)
        updateState { copy(lastPresentedWhatsNewVersion = version) }
    }

    fun setFontStyle(fontStyle: AppFontStyle) {
        store.saveFontStyle(fontStyle)
        updateState { copy(fontStyle = fontStyle) }
    }

    fun setAccessMode(accessMode: AccessMode) {
        val providerId = currentRuntimeProviderId()
        store.saveAccessMode(accessMode, providerId)
        updateState { copy(accessMode = accessMode) }
    }

    fun setSelectedProviderId(providerId: String) {
        val normalizedProviderId = normalizeProviderId(providerId)
        store.saveSelectedProviderId(normalizedProviderId)
        updateState { copy(selectedProviderId = normalizedProviderId) }
        scope.launch {
            syncRuntimeSelectionContext(normalizedProviderId, refreshModels = state.value.isConnected)
        }
    }

    fun setSelectedModelId(modelId: String?) {
        store.saveSelectedModelId(modelId, currentRuntimeProviderId())
        updateState { copy(selectedModelId = modelId) }
    }

    fun setSelectedReasoningEffort(reasoningEffort: String?) {
        store.saveSelectedReasoningEffort(reasoningEffort, currentRuntimeProviderId())
        updateState { copy(selectedReasoningEffort = reasoningEffort) }
    }

    fun updateImportText(value: String) {
        updateState { copy(importText = value) }
    }

    fun clearLastErrorMessage() {
        updateState { copy(lastErrorMessage = null) }
    }

    fun importPairingPayload(rawText: String, resetScanLock: (() -> Unit)? = null) {
        scope.launch {
            // Validate text encoding first (iOS does this check)
            if (rawText.toByteArray(Charsets.UTF_8).toString(Charsets.UTF_8) != rawText) {
                rejectScan(
                    code = rawText,
                    message = "QR code contains invalid text encoding.",
                    resetScanLock = resetScanLock
                )
                return@launch
            }

            val payload = runCatching {
                json.decodeFromString(PairingPayload.serializer(), rawText.trim())
            }.getOrElse {
                rejectScan(
                    code = rawText,
                    message = "Not a valid secure pairing code. Make sure you're scanning a QR from the latest CodeRover bridge.",
                    resetScanLock = resetScanLock
                )
                return@launch
            }

            when {
                payload.v != PAIRING_QR_VERSION -> {
                    rejectScan(
                        code = rawText,
                        message = "This QR code uses an unsupported pairing format. Update the Android app or the Mac bridge and try again.",
                        resetScanLock = resetScanLock
                    )
                    return@launch
                }
                payload.bridgeId.isBlank() -> {
                    rejectScan(
                        code = rawText,
                        message = "QR code is missing the bridge ID. Re-generate the code from the bridge.",
                        resetScanLock = resetScanLock
                    )
                    return@launch
                }
                payload.transportCandidates.isEmpty() -> {
                    rejectScan(
                        code = rawText,
                        message = "QR code is missing bridge transports. Re-generate the code from the bridge.",
                        resetScanLock = resetScanLock
                    )
                    return@launch
                }
                payload.expiresAt + CLOCK_SKEW_TOLERANCE_MS < System.currentTimeMillis() -> {
                    rejectScan(
                        code = rawText,
                        message = "This pairing QR code has expired. Generate a new one from the Mac bridge.",
                        resetScanLock = resetScanLock
                    )
                    return@launch
                }
            }

            // Clear rejection tracking on successful scan
            lastRejectedCode = null
            lastRejectedMessage = null

            val existing = state.value.pairings.filterNot { it.macDeviceId == payload.macDeviceId }
            val updatedTrustedRegistry = state.value.trustedMacRegistry.copy(
                records = state.value.trustedMacRegistry.records - payload.macDeviceId,
            )
            val record = PairingRecord(
                bridgeId = payload.bridgeId.trim(),
                macDeviceId = payload.macDeviceId.trim(),
                macIdentityPublicKey = payload.macIdentityPublicKey.trim(),
                transportCandidates = payload.transportCandidates.filter { it.url.isNotBlank() },
                secureProtocolVersion = SECURE_PROTOCOL_VERSION,
            )
            val updatedPairings = (existing + record).sortedByDescending(PairingRecord::lastPairedAt)
            store.savePairings(updatedPairings)
            store.saveActivePairingMacDeviceId(record.macDeviceId)
            store.saveTrustedMacRegistry(updatedTrustedRegistry)
            val bestTransportUrl = TransportCandidatePrioritizer.orderedTransportUrls(record).firstOrNull()

            updateState {
                copy(
                    pairings = updatedPairings,
                    activePairingMacDeviceId = record.macDeviceId,
                    trustedMacRegistry = updatedTrustedRegistry,
                    pendingTransportSelectionMacDeviceId = null,
                    secureConnectionState = resolveSecureConnectionState(record.macDeviceId, updatedTrustedRegistry),
                    secureMacFingerprint = SecureCrypto.fingerprint(record.macIdentityPublicKey),
                    importText = "",
                    lastErrorMessage = null,
                )
            }
            if (bestTransportUrl != null) {
                setPreferredTransport(record.macDeviceId, bestTransportUrl)
                connectActivePairing()
            }
        }
    }

    fun confirmPendingPairingTransport(macDeviceId: String, url: String) {
        setPreferredTransport(macDeviceId, url)
        updateState {
            copy(
                activePairingMacDeviceId = macDeviceId,
                pendingTransportSelectionMacDeviceId = null,
                lastErrorMessage = null,
            )
        }
        connectActivePairing()
    }

    fun connectActivePairing() {
        if (!isConnectInFlight.compareAndSet(false, true)) {
            Log.d(TAG, "connectActivePairing ignored because a connection attempt is already in flight")
            return
        }
        scope.launch {
            try {
                stopSelectedThreadSyncLoop()
                val epoch = connectionEpoch.incrementAndGet()
                val currentState = state.value
                val pairing = currentState.activePairing ?: run {
                    updateError("No saved bridge pairing is available.")
                    return@launch
                }
                val phoneIdentity = currentState.phoneIdentityState ?: run {
                    updateError("Phone identity is missing.")
                    return@launch
                }
                val preferredThreadId = currentState.selectedThreadId
                    ?.takeIf { threadId -> currentState.threads.any { it.id == threadId } }
                val isForegroundThreadReconnect = preferredThreadId != null

                updateState {
                    copy(
                        connectionPhase = ConnectionPhase.CONNECTING,
                        lastErrorMessage = null,
                    )
                }

                val orderedUrls = orderedTransportUrls(pairing)
                if (orderedUrls.isEmpty()) {
                    updateError("No saved bridge transport is available.")
                    updateState { copy(connectionPhase = ConnectionPhase.OFFLINE) }
                    return@launch
                }

                var lastFailure: Throwable? = null
                var finalSecureState = currentState.secureConnectionState
                for (url in orderedUrls) {
                    try {
                        Log.d(TAG, "connectActivePairing epoch=$epoch url=$url mac=${pairing.macDeviceId}")
                        val clientGeneration = nextClientGeneration.incrementAndGet()
                        val bridgeClient = buildClient(epoch, clientGeneration)
                        clientMutex.withLock {
                            client?.disconnect()
                            activeClientGeneration.set(clientGeneration)
                            client = bridgeClient
                        }
                        bridgeClient.connect(
                            url = url,
                            pairingRecord = pairing,
                            phoneIdentityState = phoneIdentity,
                            trustedMacRecord = state.value.trustedMacRegistry.records[pairing.macDeviceId],
                            accessMode = state.value.accessMode,
                        )
                        Log.d(TAG, "websocket+handshake ok epoch=$epoch url=$url")
                        rememberSuccessfulTransport(url)
                        initializeSession(updatePhase = !isForegroundThreadReconnect)
                        Log.d(TAG, "initialize ok epoch=$epoch")
                        listProviders()
                        Log.d(TAG, "runtime/provider/list ok epoch=$epoch")
                        syncRuntimeSelectionContext(currentRuntimeProviderId(), refreshModels = false)
                        val reconnectThreadId = preferredThreadId
                            ?: state.value.selectedThreadId
                            ?: state.value.threads.firstOrNull()?.id
                        updateState {
                            copy(
                                connectionPhase = ConnectionPhase.CONNECTED,
                                lastErrorMessage = null,
                                selectedThreadId = reconnectThreadId ?: selectedThreadId ?: threads.firstOrNull()?.id,
                            )
                        }
                        startSelectedThreadSyncLoop()
                        refreshBridgeMetadataInternal()
                        Log.d(TAG, "runtime selection restored epoch=$epoch provider=${currentRuntimeProviderId()}")
                        reconnectThreadId?.let { threadId ->
                            runCatching {
                                refreshThreadHistory(threadId, reason = "initial-connect")
                            }.onFailure { failure ->
                                Log.w(TAG, "initial thread/read failed after connect epoch=$epoch threadId=$threadId", failure)
                                scheduleThreadHistoryRetry(threadId, "initial-connect")
                            }
                        }
                        launchPostConnectBootstrap(epoch, reconnectThreadId)
                        return@launch
                    } catch (failure: Throwable) {
                        Log.e(TAG, "connectActivePairing failed epoch=$epoch url=$url", failure)
                        lastFailure = failure
                        val resolution = resolveConnectionFailure(failure, finalSecureState)
                        finalSecureState = resolution.secureConnectionState
                        if (resolution.shouldStopTryingOtherTransports) {
                            break
                        }
                    }
                }

                clientMutex.withLock {
                    if (connectionEpoch.get() == epoch) {
                        client?.disconnect()
                        client = null
                        activeClientGeneration.set(0)
                    }
                }
                updateState {
                    copy(
                        connectionPhase = ConnectionPhase.OFFLINE,
                        secureConnectionState = finalSecureState,
                        lastErrorMessage = lastFailure?.message ?: "Could not connect to the CodeRover bridge.",
                    )
                }
            } finally {
                isConnectInFlight.set(false)
            }
        }
    }

    private fun launchPostConnectBootstrap(epoch: Long, foregroundThreadId: String?) {
        scope.launch {
            runCatching {
                listThreads(updatePhase = false)
                Log.d(TAG, "thread/list ok epoch=$epoch")
            }.onFailure { failure ->
                Log.w(TAG, "thread/list failed after connect epoch=$epoch", failure)
            }

            val providerId = currentRuntimeProviderId()
            runCatching {
                syncRuntimeSelectionContext(providerId, refreshModels = true)
                Log.d(TAG, "model/list ok epoch=$epoch provider=$providerId")
            }.onFailure { failure ->
                Log.w(TAG, "model/list failed after connect epoch=$epoch provider=$providerId", failure)
            }

            val selectedThreadId = state.value.selectedThreadId
            if (selectedThreadId != null &&
                selectedThreadId != foregroundThreadId &&
                state.value.messagesByThread[selectedThreadId].orEmpty().isEmpty()
            ) {
                runCatching {
                    refreshThreadHistory(selectedThreadId, reason = "post-connect-selection")
                }.onFailure { failure ->
                    Log.w(TAG, "post-connect thread/read failed epoch=$epoch threadId=$selectedThreadId", failure)
                    scheduleThreadHistoryRetry(selectedThreadId, "post-connect-selection")
                }
            }
        }
    }

    fun disconnect() {
        scope.launch {
            disconnectCurrentClient(resetThreadSession = false)
        }
    }

    fun refreshBridgeMetadata() {
        scope.launch {
            refreshBridgeMetadataInternal()
        }
    }

    fun setBridgeKeepAwakeEnabled(enabled: Boolean) {
        scope.launch {
            updateBridgeKeepAwakeEnabled(enabled)
        }
    }

    fun removePairing(macDeviceId: String) {
        scope.launch {
            val currentState = state.value
            val removingActivePairing = currentState.activePairingMacDeviceId == macDeviceId
            val remaining = currentState.pairings.filterNot { it.macDeviceId == macDeviceId }
            val activeMacDeviceId = currentState.activePairingMacDeviceId.takeUnless { it == macDeviceId }
                ?: remaining.maxByOrNull(PairingRecord::lastPairedAt)?.macDeviceId
            val trustedRegistry = currentState.trustedMacRegistry.copy(
                records = currentState.trustedMacRegistry.records - macDeviceId,
            )
            store.savePairings(remaining)
            store.saveActivePairingMacDeviceId(activeMacDeviceId)
            store.saveTrustedMacRegistry(trustedRegistry)

            updateState {
                copy(
                    pairings = remaining,
                    activePairingMacDeviceId = activeMacDeviceId,
                    trustedMacRegistry = trustedRegistry,
                    secureConnectionState = resolveSecureConnectionState(activeMacDeviceId, trustedRegistry),
                    secureMacFingerprint = remaining.firstOrNull { it.macDeviceId == activeMacDeviceId }
                        ?.macIdentityPublicKey
                        ?.let(SecureCrypto::fingerprint),
                    pendingTransportSelectionMacDeviceId = pendingTransportSelectionMacDeviceId
                        ?.takeUnless { it == macDeviceId },
                )
            }

            if (removingActivePairing || remaining.isEmpty()) {
                disconnectCurrentClient(resetThreadSession = true)
            }
        }
    }

    fun selectPairing(macDeviceId: String) {
        store.saveActivePairingMacDeviceId(macDeviceId)
        updateState {
            copy(
                activePairingMacDeviceId = macDeviceId,
                pendingTransportSelectionMacDeviceId = null,
                secureConnectionState = resolveSecureConnectionState(macDeviceId, trustedMacRegistry),
                secureMacFingerprint = pairings.firstOrNull { it.macDeviceId == macDeviceId }
                    ?.macIdentityPublicKey
                    ?.let(SecureCrypto::fingerprint),
            )
        }
    }

    fun setPreferredTransport(macDeviceId: String, url: String) {
        val updatedPairings = state.value.pairings.map { pairing ->
            if (pairing.macDeviceId == macDeviceId) {
                pairing.copy(preferredTransportUrl = url)
            } else {
                pairing
            }
        }
        store.savePairings(updatedPairings)
        updateState { copy(pairings = updatedPairings) }
    }

    fun selectThread(threadId: String) {
        val thread = state.value.threads.firstOrNull { it.id == threadId }
        updateState { copy(selectedThreadId = threadId, pendingApprovals = emptyList(), readyThreadIds = readyThreadIds - threadId, failedThreadIds = failedThreadIds - threadId) }
        scope.launch {
            syncRuntimeSelectionContext(thread?.provider ?: state.value.selectedProviderId, refreshModels = state.value.isConnected)
        }
        scope.launch {
            if (!state.value.isConnected) {
                return@launch
            }
            runCatching {
                refreshThreadHistory(threadId, reason = "select-thread")
            }.onFailure { failure ->
                Log.w(TAG, "thread/read refresh failed reason=select-thread threadId=$threadId", failure)
            }
        }
        scope.launch {
            refreshContextWindowUsage(threadId)
        }
    }

    fun clearSelectedThread() {
        updateState { copy(selectedThreadId = null, pendingApprovals = emptyList()) }
        scope.launch {
            syncRuntimeSelectionContext(state.value.selectedProviderId, refreshModels = state.value.isConnected)
        }
    }

    fun createThread(preferredProjectPath: String? = null, providerId: String? = null) {
        scope.launch {
            val resolvedProviderId = normalizeProviderId(providerId ?: state.value.selectedProviderId)
            store.saveSelectedProviderId(resolvedProviderId)
            updateState { copy(selectedProviderId = resolvedProviderId) }
            syncRuntimeSelectionContext(resolvedProviderId, refreshModels = state.value.isConnected)
            startThread(preferredProjectPath, resolvedProviderId)
        }
    }

    fun createManagedWorktreeThread(preferredProjectPath: String, providerId: String? = null) {
        scope.launch {
            val normalizedProjectPath = normalizedProjectPath(preferredProjectPath)
            if (normalizedProjectPath == null) {
                updateError("Choose a local project before starting a worktree chat.")
                return@launch
            }

            val resolvedProviderId = normalizeProviderId(providerId ?: state.value.selectedProviderId)
            store.saveSelectedProviderId(resolvedProviderId)
            updateState { copy(selectedProviderId = resolvedProviderId) }
            syncRuntimeSelectionContext(resolvedProviderId, refreshModels = state.value.isConnected)

            val branchTargets = gitBranchesWithStatus(normalizedProjectPath)
            val baseBranch = branchTargets?.defaultBranch?.trim()?.takeIf(String::isNotEmpty)
                ?: branchTargets?.currentBranch?.trim()?.takeIf(String::isNotEmpty)

            if (baseBranch == null) {
                updateError("Could not determine a base branch for the managed worktree.")
                return@launch
            }

            val worktreeResult = createManagedWorktree(
                cwd = normalizedProjectPath,
                baseBranch = baseBranch,
                changeTransfer = GitWorktreeChangeTransferMode.NONE,
            )

            if (worktreeResult == null) {
                updateError("Unable to create a worktree chat right now.")
                return@launch
            }

            val thread = runCatching {
                startThread(worktreeResult.worktreePath, resolvedProviderId)
            }.getOrElse { failure ->
                if (!worktreeResult.alreadyExisted) {
                    runCatching {
                        removeManagedWorktree(worktreeResult.worktreePath, branch = null)
                    }
                }
                throw failure
            }

            if (thread == null) {
                if (!worktreeResult.alreadyExisted) {
                    runCatching {
                        removeManagedWorktree(worktreeResult.worktreePath, branch = null)
                    }
                }
                updateError("Unable to create a worktree chat right now.")
            }
        }
    }

    fun deleteThread(threadId: String) {
        val current = state.value
        val updatedThreads = current.threads.filterNot { it.id == threadId }
        val updatedMessages = current.messagesByThread - threadId
        val newSelectedId = if (current.selectedThreadId == threadId) null else current.selectedThreadId
        clearThreadSyncState(threadId)
        rememberAssociatedManagedWorktreePath(threadId, null)
        updateState { copy(threads = updatedThreads, messagesByThread = updatedMessages, selectedThreadId = newSelectedId) }
        scope.launch {
            val params = kotlinx.serialization.json.buildJsonObject {
                put("thread_id", kotlinx.serialization.json.JsonPrimitive(threadId))
                put("unarchive", kotlinx.serialization.json.JsonPrimitive(false))
            }
            requestWithSandboxFallback("thread/archive", params)
        }
    }

    fun archiveThread(threadId: String) {
        val current = state.value
        val updatedThreads = current.threads.map { 
            if (it.id == threadId) it.copy(syncState = com.coderover.android.data.model.ThreadSyncState.ARCHIVED_LOCAL) else it 
        }
        val newSelectedId = if (current.selectedThreadId == threadId) null else current.selectedThreadId
        updateState { copy(threads = updatedThreads, selectedThreadId = newSelectedId) }
        scope.launch {
            val params = kotlinx.serialization.json.buildJsonObject {
                put("thread_id", kotlinx.serialization.json.JsonPrimitive(threadId))
                put("unarchive", kotlinx.serialization.json.JsonPrimitive(false))
            }
            requestWithSandboxFallback("thread/archive", params)
        }
    }

    fun unarchiveThread(threadId: String) {
        val current = state.value
        val updatedThreads = current.threads.map { 
            if (it.id == threadId) it.copy(syncState = com.coderover.android.data.model.ThreadSyncState.LIVE) else it 
        }
        updateState { copy(threads = updatedThreads) }
        scope.launch {
            val params = kotlinx.serialization.json.buildJsonObject {
                put("thread_id", kotlinx.serialization.json.JsonPrimitive(threadId))
                put("unarchive", kotlinx.serialization.json.JsonPrimitive(true))
            }
            requestWithSandboxFallback("thread/archive", params)
        }
    }

    fun renameThread(threadId: String, name: String) {
        val current = state.value
        val updatedThreads = current.threads.map { 
            if (it.id == threadId) it.copy(name = name, title = name) else it 
        }
        updateState { copy(threads = updatedThreads) }
        scope.launch {
            val params = kotlinx.serialization.json.buildJsonObject {
                put("thread_id", kotlinx.serialization.json.JsonPrimitive(threadId))
                put("name", kotlinx.serialization.json.JsonPrimitive(name))
            }
            requestWithSandboxFallback("thread/name/set", params)
        }
    }

    fun removeQueuedDraft(threadId: String, draftId: String) {
        updateState {
            val currentQueue = queuedTurnDraftsByThread[threadId].orEmpty()
            val updatedQueue = currentQueue.filterNot { it.id == draftId }
            copy(
                queuedTurnDraftsByThread = if (updatedQueue.isEmpty()) {
                    queuedTurnDraftsByThread - threadId
                } else {
                    queuedTurnDraftsByThread + (threadId to updatedQueue)
                }
            )
        }
    }

    fun resumeQueuedDrafts(threadId: String) {
        updateState {
            copy(queuePauseMessageByThread = queuePauseMessageByThread - threadId)
        }
        checkAndSendNextQueuedDraft(threadId)
    }

    fun steerQueuedDraft(threadId: String, draftId: String) {
        scope.launch {
            val draft = state.value.queuedTurnDraftsByThread[threadId]
                ?.firstOrNull { it.id == draftId }
                ?: return@launch
            val payload = draft.toDispatchPayload()
            var activeTurnId = state.value.activeTurnIdByThread[threadId]
                ?: resolveActiveTurnId(threadId)

            if (activeTurnId.isNullOrBlank()) {
                dispatchDraftTurn(
                    threadId = threadId,
                    text = payload.text,
                    attachments = payload.attachments,
                    skillMentions = payload.skillMentions,
                    usePlanMode = payload.usePlanMode,
                )
                removeQueuedDraft(threadId, draftId)
                return@launch
            }

            appendLocalMessage(
                ChatMessage(
                    threadId = threadId,
                    role = MessageRole.USER,
                    text = payload.text,
                    attachments = payload.attachments,
                    orderIndex = nextOrderIndex(),
                ),
            )

            val steerBaseParams = buildJsonObject(
                "threadId" to JsonPrimitive(threadId)
            )

            var includeStructuredSkillItems = payload.skillMentions.isNotEmpty()
            var didRetryWithRefreshedTurnId = false

            runCatching {
                while (true) {
                    val params = steerBaseParams.copyWith(
                        "expectedTurnId" to JsonPrimitive(activeTurnId),
                        "input" to buildTurnInputItems(
                            text = payload.text,
                            attachments = payload.attachments,
                            skillMentions = payload.skillMentions,
                            includeStructuredSkillItems = includeStructuredSkillItems,
                        ),
                    )
                    try {
                        requestWithSandboxFallback("turn/steer", params)
                        break
                    } catch (failure: Throwable) {
                        if (includeStructuredSkillItems && shouldRetryTurnStartWithoutSkillItems(failure)) {
                            includeStructuredSkillItems = false
                            continue
                        }
                        if (!didRetryWithRefreshedTurnId && shouldRetrySteerWithRefreshedTurnId(failure)) {
                            val refreshedTurnId = resolveActiveTurnId(threadId)
                            if (!refreshedTurnId.isNullOrBlank() && refreshedTurnId != activeTurnId) {
                                activeTurnId = refreshedTurnId
                                didRetryWithRefreshedTurnId = true
                                continue
                            }
                        }
                        throw failure
                    }
                }
            }.onSuccess {
                removeQueuedDraft(threadId, draftId)
            }.onFailure { failure ->
                removeLatestMatchingUserMessage(
                    threadId = threadId,
                    text = payload.text,
                    attachments = payload.attachments,
                )
                updateError(failure.message ?: "Unable to steer queued draft.")
            }
        }
    }

    fun sendMessage(
        text: String,
        attachments: List<ImageAttachment> = emptyList(),
        skillMentions: List<TurnSkillMention> = emptyList(),
        usePlanMode: Boolean = false,
    ) {
        scope.launch {
            val trimmed = text.trim()
            if (trimmed.isEmpty() && attachments.isEmpty()) {
                return@launch
            }

            val selectedModel = state.value.selectedTurnStartModel()
            if (usePlanMode && selectedModel == null) {
                updateError("Plan mode requires an available model before starting a turn.")
                return@launch
            }

            val threadId = state.value.selectedThreadId
                ?: startThread(preferredProjectPath = null)?.id
                ?: return@launch

            val queueStatus = state.value.threadQueueStatus(threadId)
            if (queueStatus.blocksImmediateSend) {
                updateState {
                    val currentQueue = queuedTurnDraftsByThread[threadId].orEmpty()
                    copy(
                        queuedTurnDraftsByThread = queuedTurnDraftsByThread + (
                            threadId to (
                                currentQueue + QueuedTurnDraft(
                                    text = trimmed,
                                    attachments = attachments,
                                    skillMentions = skillMentions,
                                    usePlanMode = usePlanMode,
                                )
                            )
                        )
                    )
                }
                if (queueStatus.shouldSurfacePausedNotice) {
                    updateState {
                        copy(lastErrorMessage = "Queue paused. Resume queued drafts to continue sending.")
                    }
                }
                return@launch
            }

            appendLocalMessage(
                ChatMessage(
                    threadId = threadId,
                    role = MessageRole.USER,
                    text = trimmed,
                    attachments = attachments,
                    orderIndex = nextOrderIndex(),
                ),
            )
            updateState {
                copy(
                    runningThreadIds = runningThreadIds + threadId,
                    lastErrorMessage = null,
                )
            }
            runCatching {
                executeTurnStartRequest(
                    threadId = threadId,
                    text = trimmed,
                    attachments = attachments,
                    skillMentions = skillMentions,
                    usePlanMode = usePlanMode,
                    selectedModel = selectedModel,
                )
            }.onFailure { failure ->
                updateState {
                    copy(
                        runningThreadIds = runningThreadIds - threadId,
                        lastErrorMessage = failure.message ?: "Unable to send message.",
                    )
                }
                appendLocalMessage(
                    ChatMessage(
                        threadId = threadId,
                        role = MessageRole.SYSTEM,
                        kind = MessageKind.COMMAND_EXECUTION,
                        text = "Send error: ${failure.message ?: "Unknown error"}",
                        orderIndex = nextOrderIndex(),
                    ),
                )
            }
        }
    }

    fun startReview(
        threadId: String,
        target: CodeRoverReviewTarget,
        baseBranch: String? = null,
    ) {
        scope.launch {
            val normalizedThreadId = threadId.trim()
            if (normalizedThreadId.isEmpty()) {
                updateError("Choose a conversation before starting a review.")
                return@launch
            }
            val normalizedProvider = normalizeProviderId(
                state.value.threads.firstOrNull { it.id == normalizedThreadId }?.provider,
            )
            if (normalizedProvider != "codex") {
                updateError("Code review is only available in Codex conversations.")
                return@launch
            }

            val promptText = reviewPromptText(target, baseBranch)
            appendLocalMessage(
                ChatMessage(
                    threadId = normalizedThreadId,
                    role = MessageRole.USER,
                    text = promptText,
                    orderIndex = nextOrderIndex(),
                ),
            )
            updateState {
                copy(
                    runningThreadIds = runningThreadIds + normalizedThreadId,
                    lastErrorMessage = null,
                )
            }

            runCatching {
                requestWithSandboxFallback(
                    "review/start",
                    buildReviewStartParams(
                        threadId = normalizedThreadId,
                        target = target,
                        baseBranch = baseBranch,
                    ),
                )
            }.onFailure { failure ->
                removeLatestMatchingUserMessage(
                    threadId = normalizedThreadId,
                    text = promptText,
                    attachments = emptyList(),
                )
                updateState {
                    copy(
                        runningThreadIds = runningThreadIds - normalizedThreadId,
                        lastErrorMessage = failure.message ?: "Unable to start review.",
                    )
                }
            }
        }
    }

    fun refreshContextWindowUsage(threadId: String) {
        scope.launch {
            val normalizedThreadId = threadId.trim()
            if (normalizedThreadId.isEmpty()) {
                return@launch
            }
            val normalizedProvider = normalizeProviderId(
                state.value.threads.firstOrNull { it.id == normalizedThreadId }?.provider,
            )
            if (normalizedProvider != "codex") {
                return@launch
            }

            val params = buildJsonObject(
                "threadId" to JsonPrimitive(normalizedThreadId),
                "turnId" to state.value.activeTurnIdByThread[normalizedThreadId]
                    ?.trim()
                    ?.takeIf(String::isNotEmpty)
                    ?.let(::JsonPrimitive),
            )

            runCatching {
                activeClient().sendRequest("thread/contextWindow/read", params)?.jsonObjectOrNull()
            }.onSuccess { response ->
                val usageObject = response?.get("result")?.jsonObjectOrNull()?.get("usage")?.jsonObjectOrNull()
                    ?: response?.get("usage")?.jsonObjectOrNull()
                val usage = extractContextWindowUsage(usageObject) ?: return@onSuccess
                updateState {
                    copy(contextWindowUsageByThread = contextWindowUsageByThread + (normalizedThreadId to usage))
                }
            }.onFailure { failure ->
                Log.d(TAG, "thread/contextWindow/read failed (non-fatal): ${failure.message}")
            }
        }
    }

    fun refreshRateLimits() {
        scope.launch {
            if (currentRuntimeProviderId() != "codex") {
                updateState {
                    copy(
                        rateLimitBuckets = emptyList(),
                        isLoadingRateLimits = false,
                        rateLimitsErrorMessage = null,
                    )
                }
                return@launch
            }

            updateState {
                copy(
                    isLoadingRateLimits = true,
                    rateLimitsErrorMessage = null,
                )
            }

            runCatching {
                fetchRateLimitsWithCompatRetry()
            }.onSuccess { response ->
                val payload = response?.get("result")?.jsonObjectOrNull() ?: response ?: JsonObject(emptyMap())
                applyRateLimitsPayload(payload, mergeWithExisting = false)
                updateState {
                    copy(
                        isLoadingRateLimits = false,
                        rateLimitsErrorMessage = null,
                    )
                }
            }.onFailure { failure ->
                updateState {
                    copy(
                        rateLimitBuckets = emptyList(),
                        isLoadingRateLimits = false,
                        rateLimitsErrorMessage = failure.message?.trim().takeUnless { it.isNullOrEmpty() }
                            ?: "Unable to load rate limits",
                    )
                }
            }
        }
    }

    fun interruptActiveTurn() {
        scope.launch {
            val threadId = state.value.selectedThreadId ?: return@launch
            val turnId = state.value.activeTurnIdByThread[threadId]
                ?: resolveActiveTurnId(threadId)
            if (turnId.isNullOrBlank()) {
                return@launch
            }
            updateState {
                copy(activeTurnIdByThread = activeTurnIdByThread + (threadId to turnId))
            }
            runCatching {
                activeClient().sendRequest(
                    method = "turn/interrupt",
                    params = JsonObject(
                        mapOf(
                            "turnId" to JsonPrimitive(turnId),
                            "threadId" to JsonPrimitive(threadId),
                        ),
                    ),
                )
            }.onFailure {
                updateError(it.message ?: "Unable to stop the active turn.")
            }
        }
    }

    fun refreshThreadsIfConnected() {
        scope.launch {
            if (!state.value.isConnected) {
                return@launch
            }
            runCatching<Unit> {
                listThreads(updatePhase = false)
                state.value.selectedThreadId?.let { threadId ->
                    refreshThreadHistory(threadId, reason = "manual-refresh")
                }
            }.onFailure { failure ->
                updateError(failure.message ?: "Unable to refresh chats.")
            }
        }
    }

    fun approvePendingRequest(approve: Boolean) {
        scope.launch {
            val request = state.value.pendingApproval ?: return@launch
            runCatching {
                activeClient().sendResponse(
                    id = request.requestId,
                    result = JsonPrimitive(if (approve) "accept" else "reject"),
                )
            }
            updateState { copy(pendingApprovals = pendingApprovals.drop(1)) }
        }
    }

    fun respondToStructuredUserInput(
        requestId: JsonElement,
        answersByQuestionId: Map<String, String>,
    ) {
        scope.launch {
            val answersObject = JsonObject(
                answersByQuestionId
                    .mapValues { (_, answer) ->
                        JsonObject(
                            mapOf(
                                "answers" to JsonArray(
                                    listOfNotNull(
                                        answer.trim().takeIf(String::isNotEmpty)?.let(::JsonPrimitive),
                                    ),
                                ),
                            ),
                        )
                    },
            )
            runCatching {
                activeClient().sendResponse(
                    id = requestId,
                    result = JsonObject(
                        mapOf(
                            "answers" to answersObject,
                        ),
                    ),
                )
            }.onFailure {
                updateError(it.message ?: "Unable to send response.")
            }
        }
    }

    suspend fun fuzzyFileSearch(query: String, threadId: String): List<FuzzyFileMatch> {
        val thread = state.value.threads.firstOrNull { it.id == threadId }
        val params = buildJsonObject(
            "query" to JsonPrimitive(query),
            "cwd" to thread?.cwd?.let(::JsonPrimitive),
        )
        val response = activeClient().sendRequest("fuzzyFileSearch", params)?.jsonObjectOrNull() ?: return emptyList()
        val files = response["result"]?.jsonObjectOrNull()?.get("files")?.jsonArrayOrNull()
            ?: response["files"]?.jsonArrayOrNull()
            ?: return emptyList()
        return files.mapNotNull { element ->
            val obj = element.jsonObjectOrNull() ?: return@mapNotNull null
            val path = obj.string("path") ?: return@mapNotNull null
            val root = obj.string("root") ?: return@mapNotNull null
            FuzzyFileMatch(path = path, root = root)
        }
    }

    suspend fun listSkills(): List<SkillMetadata> {
        val response = activeClient().sendRequest("skills/list", JsonObject(emptyMap()))?.jsonObjectOrNull() ?: return emptyList()
        val skills = response["result"]?.jsonObjectOrNull()?.get("skills")?.jsonArrayOrNull()
            ?: response["skills"]?.jsonArrayOrNull()
            ?: return emptyList()
        return skills.mapNotNull { element ->
            val obj = element.jsonObjectOrNull() ?: return@mapNotNull null
            val id = obj.string("id") ?: return@mapNotNull null
            val name = obj.string("name") ?: return@mapNotNull null
            val description = obj.string("description")
            SkillMetadata(
                id = id,
                name = name,
                description = description,
                path = obj.string("path"),
            )
        }
    }

    suspend fun gitStatus(cwd: String): com.coderover.android.data.model.GitRepoSyncResult? {
        val params = buildJsonObject("cwd" to JsonPrimitive(cwd))
        val response = activeClient().sendRequest("git/status", params)?.jsonObjectOrNull() ?: return null
        val result = parseGitRepoSyncResult(response)
        val threadId = resolveThreadIdForCwd(cwd)
        updateGitRepoSync(threadId, result)
        return result
    }

    suspend fun gitBranchesWithStatus(cwd: String): GitBranchTargets? {
        val params = buildJsonObject("cwd" to JsonPrimitive(cwd))
        val response = activeClient().sendRequest("git/branchesWithStatus", params)?.jsonObjectOrNull() ?: return null
        val branches = response["branches"]?.jsonArrayOrNull()
            ?.mapNotNull { element -> element.stringOrNull()?.trim()?.takeIf(String::isNotEmpty) }
            .orEmpty()
            .distinct()
        val currentBranch = response.string("current")?.trim().orEmpty()
        val defaultBranch = response.string("default")?.trim()?.takeIf(String::isNotEmpty)
        val branchesCheckedOutElsewhere = response["branchesCheckedOutElsewhere"]?.jsonArrayOrNull()
            ?.mapNotNull { element -> element.stringOrNull()?.trim()?.takeIf(String::isNotEmpty) }
            ?.toSet()
            .orEmpty()
        val worktreePathByBranch = response["worktreePathByBranch"]?.jsonObjectOrNull()
            ?.mapNotNull { (branch, value) ->
                val path = value.stringOrNull()?.trim()?.takeIf(String::isNotEmpty) ?: return@mapNotNull null
                branch.trim().takeIf(String::isNotEmpty)?.let { it to path }
            }
            ?.toMap()
            .orEmpty()
        val localCheckoutPath = response.string("localCheckoutPath")?.trim()?.takeIf(String::isNotEmpty)
        val targets = GitBranchTargets(
            branches = branches,
            branchesCheckedOutElsewhere = branchesCheckedOutElsewhere,
            worktreePathByBranch = worktreePathByBranch,
            localCheckoutPath = localCheckoutPath,
            currentBranch = currentBranch,
            defaultBranch = defaultBranch,
        )
        val threadId = resolveThreadIdForCwd(cwd)
        response["status"]?.jsonObjectOrNull()?.let { status ->
            updateGitRepoSync(threadId, parseGitRepoSyncResult(status))
        }
        if (threadId != null) {
            updateState {
                val normalizedBase = selectedGitBaseBranchByThread[threadId]
                    ?.trim()
                    ?.takeIf(String::isNotEmpty)
                    ?: defaultBranch
                    ?: currentBranch.takeIf(String::isNotEmpty)
                copy(
                    gitBranchTargetsByThread = gitBranchTargetsByThread + (threadId to targets),
                    selectedGitBaseBranchByThread = if (normalizedBase == null) {
                        selectedGitBaseBranchByThread
                    } else {
                        selectedGitBaseBranchByThread + (threadId to normalizedBase)
                    },
                )
            }
        }
        return targets
    }

    suspend fun checkoutGitBranch(cwd: String, branch: String): com.coderover.android.data.model.GitRepoSyncResult? {
        val normalizedBranch = branch.trim()
        if (normalizedBranch.isEmpty()) {
            return null
        }
        val params = buildJsonObject(
            "cwd" to JsonPrimitive(cwd),
            "branch" to JsonPrimitive(normalizedBranch),
        )
        val response = activeClient().sendRequest("git/checkout", params)?.jsonObjectOrNull() ?: return null
        val threadId = resolveThreadIdForCwd(cwd)
        val status = response["status"]?.jsonObjectOrNull()?.let(::parseGitRepoSyncResult)
        if (status != null) {
            updateGitRepoSync(threadId, status)
        }
        if (threadId != null) {
            updateState {
                val existingTargets = gitBranchTargetsByThread[threadId]
                copy(
                    gitBranchTargetsByThread = if (existingTargets == null) {
                        gitBranchTargetsByThread
                    } else {
                        gitBranchTargetsByThread + (threadId to existingTargets.copy(currentBranch = normalizedBranch))
                    },
                )
            }
        }
        return status
    }

    fun selectGitBaseBranch(threadId: String, branch: String) {
        val normalizedBranch = branch.trim()
        if (normalizedBranch.isEmpty()) {
            return
        }
        updateState {
            copy(selectedGitBaseBranchByThread = selectedGitBaseBranchByThread + (threadId to normalizedBranch))
        }
    }

    suspend fun handoffThreadToManagedWorktree(
        threadId: String,
        baseBranch: String? = null,
    ): ThreadSummary? {
        val currentThread = state.value.threads.firstOrNull { it.id == threadId } ?: return null
        val sourceProjectPath = normalizedProjectPath(currentThread.cwd) ?: return null
        val associatedWorktreePath = associatedManagedWorktreePath(threadId)
        if (associatedWorktreePath != null) {
            return moveThreadToProjectPath(threadId, associatedWorktreePath)
        }

        val resolvedBaseBranch = baseBranch?.trim()?.takeIf(String::isNotEmpty)
            ?: state.value.gitBranchTargetsByThread[threadId]?.currentBranch?.trim()?.takeIf(String::isNotEmpty)
            ?: state.value.gitBranchTargetsByThread[threadId]?.defaultBranch?.trim()?.takeIf(String::isNotEmpty)
            ?: gitBranchesWithStatus(sourceProjectPath)?.defaultBranch?.trim()?.takeIf(String::isNotEmpty)
            ?: gitBranchesWithStatus(sourceProjectPath)?.currentBranch?.trim()?.takeIf(String::isNotEmpty)
            ?: return null

        val result = createManagedWorktree(
            cwd = sourceProjectPath,
            baseBranch = resolvedBaseBranch,
            changeTransfer = GitWorktreeChangeTransferMode.MOVE,
        ) ?: return null

        rememberAssociatedManagedWorktreePath(threadId, result.worktreePath)
        return moveThreadToProjectPath(threadId, result.worktreePath)
    }

    suspend fun handoffThreadToLocal(threadId: String): ThreadSummary? {
        val currentThread = state.value.threads.firstOrNull { it.id == threadId } ?: return null
        val sourceProjectPath = normalizedProjectPath(currentThread.cwd) ?: return null
        val branchTargets = state.value.gitBranchTargetsByThread[threadId] ?: gitBranchesWithStatus(sourceProjectPath)
        val localCheckoutPath = normalizedProjectPath(branchTargets?.localCheckoutPath) ?: return null

        transferManagedHandoff(
            cwd = sourceProjectPath,
            targetProjectPath = localCheckoutPath,
        ) ?: return null

        return moveThreadToProjectPath(threadId, localCheckoutPath)
    }

    suspend fun forkThreadToLocal(threadId: String): ThreadSummary? {
        val currentThread = state.value.threads.firstOrNull { it.id == threadId } ?: return null
        val branchTargets = state.value.gitBranchTargetsByThread[threadId]
            ?: currentThread.normalizedProjectPath?.let { projectPath ->
                gitBranchesWithStatus(projectPath)
            }
        val targetProjectPath = when {
            !currentThread.isManagedWorktreeProject -> normalizedProjectPath(currentThread.cwd)
            else -> normalizedProjectPath(branchTargets?.localCheckoutPath)
        } ?: return null

        return forkThreadToProjectPath(threadId, targetProjectPath)
    }

    suspend fun forkThreadToManagedWorktree(
        threadId: String,
        baseBranch: String? = null,
    ): ThreadSummary? {
        val currentThread = state.value.threads.firstOrNull { it.id == threadId } ?: return null
        val sourceProjectPath = normalizedProjectPath(currentThread.cwd) ?: return null
        val resolvedBaseBranch = baseBranch?.trim()?.takeIf(String::isNotEmpty)
            ?: state.value.gitBranchTargetsByThread[threadId]?.currentBranch?.trim()?.takeIf(String::isNotEmpty)
            ?: state.value.gitBranchTargetsByThread[threadId]?.defaultBranch?.trim()?.takeIf(String::isNotEmpty)
            ?: gitBranchesWithStatus(sourceProjectPath)?.defaultBranch?.trim()?.takeIf(String::isNotEmpty)
            ?: gitBranchesWithStatus(sourceProjectPath)?.currentBranch?.trim()?.takeIf(String::isNotEmpty)
            ?: return null

        val result = createManagedWorktree(
            cwd = sourceProjectPath,
            baseBranch = resolvedBaseBranch,
            changeTransfer = GitWorktreeChangeTransferMode.NONE,
        ) ?: return null

        return runCatching {
            forkThreadToProjectPath(threadId, result.worktreePath)
        }.getOrElse { failure ->
            if (!result.alreadyExisted) {
                runCatching {
                    removeManagedWorktree(result.worktreePath, branch = null)
                }
            }
            throw failure
        }
    }

    fun findLiveThreadForProjectPath(
        projectPath: String,
        currentThreadId: String? = null,
    ): ThreadSummary? {
        val resolvedComparableProjectPath = comparableProjectPath(projectPath) ?: return null
        val excludedThreadId = normalizedIdentifier(currentThreadId)
        return state.value.threads
            .asSequence()
            .filter { it.syncState == ThreadSyncState.LIVE }
            .filter { it.id != excludedThreadId }
            .firstOrNull { comparableProjectPath(it.normalizedProjectPath) == resolvedComparableProjectPath }
    }

    private fun parseGitRepoSyncResult(response: JsonObject): com.coderover.android.data.model.GitRepoSyncResult {
        val aheadCount = response.int("ahead") ?: response.int("unpushedCount") ?: 0
        val behindCount = response.int("behind") ?: response.int("unpulledCount") ?: 0
        val isDirty = response.bool("dirty") ?: response.bool("isDirty") ?: false
        val hasUnpushedCommits = response.bool("hasUnpushedCommits") ?: (aheadCount > 0)
        val hasUnpulledCommits = response.bool("hasUnpulledCommits") ?: (behindCount > 0)
        val hasDiverged = response.bool("hasDiverged") ?: ((aheadCount > 0) && (behindCount > 0))
        val isDetachedHead = response.bool("isDetachedHead") ?: false
        val branch = response.string("branch")
        val upstreamBranch = response.string("upstreamBranch") ?: response.string("tracking")
        val unstagedCount = response.int("unstagedCount") ?: 0
        val stagedCount = response.int("stagedCount") ?: 0
        val unpushedCount = response.int("unpushedCount") ?: aheadCount
        val unpulledCount = response.int("unpulledCount") ?: behindCount
        val untrackedCount = response.int("untrackedCount") ?: 0
        val localOnlyCommitCount = response.int("localOnlyCommitCount") ?: 0
        val repoRoot = response.string("repoRoot")
        val stateLabel = response.string("state") ?: "up_to_date"
        val canPush = response.bool("canPush") ?: hasUnpushedCommits
        val isPublishedToRemote = response.bool("publishedToRemote") ?: false
        val files = response["files"]?.jsonArrayOrNull()
            ?.mapNotNull { element ->
                val fileObject = element.jsonObjectOrNull() ?: return@mapNotNull null
                val path = fileObject.string("path")?.trim()?.takeIf(String::isNotEmpty) ?: return@mapNotNull null
                com.coderover.android.data.model.GitChangedFile(
                    path = path,
                    status = fileObject.string("status")?.trim().orEmpty(),
                )
            }
            .orEmpty()
        val repoDiffTotals = response["diff"]?.jsonObjectOrNull()?.let { diff ->
            val totals = com.coderover.android.data.model.GitDiffTotals(
                additions = diff.int("additions") ?: 0,
                deletions = diff.int("deletions") ?: 0,
                binaryFiles = diff.int("binaryFiles") ?: 0,
            )
            totals.takeIf { it.hasChanges }
        }

        return com.coderover.android.data.model.GitRepoSyncResult(
            isDirty = isDirty,
            hasUnpushedCommits = hasUnpushedCommits,
            hasUnpulledCommits = hasUnpulledCommits,
            hasDiverged = hasDiverged,
            isDetachedHead = isDetachedHead,
            branch = branch,
            upstreamBranch = upstreamBranch,
            unstagedCount = unstagedCount,
            stagedCount = stagedCount,
            unpushedCount = unpushedCount,
            unpulledCount = unpulledCount,
            untrackedCount = untrackedCount,
            localOnlyCommitCount = localOnlyCommitCount,
            repoRoot = repoRoot,
            state = stateLabel,
            canPush = canPush,
            isPublishedToRemote = isPublishedToRemote,
            files = files,
            repoDiffTotals = repoDiffTotals,
        )
    }

    private suspend fun createManagedWorktree(
        cwd: String,
        baseBranch: String,
        changeTransfer: GitWorktreeChangeTransferMode,
    ): GitCreateManagedWorktreeResult? {
        val normalizedCwd = normalizedProjectPath(cwd) ?: return null
        val normalizedBaseBranch = baseBranch.trim().takeIf(String::isNotEmpty) ?: return null
        val response = activeClient().sendRequest(
            "git/createManagedWorktree",
            buildJsonObject(
                "cwd" to JsonPrimitive(normalizedCwd),
                "baseBranch" to JsonPrimitive(normalizedBaseBranch),
                "changeTransfer" to JsonPrimitive(changeTransfer.wireValue),
            ),
        )?.jsonObjectOrNull() ?: return null

        val payload = response["result"]?.jsonObjectOrNull() ?: response
        val worktreePath = normalizedProjectPath(payload.string("worktreePath")) ?: return null
        return GitCreateManagedWorktreeResult(
            worktreePath = worktreePath,
            alreadyExisted = payload.bool("alreadyExisted") ?: false,
            baseBranch = payload.string("baseBranch").orEmpty(),
            headMode = payload.string("headMode").orEmpty(),
            transferredChanges = payload.bool("transferredChanges") ?: false,
        )
    }

    private suspend fun transferManagedHandoff(
        cwd: String,
        targetProjectPath: String,
    ): GitManagedHandoffTransferResult? {
        val normalizedCwd = normalizedProjectPath(cwd) ?: return null
        val normalizedTargetPath = normalizedProjectPath(targetProjectPath) ?: return null
        val response = activeClient().sendRequest(
            "git/transferManagedHandoff",
            buildJsonObject(
                "cwd" to JsonPrimitive(normalizedCwd),
                "targetPath" to JsonPrimitive(normalizedTargetPath),
            ),
        )?.jsonObjectOrNull() ?: return null

        val payload = response["result"]?.jsonObjectOrNull() ?: response
        return GitManagedHandoffTransferResult(
            success = payload.bool("success") ?: false,
            targetPath = normalizedProjectPath(payload.string("targetPath")),
            transferredChanges = payload.bool("transferredChanges") ?: false,
        )
    }

    private suspend fun removeManagedWorktree(
        cwd: String,
        branch: String?,
    ) {
        val normalizedCwd = normalizedProjectPath(cwd) ?: return
        activeClient().sendRequest(
            "git/removeWorktree",
            buildJsonObject(
                "cwd" to JsonPrimitive(normalizedCwd),
                "branch" to branch?.trim()?.takeIf(String::isNotEmpty)?.let(::JsonPrimitive),
            ),
        )
    }

    private suspend fun forkThreadToProjectPath(
        sourceThreadId: String,
        targetProjectPath: String,
    ): ThreadSummary? {
        val normalizedThreadId = normalizedIdentifier(sourceThreadId) ?: return null
        val normalizedProjectPath = normalizedProjectPath(targetProjectPath) ?: return null
        val sourceThread = state.value.threads.firstOrNull { it.id == normalizedThreadId } ?: return null

        val response = activeClient().sendRequest(
            "thread/fork",
            buildJsonObject("threadId" to JsonPrimitive(normalizedThreadId)),
        )?.jsonObjectOrNull() ?: return null

        val payload = response["result"]?.jsonObjectOrNull() ?: response
        val threadPayload = payload["thread"]?.jsonObjectOrNull() ?: return null
        val decodedThread = ThreadSummary.fromJson(threadPayload)
            ?.copy(
                cwd = normalizedProjectPath,
                syncState = ThreadSyncState.LIVE,
                model = ThreadSummary.fromJson(threadPayload)?.model ?: sourceThread.model,
                modelProvider = ThreadSummary.fromJson(threadPayload)?.modelProvider ?: sourceThread.modelProvider,
            )
            ?: return null

        updateState {
            copy(
                threads = upsertThread(threads, decodedThread, treatAsServerState = true),
                selectedThreadId = decodedThread.id,
                lastErrorMessage = null,
            )
        }

        beginAuthoritativeProjectPathTransition(decodedThread.id, normalizedProjectPath)
        if (decodedThread.isManagedWorktreeProject) {
            rememberAssociatedManagedWorktreePath(decodedThread.id, normalizedProjectPath)
        }

        val resumedThread = ensureThreadResumed(
            threadId = decodedThread.id,
            preferredProjectPath = normalizedProjectPath,
            modelIdentifierOverride = sourceThread.model,
        )
        val targetThread = resumedThread ?: state.value.threads.firstOrNull { it.id == decodedThread.id } ?: decodedThread
        selectThread(targetThread.id)
        refreshThreadHistory(targetThread.id, reason = "fork-thread")
        return targetThread
    }

    private suspend fun moveThreadToProjectPath(
        threadId: String,
        projectPath: String,
    ): ThreadSummary? {
        val normalizedThreadId = normalizedIdentifier(threadId) ?: return null
        val normalizedProjectPath = normalizedProjectPath(projectPath) ?: return null
        val currentThread = state.value.threads.firstOrNull { it.id == normalizedThreadId } ?: return null
        val previousAuthoritativeProjectPath = authoritativeProjectPathByThreadId[normalizedThreadId]
        val previousAssociatedManagedWorktreePath = associatedManagedWorktreePath(normalizedThreadId)
        val previousThread = currentThread

        beginAuthoritativeProjectPathTransition(normalizedThreadId, normalizedProjectPath)
        if (isManagedWorktreePath(normalizedProjectPath)) {
            rememberAssociatedManagedWorktreePath(normalizedThreadId, normalizedProjectPath)
        }

        updateState {
            val reboundThread = currentThread.copy(
                cwd = normalizedProjectPath,
                updatedAt = System.currentTimeMillis(),
            )
            copy(
                threads = upsertThread(threads, reboundThread),
                selectedThreadId = normalizedThreadId,
                readyThreadIds = readyThreadIds - normalizedThreadId,
                failedThreadIds = failedThreadIds - normalizedThreadId,
                lastErrorMessage = null,
            )
        }

        return try {
            val resumedThread = ensureThreadResumed(
                threadId = normalizedThreadId,
                preferredProjectPath = normalizedProjectPath,
                modelIdentifierOverride = currentThread.model,
            )
            refreshThreadHistory(normalizedThreadId, reason = "project-rebind")
            resumedThread ?: state.value.threads.firstOrNull { it.id == normalizedThreadId }
        } catch (failure: Throwable) {
            if (shouldAllowProjectRebindWithoutResume(failure)) {
                state.value.threads.firstOrNull { it.id == normalizedThreadId }
            } else {
                restoreThreadProjectBinding(
                    thread = previousThread,
                    authoritativeProjectPath = previousAuthoritativeProjectPath,
                    associatedManagedWorktreePath = previousAssociatedManagedWorktreePath,
                )
                throw failure
            }
        }
    }

    private fun resolveThreadIdForCwd(cwd: String): String? {
        return state.value.selectedThreadId?.takeIf { selectedId ->
            state.value.threads.firstOrNull { it.id == selectedId }?.cwd == cwd
        } ?: state.value.threads.firstOrNull { it.cwd == cwd }?.id
    }

    private fun updateGitRepoSync(
        threadId: String?,
        result: com.coderover.android.data.model.GitRepoSyncResult,
    ) {
        updateState {
            copy(
                gitRepoSyncByThread = if (threadId == null) {
                    gitRepoSyncByThread
                } else {
                    gitRepoSyncByThread + (threadId to result)
                }
            )
        }
    }

    suspend fun gitDiff(cwd: String): String? {
        val params = buildJsonObject("cwd" to JsonPrimitive(cwd))
        val response = activeClient().sendRequest("git/diff", params)?.jsonObjectOrNull() ?: return null
        return response.string("patch")
            ?: response.string("diff")
            ?: response["result"]?.jsonObjectOrNull()?.string("patch")
    }

    suspend fun gitCommit(cwd: String, message: String) {
        val params = buildJsonObject(
            "cwd" to JsonPrimitive(cwd),
            "message" to JsonPrimitive(message)
        )
        activeClient().sendRequest("git/commit", params)
    }
    
    suspend fun performGitAction(cwd: String, action: com.coderover.android.data.model.TurnGitActionKind, threadId: String) {
        val params = buildJsonObject("cwd" to JsonPrimitive(cwd))
        updateState { copy(runningGitActionByThread = runningGitActionByThread + (threadId to action)) }
        try {
            when (action) {
                com.coderover.android.data.model.TurnGitActionKind.DISCARD_LOCAL_CHANGES -> {
                    activeClient().sendRequest("git/discard", params)
                    activeClient().sendRequest("git/sync", params)
                }
                else -> {
                    val method = when (action) {
                        com.coderover.android.data.model.TurnGitActionKind.SYNC_NOW -> "git/sync"
                        com.coderover.android.data.model.TurnGitActionKind.PUSH -> "git/push"
                        com.coderover.android.data.model.TurnGitActionKind.COMMIT -> "git/commit"
                        com.coderover.android.data.model.TurnGitActionKind.COMMIT_AND_PUSH -> "git/commitAndPush"
                        com.coderover.android.data.model.TurnGitActionKind.CREATE_PR -> "git/createPR"
                        com.coderover.android.data.model.TurnGitActionKind.DISCARD_LOCAL_CHANGES -> error("unreachable")
                    }
                    activeClient().sendRequest(method, params)
                }
            }
        } finally {
            updateState { copy(runningGitActionByThread = runningGitActionByThread - threadId) }
        }
    }

    suspend fun restartDesktopApp(providerId: String, threadId: String) {
        val normalizedProviderId = normalizeProviderId(providerId)
        val normalizedThreadId = threadId.trim()
        if (normalizedThreadId.isEmpty()) {
            val message = "This chat does not have a valid thread id yet."
            updateError(message)
            throw IllegalArgumentException(message)
        }

        val client = try {
            activeClient()
        } catch (error: IllegalStateException) {
            val message = "Not connected to your Mac."
            updateError(message)
            throw IllegalStateException(message, error)
        }

        val params = buildJsonObject(
            "provider" to JsonPrimitive(normalizedProviderId),
            "threadId" to JsonPrimitive(normalizedThreadId),
        )

        try {
            val response = client.sendRequest("desktop/restartApp", params)?.jsonObjectOrNull()
                ?: throw IllegalStateException("The Mac bridge did not return a valid response.")
            if (response.bool("success") != true) {
                throw IllegalStateException("The Mac bridge did not return a valid response.")
            }
        } catch (error: CodeRoverServiceException) {
            val message = desktopRestartErrorMessage(
                errorCode = error.data?.string("errorCode"),
                fallback = error.message,
            )
            updateError(message)
            throw IllegalStateException(message, error)
        } catch (error: TimeoutCancellationException) {
            val message = "The Mac bridge did not respond in time. Reconnect and try again."
            updateError(message)
            throw IllegalStateException(message, error)
        } catch (error: IllegalStateException) {
            updateError(error.message ?: "Could not restart the desktop app on your Mac.")
            throw error
        }
    }


    private suspend fun initializeSession(updatePhase: Boolean = true) {
        if (updatePhase) {
            updateState { copy(connectionPhase = ConnectionPhase.SYNCING) }
        }
        val client = activeClient()
        val clientInfo = JsonObject(
            mapOf(
                "name" to JsonPrimitive("coderover_android"),
                "title" to JsonPrimitive("CodeRover Android"),
                "version" to JsonPrimitive(AppInfo.VERSION_NAME),
            ),
        )
        runCatching {
            client.sendRequest(
                method = "initialize",
                params = JsonObject(
                    mapOf(
                        "clientInfo" to clientInfo,
                        "capabilities" to JsonObject(
                            mapOf(
                                "experimentalApi" to JsonPrimitive(true),
                            ),
                        ),
                    ),
                ),
            )
        }.recoverCatching {
            client.sendRequest(
                method = "initialize",
                params = JsonObject(
                    mapOf(
                        "clientInfo" to clientInfo,
                    ),
                ),
            )
        }.getOrThrow()
        client.sendNotification("initialized", null)
    }

    private suspend fun listProviders() {
        val result = activeClient().sendRequest(
            method = "runtime/provider/list",
            params = null,
        )?.jsonObjectOrNull() ?: return
        val providers = (
            result["providers"]?.jsonArrayOrNull()
                ?: result["items"]?.jsonArrayOrNull()
                ?: JsonArray(emptyList())
            ).mapNotNull { it.jsonObjectOrNull()?.let(RuntimeProvider::fromJson) }
        val normalizedProviders = if (providers.isEmpty()) {
            listOf(RuntimeProvider.CODEX_DEFAULT)
        } else {
            providers
        }
        val selectedProviderId = normalizeProviderId(
            state.value.selectedProviderId.takeIf { selectedId ->
                normalizedProviders.any { it.id == selectedId }
            } ?: normalizedProviders.firstOrNull()?.id,
        )
        store.saveSelectedProviderId(selectedProviderId)
        updateState {
            copy(
                availableProviders = normalizedProviders,
                selectedProviderId = selectedProviderId,
            )
        }
    }

    private suspend fun refreshBridgeMetadataInternal() {
        if (!state.value.isConnected) {
            updateState {
                copy(
                    bridgeStatus = null,
                    bridgeUpdatePrompt = null,
                    isLoadingBridgeStatus = false,
                )
            }
            return
        }

        updateState { copy(isLoadingBridgeStatus = true) }

        val nextStatus = runCatching {
            activeClient().sendRequest("bridge/status/read", JsonObject(emptyMap()))
                ?.jsonObjectOrNull()
                ?.let(BridgeStatus::fromJson)
        }.onFailure { failure ->
            Log.w(TAG, "bridge/status/read failed", failure)
        }.getOrNull()

        val nextPrompt = runCatching {
            activeClient().sendRequest("bridge/updatePrompt/read", JsonObject(emptyMap()))
                ?.jsonObjectOrNull()
                ?.let(BridgeUpdatePrompt::fromJson)
        }.onFailure { failure ->
            Log.w(TAG, "bridge/updatePrompt/read failed", failure)
        }.getOrNull()

        Log.d(
            TAG,
            "bridge metadata refresh status=${nextStatus != null} prompt=${nextPrompt != null} candidates=${nextStatus?.transportCandidates?.size ?: 0}",
        )

        updateState {
            copy(
                bridgeStatus = nextStatus,
                bridgeUpdatePrompt = nextPrompt,
                isLoadingBridgeStatus = false,
            )
        }

        nextStatus?.transportCandidates
            ?.takeIf { it.isNotEmpty() }
            ?.let { transportCandidates ->
                Log.d(TAG, "bridge status returned ${transportCandidates.size} transport candidate(s)")
                refreshActivePairingTransportCandidates(transportCandidates)
            }
    }

    private suspend fun updateBridgeKeepAwakeEnabled(enabled: Boolean) {
        val previousStatus = state.value.bridgeStatus
        if (previousStatus != null) {
            updateState {
                copy(
                    bridgeStatus = previousStatus.copy(
                        keepAwakeEnabled = enabled,
                        keepAwakeActive = enabled,
                    ),
                )
            }
        }

        val response = runCatching {
            activeClient().sendRequest(
                "bridge/preferences/update",
                JsonObject(mapOf("keepAwakeEnabled" to JsonPrimitive(enabled))),
            )?.jsonObjectOrNull()
        }.getOrNull()

        if (response == null) {
            updateState { copy(bridgeStatus = previousStatus) }
            return
        }

        val preferences = response["preferences"]?.jsonObjectOrNull()
        val keepAwakeEnabled = response.bool("keepAwakeEnabled")
            ?: preferences?.bool("keepAwakeEnabled")
            ?: enabled
        val keepAwakeActive = response.bool("keepAwakeActive") ?: enabled
        updateState {
            copy(
                bridgeStatus = (bridgeStatus ?: previousStatus)?.copy(
                    keepAwakeEnabled = keepAwakeEnabled,
                    keepAwakeActive = keepAwakeActive,
                ) ?: previousStatus,
            )
        }
    }

    private suspend fun listModels(providerId: String? = null) {
        val resolvedProviderId = normalizeProviderId(providerId ?: currentRuntimeProviderId())
        val result = activeClient().sendRequest(
            method = "model/list",
            params = JsonObject(
                mapOf(
                    "provider" to JsonPrimitive(resolvedProviderId),
                    "cursor" to JsonNull,
                    "limit" to JsonPrimitive(50),
                    "includeHidden" to JsonPrimitive(false),
                ),
            ),
        )?.jsonObjectOrNull() ?: return
        val models = (
            result["items"]?.jsonArrayOrNull()
                ?: result["data"]?.jsonArrayOrNull()
                ?: result["models"]?.jsonArrayOrNull()
                ?: JsonArray(emptyList())
            ).mapNotNull { it.jsonObjectOrNull()?.let(ModelOption::fromJson) }
        val storedModelId = store.loadSelectedModelId(resolvedProviderId)
        val selectedModel = storedModelId
            ?.let { wanted -> models.firstOrNull { it.id == wanted || it.model == wanted } }
            ?: models.firstOrNull { it.isDefault }
            ?: models.firstOrNull()
            ?: state.value.availableProviders.firstOrNull { it.id == resolvedProviderId }?.defaultModelId?.let { fallbackModelId ->
                models.firstOrNull { it.id == fallbackModelId || it.model == fallbackModelId }
            }
        val storedReasoningEffort = store.loadSelectedReasoningEffort(resolvedProviderId)
        val reasoning = selectedModel?.supportedReasoningEfforts?.firstOrNull()
        val resolvedReasoning = storedReasoningEffort
            ?.takeIf { effort -> selectedModel?.supportedReasoningEfforts?.contains(effort) == true }
            ?: selectedModel?.defaultReasoningEffort
            ?: reasoning

        updateState {
            copy(
                availableModels = models,
                selectedModelId = selectedModel?.id,
                selectedReasoningEffort = resolvedReasoning,
            )
        }
        store.saveSelectedModelId(state.value.selectedModelId, resolvedProviderId)
        store.saveSelectedReasoningEffort(state.value.selectedReasoningEffort, resolvedProviderId)
    }

    private suspend fun syncRuntimeSelectionContext(
        providerId: String,
        refreshModels: Boolean,
    ) {
        val resolvedProviderId = normalizeProviderId(providerId)
        updateState {
            copy(
                accessMode = store.loadAccessMode(resolvedProviderId),
                selectedModelId = store.loadSelectedModelId(resolvedProviderId),
                selectedReasoningEffort = store.loadSelectedReasoningEffort(resolvedProviderId),
            )
        }
        if (refreshModels) {
            listModels(resolvedProviderId)
        }
    }

    private suspend fun listThreads(updatePhase: Boolean = true) {
        if (updatePhase) {
            updateState { copy(connectionPhase = ConnectionPhase.LOADING_CHATS) }
        }
        val activePage = fetchThreadsPage(archived = false)
        val activeThreads = activePage.threads
        activeThreadListNextCursor = activePage.nextCursor
        activeThreadListHasMore = activePage.hasMore
        applyThreadListSnapshot(
            activeThreads = activeThreads,
            archivedThreads = null,
            updatePhase = updatePhase,
            preserveExistingArchivedThreads = true,
        )

        scope.launch {
            runCatching {
                fetchThreads(archived = true)
            }.onSuccess { archivedThreads ->
                val latestActiveThreads = state.value.threads
                    .filter { it.syncState != ThreadSyncState.ARCHIVED_LOCAL }
                    .ifEmpty { activeThreads }
                applyThreadListSnapshot(
                    activeThreads = latestActiveThreads,
                    archivedThreads = archivedThreads,
                    updatePhase = false,
                    preserveExistingArchivedThreads = false,
                )
            }.onFailure { failure ->
                Log.w(TAG, "thread/list archived fetch failed (non-fatal)", failure)
            }
        }
    }

    private suspend fun fetchThreadsPage(
        archived: Boolean,
        cursor: JsonElement? = JsonNull,
    ): ThreadListPage {
        val params = buildJsonObject(
            "cursor" to (cursor ?: JsonNull),
            "limit" to JsonPrimitive(60),
            "archived" to if (archived) JsonPrimitive(true) else null,
            "sourceKinds" to JsonArray(
                listOf(
                    JsonPrimitive("cli"),
                    JsonPrimitive("vscode"),
                    JsonPrimitive("appServer"),
                    JsonPrimitive("exec"),
                    JsonPrimitive("unknown"),
                ),
            ),
        )
        val result = activeClient().sendRequest("thread/list", params)?.jsonObjectOrNull() ?: return ThreadListPage(
            threads = emptyList(),
            nextCursor = JsonNull,
            hasMore = false,
        )
        val items = result["data"]?.jsonArrayOrNull()
            ?: result["items"]?.jsonArrayOrNull()
            ?: result["threads"]?.jsonArrayOrNull()
            ?: JsonArray(emptyList())
        val threads = items
            .mapNotNull { it.jsonObjectOrNull()?.let(ThreadSummary::fromJson) }
            .map { thread ->
                if (archived) {
                    thread.copy(syncState = ThreadSyncState.ARCHIVED_LOCAL)
                } else {
                    thread.copy(syncState = ThreadSyncState.LIVE)
                }
            }
        val nextCursor = result["nextCursor"] ?: result["next_cursor"] ?: JsonNull
        return ThreadListPage(
            threads = threads,
            nextCursor = nextCursor,
            hasMore = !nextCursor.isNullLike(),
        )
    }

    private suspend fun fetchThreads(archived: Boolean): List<ThreadSummary> {
        return fetchThreadsPage(archived = archived).threads
    }

    suspend fun loadMoreThreadsForProject(projectKey: String, minimumVisibleCount: Int) {
        if (!activeThreadListHasMore) {
            return
        }

        var currentCount = state.value.threads
            .filter { it.syncState == ThreadSyncState.LIVE && (it.normalizedProjectPath ?: "__no_project__") == projectKey }
            .size
        while (currentCount < minimumVisibleCount && activeThreadListHasMore) {
            val page = fetchThreadsPage(archived = false, cursor = activeThreadListNextCursor)
            activeThreadListNextCursor = page.nextCursor
            activeThreadListHasMore = page.hasMore
            applyThreadListSnapshot(
                activeThreads = page.threads,
                archivedThreads = null,
                updatePhase = false,
                preserveExistingArchivedThreads = true,
            )
            currentCount = state.value.threads
                .filter { it.syncState == ThreadSyncState.LIVE && (it.normalizedProjectPath ?: "__no_project__") == projectKey }
                .size
        }
    }

    private fun applyThreadListSnapshot(
        activeThreads: List<ThreadSummary>,
        archivedThreads: List<ThreadSummary>?,
        updatePhase: Boolean,
        preserveExistingArchivedThreads: Boolean,
    ) {
        updateState {
            val existingSyntheticSubagentThreads = threads.filter { existingThread ->
                existingThread.syncState == ThreadSyncState.LIVE &&
                    existingThread.isSubagent &&
                    activeThreads.none { it.id == existingThread.id } &&
                    archivedThreads?.none { it.id == existingThread.id } != false
            }
            val existingArchivedThreads = if (preserveExistingArchivedThreads) {
                threads.filter { it.syncState == ThreadSyncState.ARCHIVED_LOCAL }
            } else {
                emptyList()
            }
            val combined = mergeThreadLists(
                activeThreads = activeThreads + existingSyntheticSubagentThreads,
                archivedThreads = archivedThreads ?: existingArchivedThreads,
            )
            val resolvedSelectedThreadId = selectedThreadId
                ?.takeIf { selectedId -> combined.any { it.id == selectedId } }
                ?: combined.firstOrNull()?.id
            copy(
                threads = combined,
                selectedThreadId = resolvedSelectedThreadId,
                connectionPhase = if (updatePhase) ConnectionPhase.CONNECTED else connectionPhase,
            )
        }
    }

    private fun mergeThreadLists(
        activeThreads: List<ThreadSummary>,
        archivedThreads: List<ThreadSummary>,
    ): List<ThreadSummary> {
        var mergedThreads = emptyList<ThreadSummary>()
        (activeThreads + archivedThreads).forEach { thread ->
            mergedThreads = upsertThread(mergedThreads, thread)
        }
        return mergedThreads.sortedByDescending { it.updatedAt ?: it.createdAt ?: 0L }
    }

    private suspend fun loadThreadHistory(threadId: String) {
        val currentState = state.value
        val hasLocalMessages = currentState.messagesByThread[threadId].orEmpty().isNotEmpty()
        val newestCursor = normalizedHistoryCursor(currentState.historyStateByThread[threadId]?.newestCursor)
        if (shouldPreferTailReloadForManagedHistory(threadId)) {
            loadTailThreadHistory(
                threadId = threadId,
                replaceLocalHistory = shouldReplaceLocalHistoryWithTailSnapshot(
                    threadId = threadId,
                    hasLocalMessages = hasLocalMessages,
                    hasNewestCursor = newestCursor != null,
                ),
                fallbackThreadObject = null,
                prefetchOlderInBackground = !hasLocalMessages,
            )
        } else if (hasLocalMessages && newestCursor != null) {
            catchUpThreadHistoryToLatest(
                threadId = threadId,
                initialCursor = newestCursor,
                allowTailFallback = true,
                fallbackThreadObject = null,
            )
        } else {
            loadTailThreadHistory(
                threadId = threadId,
                replaceLocalHistory = shouldReplaceLocalHistoryWithTailSnapshot(
                    threadId = threadId,
                    hasLocalMessages = hasLocalMessages,
                    hasNewestCursor = newestCursor != null,
                ),
                fallbackThreadObject = null,
                prefetchOlderInBackground = !hasLocalMessages,
            )
        }
    }

    private fun shouldPreferTailReloadForManagedHistory(threadId: String): Boolean {
        val provider = state.value.threads
            .firstOrNull { it.id == threadId }
            ?.provider
            ?.trim()
            ?.lowercase()
            .orEmpty()
        return provider.isNotEmpty() && provider != "codex"
    }

    private suspend fun loadTailThreadHistory(
        threadId: String,
        replaceLocalHistory: Boolean,
        fallbackThreadObject: JsonObject?,
        prefetchOlderInBackground: Boolean = false,
    ) {
        val historyResult = try {
            activeClient().sendRequest(
                method = "thread/read",
                params = buildJsonObject(
                    "threadId" to JsonPrimitive(threadId),
                    "history" to buildJsonObject(
                        "mode" to JsonPrimitive("tail"),
                        "limit" to JsonPrimitive(50),
                    ),
                ),
            )?.jsonObjectOrNull()
        } catch (failure: Throwable) {
            if (fallbackThreadObject == null) {
                throw failure
            }
            Log.w(TAG, "thread/read tail refresh failed; falling back to resume snapshot threadId=$threadId", failure)
            null
        }
        val threadObject = historyResult?.threadPayload() ?: fallbackThreadObject ?: return
        val summaryThreadObject = fallbackThreadObject ?: threadObject
        ThreadSummary.fromJson(summaryThreadObject)?.let { thread ->
            updateState {
                copy(threads = upsertThread(threads, thread.copy(syncState = ThreadSyncState.LIVE)))
            }
        }
        extractContextWindowUsageIfAvailable(threadId, threadObject)
        val history = decodeMessagesFromThreadRead(
            threadId = threadId,
            threadObject = threadObject,
            latestLimit = 50,
        )
        val historyWindow = decodeHistoryWindow(historyResult, history)
        val syncMetadata = decodeThreadSyncMetadata(historyResult ?: threadObject)
        if (!acceptThreadSyncMetadata(
                threadId = threadId,
                syncEpoch = historyWindow.syncEpoch,
                sourceKind = historyWindow.projectionSource ?: syncMetadata.sourceKind,
                generation = currentRefreshGeneration(threadId),
            )
        ) {
            return
        }
        val activeTurnId = resolveActiveTurnId(summaryThreadObject)
        applyHistoryWindow(
            threadId = threadId,
            mode = "tail",
            history = history,
            historyWindow = historyWindow,
            replaceLocalHistory = replaceLocalHistory,
            activeTurnId = activeTurnId,
            replaceRunningState = true,
        )
        if (prefetchOlderInBackground && historyWindow.hasOlder) {
            scheduleOlderHistoryBackfill(threadId)
        }
    }

    private suspend fun loadNewerThreadHistoryIfNeeded(
        threadId: String,
        cursor: String,
    ): NewerHistoryResult {
        val result = activeClient().sendRequest(
            method = "thread/read",
            params = buildJsonObject(
                "threadId" to JsonPrimitive(threadId),
                "history" to buildJsonObject(
                    "mode" to JsonPrimitive("after"),
                    "limit" to JsonPrimitive(50),
                    "cursor" to JsonPrimitive(cursor),
                ),
            ),
        )?.jsonObjectOrNull() ?: return NewerHistoryResult(cursor, false, false, 0)
        val threadObject = result.threadPayload() ?: return NewerHistoryResult(cursor, false, false, 0)
        ThreadSummary.fromJson(threadObject)?.let { thread ->
            updateState {
                copy(threads = upsertThread(threads, thread.copy(syncState = ThreadSyncState.LIVE)))
            }
        }
        extractContextWindowUsageIfAvailable(threadId, threadObject)
        val history = decodeMessagesFromThreadRead(threadId, threadObject)
        val historyWindow = decodeHistoryWindow(result, history)
        val syncMetadata = decodeThreadSyncMetadata(result)
        if (!acceptThreadSyncMetadata(
                threadId = threadId,
                syncEpoch = historyWindow.syncEpoch,
                sourceKind = historyWindow.projectionSource ?: syncMetadata.sourceKind,
                generation = currentRefreshGeneration(threadId),
            )
        ) {
            return NewerHistoryResult(cursor, historyWindow.hasNewer, false, 0)
        }
        val activeTurnId = resolveActiveTurnId(threadObject)
        applyHistoryWindow(
            threadId = threadId,
            mode = "after",
            history = history,
            historyWindow = historyWindow,
            replaceLocalHistory = false,
            activeTurnId = activeTurnId,
            replaceRunningState = false,
        )
        val nextCursor = normalizedHistoryCursor(historyWindow.newerCursor) ?: cursor
        return NewerHistoryResult(
            newestCursor = nextCursor,
            hasNewer = historyWindow.hasNewer,
            didAdvance = history.isNotEmpty() && nextCursor != cursor,
            itemCount = history.size,
        )
    }

    suspend fun loadOlderThreadHistory(threadId: String) {
        val currentState = state.value
        val historyState = currentState.historyStateByThread[threadId]
        val requestCursor = nextOlderHistoryCursor(historyState)
        if (requestCursor == null) {
            refreshThreadHistory(threadId, reason = "older-bootstrap-empty")
            return
        }

        updateState {
            copy(
                historyStateByThread = historyStateByThread + (
                    threadId to (historyState ?: ThreadHistoryState()).copy(isLoadingOlder = true)
                ),
            )
        }

        runCatching {
            activeClient().sendRequest(
                method = "thread/read",
                params = buildJsonObject(
                    "threadId" to JsonPrimitive(threadId),
                    "history" to buildJsonObject(
                        "mode" to JsonPrimitive("before"),
                        "limit" to JsonPrimitive(50),
                        "cursor" to JsonPrimitive(requestCursor),
                    ),
                ),
            )?.jsonObjectOrNull()
        }.onSuccess { result ->
            val threadObject = result?.threadPayload() ?: return@onSuccess
            val history = decodeMessagesFromThreadRead(threadId, threadObject)
            val historyWindow = decodeHistoryWindow(result, history)
            val syncMetadata = decodeThreadSyncMetadata(result)
            if (!acceptThreadSyncMetadata(
                    threadId = threadId,
                    syncEpoch = historyWindow.syncEpoch,
                    sourceKind = historyWindow.projectionSource ?: syncMetadata.sourceKind,
                    generation = currentRefreshGeneration(threadId),
                )
            ) {
                return@onSuccess
            }
            applyHistoryWindow(
                threadId = threadId,
                mode = "before",
                history = history,
                historyWindow = historyWindow,
                replaceLocalHistory = false,
            )
        }.onFailure {
            updateState {
                copy(
                    historyStateByThread = historyStateByThread + (
                        threadId to ((historyStateByThread[threadId] ?: ThreadHistoryState()).copy(isLoadingOlder = false))
                    ),
                )
            }
        }
    }

    private fun applyHistoryWindow(
        threadId: String,
        mode: String,
        history: List<ChatMessage>,
        historyWindow: HistoryWindowState,
        replaceLocalHistory: Boolean,
        activeTurnId: String? = null,
        replaceRunningState: Boolean = false,
    ) {
        val currentState = state.value
        val existingMessages = currentState.messagesByThread[threadId].orEmpty()
        val mergedCanonicalWindow = history.any(::isCanonicalTimelineMessage) && !replaceLocalHistory
        val shouldMarkForCanonicalReconcile = mergedCanonicalWindow &&
            (currentState.runningThreadIds.contains(threadId) || threadId in resumeSeededHistoryThreadIds)
        val renderedMessages = if (history.any(::isCanonicalTimelineMessage)) {
            val canonicalMessages = if (replaceLocalHistory) {
                synchronizeThreadTimelineState(
                    threadId = threadId,
                    canonicalMessages = history,
                )
            } else {
                mergeCanonicalHistoryIntoTimelineState(
                    threadId = threadId,
                    historyMessages = history,
                    mode = mode,
                    activeThreadIds = currentState.activeTurnIdByThread.keys,
                    runningThreadIds = currentState.runningThreadIds,
                )
            }
            canonicalMessages
        } else {
            if (replaceLocalHistory) {
                history
            } else {
                mergeHistoryMessages(existingMessages, history)
            }
        }
        val nextMessages = if (replaceLocalHistory || history.isNotEmpty()) {
            currentState.messagesByThread + (threadId to renderedMessages)
        } else {
            currentState.messagesByThread
        }
        val timelineMessages = nextMessages[threadId].orEmpty()

        updateState {
            copy(
                messagesByThread = nextMessages,
                historyStateByThread = historyStateByThread + (
                    threadId to mergeHistoryState(
                        currentState = historyStateByThread[threadId],
                        historyWindow = historyWindow,
                        mode = mode,
                    )
                ),
                activeTurnIdByThread = when {
                    activeTurnId == null && replaceRunningState -> activeTurnIdByThread - threadId
                    activeTurnId == null -> activeTurnIdByThread
                    else -> activeTurnIdByThread + (threadId to activeTurnId)
                },
                runningThreadIds = when {
                    activeTurnId == null && replaceRunningState -> runningThreadIds - threadId
                    activeTurnId == null -> runningThreadIds
                    else -> runningThreadIds + threadId
                },
                readyThreadIds = readyThreadIds - threadId,
                failedThreadIds = failedThreadIds - threadId,
                threads = if (timelineMessages.isNotEmpty()) {
                    threads.refreshThreadSummaryFromMessages(threadId, timelineMessages)
                } else {
                    threads
                },
            )
        }

        if (shouldMarkForCanonicalReconcile) {
            markThreadNeedingCanonicalHistoryReconcile(threadId)
        } else if (!state.value.threadHasActiveOrRunningTurn(threadId) && threadId !in resumeSeededHistoryThreadIds) {
            markThreadCanonicalHistoryReconciled(threadId)
        }

        if (!state.value.threadHasActiveOrRunningTurn(threadId)) {
            scheduleCanonicalHistoryReconcileIfNeeded(threadId)
        }
    }

    private fun newestHistoryCursor(threadId: String): String? {
        return normalizedHistoryCursor(state.value.historyStateByThread[threadId]?.newestCursor)
    }

    private fun nextOlderHistoryCursor(historyState: ThreadHistoryState?): String? {
        if (historyState?.hasOlderOnServer != true) {
            return null
        }
        return normalizedHistoryCursor(historyState.oldestCursor)
    }

    private suspend fun catchUpRealtimeHistoryToLatest(threadId: String) {
        var cursor = newestHistoryCursor(threadId)
        if (cursor == null) {
            refreshThreadHistory(threadId, reason = "realtime-no-cursor")
            cursor = newestHistoryCursor(threadId) ?: return
        }

        catchUpThreadHistoryToLatest(
            threadId = threadId,
            initialCursor = cursor,
            allowTailFallback = true,
        )
    }

    private suspend fun catchUpThreadHistoryToLatest(
        threadId: String,
        initialCursor: String,
        allowTailFallback: Boolean,
        fallbackThreadObject: JsonObject? = null,
    ) {
        var cursor = initialCursor
        var pageCount = 0
        var itemCount = 0

        while (pageCount < 200 && itemCount < 10_000) {
            try {
                val result = loadNewerThreadHistoryIfNeeded(threadId, cursor)
                val nextCursor = normalizedHistoryCursor(result.newestCursor)
                if (!result.didAdvance || nextCursor == null) {
                    break
                }
                cursor = nextCursor
                pageCount += 1
                itemCount += maxOf(result.itemCount, 1)
                if (!result.hasNewer) {
                    break
                }
            } catch (failure: Throwable) {
                if (!allowTailFallback || !isInvalidHistoryCursorError(failure)) {
                    throw failure
                }
                loadTailThreadHistory(
                    threadId = threadId,
                    replaceLocalHistory = shouldReplaceLocalHistoryWithTailSnapshot(
                        threadId = threadId,
                        hasLocalMessages = state.value.messagesByThread[threadId].orEmpty().isNotEmpty(),
                        hasNewestCursor = normalizedHistoryCursor(state.value.historyStateByThread[threadId]?.newestCursor) != null,
                    ),
                    fallbackThreadObject = fallbackThreadObject,
                )
                break
            }
        }
    }

    private fun scheduleRealtimeHistoryCatchUp(
        threadId: String,
        itemId: String?,
        previousItemId: String?,
        cursor: String?,
        previousCursor: String?,
    ) {
        if (!shouldCatchUpRealtimeHistory(
                threadId = threadId,
                turnId = state.value.activeTurnIdByThread[threadId],
                itemId = itemId,
                previousItemId = previousItemId,
                cursor = cursor,
                previousCursor = previousCursor,
            )
        ) {
            return
        }
        enqueueRealtimeHistoryCatchUp(threadId)
    }

    private fun scheduleThreadHistoryCatchUp(threadId: String) {
        val currentState = state.value
        if (!currentState.isConnected || currentState.selectedThreadId != threadId) {
            return
        }
        enqueueHistoryChangedRefresh(threadId)
    }

    private fun enqueueHistoryChangedRefresh(threadId: String) {
        scope.launch {
            val currentJob = kotlinx.coroutines.currentCoroutineContext()[Job]
            val shouldStart = realtimeHistoryCatchUpMutex.withLock {
                pendingHistoryChangedRefreshThreadIds += threadId
                val existingTask = historyChangedRefreshTaskByThread[threadId]
                if (existingTask?.isActive == true) {
                    false
                } else {
                    if (currentJob != null) {
                        historyChangedRefreshTaskByThread[threadId] = currentJob
                    }
                    true
                }
            }
            if (!shouldStart) {
                return@launch
            }
            while (true) {
                realtimeHistoryCatchUpMutex.withLock {
                    pendingHistoryChangedRefreshThreadIds.remove(threadId)
                }
                if (isThreadHistoryRefreshBusy(threadId)) {
                    delay(150)
                    realtimeHistoryCatchUpMutex.withLock {
                        pendingHistoryChangedRefreshThreadIds += threadId
                    }
                } else {
                    runCatching {
                        loadTailThreadHistory(
                            threadId = threadId,
                            replaceLocalHistory = false,
                            fallbackThreadObject = null,
                        )
                    }.onFailure { failure ->
                        Log.w(TAG, "history-changed tail refresh failed threadId=$threadId", failure)
                    }
                }
                val shouldContinue = realtimeHistoryCatchUpMutex.withLock {
                    pendingHistoryChangedRefreshThreadIds.contains(threadId)
                }
                if (!shouldContinue) {
                    realtimeHistoryCatchUpMutex.withLock {
                        val existingTask = historyChangedRefreshTaskByThread[threadId]
                        if (existingTask === currentJob || existingTask?.isActive != true) {
                            historyChangedRefreshTaskByThread.remove(threadId)
                        }
                    }
                    return@launch
                }
            }
        }
    }

    private fun enqueueRealtimeHistoryCatchUp(threadId: String) {
        scope.launch {
            val currentJob = kotlinx.coroutines.currentCoroutineContext()[Job]
            val shouldStart = realtimeHistoryCatchUpMutex.withLock {
                pendingRealtimeHistoryCatchUpThreadIds += threadId
                val existingTask = realtimeHistoryCatchUpTaskByThread[threadId]
                if (existingTask?.isActive == true) {
                    false
                } else {
                    if (currentJob != null) {
                        realtimeHistoryCatchUpTaskByThread[threadId] = currentJob
                    }
                    true
                }
            }
            if (!shouldStart) {
                return@launch
            }
            while (true) {
                realtimeHistoryCatchUpMutex.withLock {
                    pendingRealtimeHistoryCatchUpThreadIds.remove(threadId)
                }
                if (isThreadHistoryRefreshBusy(threadId)) {
                    delay(150)
                    realtimeHistoryCatchUpMutex.withLock {
                        pendingRealtimeHistoryCatchUpThreadIds += threadId
                    }
                } else {
                    runCatching {
                        catchUpRealtimeHistoryToLatest(threadId)
                    }.onFailure { failure ->
                        Log.w(TAG, "realtime history catch-up failed threadId=$threadId", failure)
                    }
                }
                val shouldContinue = realtimeHistoryCatchUpMutex.withLock {
                    pendingRealtimeHistoryCatchUpThreadIds.contains(threadId)
                }
                if (!shouldContinue) {
                    realtimeHistoryCatchUpMutex.withLock {
                        val existingTask = realtimeHistoryCatchUpTaskByThread[threadId]
                        if (existingTask === currentJob || existingTask?.isActive != true) {
                            realtimeHistoryCatchUpTaskByThread.remove(threadId)
                        }
                    }
                    return@launch
                }
            }
        }
    }

    private fun shouldCatchUpRealtimeHistory(
        threadId: String,
        turnId: String?,
        itemId: String?,
        previousItemId: String?,
        cursor: String?,
        previousCursor: String?,
    ): Boolean {
        val currentState = state.value
        if (!currentState.isConnected) {
            return false
        }
        if (currentState.selectedThreadId != threadId) {
            return false
        }

        val newestCursor = normalizedHistoryCursor(currentState.historyStateByThread[threadId]?.newestCursor)
        val normalizedCursor = normalizedHistoryCursor(cursor)
        val normalizedPreviousCursor = normalizedHistoryCursor(previousCursor)
        if (newestCursor != null) {
            if (normalizedCursor == newestCursor || normalizedPreviousCursor == newestCursor) {
                return false
            }
            if (normalizedCursor != null || normalizedPreviousCursor != null) {
                return !currentState.shouldBypassRealtimeHistoryCatchUpForLocallyStartedTurn(
                    threadId = threadId,
                    turnId = turnId,
                    cursor = cursor,
                    previousCursor = previousCursor,
                )
            }
        }

        if (currentState.shouldBypassRealtimeHistoryCatchUpForLocallyStartedTurn(
                threadId = threadId,
                turnId = turnId,
                cursor = cursor,
                previousCursor = previousCursor,
            )
        ) {
            return false
        }

        val latestItemId = currentState.messagesByThread[threadId]
            .orEmpty()
            .asReversed()
            .firstOrNull { !it.itemId.isNullOrBlank() }
            ?.itemId
            ?.trim()

        return shouldRequestRealtimeHistoryCatchUp(latestItemId, itemId, previousItemId)
    }

    @Suppress("SameParameterValue")
    private fun handleRealtimeHistoryEvent(
        threadId: String,
        itemId: String?,
        payload: JsonObject?,
    ): Boolean {
        return handleRealtimeHistoryEvent(
            threadId = threadId,
            turnId = payload.resolveTurnId() ?: state.value.activeTurnIdByThread[threadId],
            itemId = itemId,
            previousItemId = payload.resolvePreviousItemId(),
            cursor = payload.resolveCursor(),
            previousCursor = payload.resolvePreviousCursor(),
        )
    }

    private fun handleRealtimeHistoryEvent(
        threadId: String,
        turnId: String?,
        itemId: String?,
        previousItemId: String?,
        cursor: String?,
        previousCursor: String?,
    ): Boolean {
        val needsCatchUp = shouldCatchUpRealtimeHistory(
            threadId = threadId,
            turnId = turnId,
            itemId = itemId,
            previousItemId = previousItemId,
            cursor = cursor,
            previousCursor = previousCursor,
        )
        if (needsCatchUp) {
            scheduleRealtimeHistoryCatchUp(
                threadId = threadId,
                itemId = itemId,
                previousItemId = previousItemId,
                cursor = cursor,
                previousCursor = previousCursor,
            )
            return false
        }

        applyRealtimeHistoryCursorAdvance(
            threadId = threadId,
            turnId = turnId,
            cursor = cursor,
            previousCursor = previousCursor,
        )
        return true
    }

    private fun applyRealtimeHistoryCursorAdvance(
        threadId: String,
        turnId: String?,
        cursor: String?,
        previousCursor: String?,
    ) {
        val normalizedCursor = normalizedHistoryCursor(cursor) ?: return
        updateState {
            val currentHistoryState = historyStateByThread[threadId] ?: ThreadHistoryState()
            val normalizedTurnId = normalizedIdentifier(turnId) ?: normalizedIdentifier(activeTurnIdByThread[threadId])
            val nextOldestCursor = normalizedHistoryCursor(currentHistoryState.oldestCursor) ?: normalizedCursor
            copy(
                historyStateByThread = historyStateByThread + (
                    threadId to currentHistoryState.copy(
                        oldestCursor = nextOldestCursor,
                        newestCursor = normalizedCursor,
                        hasOlderOnServer = currentHistoryState.hasOlderOnServer || normalizedHistoryCursor(previousCursor) != null,
                        hasNewerOnServer = false,
                    )
                ),
                pendingRealtimeSeededTurnIdByThread = if (
                    normalizedTurnId != null &&
                    pendingRealtimeSeededTurnIdByThread[threadId] == normalizedTurnId
                ) {
                    pendingRealtimeSeededTurnIdByThread - threadId
                } else {
                    pendingRealtimeSeededTurnIdByThread
                },
            )
        }
    }

    private suspend fun resolveActiveTurnId(threadId: String): String? {
        val result = activeClient().sendRequest(
            method = "thread/read",
            params = JsonObject(
                mapOf(
                    "threadId" to JsonPrimitive(threadId),
                    "includeTurns" to JsonPrimitive(true),
                ),
            ),
        )?.jsonObjectOrNull() ?: return null
        val threadObject = result["thread"]?.jsonObjectOrNull() ?: return null
        return resolveActiveTurnId(threadObject)
    }

    private fun resolveActiveTurnId(threadObject: JsonObject): String? {
        val turns = threadObject["turns"]?.jsonArrayOrNull().orEmpty()
        if (turns.isEmpty()) {
            return null
        }
        val activeTurn = turns
            .mapNotNull(JsonElement::jsonObjectOrNull)
            .asReversed()
            .firstOrNull { turn ->
                turn.bool("isRunning") == true ||
                    turn.bool("isActive") == true ||
                    turn.string("status")?.lowercase() in setOf("inprogress", "running", "active", "started", "pending")
            }
        return activeTurn?.string("id")
    }

    private suspend fun requestWithSandboxFallback(method: String, baseParams: JsonObject): JsonElement? {
        val attempts = listOf(
            baseParams.copyWith(
                "sandboxPolicy" to JsonObject(
                    when (state.value.accessMode) {
                        AccessMode.ON_REQUEST -> mapOf(
                            "type" to JsonPrimitive("workspaceWrite"),
                            "networkAccess" to JsonPrimitive(true),
                        )

                        AccessMode.FULL_ACCESS -> mapOf(
                            "type" to JsonPrimitive("dangerFullAccess"),
                        )
                    },
                ),
            ),
            baseParams.copyWith("sandbox" to JsonPrimitive(state.value.accessMode.sandboxLegacyValue)),
            baseParams,
        )

        var lastError: Throwable? = null
        for (params in attempts) {
            for (policy in state.value.accessMode.approvalPolicyCandidates) {
                try {
                    return activeClient().sendRequest(
                        method = method,
                        params = params.copyWith("approvalPolicy" to JsonPrimitive(policy)),
                    )
                } catch (failure: Throwable) {
                    lastError = failure
                    if (!shouldRetryForFallback(failure.message.orEmpty())) {
                        throw failure
                    }
                }
            }
        }
        throw lastError ?: IllegalStateException("$method failed")
    }

    private fun buildTurnInputItems(
        text: String,
        attachments: List<ImageAttachment>,
        skillMentions: List<TurnSkillMention>,
        includeStructuredSkillItems: Boolean,
    ): JsonArray {
        return JsonArray(
            buildList {
                attachments.forEach { attachment ->
                    val payloadDataURL = attachment.payloadDataURL?.trim().orEmpty()
                    if (payloadDataURL.isNotEmpty()) {
                        add(
                            JsonObject(
                                mapOf(
                                    "type" to JsonPrimitive("image"),
                                    "image_url" to JsonPrimitive(payloadDataURL),
                                ),
                            ),
                        )
                    }
                }
                if (text.isNotEmpty()) {
                    add(
                        JsonObject(
                            mapOf(
                                "type" to JsonPrimitive("text"),
                                "text" to JsonPrimitive(text),
                            ),
                        ),
                    )
                }
                if (includeStructuredSkillItems) {
                    skillMentions.forEach { mention ->
                        val normalizedId = mention.id.trim()
                        if (normalizedId.isEmpty()) {
                            return@forEach
                        }
                        add(
                            JsonObject(
                                buildMap {
                                    put("type", JsonPrimitive("skill"))
                                    put("id", JsonPrimitive(normalizedId))
                                    mention.name?.trim()?.takeIf(String::isNotEmpty)?.let {
                                        put("name", JsonPrimitive(it))
                                    }
                                    mention.path?.trim()?.takeIf(String::isNotEmpty)?.let {
                                        put("path", JsonPrimitive(it))
                                    }
                                },
                            ),
                        )
                    }
                }
            },
        )
    }

    private fun shouldRetryTurnStartWithoutSkillItems(error: Throwable): Boolean {
        val message = error.message?.lowercase().orEmpty()
        if (!message.contains("skill")) {
            return false
        }
        return message.contains("unknown")
            || message.contains("unsupported")
            || message.contains("invalid")
            || message.contains("expected")
            || message.contains("unrecognized")
            || message.contains("type")
            || message.contains("field")
    }

    private fun shouldRetrySteerWithRefreshedTurnId(error: Throwable): Boolean {
        val message = error.message?.lowercase().orEmpty()
        val hints = listOf(
            "turn not found",
            "no active turn",
            "not in progress",
            "not running",
            "already completed",
            "already finished",
            "invalid turn",
            "no such turn",
            "not active",
            "does not exist",
            "cannot interrupt",
            "expectedturnid",
        )
        return hints.any(message::contains)
    }

    private fun shouldRetryForFallback(message: String): Boolean {
        val lowered = message.lowercase()
        return lowered.contains("invalid")
            || lowered.contains("unsupported")
            || lowered.contains("approval")
            || lowered.contains("unexpected")
            || lowered.contains("unknown")
    }

    private fun decodeMessagesFromThreadRead(
        threadId: String,
        threadObject: JsonObject,
        latestLimit: Int? = null,
    ): List<ChatMessage> {
        val turns = threadObject["turns"]?.jsonArrayOrNull().orEmpty()
        val baseTimestamp = threadObject.timestamp("createdAt", "created_at")
            ?: threadObject.timestamp("updatedAt", "updated_at")
            ?: 0L
        val messages = mutableListOf<ChatMessage>()
        var offset = 0L

        fun decodeMessage(turn: JsonObject, item: JsonObject): ChatMessage? {
            val type = item.string("type")?.lowercase()?.replace("_", "") ?: return null
            val turnId = turn.string("id")
            val itemId = item.string("id")
            val turnTimestamp = turn.timestamp("createdAt", "created_at", "updatedAt", "updated_at")
            val timestamp = item.timestamp("createdAt", "created_at")
                ?: turnTimestamp
                ?: (baseTimestamp + offset)
            offset += 1
            val providerItemId = firstNonBlank(
                item.string("providerItemId"),
                item.string("provider_item_id"),
            )
            val timelineOrdinal = item.int("ordinal")
            val timelineStatus = firstNonBlank(
                item.string("status"),
                item["result"]?.jsonObjectOrNull()?.string("status"),
                item["output"]?.jsonObjectOrNull()?.string("status"),
            )
            val role = when (type) {
                "usermessage" -> MessageRole.USER
                "agentmessage", "assistantmessage" -> MessageRole.ASSISTANT
                "message" -> if (item.string("role")?.contains("user", ignoreCase = true) == true) {
                    MessageRole.USER
                } else {
                    MessageRole.ASSISTANT
                }

                else -> MessageRole.SYSTEM
            }
            val kind = resolveTimelineMessageKind(type, item)
            val fileChanges = if (kind == MessageKind.FILE_CHANGE) {
                decodeFileChangeEntries(item)
            } else {
                emptyList()
            }
            val commandState = if (kind == MessageKind.COMMAND_EXECUTION) {
                decodeCommandState(item, completedFallback = true)
            } else {
                null
            }
            val planState = if (kind == MessageKind.PLAN) {
                decodePlanState(item)
            } else {
                null
            }
            val structuredUserInputRequest = if (kind == MessageKind.USER_INPUT_PROMPT) {
                decodeStructuredUserInputRequest(item)
            } else {
                null
            }
            val subagentAction = if (kind == MessageKind.SUBAGENT_ACTION) {
                decodeSubagentActionItem(item)
            } else {
                null
            }
            val text = when (kind) {
                MessageKind.FILE_CHANGE -> decodeFileChangeText(item, fileChanges)
                MessageKind.COMMAND_EXECUTION -> decodeCommandExecutionText(item, commandState)
                MessageKind.SUBAGENT_ACTION -> subagentAction?.summaryText ?: decodeItemText(item)
                MessageKind.PLAN -> decodePlanText(item, planState)
                MessageKind.USER_INPUT_PROMPT -> structuredUserInputRequest?.let(::structuredUserInputFallbackText) ?: decodeItemText(item)
                else -> decodeItemText(item)
            }
            if (text.isBlank() && structuredUserInputRequest == null) {
                return null
            }
            return ChatMessage(
                id = itemId ?: UUID.randomUUID().toString(),
                threadId = threadId,
                role = role,
                kind = kind,
                text = text,
                createdAt = timestamp,
                turnId = turnId,
                itemId = itemId,
                orderIndex = timelineOrdinal ?: nextOrderIndex(),
                fileChanges = fileChanges,
                commandState = commandState,
                subagentAction = subagentAction,
                planState = planState,
                structuredUserInputRequest = structuredUserInputRequest,
                providerItemId = providerItemId,
                timelineOrdinal = timelineOrdinal,
                timelineStatus = timelineStatus,
            )
        }

        if (latestLimit != null && latestLimit > 0) {
            loop@ for (turnIndex in turns.lastIndex downTo 0) {
                val turn = turns[turnIndex].jsonObjectOrNull() ?: continue
                val items = turn["items"]?.jsonArrayOrNull().orEmpty()
                for (itemIndex in items.lastIndex downTo 0) {
                    val item = items[itemIndex].jsonObjectOrNull() ?: continue
                    val decoded = decodeMessage(turn, item) ?: continue
                    messages += decoded
                    if (messages.size >= latestLimit) {
                        break@loop
                    }
                }
            }
            val renderedMessages = messages
                .asReversed()
                .sortedWith(Comparator(::compareRenderedTimelineMessages))
            registerSubagentThreadsFromMessages(threadId, renderedMessages)
            return renderedMessages
        }

        turns.forEach { turnElement ->
            val turn = turnElement.jsonObjectOrNull() ?: return@forEach
            val items = turn["items"]?.jsonArrayOrNull().orEmpty()
            items.forEach { itemElement ->
                val item = itemElement.jsonObjectOrNull() ?: return@forEach
                decodeMessage(turn, item)?.let(messages::add)
            }
        }
        val renderedMessages = messages.sortedWith(Comparator(::compareRenderedTimelineMessages))
        registerSubagentThreadsFromMessages(threadId, renderedMessages)
        return renderedMessages
    }

    private fun decodeItemText(item: JsonObject): String {
        val content = item["content"]?.jsonArrayOrNull().orEmpty()
        val contentParts = content.mapNotNull { child ->
            val objectValue = child.jsonObjectOrNull() ?: return@mapNotNull null
            val childType = objectValue.string("type")?.lowercase()?.replace("_", "") ?: ""
            when (childType) {
                "text", "inputtext", "outputtext", "message" -> objectValue.string("text")
                "skill" -> objectValue.string("id")?.let { "\$$it" }
                else -> objectValue["data"]?.jsonObjectOrNull()?.string("text")
            }
        }
        if (contentParts.isNotEmpty()) {
            return contentParts.joinToString("\n").trim()
        }
        return item.string("text")
            ?: item.string("message")
            ?: ""
    }

    private fun decodePlanText(item: JsonObject, planState: PlanState?): String {
        val decoded = decodeItemText(item)
        if (decoded.isNotBlank()) {
            return decoded
        }
        val summary = item.flattenedString("summary")
        if (!summary.isNullOrBlank()) {
            return summary
        }
        return when {
            planState?.explanation != null -> planState.explanation
            planState?.steps?.isNotEmpty() == true -> "Planning..."
            else -> "Planning..."
        }
    }

    private fun decodeCommandExecutionText(item: JsonObject, commandState: CommandState?): String {
        val state = commandState ?: decodeCommandState(item, completedFallback = true) ?: return "Completed command"
        return "${state.phase.statusLabel} ${state.shortCommand}"
    }

    private fun decodeStructuredUserInputQuestions(value: JsonElement?): List<StructuredUserInputQuestion> {
        val items = value?.jsonArrayOrNull().orEmpty()
        return items.mapNotNull { element ->
            val objectValue = element.jsonObjectOrNull() ?: return@mapNotNull null
            val id = objectValue.string("id")?.trim()?.takeIf(String::isNotEmpty) ?: return@mapNotNull null
            val header = objectValue.string("header")?.trim().orEmpty()
            val question = objectValue.string("question")?.trim()?.takeIf(String::isNotEmpty) ?: return@mapNotNull null
            val options = objectValue.array("options")
                ?.mapNotNull { optionElement ->
                    val optionObject = optionElement.jsonObjectOrNull() ?: return@mapNotNull null
                    val label = optionObject.string("label")?.trim()?.takeIf(String::isNotEmpty) ?: return@mapNotNull null
                    StructuredUserInputOption(
                        label = label,
                        description = optionObject.string("description")?.trim().orEmpty(),
                    )
                }
                .orEmpty()
            StructuredUserInputQuestion(
                id = id,
                header = header,
                question = question,
                isOther = objectValue.bool("isOther") ?: false,
                isSecret = objectValue.bool("isSecret") ?: false,
                options = options,
            )
        }
    }

    private fun decodeStructuredUserInputRequest(item: JsonObject): StructuredUserInputRequest? {
        val questions = decodeStructuredUserInputQuestions(
            item["questions"] ?: item["request"]?.jsonObjectOrNull()?.get("questions"),
        )
        if (questions.isEmpty()) {
            return null
        }
        val requestId = item["requestId"]
            ?: item["request_id"]
            ?: item["id"]
            ?: JsonPrimitive("request-${UUID.randomUUID()}")
        return StructuredUserInputRequest(
            requestId = requestId,
            questions = questions,
        )
    }

    private fun structuredUserInputFallbackText(request: StructuredUserInputRequest): String {
        return request.questions.joinToString("\n\n") { question ->
            val header = question.header.trim()
            val prompt = question.question.trim()
            if (header.isEmpty()) prompt else "$header\n$prompt"
        }
    }

    private fun upsertStructuredUserInputPrompt(
        threadId: String,
        turnId: String?,
        itemId: String,
        request: StructuredUserInputRequest,
    ) {
        val fallbackText = structuredUserInputFallbackText(request)
        updateState {
            val existingMessages = messagesByThread[threadId].orEmpty().toMutableList()
            val existingIndex = existingMessages.indexOfLast { message ->
                message.role == MessageRole.SYSTEM &&
                    message.kind == MessageKind.USER_INPUT_PROMPT &&
                    message.structuredUserInputRequest?.let { responseKey(it.requestId) } == responseKey(request.requestId)
            }
            if (existingIndex >= 0) {
                val current = existingMessages[existingIndex]
                existingMessages[existingIndex] = current.copy(
                    text = fallbackText,
                    turnId = turnId ?: current.turnId,
                    itemId = itemId,
                    structuredUserInputRequest = request,
                    isStreaming = false,
                )
            } else {
                existingMessages += ChatMessage(
                    threadId = threadId,
                    role = MessageRole.SYSTEM,
                    kind = MessageKind.USER_INPUT_PROMPT,
                    text = fallbackText,
                    turnId = turnId,
                    itemId = itemId,
                    isStreaming = false,
                    orderIndex = nextOrderIndex(),
                    structuredUserInputRequest = request,
                )
            }
            val updatedMessagesByThread = messagesByThread + (threadId to existingMessages)
            copy(
                messagesByThread = updatedMessagesByThread,
                threads = threads.refreshThreadSummaryFromMessages(threadId, existingMessages),
            )
        }
    }

    private fun removeStructuredUserInputPrompt(
        requestId: JsonElement,
        threadIdHint: String? = null,
    ) {
        val wantedKey = responseKey(requestId)
        updateState {
            val candidateThreadIds = threadIdHint?.let(::listOf) ?: messagesByThread.keys
            val updatedMessagesByThread = messagesByThread.toMutableMap()
            candidateThreadIds.forEach { threadId ->
                val currentMessages = updatedMessagesByThread[threadId].orEmpty()
                val filtered = currentMessages.filterNot { message ->
                    message.kind == MessageKind.USER_INPUT_PROMPT &&
                        message.structuredUserInputRequest?.let { responseKey(it.requestId) } == wantedKey
                }
                if (filtered.size != currentMessages.size) {
                    updatedMessagesByThread[threadId] = filtered
                }
            }
            copy(messagesByThread = updatedMessagesByThread)
        }
    }

    private fun decodeCommandState(item: JsonObject, completedFallback: Boolean): CommandState? {
        val fullCommand = extractCommandExecutionCommand(item) ?: return null
        val phase = CommandPhase.fromStatus(commandExecutionStatus(item), completedFallback = completedFallback)
        return CommandState(
            shortCommand = shortCommandPreview(fullCommand),
            fullCommand = fullCommand,
            phase = phase,
            cwd = commandExecutionWorkingDirectory(item),
            exitCode = commandExecutionExitCode(item),
            durationMs = commandExecutionDurationMs(item),
            outputTail = commandExecutionOutputText(item).orEmpty(),
        )
    }

    private fun extractCommandExecutionCommand(item: JsonObject): String? {
        listOf("command", "cmd", "raw_command", "rawCommand", "input", "invocation").forEach { key ->
            val value = item.string(key)?.trim()?.takeIf(String::isNotEmpty)
            if (value != null) {
                return value
            }
        }
        val commandArray = item.array("command")
            ?.mapNotNull { element -> element.stringOrNull()?.trim()?.takeIf(String::isNotEmpty) }
            .orEmpty()
        if (commandArray.isNotEmpty()) {
            return commandArray.joinToString(" ")
        }
        return parseCommandExecutionTranscript(decodeItemText(item)).command
    }

    private fun commandExecutionStatus(item: JsonObject): String? {
        return firstNonBlank(
            item.string("status"),
            item["result"]?.jsonObjectOrNull()?.string("status"),
            item["output"]?.jsonObjectOrNull()?.string("status"),
            item["payload"]?.jsonObjectOrNull()?.string("status"),
            item["data"]?.jsonObjectOrNull()?.string("status"),
            item["event"]?.jsonObjectOrNull()?.string("status"),
        ) ?: parseCommandExecutionTranscript(decodeItemText(item)).status
    }

    private fun commandExecutionWorkingDirectory(item: JsonObject): String? {
        return firstNonBlank(
            item.string("cwd"),
            item.string("working_directory"),
            item.string("workingDirectory"),
            item.string("current_working_directory"),
            item.string("currentWorkingDirectory"),
        )
    }

    private fun commandExecutionExitCode(item: JsonObject): Int? {
        return firstNonNull(
            item.int("exitCode"),
            item.int("exit_code"),
            item["result"]?.jsonObjectOrNull()?.int("exitCode"),
            item["result"]?.jsonObjectOrNull()?.int("exit_code"),
            item["output"]?.jsonObjectOrNull()?.int("exitCode"),
            item["output"]?.jsonObjectOrNull()?.int("exit_code"),
        )
    }

    private fun commandExecutionDurationMs(item: JsonObject): Int? {
        return firstNonNull(
            item.int("durationMs"),
            item.int("duration_ms"),
            item["result"]?.jsonObjectOrNull()?.int("durationMs"),
            item["result"]?.jsonObjectOrNull()?.int("duration_ms"),
        )
    }

    private fun commandExecutionOutputText(item: JsonObject): String? {
        val directOutput = firstNonBlank(
            item.string("stdout"),
            item.string("stderr"),
            item.string("output_text"),
            item.string("outputText"),
            item.string("output"),
            item["output"]?.jsonObjectOrNull()?.string("text"),
            item["output"]?.jsonObjectOrNull()?.string("stdout"),
            item["output"]?.jsonObjectOrNull()?.string("stderr"),
            item["result"]?.jsonObjectOrNull()?.string("stdout"),
            item["result"]?.jsonObjectOrNull()?.string("stderr"),
            item["result"]?.jsonObjectOrNull()?.string("output"),
            item["result"]?.jsonObjectOrNull()?.string("output_text"),
            item["event"]?.jsonObjectOrNull()?.string("delta"),
            item["event"]?.jsonObjectOrNull()?.string("text"),
        )
        return directOutput?.let { parseCommandExecutionTranscript(it).outputText ?: it.trim() }
            ?: parseCommandExecutionTranscript(decodeItemText(item)).outputText
    }

    private fun shortCommandPreview(rawCommand: String, maxLength: Int = 92): String {
        val trimmed = rawCommand.trim()
        if (trimmed.isEmpty()) {
            return "command"
        }
        val compact = trimmed.replace(Regex("""\s+"""), " ")
        val unwrapped = unwrapShellCommandIfPresent(compact)
        if (unwrapped.length <= maxLength) {
            return unwrapped
        }
        return unwrapped.take(maxLength - 1) + "…"
    }

    private fun unwrapShellCommandIfPresent(command: String): String {
        val tokens = command.split(Regex("""\s+""")).filter(String::isNotBlank)
        if (tokens.isEmpty()) {
            return command
        }
        val shellNames = listOf("bash", "zsh", "sh", "fish")
        var shellIndex = 0
        if (tokens.size >= 2) {
            val first = tokens[0].lowercase()
            val second = tokens[1].lowercase()
            if ((first == "env" || first.endsWith("/env")) &&
                shellNames.any { second == it || second.endsWith("/$it") }
            ) {
                shellIndex = 1
            }
        }
        val shell = tokens[shellIndex].lowercase()
        if (!shellNames.any { shell == it || shell.endsWith("/$it") }) {
            return command
        }
        var index = shellIndex + 1
        while (index < tokens.size) {
            val token = tokens[index]
            if (token == "-c" || token == "-lc" || token == "-cl" || token == "-ic" || token == "-ci") {
                index += 1
                return tokens.drop(index).joinToString(" ").stripWrappingQuotes()
            }
            if (token.startsWith("-")) {
                index += 1
                continue
            }
            return tokens.drop(index).joinToString(" ").stripWrappingQuotes()
        }
        return command
    }

    private fun decodePlanState(item: JsonObject): PlanState? {
        val explanation = item.flattenedString("explanation")
            ?: item.flattenedString("summary")
        val steps = item.array("plan")
            ?.mapNotNull { element ->
                val stepObject = element.jsonObjectOrNull() ?: return@mapNotNull null
                val stepText = stepObject.flattenedString("step") ?: return@mapNotNull null
                val status = PlanStepStatus.fromRawValue(stepObject.flattenedString("status")) ?: return@mapNotNull null
                PlanStep(step = stepText, status = status)
            }
            .orEmpty()
        return if (explanation != null || steps.isNotEmpty()) {
            PlanState(explanation = explanation, steps = steps)
        } else {
            null
        }
    }

    private fun decodeSubagentActionItem(item: JsonObject): SubagentAction? {
        val receiverThreadIds = decodeSubagentReceiverThreadIds(item)
        val receiverAgents = decodeSubagentReceiverAgents(item, receiverThreadIds)
        val agentStates = decodeSubagentAgentStates(item)
        val tool = firstNonBlank(
            item.string("tool"),
            item.string("name"),
        ) ?: inferSubagentToolFromEventType(item) ?: "spawnAgent"
        val status = firstNonBlank(
            item.string("status"),
            item["result"]?.jsonObjectOrNull()?.string("status"),
            item["output"]?.jsonObjectOrNull()?.string("status"),
            item["event"]?.jsonObjectOrNull()?.string("status"),
        ) ?: "in_progress"
        val prompt = firstNonBlank(
            item.string("prompt"),
            item.string("task"),
            item.string("message"),
            item.string("instructions"),
            item.string("instruction"),
            item.flattenedString("prompt"),
            item.flattenedString("task"),
            item.flattenedString("message"),
        )
        val model = firstNonBlank(
            item.string("model"),
            item.string("modelName"),
            item.string("model_name"),
            item.string("requestedModel"),
            item.string("requested_model"),
            item["metadata"]?.jsonObjectOrNull()?.string("model"),
            item["metadata"]?.jsonObjectOrNull()?.string("modelName"),
            item["metadata"]?.jsonObjectOrNull()?.string("model_name"),
            item["metadata"]?.jsonObjectOrNull()?.string("modelProvider"),
            item["metadata"]?.jsonObjectOrNull()?.string("model_provider"),
        )

        if (receiverThreadIds.isEmpty() &&
            receiverAgents.isEmpty() &&
            agentStates.isEmpty() &&
            prompt.isNullOrBlank() &&
            model.isNullOrBlank()
        ) {
            return null
        }

        return SubagentAction(
            tool = tool,
            status = status,
            prompt = prompt,
            model = model,
            receiverThreadIds = receiverThreadIds,
            receiverAgents = receiverAgents,
            agentStates = agentStates,
        )
    }

    private fun inferSubagentToolFromEventType(item: JsonObject): String? {
        val normalized = item.string("type")
            ?.lowercase()
            ?.replace("_", "")
            ?.replace("-", "")
            ?: return null
        return when {
            "spawn" in normalized -> "spawnAgent"
            "waiting" in normalized || "wait" in normalized -> "waitAgent"
            "close" in normalized -> "closeAgent"
            "resume" in normalized -> "resumeAgent"
            "sendinput" in normalized || "interaction" in normalized -> "sendInput"
            else -> null
        }
    }

    private fun decodeSubagentReceiverThreadIds(item: JsonObject): List<String> {
        val threadIds = linkedSetOf<String>()
        listOf(
            item["receiverThreadIds"],
            item["receiver_thread_ids"],
            item["threadIds"],
            item["thread_ids"],
        ).forEach { candidate ->
            candidate?.jsonArrayOrNull()?.forEach { value ->
                normalizedIdentifier(value.stringOrNull())?.let(threadIds::add)
            }
        }
        if (threadIds.isNotEmpty()) {
            return threadIds.toList()
        }
        firstNonBlank(
            item.string("receiverThreadId"),
            item.string("receiver_thread_id"),
            item.string("threadId"),
            item.string("thread_id"),
            item.string("newThreadId"),
            item.string("new_thread_id"),
        )?.let(threadIds::add)
        return threadIds.toList()
    }

    private fun decodeSubagentReceiverAgents(
        item: JsonObject,
        fallbackThreadIds: List<String>,
    ): List<SubagentRef> {
        val values = listOf(
            item["receiverAgents"],
            item["receiver_agents"],
            item["agents"],
        ).firstNotNullOfOrNull { it?.jsonArrayOrNull() }
        if (values == null || values.isEmpty()) {
            return buildSyntheticSubagentRefs(item, fallbackThreadIds)
        }

        return values.mapIndexedNotNull { index, value ->
            val objectValue = value.jsonObjectOrNull() ?: return@mapIndexedNotNull null
            val threadId = firstNonBlank(
                objectValue.string("threadId"),
                objectValue.string("thread_id"),
                objectValue.string("receiverThreadId"),
                objectValue.string("receiver_thread_id"),
                objectValue.string("newThreadId"),
                objectValue.string("new_thread_id"),
                fallbackThreadIds.getOrNull(index),
            ) ?: return@mapIndexedNotNull null
            SubagentRef(
                threadId = threadId,
                agentId = firstNonBlank(
                    objectValue.string("agentId"),
                    objectValue.string("agent_id"),
                    objectValue.string("receiverAgentId"),
                    objectValue.string("receiver_agent_id"),
                    objectValue.string("newAgentId"),
                    objectValue.string("new_agent_id"),
                    objectValue.string("id"),
                ),
                nickname = firstNonBlank(
                    objectValue.string("agentNickname"),
                    objectValue.string("agent_nickname"),
                    objectValue.string("receiverAgentNickname"),
                    objectValue.string("receiver_agent_nickname"),
                    objectValue.string("newAgentNickname"),
                    objectValue.string("new_agent_nickname"),
                    objectValue.string("nickname"),
                    objectValue.string("name"),
                ),
                role = firstNonBlank(
                    objectValue.string("agentRole"),
                    objectValue.string("agent_role"),
                    objectValue.string("receiverAgentRole"),
                    objectValue.string("receiver_agent_role"),
                    objectValue.string("newAgentRole"),
                    objectValue.string("new_agent_role"),
                    objectValue.string("agentType"),
                    objectValue.string("agent_type"),
                ),
                model = firstNonBlank(
                    objectValue.string("modelProvider"),
                    objectValue.string("model_provider"),
                    objectValue.string("modelProviderId"),
                    objectValue.string("model_provider_id"),
                    objectValue.string("modelName"),
                    objectValue.string("model_name"),
                    objectValue.string("model"),
                ),
                prompt = firstNonBlank(
                    objectValue.string("prompt"),
                    objectValue.string("instructions"),
                    objectValue.string("instruction"),
                    objectValue.string("task"),
                    objectValue.string("message"),
                ),
            )
        }
    }

    private fun decodeSubagentAgentStates(item: JsonObject): Map<String, SubagentState> {
        val candidate = listOf(
            item["statuses"],
            item["agentsStates"],
            item["agents_states"],
            item["agentStates"],
            item["agent_states"],
        ).firstOrNull { it != null }

        candidate?.jsonObjectOrNull()?.let { objectValue ->
            val decoded = linkedMapOf<String, SubagentState>()
            objectValue.forEach { (rawThreadId, rawState) ->
                val stateObject = rawState.jsonObjectOrNull()
                val threadId = normalizedIdentifier(rawThreadId)
                    ?: firstNonBlank(
                        stateObject?.string("threadId"),
                        stateObject?.string("thread_id"),
                    )
                    ?: return@forEach
                decoded[threadId] = SubagentState(
                    threadId = threadId,
                    status = firstNonBlank(
                        stateObject?.string("status"),
                        rawState.stringOrNull(),
                    ) ?: "unknown",
                    message = firstNonBlank(
                        stateObject?.string("message"),
                        stateObject?.string("text"),
                        stateObject?.string("delta"),
                        stateObject?.string("summary"),
                    ),
                )
            }
            return decoded
        }

        candidate?.jsonArrayOrNull()?.let { values ->
            val decoded = linkedMapOf<String, SubagentState>()
            values.forEach { value ->
                val objectValue = value.jsonObjectOrNull() ?: return@forEach
                val threadId = firstNonBlank(
                    objectValue.string("threadId"),
                    objectValue.string("thread_id"),
                ) ?: return@forEach
                decoded[threadId] = SubagentState(
                    threadId = threadId,
                    status = objectValue.string("status") ?: "unknown",
                    message = firstNonBlank(
                        objectValue.string("message"),
                        objectValue.string("text"),
                        objectValue.string("delta"),
                        objectValue.string("summary"),
                    ),
                )
            }
            return decoded
        }

        return emptyMap()
    }

    private fun buildSyntheticSubagentRefs(
        item: JsonObject,
        fallbackThreadIds: List<String>,
    ): List<SubagentRef> {
        val threadId = fallbackThreadIds.firstOrNull() ?: firstNonBlank(
            item.string("receiverThreadId"),
            item.string("receiver_thread_id"),
            item.string("threadId"),
            item.string("thread_id"),
            item.string("newThreadId"),
            item.string("new_thread_id"),
        ) ?: return emptyList()

        return listOf(
            SubagentRef(
                threadId = threadId,
                agentId = firstNonBlank(
                    item.string("newAgentId"),
                    item.string("new_agent_id"),
                    item.string("agentId"),
                    item.string("agent_id"),
                ),
                nickname = firstNonBlank(
                    item.string("newAgentNickname"),
                    item.string("new_agent_nickname"),
                    item.string("agentNickname"),
                    item.string("agent_nickname"),
                    item.string("receiverAgentNickname"),
                    item.string("receiver_agent_nickname"),
                ),
                role = firstNonBlank(
                    item.string("receiverAgentRole"),
                    item.string("receiver_agent_role"),
                    item.string("newAgentRole"),
                    item.string("new_agent_role"),
                    item.string("agentRole"),
                    item.string("agent_role"),
                    item.string("agentType"),
                    item.string("agent_type"),
                ),
                model = firstNonBlank(
                    item.string("modelProvider"),
                    item.string("model_provider"),
                    item.string("modelProviderId"),
                    item.string("model_provider_id"),
                    item.string("modelName"),
                    item.string("model_name"),
                    item.string("model"),
                ),
                prompt = firstNonBlank(
                    item.string("prompt"),
                    item.string("instructions"),
                    item.string("instruction"),
                    item.string("task"),
                    item.string("message"),
                ),
            ),
        )
    }

    private fun decodeFileChangeText(item: JsonObject, fileChanges: List<FileChangeEntry>): String {
        if (fileChanges.isNotEmpty()) {
            return buildString {
                append("Status: ")
                append(normalizedFileChangeStatus(item, completedFallback = true))
                fileChanges.forEach { change ->
                    append("\n\nPath: ")
                    append(change.path)
                    append("\nKind: ")
                    append(change.kind)
                    if (change.additions != null || change.deletions != null) {
                        append("\nTotals: +")
                        append(change.additions ?: 0)
                        append(" -")
                        append(change.deletions ?: 0)
                    }
                }
            }
        }
        val diff = extractDiffText(item)
        return if (diff.isNotBlank()) {
            "Status: ${normalizedFileChangeStatus(item, completedFallback = true)}\n\n$diff"
        } else {
            decodeItemText(item)
        }
    }

    private fun decodeFileChangeEntries(item: JsonObject): List<FileChangeEntry> {
        val rawChanges = extractFileChangeChanges(item) ?: return emptyList()
        val changeObjects = mutableListOf<JsonObject>()
        when (rawChanges) {
            is JsonArray -> rawChanges.forEach { element ->
                element.jsonObjectOrNull()?.let(changeObjects::add)
            }

            is JsonObject -> rawChanges.keys.sorted().forEach { key ->
                val objectValue = rawChanges[key]?.jsonObjectOrNull() ?: return@forEach
                if (objectValue["path"] == null) {
                    changeObjects += JsonObject(objectValue + ("path" to JsonPrimitive(key)))
                } else {
                    changeObjects += objectValue
                }
            }

            else -> Unit
        }

        return changeObjects.map { changeObject ->
            val diff = decodeChangeDiff(changeObject)
            val totals = decodeChangeInlineTotals(changeObject)
            FileChangeEntry(
                path = decodeChangePath(changeObject),
                kind = decodeChangeKind(changeObject),
                diff = if (diff.isBlank()) {
                    changeObject.string("content")
                        ?.trim()
                        ?.takeIf(String::isNotEmpty)
                        ?.let { synthesizeUnifiedDiffFromContent(it, decodeChangeKind(changeObject), decodeChangePath(changeObject)) }
                        .orEmpty()
                } else {
                    diff
                },
                additions = totals?.first,
                deletions = totals?.second,
            )
        }
    }

    private fun extractFileChangeChanges(item: JsonObject): JsonElement? {
        return item["changes"]
            ?: item["file_changes"]
            ?: item["fileChanges"]
            ?: item["files"]
            ?: item["edits"]
            ?: item["modified_files"]
            ?: item["modifiedFiles"]
            ?: item["patches"]
    }

    private fun decodeChangePath(changeObject: JsonObject): String {
        return firstNonBlank(
            changeObject.string("path"),
            changeObject.string("file"),
            changeObject.string("file_path"),
            changeObject.string("filePath"),
            changeObject.string("relative_path"),
            changeObject.string("relativePath"),
            changeObject.string("new_path"),
            changeObject.string("newPath"),
            changeObject.string("to"),
            changeObject.string("target"),
            changeObject.string("name"),
            changeObject.string("old_path"),
            changeObject.string("oldPath"),
            changeObject.string("from"),
        ) ?: "unknown"
    }

    private fun decodeChangeKind(changeObject: JsonObject): String {
        return firstNonBlank(
            changeObject.string("kind"),
            changeObject.string("action"),
            changeObject["kind"]?.jsonObjectOrNull()?.string("type"),
            changeObject.string("type"),
        ) ?: "update"
    }

    private fun decodeChangeDiff(changeObject: JsonObject): String {
        return firstNonBlank(
            changeObject.string("diff"),
            changeObject.string("patch"),
            changeObject.string("unified_diff"),
            changeObject.string("unifiedDiff"),
        ).orEmpty()
    }

    private fun decodeChangeInlineTotals(changeObject: JsonObject): Pair<Int, Int>? {
        val additions = firstNonNull(
            changeObject.int("additions"),
            changeObject.int("added"),
            changeObject["totals"]?.jsonObjectOrNull()?.int("additions"),
        )
        val deletions = firstNonNull(
            changeObject.int("deletions"),
            changeObject.int("removed"),
            changeObject["totals"]?.jsonObjectOrNull()?.int("deletions"),
        )
        return if (additions != null || deletions != null) {
            (additions ?: 0) to (deletions ?: 0)
        } else {
            null
        }
    }

    private fun synthesizeUnifiedDiffFromContent(content: String, kind: String, path: String): String {
        val lines = content.lines()
        val header = when (kind.trim().lowercase()) {
            "create", "created", "add", "added" -> listOf("--- /dev/null", "+++ b/$path")
            "delete", "deleted", "remove", "removed" -> listOf("--- a/$path", "+++ /dev/null")
            else -> listOf("--- a/$path", "+++ b/$path")
        }
        val body = lines.joinToString("\n") { line ->
            val prefix = when {
                kind.contains("delete", ignoreCase = true) -> "-"
                kind.contains("create", ignoreCase = true) || kind.contains("add", ignoreCase = true) -> "+"
                else -> "+"
            }
            "$prefix$line"
        }
        return (header + "@@ -1,${lines.size} +1,${lines.size} @@" + body).joinToString("\n")
    }

    private fun normalizedFileChangeStatus(item: JsonObject, completedFallback: Boolean): String {
        return firstNonBlank(
            item.string("status"),
            item["output"]?.jsonObjectOrNull()?.string("status"),
            item["result"]?.jsonObjectOrNull()?.string("status"),
            item["payload"]?.jsonObjectOrNull()?.string("status"),
            item["data"]?.jsonObjectOrNull()?.string("status"),
        ) ?: if (completedFallback) {
            "completed"
        } else {
            "inProgress"
        }
    }

    private fun extractDiffText(item: JsonObject): String {
        return firstNonBlank(
            item.string("diff"),
            item.string("patch"),
            item.string("unified_diff"),
            item.string("unifiedDiff"),
        ).orEmpty()
    }

    private fun appendLocalMessage(message: ChatMessage) {
        updateState {
            val existing = messagesByThread[message.threadId].orEmpty()
            val updatedMessages = existing + message
            copy(
                messagesByThread = messagesByThread + (message.threadId to updatedMessages),
                threads = threads.refreshThreadSummaryFromMessages(message.threadId, updatedMessages),
            )
        }
    }

    private fun removeLatestMatchingUserMessage(
        threadId: String,
        text: String,
        attachments: List<ImageAttachment>,
    ) {
        updateState {
            val existing = messagesByThread[threadId].orEmpty().toMutableList()
            val index = existing.indexOfLast { message ->
                message.role == MessageRole.USER &&
                    message.text == text &&
                    message.attachments == attachments
            }
            if (index >= 0) {
                existing.removeAt(index)
            }
            copy(
                messagesByThread = messagesByThread + (threadId to existing),
                threads = threads.refreshThreadSummaryFromMessages(threadId, existing),
            )
        }
    }

    private fun canonicalTimelineRole(rawValue: String?): MessageRole {
        return when (normalizeMethodToken(rawValue.orEmpty())) {
            "user" -> MessageRole.USER
            "assistant" -> MessageRole.ASSISTANT
            else -> MessageRole.SYSTEM
        }
    }

    private fun canonicalTimelineKind(rawValue: String?): MessageKind {
        return when (normalizeMethodToken(rawValue.orEmpty())) {
            "thinking", "reasoning" -> MessageKind.THINKING
            "filechange", "toolcall", "diff" -> MessageKind.FILE_CHANGE
            "commandexecution", "commanddelta", "command", "shellcommand", "shell" -> MessageKind.COMMAND_EXECUTION
            "collabagenttoolcall", "collabtoolcall", "subagentaction" -> MessageKind.SUBAGENT_ACTION
            "plan" -> MessageKind.PLAN
            "userinputprompt" -> MessageKind.USER_INPUT_PROMPT
            else -> MessageKind.CHAT
        }
    }

    private fun resolveTimelineMessageKind(rawValue: String?, item: JsonObject): MessageKind {
        val explicitKind = canonicalTimelineKind(rawValue)
        if (explicitKind != MessageKind.CHAT) {
            return explicitKind
        }
        return when {
            isCommandExecutionPayload(item) -> MessageKind.COMMAND_EXECUTION
            else -> MessageKind.CHAT
        }
    }

    private fun isCommandExecutionPayload(item: JsonObject): Boolean {
        if (extractCommandExecutionCommand(item) != null) {
            return true
        }
        if (commandExecutionStatus(item) != null) {
            return true
        }
        if (commandExecutionWorkingDirectory(item) != null ||
            commandExecutionExitCode(item) != null ||
            commandExecutionDurationMs(item) != null
        ) {
            return true
        }
        return looksLikeCommandExecutionTranscript(decodeItemText(item))
    }

    private fun canonicalTimelineTextMode(rawValue: String?): String {
        return if (normalizeMethodToken(rawValue.orEmpty()) == "append") "append" else "replace"
    }

    private fun canonicalTimelineIsStreaming(
        status: String?,
        eventKind: CanonicalTimelineEventKind,
    ): Boolean {
        if (eventKind == CanonicalTimelineEventKind.COMPLETED) {
            return false
        }
        val normalizedStatus = normalizeMethodToken(status.orEmpty())
        return normalizedStatus !in setOf("completed", "failed", "stopped")
    }

    private fun canonicalTimelineText(
        payload: JsonObject,
        kind: MessageKind,
        planState: PlanState?,
        commandState: CommandState?,
        subagentAction: SubagentAction?,
        structuredUserInputRequest: StructuredUserInputRequest?,
        fileChanges: List<FileChangeEntry>,
    ): String {
        return when (kind) {
            MessageKind.FILE_CHANGE -> decodeFileChangeText(payload, fileChanges)
            MessageKind.COMMAND_EXECUTION -> decodeCommandExecutionText(payload, commandState)
            MessageKind.SUBAGENT_ACTION -> subagentAction?.summaryText ?: payload.deltaText()
            MessageKind.PLAN -> decodePlanText(payload, planState)
            MessageKind.USER_INPUT_PROMPT -> structuredUserInputRequest?.let(::structuredUserInputFallbackText) ?: payload.deltaText()
            else -> payload.deltaText()
        }
    }

    private fun upsertCanonicalTimelineMessage(
        threadId: String,
        turnId: String?,
        timelineItemId: String,
        providerItemId: String?,
        role: MessageRole,
        kind: MessageKind,
        incomingText: String,
        textMode: String,
        isStreaming: Boolean,
        timelineOrdinal: Int?,
        timelineStatus: String?,
        fileChanges: List<FileChangeEntry>,
        commandState: CommandState?,
        subagentAction: SubagentAction?,
        planState: PlanState?,
        structuredUserInputRequest: StructuredUserInputRequest?,
    ) {
        val existingCanonicalMessage = threadTimelineStateByThread[threadId]?.message(timelineItemId)
            ?: state.value.messagesByThread[threadId].orEmpty().firstOrNull { it.id == timelineItemId }
        val existingText = existingCanonicalMessage?.text.orEmpty()
        val nextText = when {
            textMode == "append" -> mergeStreamingSnapshotText(existingText = existingText, incomingText = incomingText)
            incomingText.isBlank() -> existingText
            else -> incomingText
        }
        val message = (existingCanonicalMessage ?: ChatMessage(
            id = timelineItemId,
            threadId = threadId,
            role = role,
            kind = kind,
            text = nextText,
            turnId = turnId,
            itemId = timelineItemId,
            isStreaming = isStreaming,
            orderIndex = timelineOrdinal ?: nextOrderIndex(),
            fileChanges = fileChanges,
            commandState = commandState,
            subagentAction = subagentAction,
            planState = planState,
            providerItemId = providerItemId,
            timelineOrdinal = timelineOrdinal,
            timelineStatus = timelineStatus,
        )).copy(
            role = role,
            kind = kind,
            text = nextText,
            turnId = turnId ?: existingCanonicalMessage?.turnId,
            itemId = timelineItemId,
            isStreaming = isStreaming,
            orderIndex = timelineOrdinal ?: existingCanonicalMessage?.orderIndex ?: nextOrderIndex(),
            fileChanges = if (fileChanges.isEmpty()) {
                existingCanonicalMessage?.fileChanges.orEmpty()
            } else {
                fileChanges
            },
            commandState = mergeCommandState(existingCanonicalMessage?.commandState, commandState),
            subagentAction = subagentAction ?: existingCanonicalMessage?.subagentAction,
            planState = planState ?: existingCanonicalMessage?.planState,
            structuredUserInputRequest = structuredUserInputRequest ?: existingCanonicalMessage?.structuredUserInputRequest,
            providerItemId = providerItemId ?: existingCanonicalMessage?.providerItemId,
            timelineOrdinal = timelineOrdinal ?: existingCanonicalMessage?.timelineOrdinal,
            timelineStatus = timelineStatus ?: existingCanonicalMessage?.timelineStatus,
        )
        val renderedMessages = upsertThreadTimelineMessage(message)
        updateState {
            val updatedThreads = message.subagentAction?.let { action ->
                registerSubagentThreads(threads, action, threadId)
            } ?: threads
            copy(
                messagesByThread = messagesByThread + (threadId to renderedMessages),
                threads = updatedThreads.refreshThreadSummaryFromMessages(threadId, renderedMessages),
            )
        }
    }

    private fun buildClient(epoch: Long, clientGeneration: Long): SecureBridgeClient {
        return SecureBridgeClient(
            onNotification = { method, params ->
                if (!isCurrentClientCallback(epoch, clientGeneration)) {
                    return@SecureBridgeClient
                }
                handleNotification(method, params)
            },
            onApprovalRequest = { id, method, params ->
                if (!isCurrentClientCallback(epoch, clientGeneration)) {
                    return@SecureBridgeClient
                }
                if (method == "item/tool/requestUserInput") {
                    val threadId = params?.string("threadId")
                    val turnId = params?.string("turnId")
                    if (threadId != null && turnId != null) {
                        val itemId = params.string("itemId") ?: "request-${responseKey(id)}"
                        val questions = decodeStructuredUserInputQuestions(params["questions"])
                        if (questions.isNotEmpty()) {
                            upsertStructuredUserInputPrompt(
                                threadId = threadId,
                                turnId = turnId,
                                itemId = itemId,
                                request = StructuredUserInputRequest(
                                    requestId = id,
                                    questions = questions,
                                ),
                            )
                        }
                    }
                } else {
                    updateState {
                        copy(
                            pendingApprovals = pendingApprovals.enqueueDistinct(
                                ApprovalRequest(
                                    id = responseKey(id),
                                    requestId = id,
                                    method = method,
                                    command = params?.string("command"),
                                    reason = params?.string("reason"),
                                    threadId = params?.string("threadId"),
                                    turnId = params?.string("turnId"),
                                ),
                            ),
                        )
                    }
                }
            },
            onDisconnected = { throwable ->
                if (!isCurrentClientCallback(epoch, clientGeneration)) {
                    Log.d(
                        TAG,
                        "ignore stale disconnect epoch=$epoch current=${connectionEpoch.get()} client=$clientGeneration active=${activeClientGeneration.get()}",
                    )
                    return@SecureBridgeClient
                }
                Log.e(TAG, "client disconnected epoch=$epoch phase=${state.value.connectionPhase}", throwable)
                val isBenignDisconnect = throwable.isBenignBackgroundDisconnect()
                stopSelectedThreadSyncLoop()
                updateState {
                    copy(
                        connectionPhase = ConnectionPhase.OFFLINE,
                        pendingRealtimeSeededTurnIdByThread = emptyMap(),
                        lastErrorMessage = if (isBenignDisconnect) lastErrorMessage else throwable?.message,
                    )
                }
            },
            onSecureStateChanged = { secureState, fingerprint ->
                if (!isCurrentClientCallback(epoch, clientGeneration)) {
                    return@SecureBridgeClient
                }
                Log.d(TAG, "secure state epoch=$epoch state=$secureState fingerprint=$fingerprint")
                updateState {
                    copy(
                        secureConnectionState = secureState,
                        secureMacFingerprint = fingerprint ?: secureMacFingerprint,
                    )
                }
            },
            onBridgeSequenceApplied = { sequence ->
                if (!isCurrentClientCallback(epoch, clientGeneration)) {
                    return@SecureBridgeClient
                }
                state.value.activePairing?.let { activePairing ->
                    val updatedPairing = activePairing.copy(lastAppliedBridgeOutboundSeq = sequence)
                    val pairings = state.value.pairings.map {
                        if (it.macDeviceId == updatedPairing.macDeviceId) updatedPairing else it
                    }
                    store.savePairings(pairings)
                    updateState { copy(pairings = pairings) }
                }
            },
            onTrustedMacConfirmed = { trustedMac ->
                if (!isCurrentClientCallback(epoch, clientGeneration)) {
                    return@SecureBridgeClient
                }
                val updatedRegistry = state.value.trustedMacRegistry.copy(
                    records = state.value.trustedMacRegistry.records + (trustedMac.macDeviceId to trustedMac),
                )
                store.saveTrustedMacRegistry(updatedRegistry)
                updateState {
                    copy(
                        trustedMacRegistry = updatedRegistry,
                        secureConnectionState = SecureConnectionState.ENCRYPTED,
                        secureMacFingerprint = SecureCrypto.fingerprint(trustedMac.macIdentityPublicKey),
                    )
                }
            },
        )
    }

    private suspend fun handleNotification(method: String, params: JsonObject?) {
        when (method) {
            "thread/started" -> {
                val thread = params?.get("thread")?.jsonObjectOrNull()?.let(ThreadSummary::fromJson) ?: return
                updateState { copy(threads = upsertThread(threads, thread)) }
            }

            "thread/name/updated" -> {
                val threadId = params?.string("threadId") ?: return
                val updatedName = params.string("name") ?: return
                updateState {
                    copy(
                        threads = threads.map { thread ->
                            if (thread.id == threadId) {
                                thread.copy(name = updatedName)
                            } else {
                                thread
                            }
                        },
                    )
                }
            }

            "thread/status/changed" -> {
                handleThreadStatusChanged(params)
            }

            "thread/history/changed" -> {
                handleThreadHistoryChanged(params)
            }

            "thread/tokenUsage/updated" -> {
                handleThreadTokenUsageUpdated(params)
            }

            "account/rateLimits/updated" -> {
                handleRateLimitsUpdated(params)
            }

            "timeline/turnUpdated" -> {
                handleCanonicalTimelineTurnUpdated(params)
            }

            "timeline/itemStarted" -> {
                handleCanonicalTimelineItemEvent(params, CanonicalTimelineEventKind.STARTED)
            }

            "timeline/itemTextUpdated" -> {
                handleCanonicalTimelineItemEvent(params, CanonicalTimelineEventKind.TEXT_UPDATED)
            }

            "timeline/itemCompleted" -> {
                handleCanonicalTimelineItemEvent(params, CanonicalTimelineEventKind.COMPLETED)
            }

            "serverRequest/resolved" -> {
                val resolvedParams = params ?: return
                val requestId = resolvedParams["requestId"] ?: return
                removeStructuredUserInputPrompt(
                    requestId = requestId,
                    threadIdHint = resolvedParams.string("threadId"),
                )
            }

            "error", "turn/failed" -> {
                val resolvedParams = params
                val threadId = params.resolveThreadId() ?: state.value.selectedThreadId ?: return
                val finalizedTimeline = finalizeCompletedTurnTimeline(
                    threadId = threadId,
                    turnId = params.resolveTurnId() ?: state.value.activeTurnIdByThread[threadId],
                )
                appendLocalMessage(
                    ChatMessage(
                        threadId = threadId,
                        role = MessageRole.SYSTEM,
                        kind = MessageKind.COMMAND_EXECUTION,
                        text = resolvedParams?.string("message") ?: "Runtime error",
                        orderIndex = nextOrderIndex(),
                    ),
                )
                updateState {
                    copy(
                        messagesByThread = if (finalizedTimeline != null) {
                            messagesByThread + (threadId to finalizedTimeline)
                        } else {
                            messagesByThread
                        },
                        runningThreadIds = runningThreadIds - threadId,
                        activeTurnIdByThread = activeTurnIdByThread - threadId,
                        pendingRealtimeSeededTurnIdByThread = pendingRealtimeSeededTurnIdByThread - threadId,
                        failedThreadIds = if (selectedThreadId != threadId) failedThreadIds + threadId else failedThreadIds,
                        threads = if (finalizedTimeline != null) {
                            threads.refreshThreadSummaryFromMessages(threadId, finalizedTimeline)
                        } else {
                            threads
                        },
                    )
                }
                checkAndSendNextQueuedDraft(threadId)
            }

            else -> {
                Log.d(TAG, "ignored notification method=$method params=${params?.toString()?.take(400)}")
            }
        }
    }

    private suspend fun handleCanonicalTimelineTurnUpdated(params: JsonObject?) {
        val payload = params ?: return
        state.value.resolveRealtimeThreadId(payload)?.let { threadId ->
            val syncMetadata = decodeThreadSyncMetadata(payload)
            if (!acceptThreadSyncMetadata(
                    threadId = threadId,
                    syncEpoch = syncMetadata.syncEpoch,
                    sourceKind = syncMetadata.sourceKind,
                )
            ) {
                return
            }
        }
        val normalizedState = normalizeMethodToken(payload.string("state").orEmpty())
        if (normalizedState == "running") {
            val threadId = state.value.resolveRealtimeThreadId(payload) ?: return
            markRealtimeTurnStarted(threadId = threadId, turnId = payload.resolveTurnId())
            return
        }

        val synthesized = if (payload["status"] == null && normalizedState.isNotBlank()) {
            JsonObject(payload + ("status" to JsonPrimitive(normalizedState)))
        } else {
            payload
        }
        handleTurnCompletedNotification(synthesized)
    }

    private fun handleCanonicalTimelineItemEvent(
        params: JsonObject?,
        eventKind: CanonicalTimelineEventKind,
    ) {
        val payload = params ?: return
        val threadId = state.value.resolveRealtimeThreadId(payload) ?: return
        val timelineItemId = payload.resolveTimelineItemId() ?: return
        val turnId = payload.resolveTurnId() ?: state.value.activeTurnIdByThread[threadId]
        val syncMetadata = decodeThreadSyncMetadata(payload)
        if (!acceptThreadSyncMetadata(
                threadId = threadId,
                syncEpoch = syncMetadata.syncEpoch,
                sourceKind = syncMetadata.sourceKind,
            )
        ) {
            return
        }
        if (!handleRealtimeHistoryEvent(
                threadId = threadId,
                turnId = turnId,
                itemId = timelineItemId,
                previousItemId = payload.resolvePreviousItemId(),
                cursor = payload.resolveCursor(),
                previousCursor = payload.resolvePreviousCursor(),
            )
        ) {
            return
        }

        markRealtimeTurnStarted(threadId = threadId, turnId = turnId)
        val role = canonicalTimelineRole(payload.string("role"))
        val kind = resolveTimelineMessageKind(payload.string("kind"), payload)
        val textMode = canonicalTimelineTextMode(payload.string("textMode") ?: payload.string("text_mode"))
        val providerItemId = firstNonBlank(
            payload.string("providerItemId"),
            payload.string("provider_item_id"),
        )
        val timelineOrdinal = payload.int("ordinal")
        val timelineStatus = normalizedIdentifier(payload.string("status"))
        val planState = if (kind == MessageKind.PLAN) decodePlanState(payload) else null
        val commandState = if (kind == MessageKind.COMMAND_EXECUTION) {
            decodeCommandState(payload, completedFallback = eventKind == CanonicalTimelineEventKind.COMPLETED)
        } else {
            null
        }
        val subagentAction = if (kind == MessageKind.SUBAGENT_ACTION) {
            decodeSubagentActionItem(payload)
        } else {
            null
        }
        val structuredUserInputRequest = if (kind == MessageKind.USER_INPUT_PROMPT) {
            decodeStructuredUserInputRequest(payload)
        } else {
            null
        }
        val fileChanges = if (kind == MessageKind.FILE_CHANGE) decodeFileChangeEntries(payload) else emptyList()
        val resolvedText = canonicalTimelineText(
            payload = payload,
            kind = kind,
            planState = planState,
            commandState = commandState,
            subagentAction = subagentAction,
            structuredUserInputRequest = structuredUserInputRequest,
            fileChanges = fileChanges,
        )
        val isStreaming = canonicalTimelineIsStreaming(timelineStatus, eventKind)

        if (isStreaming) {
            val updatedRenderedMessages = finalizeSupersededCanonicalStreamingMessages(
                threadId = threadId,
                turnId = turnId,
                keepingTimelineItemId = timelineItemId,
            )
            if (updatedRenderedMessages != null) {
                updateState {
                    copy(
                        messagesByThread = messagesByThread + (threadId to updatedRenderedMessages),
                        threads = threads.refreshThreadSummaryFromMessages(threadId, updatedRenderedMessages),
                    )
                }
            }
        }

        upsertCanonicalTimelineMessage(
            threadId = threadId,
            turnId = turnId,
            timelineItemId = timelineItemId,
            providerItemId = providerItemId,
            role = role,
            kind = kind,
            incomingText = resolvedText,
            textMode = textMode,
            isStreaming = isStreaming,
            timelineOrdinal = timelineOrdinal,
            timelineStatus = timelineStatus,
            fileChanges = fileChanges,
            commandState = commandState,
            subagentAction = subagentAction,
            planState = planState,
            structuredUserInputRequest = structuredUserInputRequest,
        )
    }

    private fun handleTurnCompletedNotification(params: JsonObject) {
        val threadId = state.value.resolveRealtimeThreadId(params) ?: return
        val resolvedTurnId = params.resolveTurnId() ?: state.value.activeTurnIdByThread[threadId]
        val status = params.string("status") ?: params["turn"]?.jsonObjectOrNull()?.string("status")
        val isFailed = status?.lowercase()?.contains("fail") == true ||
            status?.lowercase()?.contains("error") == true ||
            params.string("errorMessage") != null ||
            params["turn"]?.jsonObjectOrNull()?.get("error") != null
        val isStopped = status?.lowercase()?.contains("cancel") == true ||
            status?.lowercase()?.contains("abort") == true ||
            status?.lowercase()?.contains("interrupt") == true ||
            status?.lowercase()?.contains("stop") == true
        val terminalState = if (isFailed) ThreadRunBadgeState.FAILED else if (isStopped) null else ThreadRunBadgeState.READY
        val finalizedTimeline = finalizeCompletedTurnTimeline(threadId = threadId, turnId = resolvedTurnId)

        updateState {
            copy(
                messagesByThread = if (finalizedTimeline != null) {
                    messagesByThread + (threadId to finalizedTimeline)
                } else {
                    messagesByThread
                },
                runningThreadIds = runningThreadIds - threadId,
                activeTurnIdByThread = activeTurnIdByThread - threadId,
                pendingRealtimeSeededTurnIdByThread = pendingRealtimeSeededTurnIdByThread - threadId,
                readyThreadIds = if (terminalState == ThreadRunBadgeState.READY && selectedThreadId != threadId) readyThreadIds + threadId else readyThreadIds,
                failedThreadIds = if (terminalState == ThreadRunBadgeState.FAILED && selectedThreadId != threadId) failedThreadIds + threadId else failedThreadIds,
                threads = if (finalizedTimeline != null) {
                    threads.refreshThreadSummaryFromMessages(threadId, finalizedTimeline)
                } else {
                    threads
                },
            )
        }
        resumeSeededHistoryThreadIds.remove(threadId)
        if (state.value.selectedThreadId == threadId) {
            scope.launch {
                runCatching {
                    refreshThreadHistory(threadId, reason = "turn-completed")
                }.onFailure { failure ->
                    Log.w(TAG, "post-completion tail refresh failed threadId=$threadId", failure)
                }.onSuccess {
                    scheduleCanonicalHistoryReconcileIfNeeded(threadId)
                }
            }
        } else {
            scheduleCanonicalHistoryReconcileIfNeeded(threadId)
        }
        checkAndSendNextQueuedDraft(threadId)
    }

    private fun handleThreadStatusChanged(params: JsonObject?) {
        val threadId = params.resolveThreadId() ?: return
        val payload = params ?: return
        val normalizedStatus = normalizeMethodToken(
            firstNonBlank(
                payload.string("status"),
                payload["status"]?.jsonObjectOrNull()?.string("type"),
                payload["event"]?.jsonObjectOrNull()?.string("status"),
                payload["event"]?.jsonObjectOrNull()?.get("status")?.jsonObjectOrNull()?.string("type"),
            ).orEmpty(),
        )
        if (normalizedStatus in setOf("active", "running", "processing", "inprogress", "started", "pending")) {
            updateState { copy(runningThreadIds = runningThreadIds + threadId) }
            return
        }
        if (normalizedStatus in setOf("idle", "notloaded", "completed", "done", "finished", "stopped", "systemerror")) {
            val hasStreamingMessage = state.value.messagesByThread[threadId].orEmpty().any(ChatMessage::isStreaming)
            if (state.value.activeTurnIdByThread[threadId] != null || hasStreamingMessage) {
                return
            }
            updateState {
                copy(
                    runningThreadIds = runningThreadIds - threadId,
                    activeTurnIdByThread = if (activeTurnIdByThread[threadId] == null) {
                        activeTurnIdByThread
                    } else {
                        activeTurnIdByThread - threadId
                    },
                    pendingRealtimeSeededTurnIdByThread = pendingRealtimeSeededTurnIdByThread - threadId,
                )
            }
            resumeSeededHistoryThreadIds.remove(threadId)
            scheduleCanonicalHistoryReconcileIfNeeded(threadId)
        }
    }

    private fun handleThreadHistoryChanged(params: JsonObject?) {
        val payload = params ?: return
        val activeThreadId = state.value.selectedThreadId
        val threadId = payload.resolveThreadId() ?: activeThreadId ?: return

        if (activeThreadId != threadId) {
            return
        }

        val syncMetadata = decodeThreadSyncMetadata(payload)
        if (!acceptThreadSyncMetadata(
                threadId = threadId,
                syncEpoch = syncMetadata.syncEpoch,
                sourceKind = syncMetadata.sourceKind,
            )
        ) {
            return
        }

        val sourceMethod = payload.string("sourceMethod")
            ?: payload.string("rawMethod")
            ?: "unknown"
        if (sourceMethod == "thread/read") {
            scheduleThreadHistoryCatchUp(threadId)
            return
        }

        val advancedRealtimeCursor = handleRealtimeHistoryEvent(
            threadId = threadId,
            turnId = payload.resolveTurnId() ?: state.value.activeTurnIdByThread[threadId],
            itemId = payload.resolveItemId(),
            previousItemId = payload.resolvePreviousItemId(),
            cursor = payload.resolveCursor(),
            previousCursor = payload.resolvePreviousCursor(),
        )
        if (advancedRealtimeCursor) {
            return
        }

        scheduleThreadHistoryCatchUp(threadId)
    }

    private fun handleThreadTokenUsageUpdated(params: JsonObject?) {
        val threadId = params.resolveThreadId() ?: return
        val usageObject = params?.get("usage")?.jsonObjectOrNull()
            ?: params?.get("event")?.jsonObjectOrNull()?.get("usage")?.jsonObjectOrNull()
            ?: params
            ?: return
        val usage = extractContextWindowUsage(usageObject) ?: return
        updateState {
            copy(
                contextWindowUsageByThread = contextWindowUsageByThread + (threadId to usage),
            )
        }
    }

    private fun handleRateLimitsUpdated(params: JsonObject?) {
        val payload = params ?: return
        applyRateLimitsPayload(payload, mergeWithExisting = true)
        updateState { copy(rateLimitsErrorMessage = null) }
    }

    private fun extractContextWindowUsageIfAvailable(threadId: String, threadObject: JsonObject) {
        val usageObject = threadObject["usage"]?.jsonObjectOrNull()
            ?: threadObject["tokenUsage"]?.jsonObjectOrNull()
            ?: threadObject["token_usage"]?.jsonObjectOrNull()
            ?: threadObject["contextWindow"]?.jsonObjectOrNull()
            ?: threadObject["context_window"]?.jsonObjectOrNull()
        val usage = extractContextWindowUsage(usageObject) ?: return
        updateState {
            copy(contextWindowUsageByThread = contextWindowUsageByThread + (threadId to usage))
        }
    }

    private fun extractContextWindowUsage(usageObject: JsonObject?): com.coderover.android.data.model.ContextWindowUsage? {
        val objectValue = usageObject ?: return null
        val usedTokens = firstNonNull(
            objectValue.int("tokensUsed"),
            objectValue.int("tokens_used"),
            objectValue.int("totalTokens"),
            objectValue.int("total_tokens"),
            objectValue.int("input_tokens"),
        ) ?: 0
        val totalTokens = firstNonNull(
            objectValue.int("tokenLimit"),
            objectValue.int("token_limit"),
            objectValue.int("maxTokens"),
            objectValue.int("max_tokens"),
            objectValue.int("contextWindow"),
            objectValue.int("context_window"),
        ) ?: 0
        if (totalTokens <= 0) {
            return null
        }
        return com.coderover.android.data.model.ContextWindowUsage(
            tokensUsed = usedTokens,
            tokenLimit = totalTokens,
        )
    }

    private fun checkAndSendNextQueuedDraft(threadId: String) {
        when (val decision = state.value.queueDrainDecision(threadId)) {
            QueueDrainDecision.Skip -> return
            is QueueDrainDecision.Defer -> {
                queueCoordinator.restoreDeferredAttempt(threadId, decision.attempt)
                return
            }
            is QueueDrainDecision.Dispatch -> {
                queueCoordinator.dispatchAttempt(threadId, decision.attempt)
            }
        }
    }

    private suspend fun dispatchDraftTurn(
        threadId: String,
        text: String,
        attachments: List<ImageAttachment>,
        skillMentions: List<TurnSkillMention>,
        usePlanMode: Boolean,
    ) {
        val trimmed = text.trim()
        if (trimmed.isEmpty() && attachments.isEmpty()) {
            return
        }
        val selectedModel = state.value.selectedTurnStartModel()
        if (usePlanMode && selectedModel == null) {
            throw IllegalStateException("Plan mode requires an available model before starting a turn.")
        }
        appendLocalMessage(
            ChatMessage(
                threadId = threadId,
                role = MessageRole.USER,
                text = trimmed,
                attachments = attachments,
                orderIndex = nextOrderIndex(),
            ),
        )
        updateState {
            copy(
                runningThreadIds = runningThreadIds + threadId,
                lastErrorMessage = null,
            )
        }
        try {
            executeTurnStartRequest(
                threadId = threadId,
                text = trimmed,
                attachments = attachments,
                skillMentions = skillMentions,
                usePlanMode = usePlanMode,
                selectedModel = selectedModel,
            )
        } catch (failure: Throwable) {
            updateState {
                copy(
                    runningThreadIds = runningThreadIds - threadId,
                    lastErrorMessage = failure.message ?: "Unable to send message.",
                )
            }
            throw failure
        }
    }

    private suspend fun executeTurnStartRequest(
        threadId: String,
        text: String,
        attachments: List<ImageAttachment>,
        skillMentions: List<TurnSkillMention>,
        usePlanMode: Boolean,
        selectedModel: ModelOption?,
    ) {
        var includeStructuredSkillItems = skillMentions.isNotEmpty()
        while (true) {
            val params = buildJsonObject(
                "threadId" to JsonPrimitive(threadId),
                "input" to buildTurnInputItems(
                    text = text,
                    attachments = attachments,
                    skillMentions = skillMentions,
                    includeStructuredSkillItems = includeStructuredSkillItems,
                ),
                "model" to state.value.selectedModelId?.let(::JsonPrimitive),
                "effort" to state.value.selectedReasoningEffort?.let(::JsonPrimitive),
                "collaborationMode" to state.value.turnStartCollaborationMode(
                    usePlanMode = usePlanMode,
                    selectedModel = selectedModel,
                ),
            )
            try {
                val response = requestWithSandboxFallback("turn/start", params)?.jsonObjectOrNull()
                markRealtimeTurnStarted(
                    threadId = threadId,
                    turnId = response.resolveTurnId(),
                )
                return
            } catch (failure: Throwable) {
                if (includeStructuredSkillItems && shouldRetryTurnStartWithoutSkillItems(failure)) {
                    includeStructuredSkillItems = false
                    continue
                }
                throw failure
            }
        }
    }

    private fun markRealtimeTurnStarted(
        threadId: String,
        turnId: String?,
    ) {
        val normalizedTurnId = normalizedIdentifier(turnId)
        updateState {
            val shouldTrackPendingRealtimeSeed = normalizedTurnId != null &&
                messagesByThread[threadId].orEmpty().hasOptimisticLocalUserTailMessage(normalizedTurnId)
            copy(
                runningThreadIds = runningThreadIds + threadId,
                readyThreadIds = readyThreadIds - threadId,
                failedThreadIds = failedThreadIds - threadId,
                activeTurnIdByThread = if (normalizedTurnId == null) {
                    activeTurnIdByThread
                } else {
                    activeTurnIdByThread + (threadId to normalizedTurnId)
                },
                pendingRealtimeSeededTurnIdByThread = when {
                    normalizedTurnId == null -> pendingRealtimeSeededTurnIdByThread
                    shouldTrackPendingRealtimeSeed -> pendingRealtimeSeededTurnIdByThread + (threadId to normalizedTurnId)
                    else -> pendingRealtimeSeededTurnIdByThread - threadId
                },
            )
        }
    }

    private fun prependQueuedDraft(
        threadId: String,
        draft: QueuedTurnDraft,
    ) {
        updateState {
            copy(queuedTurnDraftsByThread = restoreQueuedDraft(threadId, draft))
        }
    }

    private fun pauseQueuedDrafts(threadId: String, message: String) {
        val outcome = queuePauseOutcome(threadId, message)
        updateState {
            copy(
                queuePauseMessageByThread = queuePauseMessageByThread + (outcome.threadId to outcome.message),
                lastErrorMessage = outcome.userVisibleError,
            )
        }
    }

    private fun buildReviewStartParams(
        threadId: String,
        target: CodeRoverReviewTarget,
        baseBranch: String?,
    ): JsonObject {
        val targetObject = when (target) {
            CodeRoverReviewTarget.UNCOMMITTED_CHANGES -> {
                buildJsonObject("type" to JsonPrimitive("uncommittedChanges"))
            }

            CodeRoverReviewTarget.BASE_BRANCH -> {
                val normalizedBranch = baseBranch?.trim()?.takeIf(String::isNotEmpty)
                    ?: throw IllegalArgumentException("Choose a base branch before starting this review.")
                buildJsonObject(
                    "type" to JsonPrimitive("baseBranch"),
                    "branch" to JsonPrimitive(normalizedBranch),
                )
            }
        }

        return buildJsonObject(
            "threadId" to JsonPrimitive(threadId),
            "delivery" to JsonPrimitive("inline"),
            "target" to targetObject,
        )
    }

    private fun reviewPromptText(target: CodeRoverReviewTarget, baseBranch: String?): String {
        return when (target) {
            CodeRoverReviewTarget.UNCOMMITTED_CHANGES -> "Review current changes"
            CodeRoverReviewTarget.BASE_BRANCH -> {
                val normalizedBranch = baseBranch?.trim().takeUnless { it.isNullOrEmpty() }
                if (normalizedBranch != null) {
                    "Review against base branch $normalizedBranch"
                } else {
                    "Review against base branch"
                }
            }
        }
    }

    private suspend fun fetchRateLimitsWithCompatRetry(): JsonObject? {
        return try {
            activeClient().sendRequest("account/rateLimits/read", null)?.jsonObjectOrNull()
        } catch (failure: Throwable) {
            if (!shouldRetryRateLimitsWithEmptyParams(failure)) {
                throw failure
            }
            activeClient().sendRequest("account/rateLimits/read", JsonObject(emptyMap()))?.jsonObjectOrNull()
        }
    }

    private fun applyRateLimitsPayload(payload: JsonObject, mergeWithExisting: Boolean) {
        val decodedBuckets = decodeRateLimitBuckets(payload)
        val resolvedBuckets = if (mergeWithExisting) {
            mergeRateLimitBuckets(state.value.rateLimitBuckets, decodedBuckets)
        } else {
            decodedBuckets
        }
        updateState {
            copy(
                rateLimitBuckets = resolvedBuckets.sortedWith(
                    compareBy<CodeRoverRateLimitBucket>({ it.sortDurationMins }, { it.displayLabel.lowercase() }),
                ),
            )
        }
    }

    private fun decodeRateLimitBuckets(payload: JsonObject): List<CodeRoverRateLimitBucket> {
        payload["rateLimitsByLimitId"]?.jsonObjectOrNull()?.let { keyedBuckets ->
            return keyedBuckets.mapNotNull { (limitId, value) ->
                decodeRateLimitBucket(limitId, value)
            }
        }
        payload["rate_limits_by_limit_id"]?.jsonObjectOrNull()?.let { keyedBuckets ->
            return keyedBuckets.mapNotNull { (limitId, value) ->
                decodeRateLimitBucket(limitId, value)
            }
        }

        val nestedBuckets = payload["rateLimits"]?.jsonObjectOrNull()
            ?: payload["rate_limits"]?.jsonObjectOrNull()
        if (nestedBuckets != null) {
            if (containsDirectRateLimitWindows(nestedBuckets)) {
                return decodeDirectRateLimitBuckets(nestedBuckets)
            }
            decodeRateLimitBucket(null, nestedBuckets)?.let { return listOf(it) }
        }

        payload["result"]?.jsonObjectOrNull()?.let { result ->
            return decodeRateLimitBuckets(result)
        }

        if (containsDirectRateLimitWindows(payload)) {
            return decodeDirectRateLimitBuckets(payload)
        }

        return emptyList()
    }

    private fun decodeRateLimitBucket(
        explicitLimitId: String?,
        value: JsonElement,
    ): CodeRoverRateLimitBucket? {
        val objectValue = value.jsonObjectOrNull() ?: return null
        val limitId = explicitLimitId
            ?: firstNonBlank(
                objectValue.string("limitId"),
                objectValue.string("limit_id"),
                objectValue.string("id"),
            )
            ?: UUID.randomUUID().toString()
        val primary = decodeRateLimitWindow(
            objectValue["primary"] ?: objectValue["primary_window"],
        )
        val secondary = decodeRateLimitWindow(
            objectValue["secondary"] ?: objectValue["secondary_window"],
        )
        if (primary == null && secondary == null) {
            return null
        }
        return CodeRoverRateLimitBucket(
            limitId = limitId,
            limitName = firstNonBlank(
                objectValue.string("limitName"),
                objectValue.string("limit_name"),
                objectValue.string("name"),
            ),
            primary = primary,
            secondary = secondary,
        )
    }

    private fun decodeDirectRateLimitBuckets(objectValue: JsonObject): List<CodeRoverRateLimitBucket> {
        val buckets = mutableListOf<CodeRoverRateLimitBucket>()
        decodeRateLimitWindow(objectValue["primary"] ?: objectValue["primary_window"])?.let { primary ->
            buckets += CodeRoverRateLimitBucket(
                limitId = "primary",
                limitName = firstNonBlank(
                    objectValue.string("limitName"),
                    objectValue.string("limit_name"),
                    objectValue.string("name"),
                ),
                primary = primary,
                secondary = null,
            )
        }
        decodeRateLimitWindow(objectValue["secondary"] ?: objectValue["secondary_window"])?.let { secondary ->
            buckets += CodeRoverRateLimitBucket(
                limitId = "secondary",
                limitName = firstNonBlank(
                    objectValue.string("secondaryName"),
                    objectValue.string("secondary_name"),
                ),
                primary = secondary,
                secondary = null,
            )
        }
        return buckets
    }

    private fun decodeRateLimitWindow(value: JsonElement?): CodeRoverRateLimitWindow? {
        val objectValue = value?.jsonObjectOrNull() ?: return null
        val usedPercent = firstNonNull(
            objectValue.int("usedPercent"),
            objectValue.int("used_percent"),
        ) ?: 0
        val durationMins = firstNonNull(
            objectValue.int("windowDurationMins"),
            objectValue.int("window_duration_mins"),
            objectValue.int("windowMinutes"),
            objectValue.int("window_minutes"),
        )
        val resetsAtMillis = firstResetTimestampMillis(objectValue)
        return CodeRoverRateLimitWindow(
            usedPercent = usedPercent,
            windowDurationMins = durationMins,
            resetsAtMillis = resetsAtMillis,
        )
    }

    private fun containsDirectRateLimitWindows(objectValue: JsonObject): Boolean {
        return objectValue["primary"] != null ||
            objectValue["secondary"] != null ||
            objectValue["primary_window"] != null ||
            objectValue["secondary_window"] != null
    }

    private fun mergeRateLimitBuckets(
        existing: List<CodeRoverRateLimitBucket>,
        incoming: List<CodeRoverRateLimitBucket>,
    ): List<CodeRoverRateLimitBucket> {
        if (existing.isEmpty()) return incoming
        if (incoming.isEmpty()) return existing

        val merged = existing.associateByTo(linkedMapOf(), CodeRoverRateLimitBucket::limitId).toMutableMap()
        incoming.forEach { bucket ->
            val current = merged[bucket.limitId]
            merged[bucket.limitId] = if (current == null) {
                bucket
            } else {
                CodeRoverRateLimitBucket(
                    limitId = bucket.limitId,
                    limitName = bucket.limitName ?: current.limitName,
                    primary = bucket.primary ?: current.primary,
                    secondary = bucket.secondary ?: current.secondary,
                )
            }
        }
        return merged.values.toList()
    }

    private fun shouldRetryRateLimitsWithEmptyParams(error: Throwable): Boolean {
        val message = error.message?.lowercase().orEmpty()
        return message.contains("params") || message.contains("invalid request")
    }

    private fun firstResetTimestampMillis(objectValue: JsonObject): Long? {
        val numeric = objectValue["resetsAt"]?.jsonObjectOrNull()
        if (numeric != null) {
            return null
        }
        val rawNumeric = (objectValue["resetsAt"] as? JsonPrimitive)?.contentOrNull?.toDoubleOrNull()
            ?: (objectValue["resets_at"] as? JsonPrimitive)?.contentOrNull?.toDoubleOrNull()
            ?: (objectValue["resetAt"] as? JsonPrimitive)?.contentOrNull?.toDoubleOrNull()
            ?: (objectValue["reset_at"] as? JsonPrimitive)?.contentOrNull?.toDoubleOrNull()
        if (rawNumeric != null) {
            val millis = if (rawNumeric > 10_000_000_000L) rawNumeric.toLong() else (rawNumeric * 1000.0).toLong()
            return millis
        }

        return firstNonBlank(
            objectValue.string("resetsAt"),
            objectValue.string("resets_at"),
            objectValue.string("resetAt"),
            objectValue.string("reset_at"),
        )?.let(::parseTimestamp)
    }

    private fun currentRuntimeProviderId(): String {
        val currentState = state.value
        return normalizeProviderId(currentState.selectedThread?.provider ?: currentState.selectedProviderId)
    }

    private fun orderedTransportUrls(pairingRecord: PairingRecord): List<String> {
        return TransportCandidatePrioritizer.orderedTransportUrls(pairingRecord)
    }

    private suspend fun startThread(preferredProjectPath: String?, providerId: String? = null): ThreadSummary? {
        val resolvedProviderId = normalizeProviderId(providerId ?: state.value.selectedProviderId)
        val normalizedPreferredProjectPath = normalizedProjectPath(preferredProjectPath)
        val params = buildJsonObject(
            "provider" to JsonPrimitive(resolvedProviderId),
            "model" to store.loadSelectedModelId(resolvedProviderId)?.let(::JsonPrimitive),
            "cwd" to normalizedPreferredProjectPath?.let(::JsonPrimitive),
        )
        val response = requestWithSandboxFallback("thread/start", params)
        val thread = response
            ?.jsonObjectOrNull()
            ?.get("thread")
            ?.jsonObjectOrNull()
            ?.let(ThreadSummary::fromJson)
            ?.let { decoded ->
                if (decoded.normalizedProjectPath == null && normalizedPreferredProjectPath != null) {
                    decoded.copy(cwd = normalizedPreferredProjectPath)
                } else {
                    decoded
                }
            }
            ?: run {
                updateError("thread/start did not return a thread.")
                return null
            }
        updateState {
            copy(
                threads = upsertThread(threads, thread, treatAsServerState = true),
                selectedThreadId = thread.id,
                selectedProviderId = resolvedProviderId,
                lastErrorMessage = null,
            )
        }
        return thread
    }

    private suspend fun ensureThreadResumed(
        threadId: String,
        preferredProjectPath: String? = null,
        modelIdentifierOverride: String? = null,
    ): ThreadSummary? {
        val normalizedThreadId = normalizedIdentifier(threadId) ?: return null
        val normalizedPreferredProjectPath = normalizedProjectPath(preferredProjectPath)
            ?: state.value.threads.firstOrNull { it.id == normalizedThreadId }?.normalizedProjectPath
        val requestedSignature = ThreadResumeRequestSignature(
            projectPath = normalizedPreferredProjectPath,
            modelIdentifier = modelIdentifierOverride?.trim()?.takeIf(String::isNotEmpty),
        )

        threadResumeTaskByThreadId[normalizedThreadId]?.let { existingTask ->
            if (threadResumeRequestSignatureByThreadId[normalizedThreadId] == requestedSignature) {
                return existingTask.await()
            }
            threadSyncCoordinator.invalidateRefreshGeneration(normalizedThreadId)
            existingTask.cancel()
        }

        val refreshGeneration = currentRefreshGeneration(normalizedThreadId)
        lateinit var task: Deferred<ThreadSummary?>
        task = scope.async(start = CoroutineStart.LAZY) {
            try {
                val params = buildJsonObject(
                    "threadId" to JsonPrimitive(normalizedThreadId),
                    "cwd" to normalizedPreferredProjectPath?.let(::JsonPrimitive),
                    "model" to requestedSignature.modelIdentifier?.let(::JsonPrimitive),
                )
                val response = activeClient().sendRequest("thread/resume", params)?.jsonObjectOrNull() ?: return@async null
                if (!isCurrentRefreshGeneration(normalizedThreadId, refreshGeneration)) {
                    return@async null
                }

                val payload = response["result"]?.jsonObjectOrNull() ?: response
                val syncMetadata = decodeThreadSyncMetadata(payload)
                if (!acceptThreadSyncMetadata(
                        threadId = normalizedThreadId,
                        syncEpoch = syncMetadata.syncEpoch,
                        sourceKind = syncMetadata.sourceKind,
                        generation = refreshGeneration,
                    )
                ) {
                    return@async null
                }

                val threadPayload = payload["thread"]?.jsonObjectOrNull() ?: return@async null
                val decodedThread = ThreadSummary.fromJson(threadPayload)
                    ?.let { decoded ->
                        if (decoded.normalizedProjectPath == null && normalizedPreferredProjectPath != null) {
                            decoded.copy(cwd = normalizedPreferredProjectPath)
                        } else {
                            decoded
                        }
                    }
                    ?: return@async null

                updateState {
                    copy(
                        threads = upsertThread(
                            threads,
                            decodedThread.copy(syncState = ThreadSyncState.LIVE),
                            treatAsServerState = true,
                        ),
                    )
                }

                extractContextWindowUsageIfAvailable(normalizedThreadId, threadPayload)
                val historyMessages = decodeMessagesFromThreadRead(normalizedThreadId, threadPayload)
                if (historyMessages.isNotEmpty()) {
                    val renderedMessages = if (historyMessages.any(::isCanonicalTimelineMessage)) {
                        mergeCanonicalHistoryIntoTimelineState(
                            threadId = normalizedThreadId,
                            historyMessages = historyMessages,
                            mode = null,
                            activeThreadIds = state.value.activeTurnIdByThread.keys,
                            runningThreadIds = state.value.runningThreadIds,
                        )
                    } else {
                        mergeHistoryMessages(
                            state.value.messagesByThread[normalizedThreadId].orEmpty(),
                            historyMessages,
                        )
                    }
                    updateState {
                        copy(
                            messagesByThread = messagesByThread + (normalizedThreadId to renderedMessages),
                            threads = threads.refreshThreadSummaryFromMessages(normalizedThreadId, renderedMessages),
                        )
                    }

                    if (decodedThread.provider.equals("codex", ignoreCase = true) &&
                        normalizedHistoryCursor(state.value.historyStateByThread[normalizedThreadId]?.newestCursor) == null
                    ) {
                        resumeSeededHistoryThreadIds += normalizedThreadId
                    }

                    if (state.value.threadHasActiveOrRunningTurn(normalizedThreadId) ||
                        normalizedThreadId in resumeSeededHistoryThreadIds
                    ) {
                        markThreadNeedingCanonicalHistoryReconcile(normalizedThreadId)
                    } else {
                        markThreadCanonicalHistoryReconciled(normalizedThreadId)
                    }
                }

                state.value.threads.firstOrNull { it.id == decodedThread.id } ?: decodedThread
            } finally {
                if (threadResumeTaskByThreadId[normalizedThreadId] === task) {
                    threadResumeTaskByThreadId.remove(normalizedThreadId)
                    threadResumeRequestSignatureByThreadId.remove(normalizedThreadId)
                }
            }
        }

        threadResumeTaskByThreadId[normalizedThreadId] = task
        threadResumeRequestSignatureByThreadId[normalizedThreadId] = requestedSignature
        task.start()
        return task.await()
    }

    private fun rememberSuccessfulTransport(url: String) {
        val activePairing = state.value.activePairing ?: return
        val updatedPairings = state.value.pairings.map { pairing ->
            if (pairing.macDeviceId == activePairing.macDeviceId) {
                pairing.copy(lastSuccessfulTransportUrl = url)
            } else {
                pairing
            }
        }
        store.savePairings(updatedPairings)
        updateState { copy(pairings = updatedPairings) }
    }

    private fun refreshActivePairingTransportCandidates(transportCandidates: List<TransportCandidate>) {
        val normalizedCandidates = transportCandidates
            .filter { it.url.isNotBlank() && it.kind.isNotBlank() }
            .distinctBy { "${it.kind}|${it.url}|${it.label.orEmpty()}" }
        if (normalizedCandidates.isEmpty()) {
            return
        }

        val activePairing = state.value.activePairing ?: return
        if (activePairing.transportCandidates == normalizedCandidates) {
            return
        }

        Log.d(
            TAG,
            "refreshing pairing transport candidates mac=${activePairing.macDeviceId} count=${normalizedCandidates.size}",
        )

        val updatedPairings = state.value.pairings.map { pairing ->
            if (pairing.macDeviceId == activePairing.macDeviceId) {
                pairing.copy(transportCandidates = normalizedCandidates)
            } else {
                pairing
            }
        }
        store.savePairings(updatedPairings)
        updateState { copy(pairings = updatedPairings) }
    }

    private fun resolveSecureConnectionState(
        activePairingMacDeviceId: String?,
        trustedRegistry: TrustedMacRegistry,
    ): SecureConnectionState {
        return if (activePairingMacDeviceId != null && trustedRegistry.records.containsKey(activePairingMacDeviceId)) {
            SecureConnectionState.TRUSTED_MAC
        } else {
            SecureConnectionState.NOT_PAIRED
        }
    }

    private fun updateState(update: AppState.() -> AppState) {
        val previous = _state.value
        val updated = previous.update()
        _state.value = updated
        persistConversationCache(previous, updated)
    }

    private fun updateError(message: String) {
        updateState { copy(lastErrorMessage = message) }
    }

    private fun desktopRestartErrorMessage(errorCode: String?, fallback: String?): String {
        return when (errorCode) {
            "missing_thread_id" -> "This chat does not have a valid thread id yet."
            "unsupported_platform" -> "Desktop restart works only when the bridge is running on macOS."
            "unsupported_provider" -> fallback ?: "This provider does not support desktop restart."
            "restart_failed", "restart_timeout" -> fallback ?: "Could not restart the Codex desktop app on your Mac."
            else -> fallback ?: "Could not restart the desktop app on your Mac."
        }
    }

    private fun rejectScan(code: String, message: String, resetScanLock: (() -> Unit)?) {
        val isDuplicateRejection = lastRejectedCode == code && lastRejectedMessage == message
        lastRejectedCode = code
        lastRejectedMessage = message
        if (!isDuplicateRejection) {
            updateError(message)
        }
        resetScanLock?.invoke()
    }

    private fun persistConversationCache(previous: AppState, updated: AppState) {
        if (previous.threads == updated.threads &&
            previous.selectedThreadId == updated.selectedThreadId &&
            previous.messagesByThread == updated.messagesByThread &&
            previous.historyStateByThread == updated.historyStateByThread
        ) {
            return
        }

        val cachedThreads = updated.threads
            .sortedByDescending { it.updatedAt ?: it.createdAt ?: 0L }
            .take(MAX_CACHED_THREADS)
        val cachedThreadIds = cachedThreads.map(ThreadSummary::id).toSet()
        val cachedMessagesByThread = cachedThreads
            .take(MAX_CACHED_THREADS_WITH_MESSAGES)
            .mapNotNull { thread ->
                updated.messagesByThread[thread.id]
                    ?.sortedBy(ChatMessage::orderIndex)
                    ?.takeLast(MAX_CACHED_MESSAGES_PER_THREAD)
                    ?.map(::sanitizeCachedConversationMessage)
                    ?.takeIf(List<ChatMessage>::isNotEmpty)
                    ?.let { messages -> thread.id to messages }
            }
            .toMap()

        store.saveCachedThreads(cachedThreads)
        store.saveCachedSelectedThreadId(updated.selectedThreadId?.takeIf(cachedThreadIds::contains))
        store.saveCachedMessagesByThread(cachedMessagesByThread)
        store.saveCachedHistoryStateByThread(
            cachedThreads
                .take(MAX_CACHED_THREADS_WITH_MESSAGES)
                .mapNotNull { thread ->
                    updated.historyStateByThread[thread.id]?.let { historyState ->
                        thread.id to historyState
                    }
                }
                .toMap(),
        )
    }

    private fun sanitizeCachedConversationMessage(message: ChatMessage): ChatMessage {
        return message.copy(
            text = message.text.trimForCache(MAX_CACHED_MESSAGE_TEXT_CHARS),
            attachments = message.attachments.map(::sanitizeCachedAttachment),
            fileChanges = message.fileChanges
                .take(MAX_CACHED_FILE_CHANGES)
                .map(::sanitizeCachedFileChange),
            commandState = message.commandState?.let(::sanitizeCachedCommandState),
        )
    }

    private fun sanitizeCachedAttachment(attachment: ImageAttachment): ImageAttachment {
        return attachment.copy(
            thumbnailBase64JPEG = attachment.thumbnailBase64JPEG.trimForCache(MAX_CACHED_ATTACHMENT_THUMBNAIL_CHARS),
            sourceBase64JPEG = null,
            payloadDataURL = null,
        )
    }

    private fun sanitizeCachedFileChange(change: FileChangeEntry): FileChangeEntry {
        return change.copy(
            diff = change.diff.trimForCache(MAX_CACHED_FILE_DIFF_CHARS),
        )
    }

    private fun sanitizeCachedCommandState(commandState: CommandState): CommandState {
        return commandState.copy(
            shortCommand = commandState.shortCommand.trimForCache(MAX_CACHED_COMMAND_CHARS),
            fullCommand = commandState.fullCommand.trimForCache(MAX_CACHED_COMMAND_CHARS),
            cwd = commandState.cwd?.trimForCache(MAX_CACHED_COMMAND_CHARS),
            outputTail = commandState.outputTail.trimForCache(MAX_CACHED_COMMAND_OUTPUT_CHARS),
        )
    }

    private fun scheduleThreadHistoryRetry(threadId: String, reason: String) {
        scope.launch {
            delay(1_500)
            val currentState = state.value
            if (!currentState.isConnected) {
                return@launch
            }
            if (currentState.messagesByThread[threadId].orEmpty().isNotEmpty()) {
                return@launch
            }
            runCatching {
                refreshThreadHistory(threadId, reason = "retry:$reason")
            }.onFailure { failure ->
                Log.w(TAG, "thread/read retry failed reason=$reason threadId=$threadId", failure)
            }
        }
    }

    private suspend fun refreshThreadHistory(threadId: String, reason: String) {
        if (!beginThreadHistoryRefresh(threadId)) {
            return
        }
        try {
            loadThreadHistory(threadId)
        } catch (failure: Throwable) {
            Log.w(TAG, "thread/read refresh failed reason=$reason threadId=$threadId", failure)
            throw failure
        } finally {
            endThreadHistoryRefresh(threadId)
        }
    }

    private suspend fun beginThreadHistoryRefresh(threadId: String): Boolean {
        val currentJob = kotlinx.coroutines.currentCoroutineContext()[Job]
        val didStart = threadHistoryRefreshMutex.withLock {
            if (threadHistoryRefreshInFlight.contains(threadId)) {
                threadHistoryRefreshPending += threadId
                false
            } else {
                threadHistoryRefreshInFlight += threadId
                if (currentJob != null) {
                    threadHistoryLoadTaskByThreadId[threadId] = currentJob
                }
                true
            }
        }
        if (!didStart) {
            return false
        }
        threadSyncCoordinator.invalidateRefreshGeneration(threadId)
        updateState {
            copy(
                historyStateByThread = historyStateByThread + (
                    threadId to ((historyStateByThread[threadId] ?: ThreadHistoryState()).copy(isTailRefreshing = true))
                ),
            )
        }
        return true
    }

    private suspend fun endThreadHistoryRefresh(threadId: String) {
        val shouldRerun = threadHistoryRefreshMutex.withLock {
            threadHistoryRefreshInFlight.remove(threadId)
            val rerun = threadHistoryRefreshPending.remove(threadId)
            threadHistoryLoadTaskByThreadId.remove(threadId)
            rerun
        }
        updateState {
            val currentHistoryState = historyStateByThread[threadId] ?: return@updateState this
            copy(
                historyStateByThread = historyStateByThread + (
                    threadId to currentHistoryState.copy(isTailRefreshing = false)
                ),
            )
        }
        if (shouldRerun) {
            scope.launch {
                runCatching {
                    refreshThreadHistory(threadId, reason = "coalesced")
                }.onFailure { failure ->
                    Log.w(TAG, "coalesced thread/read refresh failed threadId=$threadId", failure)
                }
            }
        }
    }

    private suspend fun isThreadHistoryRefreshBusy(threadId: String): Boolean {
        return threadHistoryRefreshMutex.withLock {
            threadHistoryRefreshInFlight.contains(threadId)
        }
    }

    private fun currentRefreshGeneration(threadId: String): Long {
        return threadSyncCoordinator.currentRefreshGeneration(threadId)
    }

    private fun isCurrentRefreshGeneration(threadId: String, generation: Long): Boolean {
        return threadSyncCoordinator.isRefreshCurrent(threadId, generation)
    }

    private fun acceptThreadSyncMetadata(
        threadId: String,
        syncEpoch: Int?,
        sourceKind: String?,
        generation: Long? = null,
    ): Boolean {
        return threadSyncCoordinator.acceptThreadSyncMetadata(
            threadId = threadId,
            syncEpoch = syncEpoch,
            sourceKind = sourceKind,
            generation = generation,
        )
    }

    private fun decodeThreadSyncMetadata(objectValue: JsonObject?): DecodedThreadSyncMetadata {
        return DecodedThreadSyncMetadata(
            syncEpoch = objectValue?.int("syncEpoch") ?: objectValue?.int("sync_epoch"),
            sourceKind = firstNonBlank(
                objectValue?.string("sourceKind"),
                objectValue?.string("source_kind"),
                objectValue?.string("projectionSource"),
                objectValue?.string("projection_source"),
            ),
        )
    }

    private fun shouldReplaceLocalHistoryWithTailSnapshot(
        threadId: String,
        hasLocalMessages: Boolean,
        hasNewestCursor: Boolean,
    ): Boolean {
        return shouldReplaceLocalHistoryWithTailSnapshot(
            state = state.value,
            resumeSeededHistoryThreadIds = resumeSeededHistoryThreadIds,
            threadId = threadId,
            hasLocalMessages = hasLocalMessages,
            hasNewestCursor = hasNewestCursor,
        )
    }

    private fun markThreadNeedingCanonicalHistoryReconcile(threadId: String) {
        threadSyncCoordinator.markThreadNeedingCanonicalHistoryReconcile(threadId)
        scheduleCanonicalHistoryReconcileIfNeeded(threadId)
    }

    private fun markThreadCanonicalHistoryReconciled(threadId: String) {
        threadSyncCoordinator.markThreadCanonicalHistoryReconciled(threadId)
        resumeSeededHistoryThreadIds.remove(threadId)
    }

    private fun scheduleCanonicalHistoryReconcileIfNeeded(threadId: String) {
        if (!threadSyncCoordinator.needsCanonicalHistoryReconcile(threadId)) {
            return
        }
        if (!state.value.isConnected || state.value.threadHasActiveOrRunningTurn(threadId)) {
            return
        }
        val thread = state.value.threads.firstOrNull { it.id == threadId } ?: return
        if (thread.syncState != ThreadSyncState.LIVE) {
            return
        }
        if (canonicalHistoryReconcileTaskByThreadId[threadId]?.isActive == true) {
            return
        }

        canonicalHistoryReconcileTaskByThreadId[threadId] = scope.launch {
            try {
                refreshThreadHistory(threadId, reason = "canonical-reconcile")
                if (!state.value.threadHasActiveOrRunningTurn(threadId)) {
                    markThreadCanonicalHistoryReconciled(threadId)
                }
            } catch (failure: Throwable) {
                Log.w(TAG, "canonical reconcile failed threadId=$threadId", failure)
            } finally {
                canonicalHistoryReconcileTaskByThreadId.remove(threadId)
            }
        }
    }

    private fun clearThreadSyncState(threadId: String) {
        threadResumeTaskByThreadId.remove(threadId)?.cancel()
        threadResumeRequestSignatureByThreadId.remove(threadId)
        threadHistoryLoadTaskByThreadId.remove(threadId)?.cancel()
        canonicalHistoryReconcileTaskByThreadId.remove(threadId)?.cancel()
        resumeSeededHistoryThreadIds.remove(threadId)
        threadSyncCoordinator.clearThread(threadId)
    }

    private fun clearAllThreadSyncState() {
        (threadResumeTaskByThreadId.keys + threadHistoryLoadTaskByThreadId.keys + canonicalHistoryReconcileTaskByThreadId.keys)
            .toSet()
            .forEach(threadSyncCoordinator::invalidateRefreshGeneration)
        threadResumeTaskByThreadId.values.forEach { it.cancel() }
        threadResumeTaskByThreadId.clear()
        threadResumeRequestSignatureByThreadId.clear()
        threadHistoryLoadTaskByThreadId.values.forEach { it.cancel() }
        threadHistoryLoadTaskByThreadId.clear()
        canonicalHistoryReconcileTaskByThreadId.values.forEach { it.cancel() }
        canonicalHistoryReconcileTaskByThreadId.clear()
        resumeSeededHistoryThreadIds.clear()
        threadSyncCoordinator.clearAll()
    }

    private fun scheduleOlderHistoryBackfill(threadId: String) {
        scope.launch {
            val currentJob = kotlinx.coroutines.currentCoroutineContext()[Job]
            val shouldStart = olderHistoryBackfillMutex.withLock {
                val existingTask = olderHistoryBackfillTaskByThread[threadId]
                if (existingTask?.isActive == true) {
                    false
                } else {
                    if (currentJob != null) {
                        olderHistoryBackfillTaskByThread[threadId] = currentJob
                    }
                    true
                }
            }
            if (!shouldStart) {
                return@launch
            }

            try {
                var pageCount = 0
                while (pageCount < 200) {
                    val currentState = state.value
                    val historyState = currentState.historyStateByThread[threadId] ?: break
                    if (!currentState.isConnected || currentState.selectedThreadId != threadId) {
                        break
                    }
                    if (!historyState.hasOlderOnServer) {
                        break
                    }
                    if (historyState.isLoadingOlder || historyState.isTailRefreshing) {
                        delay(120)
                        continue
                    }
                    val requestCursor = nextOlderHistoryCursor(historyState) ?: break
                    val didLoad = runCatching {
                        loadOlderThreadHistory(threadId)
                    }.onFailure { failure ->
                        Log.w(TAG, "background older history backfill failed threadId=$threadId cursor=$requestCursor", failure)
                    }
                    if (didLoad.isFailure) {
                        break
                    }
                    pageCount += 1
                    yield()
                }
            } finally {
                olderHistoryBackfillMutex.withLock {
                    val existingTask = olderHistoryBackfillTaskByThread[threadId]
                    if (existingTask === currentJob || existingTask?.isActive != true) {
                        olderHistoryBackfillTaskByThread.remove(threadId)
                    }
                }
            }
        }
    }

    private suspend fun disconnectCurrentClient(resetThreadSession: Boolean) {
        connectionEpoch.incrementAndGet()
        activeClientGeneration.set(0)
        stopSelectedThreadSyncLoop()
        clearAllThreadSyncState()
        clientMutex.withLock {
            client?.disconnect()
            client = null
        }
        if (resetThreadSession) {
            activeThreadListNextCursor = JsonNull
            activeThreadListHasMore = false
            threadTimelineStateByThread.clear()
            store.saveCachedThreads(emptyList())
            store.saveCachedSelectedThreadId(null)
            store.saveCachedMessagesByThread(emptyMap())
            store.saveCachedHistoryStateByThread(emptyMap())
        }
        updateState {
            copy(
                connectionPhase = ConnectionPhase.OFFLINE,
                threads = if (resetThreadSession) emptyList() else threads,
                selectedThreadId = if (resetThreadSession) null else selectedThreadId,
                messagesByThread = if (resetThreadSession) emptyMap() else messagesByThread,
                historyStateByThread = if (resetThreadSession) emptyMap() else historyStateByThread,
                runningThreadIds = emptySet(),
                activeTurnIdByThread = emptyMap(),
                pendingRealtimeSeededTurnIdByThread = emptyMap(),
                readyThreadIds = if (resetThreadSession) emptySet() else readyThreadIds,
                failedThreadIds = if (resetThreadSession) emptySet() else failedThreadIds,
                pendingApprovals = emptyList(),
                gitRepoSyncByThread = if (resetThreadSession) emptyMap() else gitRepoSyncByThread,
                gitBranchTargetsByThread = if (resetThreadSession) emptyMap() else gitBranchTargetsByThread,
                selectedGitBaseBranchByThread = if (resetThreadSession) emptyMap() else selectedGitBaseBranchByThread,
                contextWindowUsageByThread = if (resetThreadSession) emptyMap() else contextWindowUsageByThread,
                bridgeStatus = null,
                bridgeUpdatePrompt = null,
                isLoadingBridgeStatus = false,
                assistantRevertPresentationByMessageId = if (resetThreadSession) emptyMap() else assistantRevertPresentationByMessageId,
                queuedTurnDraftsByThread = if (resetThreadSession) emptyMap() else queuedTurnDraftsByThread,
                queuePauseMessageByThread = if (resetThreadSession) emptyMap() else queuePauseMessageByThread,
            )
        }
    }

    private suspend fun activeClient(): SecureBridgeClient {
        return clientMutex.withLock {
            client ?: error("Bridge client is not connected.")
        }
    }

    private fun startSelectedThreadSyncLoop() {
        stopSelectedThreadSyncLoop()
        selectedThreadSyncJob = scope.launch {
            while (true) {
                delay(SELECTED_THREAD_SYNC_INTERVAL_MS)
                val currentState = state.value
                if (!currentState.isConnected) {
                    break
                }
                val threadId = currentState.selectedThreadId ?: continue
                runCatching {
                    refreshThreadHistory(threadId, reason = "selected-thread-poll")
                }.onFailure { failure ->
                    Log.w(TAG, "thread/read refresh failed reason=selected-thread-poll threadId=$threadId", failure)
                }
            }
        }
    }

    private fun stopSelectedThreadSyncLoop() {
        selectedThreadSyncJob?.cancel()
        selectedThreadSyncJob = null
    }

    private fun isCurrentClientCallback(epoch: Long, clientGeneration: Long): Boolean {
        return epoch == connectionEpoch.get() && clientGeneration == activeClientGeneration.get()
    }

    private fun loadOrCreatePhoneIdentityState(): PhoneIdentityState {
        store.loadPhoneIdentityState()?.let { return it }
        val generated = SecureCrypto.generatePhoneIdentity()
        return PhoneIdentityState(
            phoneDeviceId = generated.deviceId,
            phoneIdentityPrivateKey = generated.privateKey,
            phoneIdentityPublicKey = generated.publicKey,
        ).also(store::savePhoneIdentityState)
    }

    private fun upsertThread(
        existing: List<ThreadSummary>,
        thread: ThreadSummary,
        treatAsServerState: Boolean = false,
    ): List<ThreadSummary> {
        val current = existing.firstOrNull { it.id == thread.id }
        val merged = applyAuthoritativeProjectPath(
            thread = mergeThreadSummary(current, thread),
            treatAsServerState = treatAsServerState,
        )
        return (existing.filterNot { it.id == thread.id } + merged).sortedByDescending { it.updatedAt ?: it.createdAt ?: 0L }
    }

    private fun mergeThreadSummary(
        existing: ThreadSummary?,
        incoming: ThreadSummary,
    ): ThreadSummary {
        if (existing == null) {
            return incoming
        }
        return incoming.copy(
            title = incoming.title ?: existing.title,
            name = incoming.name ?: existing.name,
            preview = incoming.preview ?: existing.preview,
            createdAt = incoming.createdAt ?: existing.createdAt,
            updatedAt = maxOf(
                incoming.updatedAt ?: Long.MIN_VALUE,
                existing.updatedAt ?: Long.MIN_VALUE,
            ).takeUnless { it == Long.MIN_VALUE } ?: incoming.createdAt ?: existing.createdAt,
            cwd = incoming.cwd ?: existing.cwd,
            provider = incoming.provider.ifBlank { existing.provider },
            providerSessionId = incoming.providerSessionId ?: existing.providerSessionId,
            capabilities = incoming.capabilities ?: existing.capabilities,
            parentThreadId = incoming.parentThreadId ?: existing.parentThreadId,
            agentId = incoming.agentId ?: existing.agentId,
            agentNickname = incoming.agentNickname ?: existing.agentNickname,
            agentRole = incoming.agentRole ?: existing.agentRole,
            model = incoming.model ?: existing.model,
            modelProvider = incoming.modelProvider ?: existing.modelProvider,
            syncState = incoming.syncState,
        )
    }

    private fun registerSubagentThreadsFromMessages(
        parentThreadId: String,
        messages: List<ChatMessage>,
    ) {
        val actions = messages.mapNotNull(ChatMessage::subagentAction)
        if (actions.isEmpty()) {
            return
        }
        updateState {
            var updatedThreads = threads
            actions.forEach { action ->
                updatedThreads = registerSubagentThreads(updatedThreads, action, parentThreadId)
            }
            if (updatedThreads === threads || updatedThreads == threads) {
                this
            } else {
                copy(threads = updatedThreads)
            }
        }
    }

    private fun registerSubagentThreads(
        existingThreads: List<ThreadSummary>,
        action: SubagentAction,
        parentThreadId: String,
    ): List<ThreadSummary> {
        val normalizedParentThreadId = normalizedIdentifier(parentThreadId) ?: return existingThreads
        val parentThread = existingThreads.firstOrNull { it.id == normalizedParentThreadId }
        var updatedThreads = existingThreads
        action.agentRows.forEach { agent ->
            val childThreadId = normalizedIdentifier(agent.threadId) ?: return@forEach
            if (childThreadId == normalizedParentThreadId) {
                return@forEach
            }
            val existingChild = updatedThreads.firstOrNull { it.id == childThreadId }
            val placeholderTimestamp = existingChild?.updatedAt
                ?: existingChild?.createdAt
                ?: parentThread?.updatedAt
                ?: parentThread?.createdAt
                ?: System.currentTimeMillis()
            val placeholder = ThreadSummary(
                id = childThreadId,
                title = null,
                name = null,
                preview = existingChild?.preview,
                createdAt = existingChild?.createdAt ?: placeholderTimestamp,
                updatedAt = existingChild?.updatedAt ?: placeholderTimestamp,
                cwd = existingChild?.cwd ?: parentThread?.cwd,
                provider = existingChild?.provider ?: parentThread?.provider ?: "codex",
                providerSessionId = existingChild?.providerSessionId ?: parentThread?.providerSessionId,
                capabilities = existingChild?.capabilities ?: parentThread?.capabilities,
                parentThreadId = normalizedParentThreadId,
                agentId = agent.agentId,
                agentNickname = agent.nickname,
                agentRole = agent.role,
                model = existingChild?.model ?: if (agent.modelIsRequestedHint) null else agent.model,
                modelProvider = existingChild?.modelProvider ?: if (agent.modelIsRequestedHint) null else agent.model,
                syncState = existingChild?.syncState ?: parentThread?.syncState ?: ThreadSyncState.LIVE,
            )
            updatedThreads = upsertThread(updatedThreads, placeholder)
        }
        return updatedThreads
    }

    private fun associatedManagedWorktreePath(threadId: String?): String? {
        val normalizedThreadId = normalizedIdentifier(threadId) ?: return null
        return normalizedProjectPath(associatedManagedWorktreePathByThreadId[normalizedThreadId])
    }

    private fun rememberAssociatedManagedWorktreePath(threadId: String, projectPath: String?) {
        val normalizedThreadId = normalizedIdentifier(threadId) ?: return
        val normalizedProjectPath = normalizedProjectPath(projectPath)
        if (normalizedProjectPath == null) {
            associatedManagedWorktreePathByThreadId.remove(normalizedThreadId)
        } else {
            associatedManagedWorktreePathByThreadId[normalizedThreadId] = normalizedProjectPath
        }
        prefs.setAssociatedManagedWorktreePaths(associatedManagedWorktreePathByThreadId)
    }

    private fun beginAuthoritativeProjectPathTransition(threadId: String, projectPath: String) {
        val normalizedThreadId = normalizedIdentifier(threadId) ?: return
        val normalizedProjectPath = normalizedProjectPath(projectPath) ?: return
        authoritativeProjectPathByThreadId[normalizedThreadId] = normalizedProjectPath
    }

    private fun applyAuthoritativeProjectPath(
        thread: ThreadSummary,
        treatAsServerState: Boolean,
    ): ThreadSummary {
        val normalizedThreadId = normalizedIdentifier(thread.id) ?: return thread
        val authoritativeProjectPath = authoritativeProjectPathByThreadId[normalizedThreadId] ?: return thread
        if (thread.normalizedProjectPath == authoritativeProjectPath) {
            if (treatAsServerState) {
                authoritativeProjectPathByThreadId.remove(normalizedThreadId)
            }
            return thread
        }
        return thread.copy(cwd = authoritativeProjectPath)
    }

    private fun restoreThreadProjectBinding(
        thread: ThreadSummary,
        authoritativeProjectPath: String?,
        associatedManagedWorktreePath: String?,
    ) {
        val normalizedThreadId = normalizedIdentifier(thread.id) ?: return
        if (authoritativeProjectPath == null) {
            authoritativeProjectPathByThreadId.remove(normalizedThreadId)
        } else {
            authoritativeProjectPathByThreadId[normalizedThreadId] = authoritativeProjectPath
        }
        rememberAssociatedManagedWorktreePath(normalizedThreadId, associatedManagedWorktreePath)
        updateState {
            copy(
                threads = upsertThread(threads, thread),
                selectedThreadId = normalizedThreadId,
            )
        }
    }

    private fun normalizedProjectPath(path: String?): String? {
        val trimmed = path?.trim()?.trimEnd('/')?.takeIf(String::isNotEmpty) ?: return null
        return trimmed
    }

    private fun comparableProjectPath(path: String?): String? {
        val normalizedPath = normalizedProjectPath(path) ?: return null
        return runCatching { File(normalizedPath).canonicalFile.path.trimEnd('/') }.getOrNull()
            ?: normalizedPath
    }

    private fun isManagedWorktreePath(path: String?): Boolean {
        val normalizedPath = normalizedProjectPath(path) ?: return false
        return normalizedPath.contains("/.coderover/worktrees/")
    }

    private fun shouldAllowProjectRebindWithoutResume(failure: Throwable): Boolean {
        val message = failure.message?.lowercase().orEmpty()
        return "no rollout found" in message || "no rollout file found" in message
    }

    private fun nextOrderIndex(): Int = orderCounter.incrementAndGet()

    private fun buildJsonObject(vararg pairs: Pair<String, JsonElement?>): JsonObject {
        return JsonObject(
            buildMap {
                pairs.forEach { (key, value) ->
                    if (value != null && value !is JsonNull) {
                        put(key, value)
                    }
                }
            },
        )
    }

    private fun encodeHistoryAnchor(anchor: ThreadHistoryAnchor): JsonObject {
        return buildJsonObject(
            "createdAt" to JsonPrimitive(anchor.createdAt),
            "itemId" to anchor.itemId?.let(::JsonPrimitive),
            "turnId" to anchor.turnId?.let(::JsonPrimitive),
        )
    }
}

private fun List<ApprovalRequest>.enqueueDistinct(request: ApprovalRequest): List<ApprovalRequest> {
    if (any { it.id == request.id }) {
        return this
    }
    return this + request
}

private fun JsonElement?.jsonObjectOrNull(): JsonObject? = this as? JsonObject

private fun JsonElement?.jsonArrayOrNull(): JsonArray? = this as? JsonArray

internal fun normalizeProviderId(providerId: String?): String {
    return when (providerId?.trim()?.lowercase()) {
        "claude" -> "claude"
        "gemini" -> "gemini"
        "copilot" -> "copilot"
        else -> "codex"
    }
}

private fun JsonObject.threadPayload(): JsonObject? {
    return this["thread"]?.jsonObjectOrNull()
        ?: this["result"]?.jsonObjectOrNull()?.get("thread")?.jsonObjectOrNull()
}

internal fun JsonObject?.resolveThreadId(): String? {
    val payload = this ?: return null
    val envelopeEvent = payload.envelopeEventObject()
    val nestedEvent = payload["event"]?.jsonObjectOrNull()
    return firstNonBlank(
        payload.normalizedIdentifier("threadId"),
        payload.normalizedIdentifier("thread_id"),
        payload.normalizedIdentifier("conversationId"),
        payload.normalizedIdentifier("conversation_id"),
        payload["thread"]?.jsonObjectOrNull()?.normalizedIdentifier("id"),
        payload["turn"]?.jsonObjectOrNull()?.normalizedIdentifier("threadId"),
        payload["turn"]?.jsonObjectOrNull()?.normalizedIdentifier("thread_id"),
        payload["item"]?.jsonObjectOrNull()?.normalizedIdentifier("threadId"),
        payload["item"]?.jsonObjectOrNull()?.normalizedIdentifier("thread_id"),
        envelopeEvent?.normalizedIdentifier("threadId"),
        envelopeEvent?.normalizedIdentifier("thread_id"),
        envelopeEvent?.normalizedIdentifier("conversationId"),
        envelopeEvent?.normalizedIdentifier("conversation_id"),
        envelopeEvent?.get("thread")?.jsonObjectOrNull()?.normalizedIdentifier("id"),
        envelopeEvent?.get("turn")?.jsonObjectOrNull()?.normalizedIdentifier("threadId"),
        envelopeEvent?.get("turn")?.jsonObjectOrNull()?.normalizedIdentifier("thread_id"),
        envelopeEvent?.get("item")?.jsonObjectOrNull()?.normalizedIdentifier("threadId"),
        envelopeEvent?.get("item")?.jsonObjectOrNull()?.normalizedIdentifier("thread_id"),
        nestedEvent?.normalizedIdentifier("threadId"),
        nestedEvent?.normalizedIdentifier("thread_id"),
        nestedEvent?.normalizedIdentifier("conversationId"),
        nestedEvent?.normalizedIdentifier("conversation_id"),
        nestedEvent?.get("thread")?.jsonObjectOrNull()?.normalizedIdentifier("id"),
        nestedEvent?.get("turn")?.jsonObjectOrNull()?.normalizedIdentifier("threadId"),
        nestedEvent?.get("turn")?.jsonObjectOrNull()?.normalizedIdentifier("thread_id"),
    )
}

internal fun JsonObject?.resolveTurnId(): String? {
    val payload = this ?: return null
    val envelopeEvent = payload.envelopeEventObject()
    val nestedEvent = payload["event"]?.jsonObjectOrNull()
    return firstNonBlank(
        payload["turn"]?.jsonObjectOrNull()?.normalizedIdentifier("id"),
        payload.normalizedIdentifier("turnId"),
        payload.normalizedIdentifier("turn_id"),
        payload["item"]?.jsonObjectOrNull()?.normalizedIdentifier("turnId"),
        payload["item"]?.jsonObjectOrNull()?.normalizedIdentifier("turn_id"),
        envelopeEvent?.normalizedIdentifier("turnId"),
        envelopeEvent?.normalizedIdentifier("turn_id"),
        envelopeEvent?.get("turn")?.jsonObjectOrNull()?.normalizedIdentifier("id"),
        envelopeEvent?.get("item")?.jsonObjectOrNull()?.normalizedIdentifier("turnId"),
        envelopeEvent?.get("item")?.jsonObjectOrNull()?.normalizedIdentifier("turn_id"),
        nestedEvent?.normalizedIdentifier("turnId"),
        nestedEvent?.normalizedIdentifier("turn_id"),
        nestedEvent?.get("turn")?.jsonObjectOrNull()?.normalizedIdentifier("id"),
    )
}

internal fun JsonObject?.resolveItemId(): String? {
    val payload = this ?: return null
    val envelopeEvent = payload.envelopeEventObject()
    val nestedEvent = payload["event"]?.jsonObjectOrNull()
    return firstNonBlank(
        payload.normalizedIdentifier("timelineItemId"),
        payload.normalizedIdentifier("timeline_item_id"),
        payload.normalizedIdentifier("itemId"),
        payload.normalizedIdentifier("item_id"),
        payload.normalizedIdentifier("id"),
        payload["item"]?.jsonObjectOrNull()?.normalizedIdentifier("id"),
        payload["item"]?.jsonObjectOrNull()?.normalizedIdentifier("timelineItemId"),
        payload["item"]?.jsonObjectOrNull()?.normalizedIdentifier("timeline_item_id"),
        envelopeEvent?.normalizedIdentifier("timelineItemId"),
        envelopeEvent?.normalizedIdentifier("timeline_item_id"),
        envelopeEvent?.normalizedIdentifier("itemId"),
        envelopeEvent?.normalizedIdentifier("item_id"),
        envelopeEvent?.normalizedIdentifier("id"),
        envelopeEvent?.get("item")?.jsonObjectOrNull()?.normalizedIdentifier("id"),
        envelopeEvent?.get("item")?.jsonObjectOrNull()?.normalizedIdentifier("timelineItemId"),
        envelopeEvent?.get("item")?.jsonObjectOrNull()?.normalizedIdentifier("timeline_item_id"),
        nestedEvent?.normalizedIdentifier("timelineItemId"),
        nestedEvent?.normalizedIdentifier("timeline_item_id"),
        nestedEvent?.normalizedIdentifier("itemId"),
        nestedEvent?.normalizedIdentifier("item_id"),
        nestedEvent?.normalizedIdentifier("id"),
        nestedEvent?.get("item")?.jsonObjectOrNull()?.normalizedIdentifier("id"),
        nestedEvent?.get("item")?.jsonObjectOrNull()?.normalizedIdentifier("timelineItemId"),
        nestedEvent?.get("item")?.jsonObjectOrNull()?.normalizedIdentifier("timeline_item_id"),
    )
}

internal fun JsonObject?.resolveTimelineItemId(): String? = resolveItemId()

internal fun JsonObject?.resolvePreviousItemId(): String? {
    val payload = this ?: return null
    val envelopeEvent = payload.envelopeEventObject()
    val nestedEvent = payload["event"]?.jsonObjectOrNull()
    return firstNonBlank(
        payload.normalizedIdentifier("previousItemId"),
        payload.normalizedIdentifier("previous_item_id"),
        payload.normalizedIdentifier("previousId"),
        payload["item"]?.jsonObjectOrNull()?.normalizedIdentifier("previousItemId"),
        payload["item"]?.jsonObjectOrNull()?.normalizedIdentifier("previous_item_id"),
        envelopeEvent?.normalizedIdentifier("previousItemId"),
        envelopeEvent?.normalizedIdentifier("previous_item_id"),
        envelopeEvent?.get("item")?.jsonObjectOrNull()?.normalizedIdentifier("previousItemId"),
        envelopeEvent?.get("item")?.jsonObjectOrNull()?.normalizedIdentifier("previous_item_id"),
        nestedEvent?.normalizedIdentifier("previousItemId"),
        nestedEvent?.normalizedIdentifier("previous_item_id"),
        nestedEvent?.get("item")?.jsonObjectOrNull()?.normalizedIdentifier("previousItemId"),
        nestedEvent?.get("item")?.jsonObjectOrNull()?.normalizedIdentifier("previous_item_id"),
    )
}

internal fun JsonObject.envelopeEventObject(): JsonObject? {
    return this["msg"]?.jsonObjectOrNull() ?: this["event"]?.jsonObjectOrNull()
}

internal fun JsonObject.normalizedIdentifier(key: String): String? {
    return string(key)?.trim()?.takeIf(String::isNotEmpty)
}

internal fun List<ThreadSummary>.refreshThreadSummaryFromMessages(
    threadId: String,
    messages: List<ChatMessage>,
): List<ThreadSummary> {
    val existingThread = firstOrNull { it.id == threadId }
    val latestTimestamp = messages.maxOfOrNull(ChatMessage::createdAt) ?: System.currentTimeMillis()
    val latestPreview = messages.sidebarPreviewText()
    val nextThread = if (existingThread != null) {
        val nextUpdatedAt = maxOf(existingThread.updatedAt ?: 0L, latestTimestamp)
        val nextPreview = latestPreview ?: existingThread.preview
        if (nextUpdatedAt == existingThread.updatedAt &&
            nextPreview == existingThread.preview &&
            existingThread.syncState == ThreadSyncState.LIVE
        ) {
            return this
        }
        existingThread.copy(
            preview = nextPreview,
            updatedAt = nextUpdatedAt,
            syncState = ThreadSyncState.LIVE,
        )
    } else {
        ThreadSummary(
            id = threadId,
            preview = latestPreview,
            createdAt = latestTimestamp,
            updatedAt = latestTimestamp,
            syncState = ThreadSyncState.LIVE,
        )
    }
    return (filterNot { it.id == threadId } + nextThread)
        .sortedByDescending { it.updatedAt ?: it.createdAt ?: 0L }
}

internal fun List<ChatMessage>.sidebarPreviewText(maxLength: Int = 160): String? {
    val preferredMessage = asReversed().firstOrNull { message ->
        message.role != MessageRole.SYSTEM &&
            message.kind != MessageKind.THINKING &&
            message.text.isNotBlank()
    } ?: asReversed().firstOrNull { message ->
        message.kind != MessageKind.THINKING && message.text.isNotBlank()
    }
    val preview = preferredMessage
        ?.text
        ?.replace('\n', ' ')
        ?.replace(Regex("""\s+"""), " ")
        ?.trim()
        ?.takeIf(String::isNotEmpty)
        ?: return null
    return if (preview.length <= maxLength) {
        preview
    } else {
        preview.take(maxLength - 1) + "…"
    }
}

private fun JsonElement?.isNullLike(): Boolean {
    return this == null || this is JsonNull || (this as? JsonPrimitive)?.contentOrNull?.isBlank() == true
}

private fun ChatMessage.toHistoryAnchor(): ThreadHistoryAnchor {
    return ThreadHistoryAnchor(
        itemId = itemId,
        createdAt = createdAt,
        turnId = turnId,
    )
}

private fun parseHistoryAnchor(json: JsonObject?): ThreadHistoryAnchor? {
    val payload = json ?: return null
    val createdAt = payload.timestamp("createdAt", "created_at")
        ?: payload.string("createdAt")?.let(::parseTimestamp)
        ?: payload.string("created_at")?.let(::parseTimestamp)
        ?: return null
    return ThreadHistoryAnchor(
        itemId = payload.string("itemId") ?: payload.string("item_id"),
        createdAt = createdAt,
        turnId = payload.string("turnId") ?: payload.string("turn_id"),
    )
}

private fun compareRenderedTimelineMessages(lhs: ChatMessage, rhs: ChatMessage): Int {
    val lhsOrder = lhs.timelineOrdinal ?: lhs.orderIndex
    val rhsOrder = rhs.timelineOrdinal ?: rhs.orderIndex
    return when {
        lhsOrder != rhsOrder -> lhsOrder.compareTo(rhsOrder)
        lhs.createdAt != rhs.createdAt -> lhs.createdAt.compareTo(rhs.createdAt)
        else -> lhs.id.compareTo(rhs.id)
    }
}

private fun isCanonicalTimelineMessage(message: ChatMessage): Boolean {
    val normalizedId = normalizedIdentifier(message.id) ?: return false
    val normalizedItemId = normalizedIdentifier(message.itemId) ?: return false
    return normalizedId == normalizedItemId
}

private fun mergeRenderedTimelineMessages(
    canonicalMessages: List<ChatMessage>,
    overlayMessages: List<ChatMessage>,
): List<ChatMessage> {
    val canonicalIds = canonicalMessages.mapTo(mutableSetOf(), ChatMessage::id)
    return (canonicalMessages + overlayMessages.filterNot { it.id in canonicalIds })
        .sortedWith(Comparator(::compareRenderedTimelineMessages))
}

private fun CodeRoverRepository.finalizeSupersededCanonicalStreamingMessages(
    threadId: String,
    turnId: String?,
    keepingTimelineItemId: String,
): List<ChatMessage>? {
    val normalizedTurnId = normalizedIdentifier(turnId) ?: return null
    val overlayMessages = state.value.messagesByThread[threadId].orEmpty().filterNot(::isCanonicalTimelineMessage)
    val timelineState = threadTimelineStateByThread[threadId]
        ?: ThreadTimelineState(
            state.value.messagesByThread[threadId].orEmpty().filter(::isCanonicalTimelineMessage),
        )
    val candidateIds = timelineState.renderedMessages().mapNotNull { message ->
        if (message.id != keepingTimelineItemId &&
            message.turnId == normalizedTurnId &&
            message.isStreaming &&
            shouldFinalizeSupersededCanonicalStreamingMessage(message)
        ) {
            message.id
        } else {
            null
        }
    }
    if (candidateIds.isEmpty()) {
        return null
    }
    candidateIds.forEach { candidateId ->
        val candidate = timelineState.message(candidateId) ?: return@forEach
        timelineState.upsert(candidate.copy(isStreaming = false))
    }
    threadTimelineStateByThread[threadId] = timelineState
    return mergeRenderedTimelineMessages(
        canonicalMessages = timelineState.renderedMessages(),
        overlayMessages = overlayMessages,
    )
}

private fun CodeRoverRepository.finalizeCompletedTurnTimeline(
    threadId: String,
    turnId: String?,
): List<ChatMessage>? {
    val existingRenderedMessages = state.value.messagesByThread[threadId].orEmpty()
    if (existingRenderedMessages.isEmpty()) {
        return null
    }
    val canonicalMessages = threadTimelineStateByThread[threadId]?.renderedMessages()
        ?: existingRenderedMessages.filter(::isCanonicalTimelineMessage)
    val overlayMessages = existingRenderedMessages.filterNot(::isCanonicalTimelineMessage)
    val finalizedCanonical = finalizeCompletedTurnMessages(canonicalMessages, turnId)
    val finalizedOverlay = finalizeCompletedTurnMessages(overlayMessages, turnId)
    threadTimelineStateByThread[threadId] = ThreadTimelineState(finalizedCanonical)
    return mergeRenderedTimelineMessages(
        canonicalMessages = finalizedCanonical,
        overlayMessages = finalizedOverlay,
    )
}

private fun String.trimForCache(maxChars: Int): String {
    if (length <= maxChars) {
        return this
    }
    return take(maxChars).trimEnd() + "\n…"
}

private fun CodeRoverRepository.synchronizeThreadTimelineState(
    threadId: String,
    canonicalMessages: List<ChatMessage>,
    preservingOverlayMessages: List<ChatMessage>? = null,
): List<ChatMessage> {
    val overlayMessages = preservingOverlayMessages
        ?: state.value.messagesByThread[threadId].orEmpty().filterNot(::isCanonicalTimelineMessage)
    val nextState = ThreadTimelineState(canonicalMessages)
    threadTimelineStateByThread[threadId] = nextState
    return mergeRenderedTimelineMessages(nextState.renderedMessages(), overlayMessages)
}

private fun CodeRoverRepository.upsertThreadTimelineMessage(message: ChatMessage): List<ChatMessage> {
    val threadId = message.threadId
    val overlayMessages = state.value.messagesByThread[threadId].orEmpty().filterNot(::isCanonicalTimelineMessage)
    val timelineState = threadTimelineStateByThread[threadId]
        ?: ThreadTimelineState(
            state.value.messagesByThread[threadId].orEmpty().filter(::isCanonicalTimelineMessage),
        )
    timelineState.upsert(message)
    threadTimelineStateByThread[threadId] = timelineState
    return mergeRenderedTimelineMessages(timelineState.renderedMessages(), overlayMessages)
}

private fun CodeRoverRepository.mergeCanonicalHistoryIntoTimelineState(
    threadId: String,
    historyMessages: List<ChatMessage>,
    mode: String?,
    activeThreadIds: Set<String>,
    runningThreadIds: Set<String>,
): List<ChatMessage> {
    val overlayMessages = state.value.messagesByThread[threadId].orEmpty().filterNot(::isCanonicalTimelineMessage)
    val existingCanonicalMessages = threadTimelineStateByThread[threadId]?.renderedMessages()
        ?: state.value.messagesByThread[threadId].orEmpty().filter(::isCanonicalTimelineMessage)
    val seededCanonicalMessages = seedCanonicalMessagesForHistoryMerge(
        existingCanonicalMessages = existingCanonicalMessages,
        incomingMessages = historyMessages,
        mode = mode,
    )
    val timelineState = ThreadTimelineState(seededCanonicalMessages)
    historyMessages.forEach { message ->
        val reconciled = timelineState.message(message.id)?.let { existing ->
            reconcileExistingTimelineMessage(
                localMessage = existing,
                serverMessage = message,
                activeThreadIds = activeThreadIds,
                runningThreadIds = runningThreadIds,
            )
        } ?: message
        timelineState.upsert(reconciled)
    }
    threadTimelineStateByThread[threadId] = timelineState
    return mergeRenderedTimelineMessages(timelineState.renderedMessages(), overlayMessages)
}

internal fun reconcileExistingTimelineMessage(
    localMessage: ChatMessage,
    serverMessage: ChatMessage,
    activeThreadIds: Set<String>,
    runningThreadIds: Set<String>,
): ChatMessage {
    val threadIsActive = localMessage.threadId in activeThreadIds || localMessage.threadId in runningThreadIds
    val preservesRunningPresentation = threadIsActive &&
        (localMessage.turnId == null || serverMessage.turnId == null || localMessage.turnId == serverMessage.turnId)
    val nextText = when {
        serverMessage.text.isBlank() -> localMessage.text
        localMessage.role == MessageRole.ASSISTANT -> {
            if (preservesRunningPresentation || shouldPreserveMoreRecentLocalText(
                    localText = localMessage.text,
                    incomingText = serverMessage.text,
                )
            ) {
                mergeStreamingSnapshotText(existingText = localMessage.text, incomingText = serverMessage.text)
            } else {
                serverMessage.text
            }
        }

        localMessage.role == MessageRole.SYSTEM -> {
            val supportsStaleSnapshotProtection = localMessage.kind in setOf(
                MessageKind.THINKING,
                MessageKind.PLAN,
                MessageKind.SUBAGENT_ACTION,
                MessageKind.CHAT,
            )
            if ((preservesRunningPresentation && localMessage.isStreaming) ||
                (supportsStaleSnapshotProtection && shouldPreserveMoreRecentLocalText(
                    localText = localMessage.text,
                    incomingText = serverMessage.text,
                ))
            ) {
                mergeStreamingSnapshotText(existingText = localMessage.text, incomingText = serverMessage.text)
            } else {
                serverMessage.text
            }
        }

        else -> serverMessage.text
    }

    return localMessage.copy(
        role = if (localMessage.role == MessageRole.ASSISTANT || serverMessage.role != MessageRole.SYSTEM) {
            serverMessage.role
        } else {
            localMessage.role
        },
        kind = if (localMessage.kind == MessageKind.CHAT) serverMessage.kind else localMessage.kind,
        text = nextText,
        turnId = localMessage.turnId ?: serverMessage.turnId,
        itemId = localMessage.itemId ?: serverMessage.itemId,
        isStreaming = if (preservesRunningPresentation) {
            localMessage.isStreaming || serverMessage.isStreaming || localMessage.threadId in runningThreadIds
        } else {
            false
        },
        attachments = if (localMessage.attachments.isEmpty()) serverMessage.attachments else localMessage.attachments,
        fileChanges = if (localMessage.fileChanges.isEmpty()) serverMessage.fileChanges else localMessage.fileChanges,
        commandState = localMessage.commandState ?: serverMessage.commandState,
        subagentAction = localMessage.subagentAction ?: serverMessage.subagentAction,
        planState = localMessage.planState ?: serverMessage.planState,
        structuredUserInputRequest = localMessage.structuredUserInputRequest ?: serverMessage.structuredUserInputRequest,
        providerItemId = localMessage.providerItemId ?: serverMessage.providerItemId,
        timelineOrdinal = localMessage.timelineOrdinal ?: serverMessage.timelineOrdinal,
        timelineStatus = serverMessage.timelineStatus ?: localMessage.timelineStatus,
        orderIndex = localMessage.timelineOrdinal ?: serverMessage.timelineOrdinal ?: localMessage.orderIndex,
    )
}

internal fun seedCanonicalMessagesForHistoryMerge(
    existingCanonicalMessages: List<ChatMessage>,
    incomingMessages: List<ChatMessage>,
    mode: String?,
): List<ChatMessage> {
    return if (mode == "tail") {
        canonicalMessagesRetainedOutsideTailCoverage(existingCanonicalMessages, incomingMessages)
    } else {
        existingCanonicalMessages
    }
}

internal fun canonicalMessagesRetainedOutsideTailCoverage(
    existingCanonicalMessages: List<ChatMessage>,
    incomingMessages: List<ChatMessage>,
): List<ChatMessage> {
    if (existingCanonicalMessages.isEmpty() || incomingMessages.isEmpty()) {
        return existingCanonicalMessages
    }

    val incomingIds = incomingMessages.mapTo(mutableSetOf(), ChatMessage::id)
    val oldestIncomingOrdinal = incomingMessages.mapNotNull(ChatMessage::timelineOrdinal).minOrNull()
    val oldestIncomingDate = incomingMessages.minOfOrNull(ChatMessage::createdAt) ?: Long.MIN_VALUE

    return existingCanonicalMessages.filter { message ->
        if (message.id in incomingIds) {
            return@filter true
        }

        if (oldestIncomingOrdinal != null && message.timelineOrdinal != null) {
            return@filter message.timelineOrdinal < oldestIncomingOrdinal
        }

        message.createdAt < oldestIncomingDate
    }
}

internal fun normalizedMessageText(text: String): String {
    return text.trim()
}

internal fun mergeStreamingSnapshotText(existingText: String, incomingText: String): String {
    if (existingText.isEmpty()) {
        return incomingText
    }
    if (incomingText == existingText) {
        return existingText
    }
    if (existingText.endsWith(incomingText)) {
        return existingText
    }
    if (incomingText.length > existingText.length && incomingText.startsWith(existingText)) {
        return incomingText
    }
    if (existingText.length > incomingText.length && existingText.startsWith(incomingText)) {
        return existingText
    }

    val maxOverlap = minOf(existingText.length, incomingText.length)
    for (overlap in maxOverlap downTo 1) {
        if (existingText.takeLast(overlap) == incomingText.take(overlap)) {
            return existingText + incomingText.drop(overlap)
        }
    }

    return existingText + incomingText
}

internal fun shouldPreserveMoreRecentLocalText(localText: String, incomingText: String): Boolean {
    val normalizedLocal = normalizedMessageText(localText)
    val normalizedIncoming = normalizedMessageText(incomingText)
    if (normalizedLocal.isEmpty() || normalizedIncoming.isEmpty() || normalizedLocal == normalizedIncoming) {
        return false
    }
    if (normalizedLocal.length > normalizedIncoming.length && normalizedLocal.startsWith(normalizedIncoming)) {
        return true
    }
    return mergeStreamingSnapshotText(existingText = localText, incomingText = incomingText) == localText
}

internal fun shouldFinalizeSupersededCanonicalStreamingMessage(message: ChatMessage): Boolean {
    if (message.role == MessageRole.ASSISTANT) {
        return true
    }
    return when (message.kind) {
        MessageKind.THINKING, MessageKind.PLAN, MessageKind.SUBAGENT_ACTION, MessageKind.CHAT -> true
        MessageKind.FILE_CHANGE, MessageKind.COMMAND_EXECUTION, MessageKind.USER_INPUT_PROMPT -> false
    }
}

internal fun shouldPruneThinkingRowAfterTurnCompletion(message: ChatMessage): Boolean {
    val trimmedText = message.text.trim()
    if (trimmedText.isEmpty()) {
        return true
    }
    if (trimmedText.equals("Thinking...", ignoreCase = true)) {
        return true
    }
    val withoutPrefix = Regex("""(?is)^\s*thinking(?:\.\.\.)?\s*""").replace(trimmedText, "")
    return withoutPrefix.trim().isEmpty()
}

internal fun finalizeCompletedTurnMessages(
    messages: List<ChatMessage>,
    turnId: String?,
): List<ChatMessage> {
    val normalizedTurnId = normalizedIdentifier(turnId)
    val closedMessages = messages.map { message ->
        val belongsToTurn = if (normalizedTurnId != null) {
            message.turnId == normalizedTurnId || message.turnId == null
        } else {
            true
        }
        if (belongsToTurn && message.isStreaming && (message.role == MessageRole.SYSTEM || message.role == MessageRole.ASSISTANT)) {
            message.copy(isStreaming = false)
        } else {
            message
        }
    }
    return closedMessages.filterNot { message ->
        val belongsToTurn = if (normalizedTurnId != null) {
            message.turnId == normalizedTurnId || message.turnId == null
        } else {
            true
        }
        belongsToTurn &&
            message.role == MessageRole.SYSTEM &&
            message.kind == MessageKind.THINKING &&
            shouldPruneThinkingRowAfterTurnCompletion(message)
    }
}

private fun mergeHistoryMessages(existing: List<ChatMessage>, history: List<ChatMessage>): List<ChatMessage> {
    val mergedByKey = linkedMapOf<String, ChatMessage>()
    (existing + history)
        .sortedWith(compareBy<ChatMessage>({ it.createdAt }, { it.orderIndex }, { it.id }))
        .forEach { message ->
        val key = historyMessageSyncKey(message)
        val previous = mergedByKey[key]
        mergedByKey[key] = when {
            previous == null -> message
            previous.isStreaming && !message.isStreaming -> message
            previous.attachments.isEmpty() && message.attachments.isNotEmpty() -> message
            previous.fileChanges.isEmpty() && message.fileChanges.isNotEmpty() -> message
            previous.commandState == null && message.commandState != null -> message
            previous.subagentAction == null && message.subagentAction != null -> message
            previous.planState == null && message.planState != null -> message
            previous.structuredUserInputRequest == null && message.structuredUserInputRequest != null -> message
            previous.text.length < message.text.length -> message
            else -> previous
        }
    }
    return mergedByKey.values
        .sortedWith(compareBy<ChatMessage>({ it.createdAt }, { it.orderIndex }, { it.id }))
        .mapIndexed { index, message -> message.copy(orderIndex = index) }
}

private fun historyMessageSyncKey(message: ChatMessage): String {
    val primaryItemId = message.itemId?.trim().orEmpty()
    if (primaryItemId.isNotEmpty()) {
        return "item|$primaryItemId|${message.createdAt}"
    }
    val turnId = message.turnId?.trim().orEmpty()
    if (turnId.isNotEmpty()) {
        return "turn|$turnId|${message.kind.name}|${message.createdAt}"
    }
    return "fallback|${message.role.name}|${message.kind.name}|${message.createdAt}|${message.text.trim()}"
}

private fun mergeHistoryState(
    currentState: ThreadHistoryState?,
    historyWindow: CodeRoverRepository.HistoryWindowState,
    mode: String,
): ThreadHistoryState {
    val baseState = currentState ?: ThreadHistoryState()
    return when (mode) {
        "tail" -> baseState.copy(
            oldestCursor = normalizedHistoryCursor(historyWindow.olderCursor),
            newestCursor = normalizedHistoryCursor(historyWindow.newerCursor),
            hasOlderOnServer = historyWindow.hasOlder,
            hasNewerOnServer = historyWindow.hasNewer,
            isLoadingOlder = false,
            isTailRefreshing = false,
        )

        "before" -> baseState.copy(
            oldestCursor = normalizedHistoryCursor(historyWindow.olderCursor) ?: baseState.oldestCursor,
            hasOlderOnServer = historyWindow.hasOlder,
            isLoadingOlder = false,
            isTailRefreshing = false,
        )

        "after" -> baseState.copy(
            newestCursor = normalizedHistoryCursor(historyWindow.newerCursor) ?: baseState.newestCursor,
            hasNewerOnServer = historyWindow.hasNewer,
            isLoadingOlder = false,
            isTailRefreshing = false,
        )

        else -> baseState.copy(
            isLoadingOlder = false,
            isTailRefreshing = false,
        )
    }
}

private fun JsonObject?.deltaText(): String {
    if (this == null) {
        return ""
    }
    return string("delta")
        ?: string("text")
        ?: string("content")
        ?: this["output"]?.jsonObjectOrNull()?.string("text")
        ?: ""
}

private fun JsonObject.flattenedString(key: String): String? {
    val value = this[key] ?: return null
    return flattenStringParts(value).takeIf(String::isNotBlank)
}

private fun flattenStringParts(value: JsonElement?): String {
    return when (value) {
        null, JsonNull -> ""
        is JsonPrimitive -> value.contentOrNull.orEmpty().trim()
        is JsonArray -> value.map(::flattenStringParts).filter(String::isNotBlank).joinToString("\n").trim()
        is JsonObject -> listOf(
            value.string("text"),
            value.string("message"),
            value["data"]?.jsonObjectOrNull()?.string("text"),
        ).firstOrNull { !it.isNullOrBlank() }?.trim().orEmpty()
    }
}

private fun firstNonBlank(vararg values: String?): String? {
    return values.firstOrNull { !it.isNullOrBlank() }?.trim()
}

internal fun normalizedIdentifier(value: String?): String? {
    return value?.trim()?.takeIf(String::isNotEmpty)
}

internal fun normalizedHistoryCursor(value: String?): String? {
    return value?.trim()?.takeIf(String::isNotEmpty)
}

internal fun shouldRequestRealtimeHistoryCatchUp(
    latestItemId: String?,
    incomingItemId: String?,
    previousItemId: String?,
): Boolean {
    val normalizedLatestItemId = normalizedIdentifier(latestItemId)
    val normalizedIncomingItemId = normalizedIdentifier(incomingItemId)
    val normalizedPreviousItemId = normalizedIdentifier(previousItemId)
    if (normalizedLatestItemId != null && normalizedIncomingItemId != null && normalizedLatestItemId == normalizedIncomingItemId) {
        return false
    }
    if (normalizedLatestItemId != null && normalizedPreviousItemId != null && normalizedLatestItemId == normalizedPreviousItemId) {
        return false
    }
    return true
}

internal data class OlderHistoryLoadRequest(
    val cursor: String? = null,
    val shouldBootstrapTail: Boolean = false,
)

internal fun resolveOlderHistoryLoadRequest(
    historyState: ThreadHistoryState?,
    localMessages: List<ChatMessage>,
): OlderHistoryLoadRequest {
    val normalizedCursor = normalizedHistoryCursor(historyState?.oldestCursor)
    if (historyState?.hasOlderOnServer == true && normalizedCursor != null) {
        return OlderHistoryLoadRequest(cursor = normalizedCursor)
    }
    return OlderHistoryLoadRequest(shouldBootstrapTail = localMessages.isEmpty() || normalizedCursor == null)
}

internal fun latestItemIdForRealtimeHistoryCatchUp(
    historyState: ThreadHistoryState?,
    localMessages: List<ChatMessage>,
): String? {
    return normalizedIdentifier(
        localMessages.asReversed().firstOrNull { !it.itemId.isNullOrBlank() }?.itemId,
    )
}

internal fun shouldReplaceLocalHistoryWithTailSnapshot(
    state: AppState,
    resumeSeededHistoryThreadIds: Set<String>,
    threadId: String,
    hasLocalMessages: Boolean,
    hasNewestCursor: Boolean,
): Boolean {
    if (!hasLocalMessages) {
        return false
    }
    if (threadId in resumeSeededHistoryThreadIds) {
        return false
    }
    if (state.threadHasActiveOrRunningTurn(threadId)) {
        return false
    }
    if (state.selectedCodexThreadIdForTailSync() == threadId) {
        return false
    }
    return !hasNewestCursor
}

private fun decodeHistoryWindow(
    result: JsonObject?,
    fallbackMessages: List<ChatMessage>,
): CodeRoverRepository.HistoryWindowState {
    val historyWindow = result?.get("historyWindow")?.jsonObjectOrNull()
        ?: result?.get("history_window")?.jsonObjectOrNull()
    if (historyWindow != null) {
        return CodeRoverRepository.HistoryWindowState(
            olderCursor = historyWindow.string("olderCursor") ?: historyWindow.string("older_cursor"),
            newerCursor = historyWindow.string("newerCursor") ?: historyWindow.string("newer_cursor"),
            hasOlder = historyWindow.bool("hasOlder") ?: historyWindow.bool("has_older") ?: false,
            hasNewer = historyWindow.bool("hasNewer") ?: historyWindow.bool("has_newer") ?: false,
            servedFromProjection = historyWindow.bool("servedFromProjection")
                ?: historyWindow.bool("served_from_projection")
                ?: false,
            projectionSource = firstNonBlank(
                historyWindow.string("projectionSource"),
                historyWindow.string("projection_source"),
                result?.string("sourceKind"),
                result?.string("source_kind"),
            ),
            syncEpoch = historyWindow.int("syncEpoch")
                ?: historyWindow.int("sync_epoch")
                ?: result?.int("syncEpoch")
                ?: result?.int("sync_epoch")
                ?: 1,
        )
    }

    return CodeRoverRepository.HistoryWindowState(
        olderCursor = null,
        newerCursor = null,
        hasOlder = false,
        hasNewer = false,
        servedFromProjection = false,
        projectionSource = firstNonBlank(
            result?.string("sourceKind"),
            result?.string("source_kind"),
        ),
        syncEpoch = result?.int("syncEpoch") ?: result?.int("sync_epoch") ?: 1,
    )
}

internal fun JsonObject?.resolveCursor(): String? {
    val payload = this ?: return null
    val envelopeEvent = payload.envelopeEventObject()
    val nestedEvent = payload["event"]?.jsonObjectOrNull()
    return firstNonBlank(
        payload.string("cursor"),
        payload.string("itemCursor"),
        payload.string("item_cursor"),
        payload["item"]?.jsonObjectOrNull()?.string("cursor"),
        payload["item"]?.jsonObjectOrNull()?.string("itemCursor"),
        payload["item"]?.jsonObjectOrNull()?.string("item_cursor"),
        envelopeEvent?.string("cursor"),
        envelopeEvent?.string("itemCursor"),
        envelopeEvent?.string("item_cursor"),
        envelopeEvent?.get("item")?.jsonObjectOrNull()?.string("cursor"),
        nestedEvent?.string("cursor"),
        nestedEvent?.string("itemCursor"),
        nestedEvent?.string("item_cursor"),
        nestedEvent?.get("item")?.jsonObjectOrNull()?.string("cursor"),
    )
}

internal fun JsonObject?.resolvePreviousCursor(): String? {
    val payload = this ?: return null
    val envelopeEvent = payload.envelopeEventObject()
    val nestedEvent = payload["event"]?.jsonObjectOrNull()
    return firstNonBlank(
        payload.string("previousCursor"),
        payload.string("previous_cursor"),
        payload.string("previousItemCursor"),
        payload.string("previous_item_cursor"),
        payload["item"]?.jsonObjectOrNull()?.string("previousCursor"),
        payload["item"]?.jsonObjectOrNull()?.string("previous_cursor"),
        envelopeEvent?.string("previousCursor"),
        envelopeEvent?.string("previous_cursor"),
        envelopeEvent?.get("item")?.jsonObjectOrNull()?.string("previousCursor"),
        nestedEvent?.string("previousCursor"),
        nestedEvent?.string("previous_cursor"),
        nestedEvent?.get("item")?.jsonObjectOrNull()?.string("previousCursor"),
    )
}

private fun isInvalidHistoryCursorError(failure: Throwable): Boolean {
    val message = failure.message?.lowercase().orEmpty()
    return message.contains("history.cursor is invalid") ||
        message.contains("cursor is invalid") ||
        message.contains("invalid cursor")
}

private fun normalizeMethodToken(value: String): String {
    return value
        .trim()
        .lowercase()
        .replace("_", "")
        .replace("-", "")
}

internal fun AppState.resolveRealtimeThreadId(payload: JsonObject?): String? {
    val explicitThreadId = payload.resolveThreadId()
    if (explicitThreadId != null) {
        return explicitThreadId
    }

    val normalizedTurnId = normalizedIdentifier(payload.resolveTurnId())
    if (normalizedTurnId != null) {
        activeTurnIdByThread.entries.firstOrNull { entry ->
            normalizedIdentifier(entry.value) == normalizedTurnId
        }?.key?.let { return it }
    }

    if (activeTurnIdByThread.size == 1) {
        return activeTurnIdByThread.keys.first()
    }

    val selectedId = selectedThreadId
    if (selectedId != null) {
        val selectedThread = threads.firstOrNull { it.id == selectedId }
        if (threadHasActiveOrRunningTurn(selectedId) || selectedThread?.provider.equals("codex", ignoreCase = true)) {
            return selectedId
        }
    }

    return threads.singleOrNull()?.id
}

internal fun AppState.selectedCodexThreadIdForTailSync(): String? {
    if (connectionPhase != ConnectionPhase.CONNECTED) {
        return null
    }
    val selectedId = selectedThreadId ?: return null
    val selectedThread = threads.firstOrNull { it.id == selectedId } ?: return null
    return if (
        threadHasActiveOrRunningTurn(selectedId) ||
        selectedThread.provider.equals("codex", ignoreCase = true)
    ) {
        selectedId
    } else {
        null
    }
}

internal fun List<ChatMessage>.hasOptimisticLocalUserTailMessage(turnId: String): Boolean {
    val normalizedTurnId = normalizedIdentifier(turnId) ?: return false
    val latestMessage = lastOrNull() ?: return false
    return latestMessage.role == MessageRole.USER &&
        latestMessage.itemId.isNullOrBlank() &&
        (
            latestMessage.turnId.isNullOrBlank() ||
                normalizedIdentifier(latestMessage.turnId) == normalizedTurnId
            )
}

internal fun AppState.shouldBypassRealtimeHistoryCatchUpForLocallyStartedTurn(
    threadId: String,
    turnId: String?,
    cursor: String?,
    previousCursor: String?,
): Boolean {
    val normalizedTurnId = normalizedIdentifier(turnId) ?: normalizedIdentifier(activeTurnIdByThread[threadId]) ?: return false
    if (pendingRealtimeSeededTurnIdByThread[threadId] != normalizedTurnId) {
        return false
    }
    val activeTurnId = normalizedIdentifier(activeTurnIdByThread[threadId])
    if (activeTurnId != null && activeTurnId != normalizedTurnId) {
        return false
    }
    if (!messagesByThread[threadId].orEmpty().hasOptimisticLocalUserTailMessage(normalizedTurnId)) {
        return false
    }
    return normalizedHistoryCursor(cursor) != null ||
        normalizedHistoryCursor(previousCursor) != null ||
        normalizedHistoryCursor(historyStateByThread[threadId]?.newestCursor) == null
}

private fun AppState.threadHasActiveOrRunningTurn(threadId: String): Boolean {
    return activeTurnIdByThread[threadId]?.isNotBlank() == true || runningThreadIds.contains(threadId)
}

private fun Throwable?.isBenignBackgroundDisconnect(): Boolean {
    val message = this?.message?.lowercase().orEmpty()
    if (message.isEmpty()) {
        return false
    }
    return message.contains("econnaborted") ||
        message.contains("ecanceled") ||
        message.contains("enotconn") ||
        message.contains("socket closed") ||
        message.contains("disconnected")
}

private fun <T> firstNonNull(vararg values: T?): T? = values.firstOrNull { it != null }

private fun String.stripWrappingQuotes(): String {
    val trimmed = trim()
    return if (trimmed.length >= 2 &&
        ((trimmed.startsWith('\"') && trimmed.endsWith('\"')) ||
            (trimmed.startsWith('\'') && trimmed.endsWith('\'')))
    ) {
        trimmed.substring(1, trimmed.length - 1)
    } else {
        trimmed
    }
}

private fun mergeCommandState(
    current: CommandState?,
    incoming: CommandState?,
): CommandState? {
    if (current == null) {
        return incoming
    }
    if (incoming == null) {
        return current
    }
    val mergedOutput = buildString {
        if (current.outputTail.isNotBlank()) {
            append(current.outputTail.trimEnd())
        }
        if (incoming.outputTail.isNotBlank()) {
            val next = incoming.outputTail.trim()
            if (isNotEmpty() && !endsWith(next)) {
                append('\n')
            }
            if (!endsWith(next)) {
                append(next)
            }
        }
    }.trim()
    val normalizedOutput = mergedOutput
        .lines()
        .takeLast(80)
        .joinToString("\n")
        .takeLast(8_000)
    return current.copy(
        shortCommand = if (incoming.shortCommand.length >= current.shortCommand.length) incoming.shortCommand else current.shortCommand,
        fullCommand = if (incoming.fullCommand.length >= current.fullCommand.length) incoming.fullCommand else current.fullCommand,
        phase = incoming.phase,
        cwd = incoming.cwd ?: current.cwd,
        exitCode = incoming.exitCode ?: current.exitCode,
        durationMs = incoming.durationMs ?: current.durationMs,
        outputTail = normalizedOutput,
    )
}
