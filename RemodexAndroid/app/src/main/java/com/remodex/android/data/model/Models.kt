package com.remodex.android.data.model

import java.time.Instant
import java.time.format.DateTimeParseException
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
const val SECURE_HANDSHAKE_TAG = "remodex-e2ee-v1"
const val SECURE_HANDSHAKE_LABEL = "client-auth"
const val CLOCK_SKEW_TOLERANCE_MS = 60_000L

@Serializable
data class TransportCandidate(
    val kind: String,
    val url: String,
    val label: String? = null,
)

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

enum class ThreadSyncState {
    LIVE,
    ARCHIVED_LOCAL,
}

data class ThreadSummary(
    val id: String,
    val title: String? = null,
    val name: String? = null,
    val preview: String? = null,
    val createdAt: Long? = null,
    val updatedAt: Long? = null,
    val cwd: String? = null,
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
                syncState = if (json.string("syncState") == "archivedLocal") {
                    ThreadSyncState.ARCHIVED_LOCAL
                } else {
                    ThreadSyncState.LIVE
                },
            )
        }
    }
}

enum class MessageRole {
    USER,
    ASSISTANT,
    SYSTEM,
}

enum class MessageKind {
    CHAT,
    THINKING,
    FILE_CHANGE,
    COMMAND_EXECUTION,
    PLAN,
    USER_INPUT_PROMPT,
}

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

data class CommandState(
    val shortCommand: String,
    val fullCommand: String,
    val phase: CommandPhase,
    val cwd: String? = null,
    val exitCode: Int? = null,
    val durationMs: Int? = null,
    val outputTail: String = "",
)

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

data class PlanStep(
    val id: String = UUID.randomUUID().toString(),
    val step: String,
    val status: PlanStepStatus,
)

data class PlanState(
    val explanation: String? = null,
    val steps: List<PlanStep> = emptyList(),
)

data class FileChangeEntry(
    val path: String,
    val kind: String,
    val diff: String = "",
    val additions: Int? = null,
    val deletions: Int? = null,
)

data class StructuredUserInputOption(
    val id: String = UUID.randomUUID().toString(),
    val label: String,
    val description: String,
)

data class StructuredUserInputQuestion(
    val id: String,
    val header: String,
    val question: String,
    val isOther: Boolean,
    val isSecret: Boolean,
    val options: List<StructuredUserInputOption>,
)

data class StructuredUserInputRequest(
    val requestId: JsonElement,
    val questions: List<StructuredUserInputQuestion>,
)

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
    val fileChanges: List<FileChangeEntry> = emptyList(),
    val commandState: CommandState? = null,
    val planState: PlanState? = null,
    val structuredUserInputRequest: StructuredUserInputRequest? = null,
) {
    val stableStreamKey: String
        get() = itemId ?: turnId ?: "$threadId:$role:$kind"
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

data class AppState(
    val onboardingSeen: Boolean = false,
    val fontStyle: AppFontStyle = AppFontStyle.SYSTEM,
    val accessMode: AccessMode = AccessMode.ON_REQUEST,
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
    val activeTurnIdByThread: Map<String, String> = emptyMap(),
    val runningThreadIds: Set<String> = emptySet(),
    val availableModels: List<ModelOption> = emptyList(),
    val selectedModelId: String? = null,
    val selectedReasoningEffort: String? = null,
    val pendingApproval: ApprovalRequest? = null,
    val lastErrorMessage: String? = null,
    val importText: String = "",
) {
    val isConnected: Boolean
        get() = connectionPhase == ConnectionPhase.CONNECTED

    val activePairing: PairingRecord?
        get() = pairings.firstOrNull { it.macDeviceId == activePairingMacDeviceId }

    val selectedThread: ThreadSummary?
        get() = threads.firstOrNull { it.id == selectedThreadId }
}

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
