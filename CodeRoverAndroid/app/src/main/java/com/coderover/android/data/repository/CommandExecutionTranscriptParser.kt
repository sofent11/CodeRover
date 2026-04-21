package com.coderover.android.data.repository

internal data class ParsedCommandExecutionTranscript(
    val command: String?,
    val status: String?,
    val outputText: String?,
)

internal fun parseCommandExecutionTranscript(rawText: String): ParsedCommandExecutionTranscript {
    val trimmedText = rawText.trim()
    if (trimmedText.isEmpty()) {
        return ParsedCommandExecutionTranscript(
            command = null,
            status = null,
            outputText = null,
        )
    }

    val lines = trimmedText.lines().map(String::trimEnd)
    val transcriptLines = lines.map(String::trim).filter(::isCommandTranscriptLine)
    val lastTranscriptLine = transcriptLines.lastOrNull()
    val command = lastTranscriptLine?.let(::parseTranscriptCommand)
    val status = lastTranscriptLine?.let(::parseTranscriptStatus)
        ?: parseTranscriptStatusFromMetadata(lines)

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
    val outputText = outputLines.joinToString("\n").trim().ifEmpty { null }

    return ParsedCommandExecutionTranscript(
        command = command,
        status = status,
        outputText = outputText,
    )
}

internal fun looksLikeCommandExecutionTranscript(rawText: String): Boolean {
    val trimmedText = rawText.trim()
    if (trimmedText.isEmpty()) {
        return false
    }
    val lines = trimmedText.lines().map(String::trim)
    return lines.any(::isCommandTranscriptLine) ||
        lines.any(::isCommandMetadataLine) ||
        trimmedText.startsWith("Output:", ignoreCase = true)
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
        withoutPrefix.removeSuffix(status).trim().ifEmpty { null }
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
        normalizedLines.any { it.startsWith("process running with session id") } -> "running"
        normalizedLines.any { it.startsWith("process exited with code 0") } -> "completed"
        normalizedLines.any { it.startsWith("process exited with code") } -> "failed"
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
