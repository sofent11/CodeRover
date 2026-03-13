package com.remodex.android.data.repository

import android.content.Context
import android.util.Log
import com.remodex.android.data.model.AccessMode
import com.remodex.android.data.model.AppFontStyle
import com.remodex.android.data.model.AppState
import com.remodex.android.data.model.ApprovalRequest
import com.remodex.android.data.model.CLOCK_SKEW_TOLERANCE_MS
import com.remodex.android.data.model.CommandPhase
import com.remodex.android.data.model.CommandState
import com.remodex.android.data.model.ConnectionPhase
import com.remodex.android.data.model.CodexImageAttachment
import com.remodex.android.data.model.CodexTurnSkillMention
import com.remodex.android.data.model.FileChangeEntry
import com.remodex.android.data.model.FuzzyFileMatch
import com.remodex.android.data.model.GitBranchTargets
import com.remodex.android.data.model.MessageKind
import com.remodex.android.data.model.MessageRole
import com.remodex.android.data.model.ModelOption
import com.remodex.android.data.model.PAIRING_QR_VERSION
import com.remodex.android.data.model.PairingPayload
import com.remodex.android.data.model.PairingRecord
import com.remodex.android.data.model.PhoneIdentityState
import com.remodex.android.data.model.PlanState
import com.remodex.android.data.model.PlanStep
import com.remodex.android.data.model.PlanStepStatus
import com.remodex.android.data.model.QueuedTurnDraft
import com.remodex.android.data.model.SECURE_PROTOCOL_VERSION
import com.remodex.android.data.model.SecureConnectionState
import com.remodex.android.data.model.SkillMetadata
import com.remodex.android.data.model.StructuredUserInputOption
import com.remodex.android.data.model.StructuredUserInputQuestion
import com.remodex.android.data.model.StructuredUserInputRequest
import com.remodex.android.data.model.ThreadSummary
import com.remodex.android.data.model.ThreadSyncState
import com.remodex.android.data.model.TrustedMacRecord
import com.remodex.android.data.model.TrustedMacRegistry
import com.remodex.android.data.model.RuntimeProvider
import com.remodex.android.data.model.array
import com.remodex.android.data.model.asIntOrNull
import com.remodex.android.data.model.bool
import com.remodex.android.data.model.copyWith
import com.remodex.android.data.model.int
import com.remodex.android.data.model.responseKey
import com.remodex.android.data.model.string
import com.remodex.android.data.model.stringOrNull
import com.remodex.android.data.model.timestamp
import com.remodex.android.data.model.ChatMessage
import com.remodex.android.data.network.SecureBridgeClient
import com.remodex.android.data.network.SecureCrypto
import com.remodex.android.data.storage.PairingStore
import com.remodex.android.data.storage.UserPreferencesStore
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

class RemodexRepository(context: Context) {
    private companion object {
        const val TAG = "RemodexRepo"
    }

    private val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
    }
    private val store = PairingStore(context)
    private val prefs = UserPreferencesStore(context)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val clientMutex = Mutex()
    private val orderCounter = AtomicInteger(0)
    private val connectionEpoch = AtomicLong(0)
    private val isConnectInFlight = AtomicBoolean(false)
    private val streamingMessageIdsByKey = mutableMapOf<String, String>()
    private var client: SecureBridgeClient? = null
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
            selectedModelId = store.loadSelectedModelId(normalizeProviderId(store.loadSelectedProviderId())),
            selectedReasoningEffort = store.loadSelectedReasoningEffort(normalizeProviderId(store.loadSelectedProviderId())),
            collapsedProjectGroupIds = prefs.getCollapsedProjectGroupIds(),
        ),
    )
    val state: StateFlow<AppState> = _state.asStateFlow()

    init {
        val currentState = _state.value
        val activePairing = currentState.pairings.firstOrNull { it.macDeviceId == currentState.activePairingMacDeviceId }
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

    fun importPairingPayload(rawText: String) {
        scope.launch {
            val payload = runCatching {
                json.decodeFromString(PairingPayload.serializer(), rawText.trim())
            }.getOrElse {
                updateError("Not a valid Remodex pairing code.")
                return@launch
            }

            when {
                payload.v != PAIRING_QR_VERSION -> {
                    updateError("This pairing QR uses an unsupported format.")
                    return@launch
                }
                payload.bridgeId.isBlank() || payload.macDeviceId.isBlank() || payload.transportCandidates.isEmpty() -> {
                    updateError("The pairing QR is missing required bridge metadata.")
                    return@launch
                }
                payload.expiresAt + CLOCK_SKEW_TOLERANCE_MS < System.currentTimeMillis() -> {
                    updateError("This pairing QR has expired. Generate a new one from the bridge.")
                    return@launch
                }
            }

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

            updateState {
                copy(
                    pairings = updatedPairings,
                    activePairingMacDeviceId = record.macDeviceId,
                    trustedMacRegistry = updatedTrustedRegistry,
                    pendingTransportSelectionMacDeviceId = if (record.transportCandidates.size > 1) {
                        record.macDeviceId
                    } else {
                        null
                    },
                    secureConnectionState = resolveSecureConnectionState(record.macDeviceId, updatedTrustedRegistry),
                    secureMacFingerprint = SecureCrypto.fingerprint(record.macIdentityPublicKey),
                    importText = "",
                    lastErrorMessage = null,
                )
            }
            if (record.transportCandidates.size == 1) {
                val selectedUrl = record.transportCandidates.first().url
                setPreferredTransport(record.macDeviceId, selectedUrl)
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
                for (url in orderedUrls) {
                    try {
                        Log.d(TAG, "connectActivePairing epoch=$epoch url=$url mac=${pairing.macDeviceId}")
                        val bridgeClient = buildClient(epoch)
                        clientMutex.withLock {
                            client?.disconnect()
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
                        initializeSession()
                        Log.d(TAG, "initialize ok epoch=$epoch")
                        listProviders()
                        Log.d(TAG, "runtime/provider/list ok epoch=$epoch")
                        listThreads()
                        Log.d(TAG, "thread/list ok epoch=$epoch")
                        syncRuntimeSelectionContext(currentRuntimeProviderId(), refreshModels = true)
                        Log.d(TAG, "model/list ok epoch=$epoch provider=${currentRuntimeProviderId()}")
                        updateState {
                            copy(
                                connectionPhase = ConnectionPhase.CONNECTED,
                                lastErrorMessage = null,
                                selectedThreadId = selectedThreadId ?: threads.firstOrNull()?.id,
                            )
                        }
                        state.value.selectedThreadId?.let { threadId ->
                            runCatching {
                                loadThreadHistory(threadId)
                            }.onFailure { failure ->
                                Log.w(TAG, "initial thread/read failed after connect epoch=$epoch threadId=$threadId", failure)
                                scheduleThreadHistoryRetry(threadId, "initial-connect")
                            }
                        }
                        return@launch
                    } catch (failure: Throwable) {
                        Log.e(TAG, "connectActivePairing failed epoch=$epoch url=$url", failure)
                        lastFailure = failure
                    }
                }

                updateState {
                    copy(
                        connectionPhase = ConnectionPhase.OFFLINE,
                        lastErrorMessage = lastFailure?.message ?: "Could not connect to the Remodex bridge.",
                    )
                }
            } finally {
                isConnectInFlight.set(false)
            }
        }
    }

    fun disconnect() {
        scope.launch {
            connectionEpoch.incrementAndGet()
            clientMutex.withLock {
                client?.disconnect()
                client = null
            }
            updateState {
                copy(
                    connectionPhase = ConnectionPhase.OFFLINE,
                    runningThreadIds = emptySet(),
                    activeTurnIdByThread = emptyMap(),
                )
            }
        }
    }

    fun removePairing(macDeviceId: String) {
        scope.launch {
            val remaining = state.value.pairings.filterNot { it.macDeviceId == macDeviceId }
            val activeMacDeviceId = state.value.activePairingMacDeviceId.takeUnless { it == macDeviceId }
                ?: remaining.maxByOrNull(PairingRecord::lastPairedAt)?.macDeviceId
            val trustedRegistry = state.value.trustedMacRegistry.copy(
                records = state.value.trustedMacRegistry.records - macDeviceId,
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

            if (remaining.isEmpty()) {
                disconnect()
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
        updateState { copy(selectedThreadId = threadId, pendingApproval = null) }
        scope.launch {
            syncRuntimeSelectionContext(thread?.provider ?: state.value.selectedProviderId, refreshModels = state.value.isConnected)
        }
        scope.launch {
            loadThreadHistory(threadId)
        }
    }

    fun clearSelectedThread() {
        updateState { copy(selectedThreadId = null, pendingApproval = null) }
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

    fun deleteThread(threadId: String) {
        val current = state.value
        val updatedThreads = current.threads.filterNot { it.id == threadId }
        val updatedMessages = current.messagesByThread - threadId
        val newSelectedId = if (current.selectedThreadId == threadId) null else current.selectedThreadId
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
            if (it.id == threadId) it.copy(syncState = com.remodex.android.data.model.ThreadSyncState.ARCHIVED_LOCAL) else it 
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
            if (it.id == threadId) it.copy(syncState = com.remodex.android.data.model.ThreadSyncState.LIVE) else it 
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
        attachments: List<CodexImageAttachment> = emptyList(),
        skillMentions: List<CodexTurnSkillMention> = emptyList(),
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
                    loadThreadHistory(threadId)
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
            updateState { copy(pendingApproval = null) }
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

    suspend fun gitStatus(cwd: String): com.remodex.android.data.model.GitRepoSyncResult? {
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
        val targets = GitBranchTargets(
            branches = branches,
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

    suspend fun checkoutGitBranch(cwd: String, branch: String): com.remodex.android.data.model.GitRepoSyncResult? {
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

    private fun parseGitRepoSyncResult(response: JsonObject): com.remodex.android.data.model.GitRepoSyncResult {
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
        val repoRoot = response.string("repoRoot")
        val stateLabel = response.string("state") ?: "up_to_date"
        val canPush = response.bool("canPush") ?: hasUnpushedCommits
        val repoDiffTotals = response["diff"]?.jsonObjectOrNull()?.let { diff ->
            val totals = com.remodex.android.data.model.GitDiffTotals(
                additions = diff.int("additions") ?: 0,
                deletions = diff.int("deletions") ?: 0,
                binaryFiles = diff.int("binaryFiles") ?: 0,
            )
            totals.takeIf { it.hasChanges }
        }

        return com.remodex.android.data.model.GitRepoSyncResult(
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
            repoRoot = repoRoot,
            state = stateLabel,
            canPush = canPush,
            repoDiffTotals = repoDiffTotals,
        )
    }

    private fun resolveThreadIdForCwd(cwd: String): String? {
        return state.value.selectedThreadId?.takeIf { selectedId ->
            state.value.threads.firstOrNull { it.id == selectedId }?.cwd == cwd
        } ?: state.value.threads.firstOrNull { it.cwd == cwd }?.id
    }

    private fun updateGitRepoSync(
        threadId: String?,
        result: com.remodex.android.data.model.GitRepoSyncResult,
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
    
    suspend fun performGitAction(cwd: String, action: com.remodex.android.data.model.TurnGitActionKind) {
        val params = buildJsonObject("cwd" to JsonPrimitive(cwd))
        when (action) {
            com.remodex.android.data.model.TurnGitActionKind.DISCARD_LOCAL_CHANGES -> {
                activeClient().sendRequest("git/discard", params)
                activeClient().sendRequest("git/sync", params)
            }
            else -> {
                val method = when (action) {
                    com.remodex.android.data.model.TurnGitActionKind.SYNC_NOW -> "git/sync"
                    com.remodex.android.data.model.TurnGitActionKind.PUSH -> "git/push"
                    com.remodex.android.data.model.TurnGitActionKind.COMMIT -> "git/commit"
                    com.remodex.android.data.model.TurnGitActionKind.COMMIT_AND_PUSH -> "git/commitAndPush"
                    com.remodex.android.data.model.TurnGitActionKind.CREATE_PR -> "git/createPR"
                    com.remodex.android.data.model.TurnGitActionKind.DISCARD_LOCAL_CHANGES -> error("unreachable")
                }
                activeClient().sendRequest(method, params)
            }
        }
    }


    private suspend fun initializeSession() {
        updateState { copy(connectionPhase = ConnectionPhase.SYNCING) }
        val client = activeClient()
        val clientInfo = JsonObject(
            mapOf(
                "name" to JsonPrimitive("remodex_android"),
                "title" to JsonPrimitive("Remodex Android"),
                "version" to JsonPrimitive("0.1.0"),
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
        val activeThreads = fetchThreads(archived = false)
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

    private suspend fun fetchThreads(archived: Boolean): List<ThreadSummary> {
        val params = buildJsonObject(
            "cursor" to JsonNull,
            "limit" to JsonPrimitive(40),
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
        val result = activeClient().sendRequest("thread/list", params)?.jsonObjectOrNull() ?: return emptyList()
        val items = result["data"]?.jsonArrayOrNull()
            ?: result["items"]?.jsonArrayOrNull()
            ?: result["threads"]?.jsonArrayOrNull()
            ?: JsonArray(emptyList())
        return items
            .mapNotNull { it.jsonObjectOrNull()?.let(ThreadSummary::fromJson) }
            .map { thread ->
                if (archived) {
                    thread.copy(syncState = ThreadSyncState.ARCHIVED_LOCAL)
                } else {
                    thread.copy(syncState = ThreadSyncState.LIVE)
                }
            }
    }

    private fun applyThreadListSnapshot(
        activeThreads: List<ThreadSummary>,
        archivedThreads: List<ThreadSummary>?,
        updatePhase: Boolean,
        preserveExistingArchivedThreads: Boolean,
    ) {
        updateState {
            val existingArchivedThreads = if (preserveExistingArchivedThreads) {
                threads.filter { it.syncState == ThreadSyncState.ARCHIVED_LOCAL }
            } else {
                emptyList()
            }
            val combined = mergeThreadLists(
                activeThreads = activeThreads,
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
        return (activeThreads + archivedThreads)
            .distinctBy(ThreadSummary::id)
            .sortedByDescending { it.updatedAt ?: it.createdAt ?: 0L }
    }

    private suspend fun loadThreadHistory(threadId: String) {
        val resumedThreadObject = runCatching {
            val resumeResult = activeClient().sendRequest(
                method = "thread/resume",
                params = buildJsonObject(
                    "threadId" to JsonPrimitive(threadId),
                    "model" to state.value.selectedModelId?.let(::JsonPrimitive),
                ),
            )?.jsonObjectOrNull()
            resumeResult?.threadPayload()
        }.getOrNull()
        val threadObject = resumedThreadObject ?: activeClient().sendRequest(
            method = "thread/read",
            params = JsonObject(
                mapOf(
                    "threadId" to JsonPrimitive(threadId),
                    "includeTurns" to JsonPrimitive(true),
                ),
            ),
        )?.jsonObjectOrNull()?.threadPayload() ?: return
        ThreadSummary.fromJson(threadObject)?.let { thread ->
            updateState {
                copy(threads = upsertThread(threads, thread.copy(syncState = ThreadSyncState.LIVE)))
            }
        }
        val history = decodeMessagesFromThreadRead(threadId, threadObject)
        val activeTurnId = resolveActiveTurnId(threadObject)
        if (history.isNotEmpty()) {
            updateState {
                copy(
                    messagesByThread = messagesByThread + (threadId to history),
                    activeTurnIdByThread = if (activeTurnId == null) {
                        activeTurnIdByThread
                    } else {
                        activeTurnIdByThread + (threadId to activeTurnId)
                    },
                    runningThreadIds = if (activeTurnId == null) {
                        runningThreadIds - threadId
                    } else {
                        runningThreadIds + threadId
                    },
                )
            }
        } else if (activeTurnId != null) {
            updateState {
                copy(
                    activeTurnIdByThread = activeTurnIdByThread + (threadId to activeTurnId),
                    runningThreadIds = runningThreadIds + threadId,
                )
            }
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
                    turn.bool("completed") == false ||
                    turn.string("status")?.lowercase() in setOf("inprogress", "running", "active", "started", "pending") ||
                    (
                        turn.string("id") != null &&
                            turn["completedAt"] == null &&
                            turn["completed_at"] == null &&
                            turn["endedAt"] == null &&
                            turn["ended_at"] == null
                        )
            }
        return activeTurn?.string("id")
            ?: turns.lastOrNull()?.jsonObjectOrNull()?.string("id")
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
        attachments: List<CodexImageAttachment>,
        skillMentions: List<CodexTurnSkillMention>,
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

    private fun decodeMessagesFromThreadRead(threadId: String, threadObject: JsonObject): List<ChatMessage> {
        val turns = threadObject["turns"]?.jsonArrayOrNull().orEmpty()
        val baseTimestamp = threadObject.timestamp("createdAt", "created_at")
            ?: threadObject.timestamp("updatedAt", "updated_at")
            ?: 0L
        val messages = mutableListOf<ChatMessage>()
        var offset = 0L
        turns.forEach { turnElement ->
            val turn = turnElement.jsonObjectOrNull() ?: return@forEach
            val turnId = turn.string("id")
            val turnTimestamp = turn.timestamp("createdAt", "created_at", "updatedAt", "updated_at")
            val items = turn["items"]?.jsonArrayOrNull().orEmpty()
            items.forEach { itemElement ->
                val item = itemElement.jsonObjectOrNull() ?: return@forEach
                val type = item.string("type")?.lowercase()?.replace("_", "") ?: return@forEach
                val timestamp = item.timestamp("createdAt", "created_at")
                    ?: turnTimestamp
                    ?: (baseTimestamp + offset)
                offset += 1
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
                val kind = when (type) {
                    "reasoning" -> MessageKind.THINKING
                    "filechange", "toolcall", "diff" -> MessageKind.FILE_CHANGE
                    "commandexecution" -> MessageKind.COMMAND_EXECUTION
                    "plan" -> MessageKind.PLAN
                    else -> MessageKind.CHAT
                }
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
                val text = when (kind) {
                    MessageKind.FILE_CHANGE -> decodeFileChangeText(item, fileChanges)
                    MessageKind.COMMAND_EXECUTION -> decodeCommandExecutionText(item, commandState)
                    MessageKind.PLAN -> decodePlanText(item, planState)
                    else -> decodeItemText(item)
                }
                if (text.isBlank()) {
                    return@forEach
                }
                messages += ChatMessage(
                    threadId = threadId,
                    role = role,
                    kind = kind,
                    text = text,
                    createdAt = timestamp,
                    turnId = turnId,
                    itemId = item.string("id"),
                    orderIndex = nextOrderIndex(),
                    fileChanges = fileChanges,
                    commandState = commandState,
                    planState = planState,
                )
            }
        }
        return messages.sortedBy(ChatMessage::createdAt)
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
            copy(messagesByThread = messagesByThread + (threadId to existingMessages))
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
        return commandArray.takeIf { it.isNotEmpty() }?.joinToString(" ")
    }

    private fun commandExecutionStatus(item: JsonObject): String? {
        return firstNonBlank(
            item.string("status"),
            item["result"]?.jsonObjectOrNull()?.string("status"),
            item["output"]?.jsonObjectOrNull()?.string("status"),
            item["payload"]?.jsonObjectOrNull()?.string("status"),
            item["data"]?.jsonObjectOrNull()?.string("status"),
            item["event"]?.jsonObjectOrNull()?.string("status"),
        )
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
        return firstNonBlank(
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
            copy(messagesByThread = messagesByThread + (message.threadId to (existing + message)))
        }
    }

    private fun removeLatestMatchingUserMessage(
        threadId: String,
        text: String,
        attachments: List<CodexImageAttachment>,
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
            copy(messagesByThread = messagesByThread + (threadId to existing))
        }
    }

    private fun upsertStreamingMessage(
        threadId: String,
        role: MessageRole,
        kind: MessageKind,
        textDelta: String,
        turnId: String?,
        itemId: String?,
        completed: Boolean = false,
        fileChanges: List<FileChangeEntry> = emptyList(),
        commandState: CommandState? = null,
        planState: PlanState? = null,
        replaceText: Boolean = false,
    ) {
        val normalizedTurnId = turnId?.trim()?.takeIf(String::isNotEmpty)
        if (normalizedTurnId == null && !state.value.threadHasActiveOrRunningTurn(threadId)) {
            return
        }
        if (textDelta.isBlank() && !completed) {
            return
        }
        val streamKey = listOfNotNull(threadId, normalizedTurnId, itemId, role.name, kind.name).joinToString(":")
        updateState {
            val existingMessages = messagesByThread[threadId].orEmpty().toMutableList()
            val existingMessageId = streamingMessageIdsByKey[streamKey]
            val existingIndex = existingMessages.indexOfLast { it.id == existingMessageId }
            if (existingIndex >= 0) {
                val current = existingMessages[existingIndex]
                existingMessages[existingIndex] = current.copy(
                    text = when {
                        completed && textDelta.isBlank() -> current.text
                        replaceText -> textDelta
                        else -> current.text + textDelta
                    },
                    isStreaming = !completed,
                    turnId = turnId ?: current.turnId,
                    itemId = itemId ?: current.itemId,
                    fileChanges = fileChanges.ifEmpty { current.fileChanges },
                    commandState = mergeCommandState(current.commandState, commandState),
                    planState = planState ?: current.planState,
                )
            } else {
                val message = ChatMessage(
                    threadId = threadId,
                    role = role,
                    kind = kind,
                    text = textDelta,
                    turnId = normalizedTurnId,
                    itemId = itemId,
                    isStreaming = !completed,
                    orderIndex = nextOrderIndex(),
                    fileChanges = fileChanges,
                    commandState = commandState,
                    planState = planState,
                )
                streamingMessageIdsByKey[streamKey] = message.id
                existingMessages += message
            }
            copy(messagesByThread = messagesByThread + (threadId to existingMessages))
        }
        if (completed) {
            streamingMessageIdsByKey.remove(streamKey)
        }
    }

    private fun buildClient(epoch: Long): SecureBridgeClient {
        return SecureBridgeClient(
            onNotification = { method, params ->
                if (epoch != connectionEpoch.get()) {
                    return@SecureBridgeClient
                }
                handleNotification(method, params)
            },
            onApprovalRequest = { id, method, params ->
                if (epoch != connectionEpoch.get()) {
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
                            pendingApproval = ApprovalRequest(
                                id = responseKey(id),
                                requestId = id,
                                method = method,
                                command = params?.string("command"),
                                reason = params?.string("reason"),
                                threadId = params?.string("threadId"),
                                turnId = params?.string("turnId"),
                            ),
                        )
                    }
                }
            },
            onDisconnected = { throwable ->
                if (epoch != connectionEpoch.get()) {
                    Log.d(TAG, "ignore stale disconnect epoch=$epoch current=${connectionEpoch.get()}")
                    return@SecureBridgeClient
                }
                Log.e(TAG, "client disconnected epoch=$epoch phase=${state.value.connectionPhase}", throwable)
                val isBenignDisconnect = throwable.isBenignBackgroundDisconnect()
                updateState {
                    copy(
                        connectionPhase = ConnectionPhase.OFFLINE,
                        lastErrorMessage = if (isBenignDisconnect) lastErrorMessage else throwable?.message,
                    )
                }
            },
            onSecureStateChanged = { secureState, fingerprint ->
                if (epoch != connectionEpoch.get()) {
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
                if (epoch != connectionEpoch.get()) {
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
                if (epoch != connectionEpoch.get()) {
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

            "thread/tokenUsage/updated" -> {
                handleThreadTokenUsageUpdated(params)
            }

            "turn/started" -> {
                val threadId = params.resolveThreadId() ?: return
                val turnId = params.resolveTurnId()
                updateState {
                    copy(
                        runningThreadIds = runningThreadIds + threadId,
                        activeTurnIdByThread = if (turnId.isNullOrBlank()) {
                            activeTurnIdByThread
                        } else {
                            activeTurnIdByThread + (threadId to turnId)
                        },
                    )
                }
            }

            "turn/plan/updated" -> {
                val resolvedParams = params ?: return
                val threadId = resolvedParams.resolveThreadId() ?: return
                val turnId = resolvedParams.resolveTurnId()
                val planState = decodePlanState(resolvedParams)
                upsertStreamingMessage(
                    threadId = threadId,
                    role = MessageRole.SYSTEM,
                    kind = MessageKind.PLAN,
                    textDelta = resolvedParams.deltaText().ifBlank {
                        decodePlanText(resolvedParams, planState)
                    },
                    turnId = turnId,
                    itemId = resolvedParams.resolveItemId(),
                    planState = planState,
                )
            }

            "serverRequest/resolved" -> {
                val resolvedParams = params ?: return
                val requestId = resolvedParams["requestId"] ?: return
                removeStructuredUserInputPrompt(
                    requestId = requestId,
                    threadIdHint = resolvedParams.string("threadId"),
                )
            }

            "turn/completed" -> {
                val resolvedParams = params ?: return
                val threadId = params.resolveThreadId() ?: return
                val turnId = params.resolveTurnId()
                updateState {
                    copy(
                        runningThreadIds = runningThreadIds - threadId,
                        activeTurnIdByThread = activeTurnIdByThread - threadId,
                    )
                }
                if (turnId != null) {
                    upsertStreamingMessage(
                        threadId = threadId,
                        role = MessageRole.ASSISTANT,
                        kind = MessageKind.CHAT,
                        textDelta = "",
                        turnId = turnId,
                        itemId = resolvedParams.string("itemId"),
                        completed = true,
                    )
                }
                checkAndSendNextQueuedDraft(threadId)
            }

            "item/agentMessage/delta",
            "codex/event/agent_message_content_delta",
            "codex/event/agent_message_delta" -> {
                val resolvedParams = params ?: return
                val threadId = params.resolveThreadId() ?: return
                upsertStreamingMessage(
                    threadId = threadId,
                    role = MessageRole.ASSISTANT,
                    kind = MessageKind.CHAT,
                    textDelta = params.deltaText(),
                    turnId = params.resolveTurnId(),
                    itemId = resolvedParams.string("itemId") ?: resolvedParams.string("id"),
                )
            }

            "item/reasoning/summaryTextDelta",
            "item/reasoning/summaryPartAdded",
            "item/reasoning/textDelta" -> {
                val resolvedParams = params ?: return
                val threadId = params.resolveThreadId() ?: return
                upsertStreamingMessage(
                    threadId = threadId,
                    role = MessageRole.SYSTEM,
                    kind = MessageKind.THINKING,
                    textDelta = params.deltaText(),
                    turnId = params.resolveTurnId(),
                    itemId = resolvedParams.string("itemId") ?: resolvedParams.string("id"),
                )
            }

            "item/plan/delta" -> {
                val resolvedParams = params ?: return
                val threadId = resolvedParams.resolveThreadId() ?: return
                val planState = decodePlanState(resolvedParams)
                upsertStreamingMessage(
                    threadId = threadId,
                    role = MessageRole.SYSTEM,
                    kind = MessageKind.PLAN,
                    textDelta = resolvedParams.deltaText().ifBlank {
                        decodePlanText(resolvedParams, planState)
                    },
                    turnId = resolvedParams.resolveTurnId(),
                    itemId = resolvedParams.resolveItemId(),
                    planState = planState,
                )
            }

            "item/fileChange/outputDelta",
            "turn/diff/updated",
            "codex/event/turn_diff_updated",
            "codex/event/turn_diff" -> {
                val resolvedParams = params ?: return
                val threadId = params.resolveThreadId() ?: return
                val fileChanges = decodeFileChangeEntries(resolvedParams)
                upsertStreamingMessage(
                    threadId = threadId,
                    role = MessageRole.SYSTEM,
                    kind = MessageKind.FILE_CHANGE,
                    textDelta = params.deltaText(),
                    turnId = params.resolveTurnId(),
                    itemId = resolvedParams.resolveItemId(),
                    fileChanges = fileChanges,
                )
            }

            "item/toolCall/outputDelta",
            "item/toolCall/output_delta",
            "item/tool_call/outputDelta",
            "item/tool_call/output_delta",
            "item/toolCall/completed",
            "item/tool_call/completed" -> {
                val resolvedParams = params ?: return
                val threadId = resolvedParams.resolveThreadId() ?: return
                val fileChanges = decodeFileChangeEntries(resolvedParams)
                upsertStreamingMessage(
                    threadId = threadId,
                    role = MessageRole.SYSTEM,
                    kind = MessageKind.FILE_CHANGE,
                    textDelta = resolvedParams.deltaText(),
                    turnId = resolvedParams.resolveTurnId(),
                    itemId = resolvedParams.resolveItemId(),
                    fileChanges = fileChanges,
                    completed = method.endsWith("completed"),
                )
            }

            "item/commandExecution/outputDelta",
            "item/command_execution/outputDelta" -> {
                val resolvedParams = params ?: return
                val threadId = params.resolveThreadId() ?: return
                val commandState = decodeCommandState(resolvedParams, completedFallback = false)
                upsertStreamingMessage(
                    threadId = threadId,
                    role = MessageRole.SYSTEM,
                    kind = MessageKind.COMMAND_EXECUTION,
                    textDelta = decodeCommandExecutionText(resolvedParams, commandState),
                    turnId = params.resolveTurnId(),
                    itemId = resolvedParams.resolveItemId(),
                    commandState = commandState,
                    replaceText = true,
                )
            }

            "item/completed",
            "codex/event/item_completed",
            "codex/event/agent_message" -> {
                val resolvedParams = params ?: return
                val threadId = params.resolveThreadId() ?: return
                when (resolvedParams.resolveMessageKind()) {
                    MessageKind.FILE_CHANGE -> {
                        upsertStreamingMessage(
                            threadId = threadId,
                            role = MessageRole.SYSTEM,
                            kind = MessageKind.FILE_CHANGE,
                            textDelta = "",
                            turnId = resolvedParams.resolveTurnId(),
                            itemId = resolvedParams.resolveItemId(),
                            completed = true,
                            fileChanges = decodeFileChangeEntries(resolvedParams),
                        )
                    }

                    MessageKind.COMMAND_EXECUTION -> {
                        val commandState = decodeCommandState(resolvedParams, completedFallback = true)
                        upsertStreamingMessage(
                            threadId = threadId,
                            role = MessageRole.SYSTEM,
                            kind = MessageKind.COMMAND_EXECUTION,
                            textDelta = decodeCommandExecutionText(resolvedParams, commandState),
                            turnId = resolvedParams.resolveTurnId(),
                            itemId = resolvedParams.resolveItemId(),
                            completed = true,
                            commandState = commandState,
                            replaceText = true,
                        )
                    }

                    MessageKind.PLAN -> {
                        val planState = decodePlanState(resolvedParams)
                        upsertStreamingMessage(
                            threadId = threadId,
                            role = MessageRole.SYSTEM,
                            kind = MessageKind.PLAN,
                            textDelta = "",
                            turnId = resolvedParams.resolveTurnId(),
                            itemId = resolvedParams.resolveItemId(),
                            completed = true,
                            planState = planState,
                        )
                    }

                    MessageKind.THINKING -> {
                        upsertStreamingMessage(
                            threadId = threadId,
                            role = MessageRole.SYSTEM,
                            kind = MessageKind.THINKING,
                            textDelta = resolvedParams.deltaText(),
                            turnId = resolvedParams.resolveTurnId(),
                            itemId = resolvedParams.resolveItemId(),
                            completed = true,
                        )
                    }

                    else -> {
                        val text = params.deltaText()
                        if (text.isNotBlank()) {
                            upsertStreamingMessage(
                                threadId = threadId,
                                role = MessageRole.ASSISTANT,
                                kind = MessageKind.CHAT,
                                textDelta = text,
                                turnId = params.resolveTurnId(),
                                itemId = resolvedParams.resolveItemId(),
                                completed = true,
                            )
                        }
                    }
                }
            }

            "item/started",
            "codex/event/item_started" -> Unit

            "error", "codex/event/error", "turn/failed" -> {
                val resolvedParams = params
                val threadId = params.resolveThreadId() ?: state.value.selectedThreadId ?: return
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
                        runningThreadIds = runningThreadIds - threadId,
                        activeTurnIdByThread = activeTurnIdByThread - threadId,
                    )
                }
                checkAndSendNextQueuedDraft(threadId)
            }

            "codex/event" -> {
                if (handleLegacyCodexEnvelopeEvent(params)) {
                    return
                }
            }

            else -> {
                if (method.startsWith("codex/event/") && handleLegacyCodexNamedEvent(method, params)) {
                    return
                }
                if (handleToolCallNotificationFallback(method, params)) {
                    return
                }
                if (handleDiffNotificationFallback(method, params)) {
                    return
                }
                if (handleFileChangeNotificationFallback(method, params)) {
                    return
                }
                Log.d(TAG, "ignored notification method=$method params=${params?.toString()?.take(400)}")
            }
        }
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
            updateState {
                copy(
                    runningThreadIds = runningThreadIds - threadId,
                    activeTurnIdByThread = if (activeTurnIdByThread[threadId] == null) {
                        activeTurnIdByThread
                    } else {
                        activeTurnIdByThread - threadId
                    },
                )
            }
        }
    }

    private fun handleThreadTokenUsageUpdated(params: JsonObject?) {
        val threadId = params.resolveThreadId() ?: return
        val usageObject = params?.get("usage")?.jsonObjectOrNull()
            ?: params?.get("event")?.jsonObjectOrNull()?.get("usage")?.jsonObjectOrNull()
            ?: params
            ?: return
        val usedTokens = firstNonNull(
            usageObject.int("tokensUsed"),
            usageObject.int("tokens_used"),
            usageObject.int("totalTokens"),
            usageObject.int("total_tokens"),
        ) ?: return
        val totalTokens = firstNonNull(
            usageObject.int("tokenLimit"),
            usageObject.int("token_limit"),
            usageObject.int("maxTokens"),
            usageObject.int("max_tokens"),
            usageObject.int("contextWindow"),
            usageObject.int("context_window"),
        ) ?: return
        if (totalTokens <= 0) {
            return
        }
        updateState {
            copy(
                contextWindowUsageByThread = contextWindowUsageByThread + (
                    threadId to com.remodex.android.data.model.ContextWindowUsage(
                        tokensUsed = usedTokens,
                        tokenLimit = totalTokens,
                    )
                ),
            )
        }
    }

    private suspend fun handleLegacyCodexEnvelopeEvent(params: JsonObject?): Boolean {
        val msgObject = params?.get("msg")?.jsonObjectOrNull() ?: return false
        val eventType = msgObject.string("type")?.trim()?.lowercase() ?: return false
        if (eventType == "turn_diff") {
            val normalized = JsonObject(
                buildMap {
                    putAll(params)
                    put("event", msgObject)
                    msgObject.string("unified_diff")?.let { put("diff", JsonPrimitive(it)) }
                    if (params.resolveTurnId() == null) {
                        msgObject.string("turnId")?.let { put("turnId", JsonPrimitive(it)) }
                    }
                    if (params.resolveThreadId() == null) {
                        firstNonBlank(
                            msgObject.string("threadId"),
                            msgObject.string("thread_id"),
                            msgObject.string("conversationId"),
                            msgObject.string("conversation_id"),
                        )?.let { put("threadId", JsonPrimitive(it)) }
                    }
                },
            )
            handleNotification("turn/diff/updated", normalized)
            return true
        }
        return handleLegacyCodexEventType(eventType, msgObject, params)
    }

    private suspend fun handleLegacyCodexNamedEvent(method: String, params: JsonObject?): Boolean {
        if (!method.startsWith("codex/event/")) {
            return false
        }
        val eventType = method.removePrefix("codex/event/").trim().lowercase()
        if (eventType.isEmpty()) {
            return false
        }
        val payload = params?.get("msg")?.jsonObjectOrNull()
            ?: params?.get("event")?.jsonObjectOrNull()
            ?: params
            ?: return false
        if (eventType == "turn_diff") {
            val normalized = JsonObject(
                buildMap {
                    if (params != null) {
                        putAll(params)
                    }
                    put("event", payload)
                    firstNonBlank(payload.string("unified_diff"), payload.string("diff"))
                        ?.let { put("diff", JsonPrimitive(it)) }
                },
            )
            handleNotification("turn/diff/updated", normalized)
            return true
        }
        return handleLegacyCodexEventType(eventType, payload, params)
    }

    private suspend fun handleLegacyCodexEventType(
        eventType: String,
        payload: JsonObject,
        params: JsonObject?,
    ): Boolean {
        return when (eventType) {
            "exec_command_begin", "exec_command_output_delta", "exec_command_end" -> {
                handleLegacyCommandExecutionEvent(eventType, payload, params)
            }

            "background_event", "read", "search", "list_files" -> {
                handleLegacyActivityEvent(eventType, payload, params)
            }

            else -> false
        }
    }

    private suspend fun handleLegacyCommandExecutionEvent(
        eventType: String,
        payload: JsonObject,
        params: JsonObject?,
    ): Boolean {
        val normalized = JsonObject(
            buildMap {
                if (params != null) {
                    putAll(params)
                }
                put("event", payload)
                firstNonBlank(
                    payload.string("call_id"),
                    payload.string("callId"),
                    params?.resolveItemId(),
                )?.let { put("itemId", JsonPrimitive(it)) }
                firstNonBlank(
                    payload.string("threadId"),
                    payload.string("thread_id"),
                    payload.string("conversationId"),
                    params?.resolveThreadId(),
                )?.let { put("threadId", JsonPrimitive(it)) }
                firstNonBlank(
                    payload.string("turnId"),
                    payload.string("turn_id"),
                    params?.resolveTurnId(),
                )?.let { put("turnId", JsonPrimitive(it)) }
                payload.flattenedString("text")?.let { put("text", JsonPrimitive(it)) }
                payload.flattenedString("message")?.let { put("message", JsonPrimitive(it)) }
                payload.string("status")?.let { put("status", JsonPrimitive(it)) }
            },
        )
        val mappedMethod = when (eventType) {
            "exec_command_output_delta" -> "item/commandExecution/outputDelta"
            else -> "item/completed"
        }
        if (eventType == "exec_command_begin") {
            upsertStreamingMessage(
                threadId = normalized.resolveThreadId() ?: return false,
                role = MessageRole.SYSTEM,
                kind = MessageKind.COMMAND_EXECUTION,
                textDelta = decodeCommandExecutionText(normalized, decodeCommandState(normalized, completedFallback = false)),
                turnId = normalized.resolveTurnId(),
                itemId = normalized.resolveItemId(),
                commandState = decodeCommandState(normalized, completedFallback = false),
                replaceText = true,
            )
            return true
        }
        handleNotification(mappedMethod, normalized)
        return true
    }

    private fun handleLegacyActivityEvent(
        eventType: String,
        payload: JsonObject,
        params: JsonObject?,
    ): Boolean {
        val threadId = params.resolveThreadId() ?: return false
        val line = firstNonBlank(
            payload.flattenedString("message"),
            payload.flattenedString("text"),
            payload.flattenedString("path"),
        ) ?: eventType.replace('_', ' ')
        appendLocalMessage(
            ChatMessage(
                threadId = threadId,
                role = MessageRole.SYSTEM,
                kind = MessageKind.COMMAND_EXECUTION,
                text = line,
                turnId = params.resolveTurnId(),
                orderIndex = nextOrderIndex(),
            ),
        )
        return true
    }

    private suspend fun handleFileChangeNotificationFallback(method: String, params: JsonObject?): Boolean {
        val normalized = normalizeMethodToken(method)
        if (!normalized.contains("filechange")) {
            return false
        }
        val targetMethod = when {
            normalized.contains("delta") || normalized.contains("partadded") -> "item/fileChange/outputDelta"
            normalized.contains("completed") || normalized.contains("finished") || normalized.contains("done") -> "item/completed"
            else -> "item/completed"
        }
        handleNotification(targetMethod, params)
        return true
    }

    private suspend fun handleToolCallNotificationFallback(method: String, params: JsonObject?): Boolean {
        val normalized = normalizeMethodToken(method)
        if (!normalized.contains("toolcall")) {
            return false
        }
        val targetMethod = when {
            normalized.contains("delta") || normalized.contains("partadded") -> "item/toolCall/outputDelta"
            normalized.contains("completed") || normalized.contains("finished") || normalized.contains("done") -> "item/toolCall/completed"
            else -> "item/toolCall/completed"
        }
        handleNotification(targetMethod, params)
        return true
    }

    private suspend fun handleDiffNotificationFallback(method: String, params: JsonObject?): Boolean {
        val normalized = normalizeMethodToken(method)
        val isDiffMethod = normalized.contains("turndiff") ||
            normalized.contains("/diff/") ||
            normalized.startsWith("diff/") ||
            normalized.endsWith("/diff") ||
            normalized.contains("itemdiff")
        if (!isDiffMethod) {
            return false
        }
        handleNotification("turn/diff/updated", params)
        return true
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
        attachments: List<CodexImageAttachment>,
        skillMentions: List<CodexTurnSkillMention>,
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
        attachments: List<CodexImageAttachment>,
        skillMentions: List<CodexTurnSkillMention>,
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
                requestWithSandboxFallback("turn/start", params)
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

    private fun currentRuntimeProviderId(): String {
        val currentState = state.value
        return normalizeProviderId(currentState.selectedThread?.provider ?: currentState.selectedProviderId)
    }

    private fun orderedTransportUrls(pairingRecord: PairingRecord): List<String> {
        val priority = mapOf(
            "local_ipv4" to 0,
            "tailnet_ipv4" to 1,
            "tailnet" to 1,
            "local_hostname" to 2,
        )
        val unique = linkedSetOf<String>()
        pairingRecord.preferredTransportUrl?.let(unique::add)
        pairingRecord.lastSuccessfulTransportUrl?.let(unique::add)
        pairingRecord.transportCandidates
            .sortedBy { priority[it.kind] ?: 99 }
            .map { it.url.trim() }
            .filter(String::isNotEmpty)
            .forEach(unique::add)
        return unique.toList()
    }

    private suspend fun startThread(preferredProjectPath: String?, providerId: String? = null): ThreadSummary? {
        val resolvedProviderId = normalizeProviderId(providerId ?: state.value.selectedProviderId)
        val params = buildJsonObject(
            "provider" to JsonPrimitive(resolvedProviderId),
            "model" to store.loadSelectedModelId(resolvedProviderId)?.let(::JsonPrimitive),
            "cwd" to preferredProjectPath?.trim()?.takeIf(String::isNotEmpty)?.let(::JsonPrimitive),
        )
        val response = requestWithSandboxFallback("thread/start", params)
        val thread = response
            ?.jsonObjectOrNull()
            ?.get("thread")
            ?.jsonObjectOrNull()
            ?.let(ThreadSummary::fromJson)
            ?: run {
                updateError("thread/start did not return a thread.")
                return null
            }
        updateState {
            copy(
                threads = upsertThread(threads, thread),
                selectedThreadId = thread.id,
                selectedProviderId = resolvedProviderId,
                lastErrorMessage = null,
            )
        }
        return thread
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

    private fun persistConversationCache(previous: AppState, updated: AppState) {
        if (previous.threads == updated.threads &&
            previous.selectedThreadId == updated.selectedThreadId &&
            previous.messagesByThread == updated.messagesByThread
        ) {
            return
        }

        val cachedThreads = updated.threads
            .sortedByDescending { it.updatedAt ?: it.createdAt ?: 0L }
            .take(40)
        val cachedThreadIds = cachedThreads.map(ThreadSummary::id).toSet()
        val cachedMessagesByThread = cachedThreads
            .take(8)
            .mapNotNull { thread ->
                updated.messagesByThread[thread.id]
                    ?.sortedBy(ChatMessage::orderIndex)
                    ?.takeLast(200)
                    ?.takeIf(List<ChatMessage>::isNotEmpty)
                    ?.let { messages -> thread.id to messages }
            }
            .toMap()

        store.saveCachedThreads(cachedThreads)
        store.saveCachedSelectedThreadId(updated.selectedThreadId?.takeIf(cachedThreadIds::contains))
        store.saveCachedMessagesByThread(cachedMessagesByThread)
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
                loadThreadHistory(threadId)
            }.onFailure { failure ->
                Log.w(TAG, "thread/read retry failed reason=$reason threadId=$threadId", failure)
            }
        }
    }

    private suspend fun activeClient(): SecureBridgeClient {
        return clientMutex.withLock {
            client ?: error("Bridge client is not connected.")
        }
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

    private fun upsertThread(existing: List<ThreadSummary>, thread: ThreadSummary): List<ThreadSummary> {
        return (existing.filterNot { it.id == thread.id } + thread).sortedByDescending { it.updatedAt ?: it.createdAt ?: 0L }
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
}

private fun JsonElement?.jsonObjectOrNull(): JsonObject? = this as? JsonObject

private fun JsonElement?.jsonArrayOrNull(): JsonArray? = this as? JsonArray

private fun normalizeProviderId(providerId: String?): String {
    return when (providerId?.trim()?.lowercase()) {
        "claude" -> "claude"
        "gemini" -> "gemini"
        else -> "codex"
    }
}

private fun JsonObject.threadPayload(): JsonObject? {
    return this["thread"]?.jsonObjectOrNull()
        ?: this["result"]?.jsonObjectOrNull()?.get("thread")?.jsonObjectOrNull()
}

private fun JsonObject?.resolveThreadId(): String? {
    if (this == null) {
        return null
    }
    return string("threadId")
        ?: this["thread"]?.jsonObjectOrNull()?.string("id")
        ?: this["turn"]?.jsonObjectOrNull()?.string("threadId")
}

private fun JsonObject?.resolveTurnId(): String? {
    if (this == null) {
        return null
    }
    return string("turnId")
        ?: this["turn"]?.jsonObjectOrNull()?.string("id")
}

private fun JsonObject?.resolveItemId(): String? {
    if (this == null) {
        return null
    }
    return string("itemId")
        ?: string("item_id")
        ?: string("id")
        ?: this["item"]?.jsonObjectOrNull()?.string("id")
        ?: this["event"]?.jsonObjectOrNull()?.string("id")
}

private fun JsonObject?.resolveMessageKind(): MessageKind {
    if (this == null) {
        return MessageKind.CHAT
    }
    val normalizedType = (
        string("type")
            ?: this["item"]?.jsonObjectOrNull()?.string("type")
            ?: this["event"]?.jsonObjectOrNull()?.string("type")
        )
        ?.lowercase()
        ?.replace("_", "")
        ?.replace("-", "")
        ?: ""
    return when {
        normalizedType == "reasoning" -> MessageKind.THINKING
        normalizedType == "plan" -> MessageKind.PLAN
        normalizedType == "filechange" || normalizedType == "diff" -> MessageKind.FILE_CHANGE
        normalizedType == "commandexecution" -> MessageKind.COMMAND_EXECUTION
        normalizedType == "toolcall" && (
            this["changes"] != null || this["fileChanges"] != null || this["file_changes"] != null ||
                this["patches"] != null || this["diff"] != null || this["patch"] != null
            ) -> MessageKind.FILE_CHANGE
        normalizedType.contains("message") -> MessageKind.CHAT
        else -> MessageKind.CHAT
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

private fun normalizeMethodToken(value: String): String {
    return value
        .trim()
        .lowercase()
        .replace("_", "")
        .replace("-", "")
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
