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
    val parentThreadId: String? = null,
    val agentId: String? = null,
    val agentNickname: String? = null,
    val agentRole: String? = null,
    val model: String? = null,
    val modelProvider: String? = null,
    val syncState: ThreadSyncState = ThreadSyncState.LIVE,
) {
    val displayTitle: String
        get() {
            val resolved = listOf(name, agentDisplayLabel, title, preview)
                .mapNotNull { it?.trim()?.takeIf(String::isNotEmpty) }
                .firstOrNull {
                    it.equals("Conversation", ignoreCase = true).not() || preview == it
                }
            return resolved ?: "Conversation"
        }

    val isSubagent: Boolean
        get() = !parentThreadId.isNullOrBlank()

    val preferredSubagentLabel: String?
        get() {
            if (!isSubagent) return null
            return listOf(agentDisplayLabel, name, title)
                .mapNotNull { it?.trim()?.takeIf(String::isNotEmpty) }
                .firstOrNull { !it.equals("Conversation", ignoreCase = true) }
        }

    val agentDisplayLabel: String?
        get() {
            val nickname = agentNickname?.trim()?.takeIf(String::isNotEmpty)
            val role = agentRole?.trim()?.takeIf(String::isNotEmpty)
            return when {
                nickname != null && role != null -> "$nickname [$role]"
                nickname != null -> nickname
                role != null -> role.replaceFirstChar { it.uppercase() }
                else -> null
            }
        }

    val modelDisplayLabel: String?
        get() = modelProvider?.trim()?.takeIf(String::isNotEmpty)
            ?: model?.trim()?.takeIf(String::isNotEmpty)

    val normalizedProjectPath: String?
        get() = cwd?.trim()?.trimEnd('/')?.takeIf(String::isNotEmpty)

    val isManagedWorktreeProject: Boolean
        get() = managedWorktreeToken(normalizedProjectPath) != null

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

    private fun managedWorktreeToken(normalizedProjectPath: String?): String? {
        val path = normalizedProjectPath ?: return null
        val components = path.split('/').filter(String::isNotEmpty)
        val worktreesIndex = components.indexOf("worktrees")
        if (worktreesIndex <= 0 || components.getOrNull(worktreesIndex - 1) != ".coderover") {
            return null
        }
        return components.getOrNull(worktreesIndex + 1)?.trim()?.takeIf(String::isNotEmpty)
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
                parentThreadId = firstNonBlank(
                    json.string("parentThreadId"),
                    json.string("parent_thread_id"),
                    json["metadata"]?.jsonObjectOrNull()?.string("parentThreadId"),
                    json["metadata"]?.jsonObjectOrNull()?.string("parent_thread_id"),
                ),
                agentId = firstNonBlank(
                    json.string("agentId"),
                    json.string("agent_id"),
                    json["metadata"]?.jsonObjectOrNull()?.string("agentId"),
                    json["metadata"]?.jsonObjectOrNull()?.string("agent_id"),
                ),
                agentNickname = firstNonBlank(
                    json.string("agentNickname"),
                    json.string("agent_nickname"),
                    json["metadata"]?.jsonObjectOrNull()?.string("agentNickname"),
                    json["metadata"]?.jsonObjectOrNull()?.string("agent_nickname"),
                    json["metadata"]?.jsonObjectOrNull()?.string("nickname"),
                    json["metadata"]?.jsonObjectOrNull()?.string("name"),
                ),
                agentRole = firstNonBlank(
                    json.string("agentRole"),
                    json.string("agent_role"),
                    json["metadata"]?.jsonObjectOrNull()?.string("agentRole"),
                    json["metadata"]?.jsonObjectOrNull()?.string("agent_role"),
                    json["metadata"]?.jsonObjectOrNull()?.string("agentType"),
                    json["metadata"]?.jsonObjectOrNull()?.string("agent_type"),
                ),
                model = firstNonBlank(
                    json.string("model"),
                    json["metadata"]?.jsonObjectOrNull()?.string("model"),
                    json["metadata"]?.jsonObjectOrNull()?.string("modelName"),
                    json["metadata"]?.jsonObjectOrNull()?.string("model_name"),
                ),
                modelProvider = firstNonBlank(
                    json.string("modelProvider"),
                    json.string("model_provider"),
                    json["metadata"]?.jsonObjectOrNull()?.string("modelProvider"),
                    json["metadata"]?.jsonObjectOrNull()?.string("model_provider"),
                    json["metadata"]?.jsonObjectOrNull()?.string("modelProviderId"),
                    json["metadata"]?.jsonObjectOrNull()?.string("model_provider_id"),
                ),
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
    SUBAGENT_ACTION,
    PLAN,
    USER_INPUT_PROMPT,
}

@Serializable
data class SubagentRef(
    val threadId: String,
    val agentId: String? = null,
    val nickname: String? = null,
    val role: String? = null,
    val model: String? = null,
    val prompt: String? = null,
)

@Serializable
data class SubagentState(
    val threadId: String,
    val status: String,
    val message: String? = null,
)

@Serializable
data class SubagentThreadPresentation(
    val threadId: String,
    val agentId: String? = null,
    val nickname: String? = null,
    val role: String? = null,
    val model: String? = null,
    val modelIsRequestedHint: Boolean = false,
    val prompt: String? = null,
    val fallbackStatus: String? = null,
    val fallbackMessage: String? = null,
) {
    val displayLabel: String
        get() {
            val trimmedNickname = nickname?.trim()?.takeIf(String::isNotEmpty)
            val trimmedRole = role?.trim()?.takeIf(String::isNotEmpty)
            return when {
                trimmedNickname != null && trimmedRole != null -> "$trimmedNickname [$trimmedRole]"
                trimmedNickname != null -> trimmedNickname
                trimmedRole != null -> trimmedRole.replaceFirstChar { it.uppercase() }
                else -> "Agent"
            }
        }
}

@Serializable
data class SubagentAction(
    val tool: String,
    val status: String,
    val prompt: String? = null,
    val model: String? = null,
    val receiverThreadIds: List<String> = emptyList(),
    val receiverAgents: List<SubagentRef> = emptyList(),
    val agentStates: Map<String, SubagentState> = emptyMap(),
) {
    val normalizedTool: String
        get() = tool.trim().lowercase().replace("_", "").replace("-", "")

    val agentRows: List<SubagentThreadPresentation>
        get() {
            val orderedThreadIds = buildList {
                receiverThreadIds.forEach { if (it !in this) add(it) }
                receiverAgents.map(SubagentRef::threadId).forEach { if (it !in this) add(it) }
                agentStates.keys.sorted().forEach { if (it !in this) add(it) }
            }
            return orderedThreadIds.map { threadId ->
                val matchingAgent = receiverAgents.firstOrNull { it.threadId == threadId }
                val matchingState = agentStates[threadId]
                SubagentThreadPresentation(
                    threadId = threadId,
                    agentId = matchingAgent?.agentId,
                    nickname = matchingAgent?.nickname,
                    role = matchingAgent?.role,
                    model = matchingAgent?.model ?: model,
                    modelIsRequestedHint = matchingAgent?.model == null && model != null,
                    prompt = matchingAgent?.prompt,
                    fallbackStatus = matchingState?.status,
                    fallbackMessage = matchingState?.message,
                )
            }
        }

    val summaryText: String
        get() {
            val count = maxOf(1, receiverThreadIds.size, receiverAgents.size, agentRows.size)
            val noun = if (count == 1) "agent" else "agents"
            return when (normalizedTool) {
                "spawnagent" -> "Spawning $count $noun"
                "wait", "waitagent" -> "Waiting on $count $noun"
                "sendinput" -> "Sending input to $count $noun"
                "resumeagent" -> "Resuming $count $noun"
                "closeagent" -> "Closing $count $noun"
                else -> "Coordinating $count $noun"
            }
        }
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
    val subagentAction: SubagentAction? = null,
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

data class BridgeVersionSupport(
    val minimumVersion: String? = null,
    val maximumVersion: String? = null,
    val recommendedVersion: String? = null,
) {
    val displayLabel: String
        get() = when {
            minimumVersion != null && maximumVersion != null -> "$minimumVersion - $maximumVersion"
            minimumVersion != null -> "$minimumVersion+"
            recommendedVersion != null -> recommendedVersion
            else -> "Unknown"
        }

    companion object {
        fun fromJson(json: JsonObject?): BridgeVersionSupport? {
            if (json == null) {
                return null
            }
            return BridgeVersionSupport(
                minimumVersion = json.string("minimumVersion"),
                maximumVersion = json.string("maximumVersion"),
                recommendedVersion = json.string("recommendedVersion"),
            )
        }
    }
}

data class BridgeMobileSupportMatrix(
    val ios: BridgeVersionSupport? = null,
    val android: BridgeVersionSupport? = null,
) {
    companion object {
        fun fromJson(json: JsonObject?): BridgeMobileSupportMatrix? {
            if (json == null) {
                return null
            }
            return BridgeMobileSupportMatrix(
                ios = BridgeVersionSupport.fromJson(json["ios"]?.jsonObjectOrNull()),
                android = BridgeVersionSupport.fromJson(json["android"]?.jsonObjectOrNull()),
            )
        }
    }
}

data class BridgeStatus(
    val bridgeVersion: String? = null,
    val bridgeLatestVersion: String? = null,
    val updateAvailable: Boolean = false,
    val upgradeCommand: String? = null,
    val keepAwakeEnabled: Boolean = false,
    val keepAwakeActive: Boolean = false,
    val trustedDeviceCount: Int = 0,
    val trustedDeviceStatus: String? = null,
    val supportedMobileVersions: BridgeMobileSupportMatrix? = null,
) {
    val bridgeVersionLabel: String
        get() = bridgeVersion ?: "Unavailable"

    val latestVersionLabel: String
        get() = bridgeLatestVersion ?: "Unavailable"

    companion object {
        fun fromJson(json: JsonObject): BridgeStatus {
            val preferences = json["preferences"]?.jsonObjectOrNull()
            return BridgeStatus(
                bridgeVersion = json.string("bridgeVersion"),
                bridgeLatestVersion = json.string("bridgeLatestVersion"),
                updateAvailable = json.bool("updateAvailable") ?: false,
                upgradeCommand = json.string("upgradeCommand"),
                keepAwakeEnabled = json.bool("keepAwakeEnabled")
                    ?: preferences?.bool("keepAwakeEnabled")
                    ?: false,
                keepAwakeActive = json.bool("keepAwakeActive") ?: false,
                trustedDeviceCount = json.int("trustedDeviceCount") ?: 0,
                trustedDeviceStatus = json.string("trustedDeviceStatus"),
                supportedMobileVersions = BridgeMobileSupportMatrix.fromJson(
                    json["supportedMobileVersions"]?.jsonObjectOrNull()
                ),
            )
        }
    }
}

data class BridgeUpdatePrompt(
    val shouldPrompt: Boolean = false,
    val kind: String = "none",
    val title: String? = null,
    val message: String? = null,
    val bridgeVersion: String? = null,
    val bridgeLatestVersion: String? = null,
    val upgradeCommand: String? = null,
) {
    val id: String
        get() = listOf(
            kind,
            bridgeVersion ?: "bridge",
            bridgeLatestVersion ?: "latest",
        ).joinToString(":")

    companion object {
        fun fromJson(json: JsonObject): BridgeUpdatePrompt {
            return BridgeUpdatePrompt(
                shouldPrompt = json.bool("shouldPrompt") ?: false,
                kind = json.string("kind") ?: "none",
                title = json.string("title"),
                message = json.string("message"),
                bridgeVersion = json.string("bridgeVersion"),
                bridgeLatestVersion = json.string("bridgeLatestVersion"),
                upgradeCommand = json.string("upgradeCommand"),
            )
        }
    }
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
    val pendingApprovals: List<ApprovalRequest> = emptyList(),
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
    val bridgeStatus: BridgeStatus? = null,
    val bridgeUpdatePrompt: BridgeUpdatePrompt? = null,
    val isLoadingBridgeStatus: Boolean = false,
    val lastPresentedWhatsNewVersion: String? = null,
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

    val pendingApproval: ApprovalRequest?
        get() = pendingApprovals.firstOrNull()

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
data class GitChangedFile(
    val path: String,
    val status: String = "",
)

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
    val localOnlyCommitCount: Int = 0,
    val repoRoot: String? = null,
    val state: String = "up_to_date",
    val canPush: Boolean = false,
    val isPublishedToRemote: Boolean = false,
    val files: List<GitChangedFile> = emptyList(),
    val repoDiffTotals: GitDiffTotals? = null,
)

@Serializable
data class GitBranchTargets(
    val branches: List<String> = emptyList(),
    val branchesCheckedOutElsewhere: Set<String> = emptySet(),
    val worktreePathByBranch: Map<String, String> = emptyMap(),
    val localCheckoutPath: String? = null,
    val currentBranch: String = "",
    val defaultBranch: String? = null,
)

enum class GitWorktreeChangeTransferMode(val wireValue: String) {
    MOVE("move"),
    COPY("copy"),
    NONE("none"),
}

@Serializable
data class GitCreateManagedWorktreeResult(
    val worktreePath: String,
    val alreadyExisted: Boolean = false,
    val baseBranch: String = "",
    val headMode: String = "",
    val transferredChanges: Boolean = false,
)

@Serializable
data class GitManagedHandoffTransferResult(
    val success: Boolean = false,
    val targetPath: String? = null,
    val transferredChanges: Boolean = false,
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

private fun firstNonBlank(vararg values: String?): String? {
    return values.firstOrNull { !it.isNullOrBlank() }?.trim()
}
