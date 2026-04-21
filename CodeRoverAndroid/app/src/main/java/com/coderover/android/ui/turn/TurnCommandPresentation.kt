package com.coderover.android.ui.turn

import com.coderover.android.data.model.ChatMessage
import com.coderover.android.data.model.CommandPhase
import com.coderover.android.data.model.MessageKind

internal data class CommandPreviewUi(
    val command: String?,
    val outputLines: List<String>,
    val statusLabel: String,
)

internal data class CommandDetailUi(
    val command: String?,
    val statusLabel: String,
    val cwd: String?,
    val exitCode: Int?,
    val durationMs: Int?,
    val outputSections: List<CommandOutputSectionUi>,
    val fallbackBody: String,
)

internal data class CommandOutputSectionUi(
    val title: String?,
    val lines: List<CommandOutputLineUi>,
)

internal data class CommandOutputLineUi(
    val text: String,
    val kind: CommandOutputLineKind,
)

internal enum class CommandOutputLineKind {
    STANDARD,
    META,
    WARNING,
    ERROR,
}

internal fun buildCommandOutputDetailText(message: ChatMessage): String {
    val commandState = message.commandState
    if (commandState == null) {
        return message.text.trim()
    }
    return buildString {
        append(commandPhaseStatusLabel(commandState.phase))
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

internal fun buildCommandDetail(
    message: ChatMessage,
    preview: CommandPreviewUi,
): CommandDetailUi {
    val commandState = message.commandState
    val transcript = parseCommandTranscriptPreview(message.text, message.isStreaming)
    val fallbackBody = transcript?.let { buildTranscriptFallbackBody(preview, it) } ?: buildCommandOutputDetailText(message)
    if (commandState == null) {
        val detailText = transcript?.detailText ?: message.text.trim()
        val lines = detailText
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
        statusLabel = commandPhaseStatusLabel(commandState.phase),
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

internal fun parseCommandPreview(text: String, isStreaming: Boolean): CommandPreviewUi {
    parseCommandTranscriptPreview(text, isStreaming)?.let { transcript ->
        return CommandPreviewUi(
            command = transcript.command,
            outputLines = transcript.detailText.lines().take(4),
            statusLabel = transcript.statusLabel,
        )
    }
    val lines = text.lines().map(String::trimEnd).filter(String::isNotBlank)
    val command = lines.firstOrNull()?.take(220)
    val output = lines.drop(if (command == null) 0 else 1).take(4)
    val lowered = text.lowercase()
    val status = when {
        isStreaming -> commandPhaseStatusLabel(CommandPhase.RUNNING)
        lowered.contains("stopped") -> commandPhaseStatusLabel(CommandPhase.STOPPED)
        lowered.contains("error") || lowered.contains("failed") || lowered.contains("exit code") -> commandPhaseStatusLabel(CommandPhase.FAILED)
        else -> commandPhaseStatusLabel(CommandPhase.COMPLETED)
    }
    return CommandPreviewUi(
        command = command,
        outputLines = output,
        statusLabel = status,
    )
}

internal fun isCommandTranscriptMessage(message: ChatMessage): Boolean {
    return message.kind == MessageKind.CHAT && parseCommandTranscriptPreview(message.text, message.isStreaming) != null
}

internal fun isCommandCompletionPlaceholder(message: ChatMessage): Boolean {
    return message.kind == MessageKind.COMMAND_EXECUTION &&
        message.commandState == null &&
        message.text.trim().equals("Completed command", ignoreCase = true)
}

private data class ParsedCommandTranscriptUi(
    val command: String?,
    val statusLabel: String,
    val detailText: String,
)

private fun parseCommandTranscriptPreview(text: String, isStreaming: Boolean): ParsedCommandTranscriptUi? {
    val trimmedText = text.trim()
    if (trimmedText.isEmpty()) {
        return null
    }
    val lines = trimmedText.lines().map(String::trimEnd)
    val transcriptLines = lines.map(String::trim).filter(::isCommandTranscriptLine)
    val lastTranscriptLine = transcriptLines.lastOrNull()
    val hasMetadata = lines.any { line -> isCommandMetadataLine(line) }
    if (lastTranscriptLine == null && !hasMetadata) {
        return null
    }
    val command = lastTranscriptLine?.let(::parseTranscriptCommand)
    val metadataStatus = parseTranscriptStatusFromMetadata(lines)
    val status = lastTranscriptLine?.let(::parseTranscriptStatus)
        ?: metadataStatus
        ?: if (isStreaming) commandPhaseStatusLabel(CommandPhase.RUNNING) else commandPhaseStatusLabel(CommandPhase.COMPLETED)
    val detailText = buildTranscriptDetailText(lines) ?: return null
    return ParsedCommandTranscriptUi(
        command = command ?: "command",
        statusLabel = status,
        detailText = detailText,
    )
}

private fun buildTranscriptDetailText(lines: List<String>): String? {
    val outputStartIndex = lines.indexOfFirst { it.trim().equals("Output:", ignoreCase = true) }
    val candidateOutputLines = when {
        outputStartIndex >= 0 -> lines.drop(outputStartIndex + 1)
        else -> lines
    }
    val outputLines = candidateOutputLines
        .dropWhile { line ->
            val trimmed = line.trim()
            trimmed.isEmpty() || isCommandTranscriptLine(trimmed) || isCommandMetadataLine(trimmed)
        }
        .filterNot { line -> isCommandMetadataLine(line.trim()) }
    return outputLines.joinToString("\n").trim().ifEmpty { null }
}

private fun buildTranscriptFallbackBody(
    preview: CommandPreviewUi,
    transcript: ParsedCommandTranscriptUi,
): String {
    return buildString {
        append(preview.statusLabel)
        append(" ")
        append(preview.command ?: transcript.command ?: "command")
        if (transcript.detailText.isNotBlank()) {
            append("\n\n")
            append(transcript.detailText)
        }
    }
}

private fun parseTranscriptCommand(line: String): String? {
    val trimmed = line.trim()
    val withoutPrefix = COMMAND_TRANSCRIPT_PREFIXES
        .firstNotNullOfOrNull { prefix ->
            trimmed.removePrefix(prefix).takeIf { it != trimmed }
        }
        ?.trim()
        ?: return null
    val status = parseTranscriptStatus(trimmed)
    return if (status != null && withoutPrefix.endsWith(status, ignoreCase = true)) {
        withoutPrefix.dropLast(status.length).trim().ifEmpty { null }
    } else {
        withoutPrefix.ifEmpty { null }
    }
}

private fun parseTranscriptStatus(line: String): String? {
    val trimmed = line.trim().lowercase()
    return COMMAND_TRANSCRIPT_STATUSES.firstOrNull { status -> trimmed.endsWith(status) }
}

private fun parseTranscriptStatusFromMetadata(lines: List<String>): String? {
    val normalizedLines = lines.map { it.trim().lowercase() }
    return when {
        normalizedLines.any { it.startsWith("process running with session id") } -> commandPhaseStatusLabel(CommandPhase.RUNNING)
        normalizedLines.any { it.startsWith("process exited with code 0") } -> commandPhaseStatusLabel(CommandPhase.COMPLETED)
        normalizedLines.any { it.startsWith("process exited with code") } -> commandPhaseStatusLabel(CommandPhase.FAILED)
        else -> null
    }
}

private fun isCommandTranscriptLine(line: String): Boolean {
    val trimmed = line.trim()
    return COMMAND_TRANSCRIPT_PREFIXES.any(trimmed::startsWith)
}

private fun isCommandMetadataLine(line: String): Boolean {
    val normalized = line.trim().lowercase()
    return normalized == "output:" || COMMAND_METADATA_PREFIXES.any(normalized::startsWith)
}

private val COMMAND_TRANSCRIPT_PREFIXES = listOf("| <>", "|<", "<>")
private val COMMAND_TRANSCRIPT_STATUSES = listOf("running", "completed", "failed", "stopped")
private val COMMAND_METADATA_PREFIXES = listOf(
    "chunk id:",
    "wall time:",
    "process running with session id",
    "process exited with code",
    "original token count:",
)

internal fun commandPhaseStatusLabel(phase: CommandPhase): String {
    return when (phase) {
        CommandPhase.RUNNING -> "running"
        CommandPhase.COMPLETED -> "completed"
        CommandPhase.FAILED -> "failed"
        CommandPhase.STOPPED -> "stopped"
    }
}
