package com.coderover.android.ui.turn

import com.coderover.android.data.model.ChatMessage
import com.coderover.android.data.model.CommandPhase

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

internal fun buildCommandDetail(
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

internal fun parseCommandPreview(text: String, isStreaming: Boolean): CommandPreviewUi {
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
