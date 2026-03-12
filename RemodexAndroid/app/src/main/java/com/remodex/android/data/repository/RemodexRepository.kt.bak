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
import com.remodex.android.data.model.FileChangeEntry
import com.remodex.android.data.model.MessageKind
import com.remodex.android.data.model.MessageRole
import com.remodex.android.data.model.ModelOption
import com.remodex.android.data.model.PAIRING_QR_VERSION
import com.remodex.android.data.model.PairingPayload
import com.remodex.android.data.model.PairingRecord
import com.remodex.android.data.model.PhoneIdentityState
import com.remodex.android.data.model.SECURE_PROTOCOL_VERSION
import com.remodex.android.data.model.SecureConnectionState
import com.remodex.android.data.model.StructuredUserInputOption
import com.remodex.android.data.model.StructuredUserInputQuestion
import com.remodex.android.data.model.StructuredUserInputRequest
import com.remodex.android.data.model.PlanState
import com.remodex.android.data.model.PlanStep
import com.remodex.android.data.model.PlanStepStatus
import com.remodex.android.data.model.ThreadSummary
import com.remodex.android.data.model.TrustedMacRecord
import com.remodex.android.data.model.TrustedMacRegistry
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
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
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
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val clientMutex = Mutex()
    private val orderCounter = AtomicInteger(0)
    private val connectionEpoch = AtomicLong(0)
    private val streamingMessageIdsByKey = mutableMapOf<String, String>()
    private var client: SecureBridgeClient? = null

    private val _state = MutableStateFlow(
        AppState(
            onboardingSeen = store.loadOnboardingSeen(),
            fontStyle = store.loadFontStyle(),
            accessMode = store.loadAccessMode(),
            pairings = store.loadPairings(),
            activePairingMacDeviceId = store.loadActivePairingMacDeviceId(),
            phoneIdentityState = loadOrCreatePhoneIdentityState(),
            trustedMacRegistry = store.loadTrustedMacRegistry(),
            selectedModelId = store.loadSelectedModelId(),
            selectedReasoningEffort = store.loadSelectedReasoningEffort(),
        ),
    )
    val state: StateFlow<AppState> = _state.asStateFlow()

    init {
        val currentState = _state.value
        val activePairing = currentState.pairings.firstOrNull { it.macDeviceId == currentState.activePairingMacDeviceId }
        _state.value = currentState.copy(
            activePairingMacDeviceId = activePairing?.macDeviceId
                ?: currentState.pairings.maxByOrNull(PairingRecord::lastPairedAt)?.macDeviceId,
            secureConnectionState = resolveSecureConnectionState(
                activePairingMacDeviceId = activePairing?.macDeviceId ?: currentState.activePairingMacDeviceId,
                trustedRegistry = currentState.trustedMacRegistry,
            ),
            secureMacFingerprint = activePairing?.macIdentityPublicKey?.let(SecureCrypto::fingerprint),
        )
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
        store.saveAccessMode(accessMode)
        updateState { copy(accessMode = accessMode) }
    }

    fun setSelectedModelId(modelId: String?) {
        store.saveSelectedModelId(modelId)
        updateState { copy(selectedModelId = modelId) }
    }

    fun setSelectedReasoningEffort(reasoningEffort: String?) {
        store.saveSelectedReasoningEffort(reasoningEffort)
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
                    secureConnectionState = SecureConnectionState.HANDSHAKING,
                    secureMacFingerprint = SecureCrypto.fingerprint(record.macIdentityPublicKey),
                    importText = "",
                    lastErrorMessage = null,
                )
            }
            connectActivePairing()
        }
    }

    fun connectActivePairing() {
        scope.launch {
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
                    listModels()
                    Log.d(TAG, "model/list ok epoch=$epoch")
                    listThreads()
                    Log.d(TAG, "thread/list ok epoch=$epoch")
                    updateState {
                        copy(
                            connectionPhase = ConnectionPhase.CONNECTED,
                            lastErrorMessage = null,
                            selectedThreadId = selectedThreadId ?: threads.firstOrNull()?.id,
                        )
                    }
                    state.value.selectedThreadId?.let { threadId ->
                        loadThreadHistory(threadId)
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
                secureConnectionState = resolveSecureConnectionState(macDeviceId, trustedMacRegistry),
                secureMacFingerprint = pairings.firstOrNull { it.macDeviceId == macDeviceId }
                    ?.macIdentityPublicKey
                    ?.let(SecureCrypto::fingerprint),
            )
        }
    }

    fun selectThread(threadId: String) {
        updateState { copy(selectedThreadId = threadId, pendingApproval = null) }
        scope.launch {
            loadThreadHistory(threadId)
        }
    }

    fun createThread(preferredProjectPath: String? = null) {
        scope.launch {
            val params = buildJsonObject(
                "model" to state.value.selectedModelId?.let(::JsonPrimitive),
                "cwd" to preferredProjectPath?.trim()?.takeIf(String::isNotEmpty)?.let(::JsonPrimitive),
            )
            val response = requestWithSandboxFallback("thread/start", params)
            val thread = response
                ?.jsonObjectOrNull()
                ?.get("thread")
                ?.jsonObjectOrNull()
                ?.let(ThreadSummary::fromJson)
                ?: return@launch updateError("thread/start did not return a thread.")
            updateState {
                copy(
                    threads = upsertThread(threads, thread),
                    selectedThreadId = thread.id,
                    lastErrorMessage = null,
                )
            }
        }
    }

    fun sendMessage(text: String, usePlanMode: Boolean = false) {
        scope.launch {
            val trimmed = text.trim()
            if (trimmed.isEmpty()) {
                return@launch
            }

            val selectedModel = state.value.availableModels.firstOrNull {
                it.id == state.value.selectedModelId || it.model == state.value.selectedModelId
            } ?: state.value.availableModels.firstOrNull { it.isDefault }
                ?: state.value.availableModels.firstOrNull()
            if (usePlanMode && selectedModel == null) {
                updateError("Plan mode requires an available model before starting a turn.")
                return@launch
            }

            val threadId = state.value.selectedThreadId ?: run {
                createThread()
                return@launch
            }
            appendLocalMessage(
                ChatMessage(
                    threadId = threadId,
                    role = MessageRole.USER,
                    text = trimmed,
                    orderIndex = nextOrderIndex(),
                ),
            )
            updateState {
                copy(
                    runningThreadIds = runningThreadIds + threadId,
                    lastErrorMessage = null,
                )
            }

            val inputItems = JsonArray(
                listOf(
                    JsonObject(
                        mapOf(
                            "type" to JsonPrimitive("text"),
                            "text" to JsonPrimitive(trimmed),
                        ),
                    ),
                ),
            )
            val params = buildJsonObject(
                "threadId" to JsonPrimitive(threadId),
                "input" to inputItems,
                "model" to state.value.selectedModelId?.let(::JsonPrimitive),
                "effort" to state.value.selectedReasoningEffort?.let(::JsonPrimitive),
                "collaborationMode" to if (usePlanMode && selectedModel != null) {
                    buildJsonObject(
                        "mode" to JsonPrimitive("plan"),
                        "settings" to buildJsonObject(
                            "model" to JsonPrimitive(selectedModel.model),
                            "reasoning_effort" to state.value.selectedReasoningEffort?.let(::JsonPrimitive),
                            "developer_instructions" to JsonNull,
                        ),
                    )
                } else {
                    null
                },
            )

            runCatching {
                requestWithSandboxFallback("turn/start", params)
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
            if (turnId.isNullOrBlank()) {
                return@launch
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

    private suspend fun listModels() {
        val result = activeClient().sendRequest(
            method = "model/list",
            params = JsonObject(
                mapOf(
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
        if (models.isNotEmpty()) {
            val selectedModel = state.value.selectedModelId
                ?.let { wanted -> models.firstOrNull { it.id == wanted || it.model == wanted } }
                ?: models.firstOrNull { it.isDefault }
                ?: models.firstOrNull()
            val reasoning = selectedModel?.supportedReasoningEfforts?.firstOrNull()
            updateState {
                copy(
                    availableModels = models,
                    selectedModelId = selectedModel?.id,
                    selectedReasoningEffort = selectedReasoningEffort
                        ?.takeIf { effort -> selectedModel?.supportedReasoningEfforts?.contains(effort) == true }
                        ?: selectedModel?.defaultReasoningEffort
                        ?: reasoning,
                )
            }
            store.saveSelectedModelId(state.value.selectedModelId)
            store.saveSelectedReasoningEffort(state.value.selectedReasoningEffort)
        }
    }

    private suspend fun listThreads() {
        updateState { copy(connectionPhase = ConnectionPhase.LOADING_CHATS) }
        val activeThreads = fetchThreads(archived = false)
        val archivedThreads = runCatching { fetchThreads(archived = true) }.getOrDefault(emptyList())
        val combined = (activeThreads + archivedThreads)
            .distinctBy(ThreadSummary::id)
            .sortedByDescending { it.updatedAt ?: it.createdAt ?: 0L }
        updateState {
            copy(
                threads = combined,
                selectedThreadId = selectedThreadId ?: combined.firstOrNull()?.id,
                connectionPhase = ConnectionPhase.CONNECTED,
            )
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
        return items.mapNotNull { it.jsonObjectOrNull()?.let(ThreadSummary::fromJson) }
    }

    private suspend fun loadThreadHistory(threadId: String) {
        val result = activeClient().sendRequest(
            method = "thread/read",
            params = JsonObject(
                mapOf(
                    "threadId" to JsonPrimitive(threadId),
                    "includeTurns" to JsonPrimitive(true),
                ),
            ),
        )?.jsonObjectOrNull() ?: return
        val threadObject = result["thread"]?.jsonObjectOrNull() ?: return
        val history = decodeMessagesFromThreadRead(threadId, threadObject)
        if (history.isNotEmpty()) {
            updateState {
                copy(
                    messagesByThread = messagesByThread + (threadId to history),
                )
            }
        }
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
        if (textDelta.isBlank() && !completed) {
            return
        }
        val streamKey = listOfNotNull(threadId, turnId, itemId, role.name, kind.name).joinToString(":")
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
                    turnId = turnId,
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
                updateState {
                    copy(
                        connectionPhase = ConnectionPhase.OFFLINE,
                        runningThreadIds = emptySet(),
                        activeTurnIdByThread = emptyMap(),
                        lastErrorMessage = throwable?.message,
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
            }
        }
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
        _state.value = _state.value.update()
    }

    private fun updateError(message: String) {
        updateState { copy(lastErrorMessage = message) }
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
