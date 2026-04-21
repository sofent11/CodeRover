package com.coderover.android.ui.turn

import com.coderover.android.data.model.ChatMessage

internal data class DiffFileDetailUi(
    val path: String,
    val actionLabel: String,
    val additions: Int,
    val deletions: Int,
    val hunks: List<DiffHunkUi>,
    val rawBody: String,
)

internal data class DiffHunkUi(
    val header: String?,
    val lines: List<DiffLineUi>,
)

internal data class DiffLineUi(
    val text: String,
    val kind: DiffLineKind,
)

internal enum class DiffLineKind {
    ADDED,
    REMOVED,
    CONTEXT,
    META,
}

private class MutableDiffFileDetail(
    var path: String,
    var actionLabel: String,
    val rawLines: MutableList<String> = mutableListOf(),
)

internal fun buildDiffDetailFiles(message: ChatMessage): List<DiffFileDetailUi> {
    if (message.fileChanges.isNotEmpty()) {
        val fileChangeDetails = message.fileChanges.map { change ->
            val hunks = parseDiffHunks(change.diff)
            val (additions, deletions) = resolveDiffCounts(
                additions = change.additions,
                deletions = change.deletions,
                rawDiff = change.diff,
                parsedHunks = hunks,
            )
            DiffFileDetailUi(
                path = change.path,
                actionLabel = fileChangeActionLabel(change.kind),
                additions = additions,
                deletions = deletions,
                hunks = hunks,
                rawBody = change.diff.trim(),
            )
        }
        val parsedTextDetails = parseDiffDetailFiles(message.text)
        return if (
            parsedTextDetails.isNotEmpty() &&
            fileChangeDetails.all { it.additions == 0 && it.deletions == 0 && it.rawBody.isBlank() }
        ) {
            parsedTextDetails
        } else {
            fileChangeDetails
        }
    }
    return parseDiffDetailFiles(message.text)
}

internal fun buildRepositoryDiffFiles(rawPatch: String): List<DiffFileDetailUi> {
    return parseDiffDetailFiles(rawPatch)
}

private fun parseDiffDetailFiles(text: String): List<DiffFileDetailUi> {
    val structuredSections = parseStructuredFileChangeSections(text)
    if (structuredSections.isNotEmpty()) {
        return structuredSections.map { section ->
            val hunks = parseDiffHunks(section.diffBody)
            val (additions, deletions) = resolveDiffCounts(
                additions = section.additions,
                deletions = section.deletions,
                rawDiff = section.diffBody,
                parsedHunks = hunks,
            )
            DiffFileDetailUi(
                path = section.path,
                actionLabel = section.actionLabel,
                additions = additions,
                deletions = deletions,
                hunks = hunks,
                rawBody = section.diffBody,
            )
        }
    }
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

            else -> current?.rawLines?.add(line)
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

internal fun resolveDiffCounts(
    additions: Int?,
    deletions: Int?,
    rawDiff: String,
    parsedHunks: List<DiffHunkUi>? = null,
): Pair<Int, Int> {
    if (additions != null && deletions != null) {
        return additions to deletions
    }
    val hunks = parsedHunks ?: parseDiffHunks(rawDiff)
    return (additions ?: countDiffLines(hunks, DiffLineKind.ADDED)) to
        (deletions ?: countDiffLines(hunks, DiffLineKind.REMOVED))
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

internal fun buildDiffDetailText(message: ChatMessage): String {
    if (message.fileChanges.isNotEmpty()) {
        return message.fileChanges.joinToString("\n\n") { change ->
            val (additions, deletions) = resolveDiffCounts(
                additions = change.additions,
                deletions = change.deletions,
                rawDiff = change.diff,
            )
            buildString {
                append(fileChangeActionLabel(change.kind))
                append(" ")
                append(change.path)
                if (additions > 0 || deletions > 0) {
                    append("  (+")
                    append(additions)
                    append(" -")
                    append(deletions)
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
