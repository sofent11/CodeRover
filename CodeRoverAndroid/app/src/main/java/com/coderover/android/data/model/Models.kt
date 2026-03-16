package com.coderover.android.data.model

import java.time.Instant
import java.time.format.DateTimeParseException
import java.util.Comparator
import java.util.UUID
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull

const val SECURE_PROTOCOL_VERSION = 1
const val PAIRING_QR_VERSION = 3
const val SECURE_HANDSHAKE_TAG = "coderover-e2ee-v1"
const val SECURE_HANDSHAKE_LABEL = "client-auth"
const val CLOCK_SKEW_TOLERANCE_MS = 60_000L

@Serializable
data class TransportCandidate(
    val kind: String,
    val url: String,
    val label: String? = null,
) {
    fun transportHost(): String? {
        val urlText = url.trim()
        return runCatching {
            java.net.URI(urlText).host?.trim()?.takeIf(String::isNotEmpty)
        }.getOrNull()
    }

    fun isUsableCandidate(): Boolean {
        val host = transportHost() ?: return false
        if (kind == "local_ipv4" && host.startsWith("169.254.")) {
            return false
        }
        return true
    }

    fun reconnectNetworkPriority(localIpv4Addresses: Set<String>): Int {
        val host = transportHost().orEmpty()
        val ipv4 = host.normalizedIpv4Address()
        if (ipv4 != null) {
            if (localIpv4Addresses.any { it.isSameIpv4Subnet(ipv4) }) {
                return 0
            }
            if (ipv4.isPublicIpv4Address()) {
                return 1
            }
            return 4
        }

        if (kind == "tailnet_ipv4" || kind == "tailnet" || host.endsWith(".ts.net")) {
            return 2
        }

        if (kind == "local_hostname" || host.endsWith(".local")) {
            return 3
        }

        return 1
    }

    fun reconnectKindPriority(): Int {
        return when (kind) {
            "local_ipv4" -> 0
            "tailnet_ipv4", "tailnet" -> 1
            "local_hostname" -> 2
            else -> 3
        }
    }
}

private fun String.normalizedIpv4Address(): String? {
    val octets = split(".")
    if (octets.size != 4) {
        return null
    }
    val normalized = octets.map { it.toIntOrNull() ?: return null }
    if (normalized.any { it !in 0..255 }) {
        return null
    }
    return normalized.joinToString(".")
}

private fun String.isSameIpv4Subnet(other: String): Boolean {
    val lhs = normalizedIpv4Address()?.split(".") ?: return false
    val rhs = other.normalizedIpv4Address()?.split(".") ?: return false
    return lhs[0] == rhs[0] && lhs[1] == rhs[1] && lhs[2] == rhs[2]
}

private fun String.isPublicIpv4Address(): Boolean {
    val octets = normalizedIpv4Address()?.split(".")?.mapNotNull(String::toIntOrNull) ?: return false
    val first = octets[0]
    val second = octets[1]
    if (first == 10 || first == 127 || first == 0) {
        return false
    }
    if (first == 169 && second == 254) {
        return false
    }
    if (first == 172 && second in 16..31) {
        return false
    }
    if (first == 192 && second == 168) {
        return false
    }
    if (first >= 224) {
        return false
    }
    return true
}

@Serializable
data class PairingPayload(
    val v: Int,
    val bridgeId: String,
    val macDeviceId: String,
    val macIdentityPublicKey: String,
    val transportCandidates: List<TransportCandidate>,
    val expiresAt: Long,
)

@Serializable
data class PairingRecord(
    val bridgeId: String,
    val macDeviceId: String,
    val macIdentityPublicKey: String,
    val transportCandidates: List<TransportCandidate>,
    val preferredTransportUrl: String? = null,
    val lastSuccessfulTransportUrl: String? = null,
    val secureProtocolVersion: Int = SECURE_PROTOCOL_VERSION,
    val lastAppliedBridgeOutboundSeq: Int = 0,
    val lastPairedAt: Long = System.currentTimeMillis(),
)

@Serializable
data class PhoneIdentityState(
    val phoneDeviceId: String,
    val phoneIdentityPrivateKey: String,
    val phoneIdentityPublicKey: String,
)

@Serializable
data class TrustedMacRecord(
    val macDeviceId: String,
    val macIdentityPublicKey: String,
    val lastPairedAt: Long,
)

@Serializable
data class TrustedMacRegistry(
    val records: Map<String, TrustedMacRecord> = emptyMap(),
)

enum class HandshakeMode(val rawValue: String) {
    QR_BOOTSTRAP("qr_bootstrap"),
    TRUSTED_RECONNECT("trusted_reconnect"),
}

enum class SecureConnectionState(val statusLabel: String) {
    NOT_PAIRED("Not paired"),
    TRUSTED_MAC("Trusted Mac"),
    HANDSHAKING("Secure handshake in progress"),
    ENCRYPTED("End-to-end encrypted"),
    RECONNECTING("Reconnecting securely"),
    RE_PAIR_REQUIRED("Re-pair required"),
    UPDATE_REQUIRED("Update required"),
}

val SecureConnectionState.blocksAutomaticReconnect: Boolean
    get() = this == SecureConnectionState.RE_PAIR_REQUIRED || this == SecureConnectionState.UPDATE_REQUIRED

enum class ConnectionPhase {
    OFFLINE,
    CONNECTING,
    LOADING_CHATS,
    SYNCING,
    CONNECTED,
}

enum class AppFontStyle {
    SYSTEM,
    GEIST,
}

enum class AccessMode(
    val rawValue: String,
    val displayName: String,
    val approvalPolicyCandidates: List<String>,
    val sandboxLegacyValue: String,
) {
    ON_REQUEST(
        rawValue = "on-request",
        displayName = "On-Request",
        approvalPolicyCandidates = listOf("on-request", "onRequest"),
        sandboxLegacyValue = "workspaceWrite",
    ),
    FULL_ACCESS(
        rawValue = "full-access",
        displayName = "Full access",
        approvalPolicyCandidates = listOf("never"),
        sandboxLegacyValue = "dangerFullAccess",
    );

    companion object {
        fun fromRawValue(rawValue: String?): AccessMode {
            return entries.firstOrNull { it.rawValue == rawValue } ?: ON_REQUEST
        }
    }
}

@Serializable
data class RuntimeCapabilities(
    val planMode: Boolean = true,
    val structuredUserInput: Boolean = true,
    val inlineApproval: Boolean = true,
    val turnSteer: Boolean = true,
    val reasoningOptions: Boolean = true,
    val desktopRefresh: Boolean = true,
    val desktopRestart: Boolean = true,
) {
    companion object {
        val CODEX_DEFAULT = RuntimeCapabilities()

        fun fromJson(json: JsonObject?): RuntimeCapabilities {
            if (json == null) {
                return CODEX_DEFAULT
            }
            return RuntimeCapabilities(
                planMode = json.bool("planMode") ?: CODEX_DEFAULT.planMode,
                structuredUserInput = json.bool("structuredUserInput") ?: CODEX_DEFAULT.structuredUserInput,
                inlineApproval = json.bool("inlineApproval") ?: CODEX_DEFAULT.inlineApproval,
                turnSteer = json.bool("turnSteer") ?: CODEX_DEFAULT.turnSteer,
                reasoningOptions = json.bool("reasoningOptions") ?: CODEX_DEFAULT.reasoningOptions,
                desktopRefresh = json.bool("desktopRefresh") ?: CODEX_DEFAULT.desktopRefresh,
                desktopRestart = json.bool("desktopRestart") ?: CODEX_DEFAULT.desktopRestart,
            )
        }
    }
}

@Serializable
data class RuntimeAccessModeOption(
    val id: String,
    val title: String,
) {
    companion object {
        fun fromJson(json: JsonObject): RuntimeAccessModeOption? {
            val id = json.string("id") ?: return null
            val title = json.string("title") ?: return null
            return RuntimeAccessModeOption(id = id, title = title)
        }
    }
}

@Serializable
data class RuntimeProvider(
    val id: String,
    val title: String,
    val supports: RuntimeCapabilities = RuntimeCapabilities.CODEX_DEFAULT,
    val accessModes: List<RuntimeAccessModeOption> = emptyList(),
    val defaultModelId: String? = null,
) {
    companion object {
        val CODEX_DEFAULT = RuntimeProvider(
            id = "codex",
            title = "Codex",
            supports = RuntimeCapabilities.CODEX_DEFAULT,
            accessModes = listOf(
                RuntimeAccessModeOption(id = AccessMode.ON_REQUEST.rawValue, title = AccessMode.ON_REQUEST.displayName),
                RuntimeAccessModeOption(id = AccessMode.FULL_ACCESS.rawValue, title = AccessMode.FULL_ACCESS.displayName),
            ),
            defaultModelId = null,
        )

        fun fromJson(json: JsonObject): RuntimeProvider? {
            val id = json.string("id") ?: return null
            val title = json.string("title") ?: return null
            return RuntimeProvider(
                id = id,
                title = title,
                supports = RuntimeCapabilities.fromJson(json["supports"]?.jsonObjectOrNull()),
                accessModes = json.array("accessModes")
                    ?.mapNotNull { it.jsonObjectOrNull()?.let(RuntimeAccessModeOption::fromJson) }
                    .orEmpty(),
                defaultModelId = json.string("defaultModelId"),
            )
        }
    }
}

@Serializable
enum class ThreadSyncState {
    LIVE,
    ARCHIVED_LOCAL,
}

@Serializable
data class ThreadSummary(
    val id: String,
    val title: String? = null,
    val name: String? = null,
    val preview: String? = null,
    val createdAt: Long? = null,
    val updatedAt: Long? = null,
    val cwd: String? = null,
    val provider: String = "codex",
    val providerSessionId: String? = null,
    val capabilities: RuntimeCapabilities? = RuntimeCapabilities.CODEX_DEFAULT,
    val syncState: ThreadSyncState = ThreadSyncState.LIVE,
) {
    val displayTitle: String
        get() {
            val resolved = listOf(name, title, preview)
                .mapNotNull { it?.trim()?.takeIf(String::isNotEmpty) }
                .firstOrNull()
            return resolved ?: "Conversation"
        }

    val normalizedProjectPath: String?
        get() = cwd?.trim()?.trimEnd('/')?.takeIf(String::isNotEmpty)

    val projectDisplayName: String
        get() {
            val project = normalizedProjectPath ?: return "No Project"
            return project.substringAfterLast('/').ifEmpty { project }
        }

    val providerBadgeTitle: String
        get() = when (provider.trim().lowercase()) {
            "claude" -> "Claude"
            "gemini" -> "Gemini"
            else -> "Codex"
        }

    companion object {
        fun fromJson(json: JsonObject): ThreadSummary? {
            val id = json.string("id") ?: return null
            return ThreadSummary(
                id = id,
                title = json.string("title"),
                name = json.string("name"),
                preview = json.string("preview"),
                createdAt = json.timestamp("createdAt", "created_at"),
                updatedAt = json.timestamp("updatedAt", "updated_at"),
                cwd = json.string("cwd")
                    ?: json.string("current_working_directory")
                    ?: json.string("working_directory"),
                provider = json.string("provider") ?: "codex",
                providerSessionId = json.string("providerSessionId"),
                capabilities = RuntimeCapabilities.fromJson(json["capabilities"]?.jsonObjectOrNull()),
                syncState = if (json.string("syncState") == "archivedLocal") {
                    ThreadSyncState.ARCHIVED_LOCAL
                } else {
                    ThreadSyncState.LIVE
                },
            )
        }
    }
}

@Serializable
enum class MessageRole {
    USER,
    ASSISTANT,
    SYSTEM,
}

@Serializable
enum class MessageKind {
    CHAT,
    THINKING,
    FILE_CHANGE,
    COMMAND_EXECUTION,
    PLAN,
    USER_INPUT_PROMPT,
}

@Serializable
enum class CommandPhase(val statusLabel: String) {
    RUNNING("Running"),
    COMPLETED("Completed"),
    FAILED("Needs attention"),
    STOPPED("Stopped");

    companion object {
        fun fromStatus(rawStatus: String?, completedFallback: Boolean = false): CommandPhase {
            val normalized = rawStatus
                ?.trim()
                ?.lowercase()
                .orEmpty()
            return when {
                normalized.contains("fail") || normalized.contains("error") -> FAILED
                normalized.contains("cancel") || normalized.contains("abort") || normalized.contains("interrupt") -> STOPPED
                normalized.contains("complete") || normalized.contains("success") || normalized.contains("done") -> COMPLETED
                completedFallback -> COMPLETED
                else -> RUNNING
            }
        }
    }
}

@Serializable
data class CommandState(
    val shortCommand: String,
    val fullCommand: String,
    val phase: CommandPhase,
    val cwd: String? = null,
    val exitCode: Int? = null,
    val durationMs: Int? = null,
    val outputTail: String = "",
)

@Serializable
enum class PlanStepStatus {
    PENDING,
    IN_PROGRESS,
    COMPLETED;

    companion object {
        fun fromRawValue(rawValue: String?): PlanStepStatus? {
            return when (rawValue?.trim()?.lowercase()) {
                "pending" -> PENDING
                "in_progress", "in progress" -> IN_PROGRESS
                "completed" -> COMPLETED
                else -> null
            }
        }
    }
}

@Serializable
data class PlanStep(
    val id: String = UUID.randomUUID().toString(),
    val step: String,
    val status: PlanStepStatus,
)

@Serializable
data class PlanState(
    val explanation: String? = null,
    val steps: List<PlanStep> = emptyList(),
)

@Serializable
data class FileChangeEntry(
    val path: String,
    val kind: String,
    val diff: String = "",
    val additions: Int? = null,
    val deletions: Int? = null,
)

@Serializable
data class ImageAttachment(
    val thumbnailBase64JPEG: String,
    val sourceBase64JPEG: String? = null,
    val payloadDataURL: String? = null,
    val sourceUrl: String? = null,
)

@Serializable
data class StructuredUserInputOption(
    val id: String = UUID.randomUUID().toString(),
    val label: String,
    val description: String,
)

@Serializable
data class StructuredUserInputQuestion(
    val id: String,
    val header: String,
    val question: String,
    val isOther: Boolean,
    val isSecret: Boolean,
    val options: List<StructuredUserInputOption>,
)

@Serializable
data class StructuredUserInputRequest(
    val requestId: JsonElement,
    val questions: List<StructuredUserInputQuestion>,
)

@Serializable
data class ChatMessage(
    val id: String = UUID.randomUUID().toString(),
    val threadId: String,
    val role: MessageRole,
    val kind: MessageKind = MessageKind.CHAT,
    val text: String,
    val createdAt: Long = System.currentTimeMillis(),
    val turnId: String? = null,
    val itemId: String? = null,
    val isStreaming: Boolean = false,
    val orderIndex: Int = 0,
    val attachments: List<ImageAttachment> = emptyList(),
    val fileChanges: List<FileChangeEntry> = emptyList(),
    val commandState: CommandState? = null,
    val planState: PlanState? = null,
    val structuredUserInputRequest: StructuredUserInputRequest? = null,
    val providerItemId: String? = null,
    val timelineOrdinal: Int? = null,
    val timelineStatus: String? = null,
) {
    val stableStreamKey: String
        get() = itemId ?: turnId ?: "$threadId:$role:$kind"

    val timelineItemId: String
        get() = id
}

data class ThreadTimelineState(
    private val itemsById: MutableMap<String, ChatMessage> = linkedMapOf(),
    private val orderedItemIds: MutableList<String> = mutableListOf(),
) {
    constructor(messages: List<ChatMessage>) : this() {
        replaceAll(messages)
    }

    fun replaceAll(messages: List<ChatMessage>) {
        itemsById.clear()
        orderedItemIds.clear()
        messages.forEach(::upsert)
    }

    fun upsert(message: ChatMessage) {
        itemsById[message.id] = message
        if (!orderedItemIds.contains(message.id)) {
            orderedItemIds += message.id
        }
        orderedItemIds.sortWith(
            Comparator { lhs, rhs ->
                compareTimelineMessages(itemsById[lhs], itemsById[rhs])
            },
        )
    }

    fun message(id: String): ChatMessage? = itemsById[id]

    fun renderedMessages(): List<ChatMessage> = orderedItemIds.mapNotNull(itemsById::get)

    private fun compareTimelineMessages(lhs: ChatMessage?, rhs: ChatMessage?): Int {
        if (lhs == null || rhs == null) {
            return (lhs?.id ?: "").compareTo(rhs?.id ?: "")
        }
        val lhsOrder = lhs.timelineOrdinal ?: lhs.orderIndex
        val rhsOrder = rhs.timelineOrdinal ?: rhs.orderIndex
        return when {
            lhsOrder != rhsOrder -> lhsOrder.compareTo(rhsOrder)
            lhs.createdAt != rhs.createdAt -> lhs.createdAt.compareTo(rhs.createdAt)
            else -> lhs.id.compareTo(rhs.id)
        }
    }
}

data class ModelOption(
    val id: String,
    val model: String,
    val title: String,
    val isDefault: Boolean,
    val supportedReasoningEfforts: List<String>,
    val defaultReasoningEffort: String?,
) {
    companion object {
        fun fromJson(json: JsonObject): ModelOption? {
            val id = json.string("id") ?: json.string("model") ?: return null
            val model = json.string("model") ?: id
            val title = json.string("title") ?: model
            val efforts = json.array("supportedReasoningEfforts")
                ?.mapNotNull { it.jsonObjectOrNull()?.string("reasoningEffort") ?: it.stringOrNull() }
                .orEmpty()
            return ModelOption(
                id = id,
                model = model,
                title = title,
                isDefault = json.bool("isDefault") ?: false,
                supportedReasoningEfforts = efforts,
                defaultReasoningEffort = json.string("defaultReasoningEffort"),
            )
        }
    }
}

data class ApprovalRequest(
    val id: String,
    val requestId: JsonElement,
    val method: String,
    val command: String?,
    val reason: String?,
    val threadId: String?,
    val turnId: String?,
)

@Serializable
data class FuzzyFileMatch(
    val path: String,
    val root: String,
) {
    val fileName: String get() = path.substringAfterLast('/')
}

@Serializable
data class SkillMetadata(
    val id: String,
    val name: String,
    val description: String?,
    val path: String? = null,
)

data class TurnComposerMentionedFile(
    val id: String = UUID.randomUUID().toString(),
    val fileName: String,
    val path: String,
)

data class TurnComposerMentionedSkill(
    val id: String = UUID.randomUUID().toString(),
    val skillId: String,
    val name: String,
    val path: String? = null,
    val description: String? = null,
)

@Serializable
data class TurnSkillMention(
    val id: String,
    val name: String? = null,
    val path: String? = null,
)

enum class ThreadRunBadgeState {
    RUNNING,
    READY,
    FAILED
}

data class AppState(
    val onboardingSeen: Boolean = false,
    val fontStyle: AppFontStyle = AppFontStyle.SYSTEM,
    val accessMode: AccessMode = AccessMode.ON_REQUEST,
    val availableProviders: List<RuntimeProvider> = listOf(RuntimeProvider.CODEX_DEFAULT),
    val selectedProviderId: String = "codex",
    val pairings: List<PairingRecord> = emptyList(),
    val activePairingMacDeviceId: String? = null,
    val phoneIdentityState: PhoneIdentityState? = null,
    val trustedMacRegistry: TrustedMacRegistry = TrustedMacRegistry(),
    val connectionPhase: ConnectionPhase = ConnectionPhase.OFFLINE,
    val secureConnectionState: SecureConnectionState = SecureConnectionState.NOT_PAIRED,
    val secureMacFingerprint: String? = null,
    val threads: List<ThreadSummary> = emptyList(),
    val selectedThreadId: String? = null,
    val messagesByThread: Map<String, List<ChatMessage>> = emptyMap(),
    val historyStateByThread: Map<String, ThreadHistoryState> = emptyMap(),
    val activeTurnIdByThread: Map<String, String> = emptyMap(),
    val pendingRealtimeSeededTurnIdByThread: Map<String, String> = emptyMap(),
    val runningThreadIds: Set<String> = emptySet(),
    val readyThreadIds: Set<String> = emptySet(),
    val failedThreadIds: Set<String> = emptySet(),
    val availableModels: List<ModelOption> = emptyList(),
    val selectedModelId: String? = null,
    val selectedReasoningEffort: String? = null,
    val pendingApproval: ApprovalRequest? = null,
    val lastErrorMessage: String? = null,
    val importText: String = "",
    val pendingTransportSelectionMacDeviceId: String? = null,
    val gitRepoSyncByThread: Map<String, GitRepoSyncResult> = emptyMap(),
    val gitBranchTargetsByThread: Map<String, GitBranchTargets> = emptyMap(),
    val selectedGitBaseBranchByThread: Map<String, String> = emptyMap(),
    val runningGitActionByThread: Map<String, TurnGitActionKind> = emptyMap(),
    val contextWindowUsageByThread: Map<String, ContextWindowUsage> = emptyMap(),
    val rateLimitBuckets: List<CodeRoverRateLimitBucket> = emptyList(),
    val isLoadingRateLimits: Boolean = false,
    val rateLimitsErrorMessage: String? = null,
    val collapsedProjectGroupIds: Set<String> = emptySet(),
    val assistantRevertPresentationByMessageId: Map<String, AssistantRevertPresentation> = emptyMap(),
    val queuedTurnDraftsByThread: Map<String, List<QueuedTurnDraft>> = emptyMap(),
    val queuePauseMessageByThread: Map<String, String> = emptyMap(),
) {
    val isConnected: Boolean
        get() = connectionPhase == ConnectionPhase.CONNECTED

    val activePairing: PairingRecord?
        get() = pairings.firstOrNull { it.macDeviceId == activePairingMacDeviceId }

    val selectedThread: ThreadSummary?
        get() = threads.firstOrNull { it.id == selectedThreadId }

    val gitRepoSyncResult: GitRepoSyncResult?
        get() = selectedThreadId?.let(gitRepoSyncByThread::get)

    val gitBranchTargets: GitBranchTargets?
        get() = selectedThreadId?.let(gitBranchTargetsByThread::get)

    val selectedGitBaseBranch: String?
        get() = selectedThreadId?.let(selectedGitBaseBranchByThread::get)

    val contextWindowUsage: ContextWindowUsage?
        get() = selectedThreadId?.let(contextWindowUsageByThread::get)

    val pendingTransportSelectionPairing: PairingRecord?
        get() = pendingTransportSelectionMacDeviceId?.let { macDeviceId ->
            pairings.firstOrNull { it.macDeviceId == macDeviceId }
        }

    val selectedProvider: RuntimeProvider
        get() = availableProviders.firstOrNull { it.id == selectedProviderId } ?: RuntimeProvider.CODEX_DEFAULT

    val activeRuntimeProviderId: String
        get() = selectedThread?.provider ?: selectedProviderId

    val activeRuntimeProvider: RuntimeProvider
        get() = availableProviders.firstOrNull { it.id == activeRuntimeProviderId } ?: RuntimeProvider.CODEX_DEFAULT

    val activeRuntimeCapabilities: RuntimeCapabilities
        get() = selectedThread?.capabilities ?: activeRuntimeProvider.supports

    val runningGitAction: TurnGitActionKind?
        get() = selectedThreadId?.let(runningGitActionByThread::get)

    val isRunningGitAction: Boolean
        get() = runningGitAction != null

    val gitSyncState: String?
        get() = gitRepoSyncResult?.state

    val shouldShowDiscardRuntimeChangesAndSync: Boolean
        get() {
            val sync = gitRepoSyncResult ?: return false
            val dangerousStates = setOf("dirty", "dirty_and_behind", "diverged")
            return dangerousStates.contains(sync.state) || (sync.isDirty && sync.state == "no_upstream")
        }
}

@Serializable
data class ThreadHistoryAnchor(
    val itemId: String? = null,
    val createdAt: Long,
    val turnId: String? = null,
)

@Serializable
data class ThreadHistorySegment(
    val oldestAnchor: ThreadHistoryAnchor,
    val newestAnchor: ThreadHistoryAnchor,
)

@Serializable
data class ThreadHistoryGap(
    val olderAnchor: ThreadHistoryAnchor,
    val newerAnchor: ThreadHistoryAnchor,
)

@Serializable
data class ThreadHistoryState(
    val oldestCursor: String? = null,
    val newestCursor: String? = null,
    val segments: List<ThreadHistorySegment> = emptyList(),
    val gaps: List<ThreadHistoryGap> = emptyList(),
    val oldestLoadedAnchor: ThreadHistoryAnchor? = null,
    val newestLoadedAnchor: ThreadHistoryAnchor? = null,
    val hasOlderOnServer: Boolean = false,
    val hasNewerOnServer: Boolean = false,
    val isLoadingOlder: Boolean = false,
    val isTailRefreshing: Boolean = false,
)

fun JsonObject.string(key: String): String? = this[key].stringOrNull()

fun JsonObject.bool(key: String): Boolean? = this[key].boolOrNull()

fun JsonObject.int(key: String): Int? = this[key].asIntOrNull()

fun JsonObject.array(key: String): JsonArray? = this[key]?.jsonArrayOrNull()

fun JsonObject.timestamp(vararg keys: String): Long? {
    for (key in keys) {
        val element = this[key] ?: continue
        val primitive = element as? JsonPrimitive ?: continue
        primitive.longOrNull?.let { value ->
            return if (value > 10_000_000_000L) value else value * 1_000
        }
        primitive.doubleOrNull?.let { value ->
            val numeric = value.toLong()
            return if (numeric > 10_000_000_000L) numeric else numeric * 1_000
        }
        primitive.contentOrNull?.let { value ->
            parseTimestamp(value)?.let { return it }
        }
    }
    return null
}

fun JsonElement?.jsonObjectOrNull(): JsonObject? = this as? JsonObject

fun JsonElement?.jsonArrayOrNull(): JsonArray? = this as? JsonArray

fun JsonElement?.stringOrNull(): String? = (this as? JsonPrimitive)?.contentOrNull

fun JsonElement?.boolOrNull(): Boolean? = (this as? JsonPrimitive)?.booleanOrNull

fun JsonElement?.asIntOrNull(): Int? = when (val primitive = this as? JsonPrimitive) {
    null -> null
    else -> primitive.intOrNull ?: primitive.longOrNull?.toInt()
}

fun JsonObject.copyWith(vararg pairs: Pair<String, JsonElement>): JsonObject {
    return JsonObject(this + pairs)
}

fun parseTimestamp(value: String): Long? {
    return value.toLongOrNull()?.let { numeric ->
        if (numeric > 10_000_000_000L) numeric else numeric * 1_000
    } ?: try {
        Instant.parse(value).toEpochMilli()
    } catch (_: DateTimeParseException) {
        null
    }
}

fun jsonString(value: String?): JsonElement = value?.let(::JsonPrimitive) ?: JsonNull

fun jsonBool(value: Boolean?): JsonElement = value?.let(::JsonPrimitive) ?: JsonNull

fun jsonInt(value: Int?): JsonElement = value?.let(::JsonPrimitive) ?: JsonNull

fun responseKey(id: JsonElement): String = when (id) {
    is JsonPrimitive -> id.content
    else -> id.toString()
}

@Serializable
data class GitRepoSyncResult(
    val isDirty: Boolean = false,
    val hasUnpushedCommits: Boolean = false,
    val hasUnpulledCommits: Boolean = false,
    val hasDiverged: Boolean = false,
    val isDetachedHead: Boolean = false,
    val branch: String? = null,
    val upstreamBranch: String? = null,
    val unstagedCount: Int = 0,
    val stagedCount: Int = 0,
    val unpushedCount: Int = 0,
    val unpulledCount: Int = 0,
    val untrackedCount: Int = 0,
    val repoRoot: String? = null,
    val state: String = "up_to_date",
    val canPush: Boolean = false,
    val repoDiffTotals: GitDiffTotals? = null,
)

@Serializable
data class GitBranchTargets(
    val branches: List<String> = emptyList(),
    val currentBranch: String = "",
    val defaultBranch: String? = null,
)

enum class TurnGitActionKind(val title: String) {
    SYNC_NOW("Update"),
    COMMIT("Commit"),
    PUSH("Push"),
    COMMIT_AND_PUSH("Commit & Push"),
    CREATE_PR("Create PR"),
    DISCARD_LOCAL_CHANGES("Discard Local Changes")
}

@Serializable
data class GitDiffTotals(
    val additions: Int,
    val deletions: Int,
    val binaryFiles: Int = 0,
) {
    val hasChanges: Boolean
        get() = additions > 0 || deletions > 0 || binaryFiles > 0
}

@Serializable
data class ContextWindowUsage(
    val tokensUsed: Int,
    val tokenLimit: Int,
) {
    val fractionUsed: Float
        get() {
            if (tokenLimit <= 0) return 0f
            return (tokensUsed.toFloat() / tokenLimit.toFloat()).coerceIn(0f, 1f)
        }

    val percentUsed: Int
        get() = (fractionUsed * 100).toInt()

    val tokensUsedFormatted: String
        get() = formatTokenCount(tokensUsed)

    val tokenLimitFormatted: String
        get() = formatTokenCount(tokenLimit)

    private fun formatTokenCount(count: Int): String {
        return when {
            count >= 1_000_000 -> {
                val value = count.toDouble() / 1_000_000.0
                String.format("%.1fM", value)
            }
            count >= 1_000 -> {
                val value = count.toDouble() / 1_000.0
                if (value % 1.0 == 0.0) {
                    "${value.toInt()}k"
                } else {
                    String.format("%.1fk", value)
                }
            }
            else -> count.toString()
        }
    }
}

enum class CodeRoverReviewTarget {
    UNCOMMITTED_CHANGES,
    BASE_BRANCH,
}

data class CodeRoverRateLimitWindow(
    val usedPercent: Int,
    val windowDurationMins: Int?,
    val resetsAtMillis: Long?,
) {
    val clampedUsedPercent: Int
        get() = usedPercent.coerceIn(0, 100)

    val remainingPercent: Int
        get() = (100 - clampedUsedPercent).coerceAtLeast(0)
}

data class CodeRoverRateLimitDisplayRow(
    val id: String,
    val label: String,
    val window: CodeRoverRateLimitWindow,
)

data class CodeRoverRateLimitBucket(
    val limitId: String,
    val limitName: String?,
    val primary: CodeRoverRateLimitWindow?,
    val secondary: CodeRoverRateLimitWindow?,
) {
    val primaryOrSecondary: CodeRoverRateLimitWindow?
        get() = primary ?: secondary

    val displayRows: List<CodeRoverRateLimitDisplayRow>
        get() {
            val rows = mutableListOf<CodeRoverRateLimitDisplayRow>()
            primary?.let { window ->
                rows += CodeRoverRateLimitDisplayRow(
                    id = "$limitId-primary",
                    label = labelFor(window, limitName ?: limitId),
                    window = window,
                )
            }
            secondary?.let { window ->
                rows += CodeRoverRateLimitDisplayRow(
                    id = "$limitId-secondary",
                    label = labelFor(window, limitName ?: limitId),
                    window = window,
                )
            }
            return rows
        }

    val sortDurationMins: Int
        get() = primaryOrSecondary?.windowDurationMins ?: Int.MAX_VALUE

    val displayLabel: String
        get() {
            durationLabel(primaryOrSecondary?.windowDurationMins)?.let { return it }
            val trimmedName = limitName?.trim()
            return if (trimmedName.isNullOrEmpty()) limitId else trimmedName
        }

    private fun labelFor(window: CodeRoverRateLimitWindow, fallback: String): String {
        return durationLabel(window.windowDurationMins) ?: fallback
    }

    private fun durationLabel(minutes: Int?): String? {
        val value = minutes?.takeIf { it > 0 } ?: return null
        val weekMinutes = 7 * 24 * 60
        val dayMinutes = 24 * 60
        return when {
            value % weekMinutes == 0 -> if (value == weekMinutes) "Weekly" else "${value / weekMinutes}w"
            value % dayMinutes == 0 -> "${value / dayMinutes}d"
            value % 60 == 0 -> "${value / 60}h"
            else -> "${value}m"
        }
    }
}

@Serializable
data class QueuedTurnDraft(
    val id: String = java.util.UUID.randomUUID().toString(),
    val text: String,
    val attachments: List<ImageAttachment> = emptyList(),
    val skillMentions: List<TurnSkillMention> = emptyList(),
    val usePlanMode: Boolean,
)
