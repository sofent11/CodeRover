package com.coderover.android.ui.turn

internal data class FileChangeEntryUi(
    val path: String,
    val actionLabel: String,
    val additions: Int,
    val deletions: Int,
)

internal data class FileChangeGroupUi(
    val actionLabel: String,
    val entries: List<FileChangeEntryUi>,
)

internal data class StructuredFileChangeSectionUi(
    val path: String,
    val actionLabel: String,
    val additions: Int,
    val deletions: Int,
    val diffBody: String,
)

private val INLINE_ACTION_REGEX = Regex("(?i)^(edited|updated|patched|modified|added|created|deleted|removed|renamed|moved)\\s+(.+?)$")
private val INLINE_TOTALS_REGEX = Regex("[+＋]\\s*(\\d+)\\s*[-−–—﹣－]\\s*(\\d+)")
private val TRAILING_INLINE_TOTALS_REGEX = Regex("\\s*[+＋]\\s*\\d+\\s*[-−–—﹣－]\\s*\\d+\\s*$")
private val TRAILING_LINE_COLUMN_REGEX = Regex(":\\d+(?::\\d+)?$")
private val FILE_LIKE_TOKEN_REGEX = Regex("[A-Za-z0-9_+.-]+\\.[A-Za-z0-9]+$")
private val INLINE_EDITING_ROW_REGEX = Regex(
    "(?i)^(edited|updated|patched|modified|added|created|deleted|removed|renamed|moved)\\s+.+\\s+[+＋]\\s*\\d+\\s*[-−–—﹣－]\\s*\\d+\\s*$",
)
private val COLLAPSIBLE_NEWLINES_REGEX = Regex("\\n{3,}")

private class MutableFileChangeEntry(
    var path: String,
    var actionLabel: String,
    var additions: Int = 0,
    var deletions: Int = 0,
)

internal fun parseFileChangeEntries(text: String): List<FileChangeEntryUi> {
    val structuredSections = parseStructuredFileChangeSections(text)
    if (structuredSections.isNotEmpty()) {
        return structuredSections.map { section ->
            FileChangeEntryUi(
                path = section.path,
                actionLabel = section.actionLabel,
                additions = section.additions,
                deletions = section.deletions,
            )
        }
    }
    val lines = text.lines()
    val entries = linkedMapOf<String, MutableFileChangeEntry>()
    var currentKey: String? = null

    fun upsert(path: String, actionLabel: String) {
        val normalizedPath = path.trim().removePrefix("a/").removePrefix("b/")
        if (normalizedPath.isEmpty()) {
            return
        }
        val existing = entries[normalizedPath]
        if (existing == null) {
            entries[normalizedPath] = MutableFileChangeEntry(
                path = normalizedPath,
                actionLabel = actionLabel,
            )
        } else if (existing.actionLabel == "Changed" && actionLabel != "Changed") {
            existing.actionLabel = actionLabel
        }
        currentKey = normalizedPath
    }

    lines.forEach { rawLine ->
        val line = rawLine.trimEnd()
        when {
            line.startsWith("*** Add File: ") -> upsert(line.removePrefix("*** Add File: "), "Added")
            line.startsWith("*** Update File: ") -> upsert(line.removePrefix("*** Update File: "), "Updated")
            line.startsWith("*** Delete File: ") -> upsert(line.removePrefix("*** Delete File: "), "Deleted")
            line.startsWith("*** Move to: ") -> {
                val movedTo = line.removePrefix("*** Move to: ").trim()
                val previousKey = currentKey
                if (!previousKey.isNullOrBlank()) {
                    val previous = entries.remove(previousKey)
                    if (previous != null) {
                        previous.path = movedTo
                        previous.actionLabel = "Moved"
                        entries[movedTo] = previous
                    } else {
                        upsert(movedTo, "Moved")
                    }
                    currentKey = movedTo
                } else {
                    upsert(movedTo, "Moved")
                }
            }

            line.startsWith("diff --git ") -> {
                val match = Regex("""diff --git a/(.+) b/(.+)""").find(line)
                val path = match?.groupValues?.getOrNull(2)
                if (path != null) {
                    upsert(path, "Changed")
                }
            }

            line.startsWith("+++ b/") -> upsert(line.removePrefix("+++ b/"), "Changed")
            line.startsWith("Added ") || line.startsWith("Updated ") || line.startsWith("Modified ") ||
                line.startsWith("Patched ") || line.startsWith("Deleted ") || line.startsWith("Created ") ||
                line.startsWith("Renamed ") || line.startsWith("Edited ") || line.startsWith("Removed ") ||
                line.startsWith("Moved ") -> {
                val parts = line.split(' ', limit = 2)
                val action = parts.firstOrNull().orEmpty()
                val path = parts.getOrNull(1)
                    ?.substringBefore(" (+")
                    ?.substringBefore(" (-")
                    ?.substringBefore(" +")
                    ?.substringBefore(" -")
                    ?.trim()
                    .orEmpty()
                val normalizedAction = when (action) {
                    "Modified" -> "Updated"
                    "Patched" -> "Updated"
                    "Created" -> "Added"
                    "Renamed" -> "Moved"
                    "Edited" -> "Updated"
                    "Removed" -> "Deleted"
                    else -> action
                }
                upsert(path, normalizedAction)
                INLINE_TOTALS_REGEX.find(line)?.let { totals ->
                    entries[path]?.additions = totals.groupValues.getOrNull(1)?.toIntOrNull() ?: 0
                    entries[path]?.deletions = totals.groupValues.getOrNull(2)?.toIntOrNull() ?: 0
                }
            }

            currentKey != null && line.startsWith("+") && !line.startsWith("+++") -> {
                entries[currentKey]?.additions = (entries[currentKey]?.additions ?: 0) + 1
            }

            currentKey != null && line.startsWith("-") && !line.startsWith("---") -> {
                entries[currentKey]?.deletions = (entries[currentKey]?.deletions ?: 0) + 1
            }

            else -> {
                val inlineEntry = parseInlineFileEntry(line)
                if (inlineEntry != null) {
                    upsert(inlineEntry.path, inlineEntry.actionLabel)
                    inlineEntry.additions?.let { additions ->
                        entries[inlineEntry.path]?.additions = additions
                    }
                    inlineEntry.deletions?.let { deletions ->
                        entries[inlineEntry.path]?.deletions = deletions
                    }
                }
            }
        }
    }

    return entries.values.map { entry ->
        FileChangeEntryUi(
            path = entry.path,
            actionLabel = entry.actionLabel,
            additions = entry.additions,
            deletions = entry.deletions,
        )
    }
}

internal fun fileChangeActionLabel(kind: String): String {
    return when (kind.trim().lowercase()) {
        "create", "created", "add", "added" -> "Added"
        "delete", "deleted", "remove", "removed" -> "Deleted"
        "rename", "renamed", "move", "moved" -> "Moved"
        "patch", "patched", "edit", "edited", "update", "updated", "modify", "modified", "change", "changed" -> "Updated"
        else -> "Updated"
    }
}

internal fun groupFileChangeEntries(entries: List<FileChangeEntryUi>): List<FileChangeGroupUi> {
    val order = mutableListOf<String>()
    val grouped = linkedMapOf<String, MutableList<FileChangeEntryUi>>()
    entries.forEach { entry ->
        if (grouped[entry.actionLabel] == null) {
            order += entry.actionLabel
            grouped[entry.actionLabel] = mutableListOf()
        }
        grouped.getValue(entry.actionLabel) += entry
    }
    return order.map { key -> FileChangeGroupUi(actionLabel = key, entries = grouped.getValue(key)) }
}

internal fun fileChangeDedupeKey(text: String): String? {
    val entries = parseFileChangeEntries(text)
    if (entries.isNotEmpty()) {
        return entries
            .sortedBy(FileChangeEntryUi::path)
            .joinToString(separator = "||") { entry ->
                "${entry.path}|${entry.actionLabel}|+${entry.additions}|-${entry.deletions}"
            }
    }
    val normalized = text.trim().replace("\r\n", "\n")
    return normalized.ifEmpty { null }
}

internal fun removeInlineEditingRows(text: String): String {
    val filtered = text
        .lines()
        .filterNot(::isInlineEditingRow)
        .joinToString("\n")
    return filtered
        .replace(COLLAPSIBLE_NEWLINES_REGEX, "\n\n")
        .trim()
}

private fun isInlineEditingRow(line: String): Boolean {
    val trimmed = line.trim()
    return trimmed.isNotEmpty() && INLINE_EDITING_ROW_REGEX.matches(trimmed)
}

private data class InlineFileEntry(
    val path: String,
    val actionLabel: String,
    val additions: Int?,
    val deletions: Int?,
)

private fun parseInlineFileEntry(line: String): InlineFileEntry? {
    var candidate = line.trim()
    if (candidate.startsWith("- ") || candidate.startsWith("* ")) {
        candidate = candidate.drop(2)
    } else if (candidate.startsWith("• ")) {
        candidate = candidate.drop(2)
    }
    candidate = candidate.replace("`", "").trim()
    if (candidate.isEmpty()) {
        return null
    }

    val totals = INLINE_TOTALS_REGEX.find(candidate)
    val additions = totals?.groupValues?.getOrNull(1)?.toIntOrNull()
    val deletions = totals?.groupValues?.getOrNull(2)?.toIntOrNull()
    val withoutTotals = when {
        totals != null -> candidate.removeRange(totals.range.first, candidate.length).trim()
        else -> candidate.replace(TRAILING_INLINE_TOTALS_REGEX, "").trim()
    }

    val actionMatch = INLINE_ACTION_REGEX.matchEntire(withoutTotals)
    if (actionMatch != null) {
        val action = actionMatch.groupValues[1]
        val rawPath = actionMatch.groupValues[2]
        val normalizedPath = normalizeInlinePath(rawPath)
        if (!looksLikePath(normalizedPath)) {
            return null
        }
        return InlineFileEntry(
            path = normalizedPath,
            actionLabel = fileChangeActionLabel(action),
            additions = additions,
            deletions = deletions,
        )
    }

    if (totals != null) {
        val rawPath = withoutTotals.substringBefore(' ').trim()
        val normalizedPath = normalizeInlinePath(rawPath)
        if (looksLikePath(normalizedPath)) {
            return InlineFileEntry(
                path = normalizedPath,
                actionLabel = "Updated",
                additions = additions,
                deletions = deletions,
            )
        }
    }

    return null
}

private fun normalizeInlinePath(rawToken: String): String {
    var token = rawToken.trim().replace("\"", "").replace("'", "")
    if (token.contains(" ")) {
        token = token.substringBefore(' ')
    }
    while (token.lastOrNull() in listOf(',', '.', ';', ')')) {
        token = token.dropLast(1)
    }
    if (token.startsWith("(")) {
        token = token.drop(1)
    }
    token = token.replace(TRAILING_LINE_COLUMN_REGEX, "")
    return token
}

private fun looksLikePath(token: String): Boolean {
    if (token.isBlank()) {
        return false
    }
    if (token.contains("/") || token.startsWith("./") || token.startsWith("../")) {
        return true
    }
    return FILE_LIKE_TOKEN_REGEX.matches(token)
}

internal fun parseStructuredFileChangeSections(text: String): List<StructuredFileChangeSectionUi> {
    val normalizedText = text.trim()
    if (normalizedText.isEmpty()) {
        return emptyList()
    }

    val separatedSections = normalizedText.split("\n\n---\n\n")
    if (separatedSections.size > 1) {
        return separatedSections.mapNotNull { section ->
            parseStructuredFileChangeSection(section.lines())
        }
    }

    val lines = normalizedText.lines()
    val sections = mutableListOf<StructuredFileChangeSectionUi>()
    val currentLines = mutableListOf<String>()

    fun flushCurrent() {
        parseStructuredFileChangeSection(currentLines.toList())?.let(sections::add)
        currentLines.clear()
    }

    lines.forEach { line ->
        if (isStructuredPathLine(line.trim()) &&
            currentLines.any { existing ->
                isStructuredPathLine(existing.trim()) || existing.trim().startsWith("```")
            }
        ) {
            flushCurrent()
        }
        currentLines += line
    }
    flushCurrent()

    return sections
}

private fun parseStructuredFileChangeSection(lines: List<String>): StructuredFileChangeSectionUi? {
    if (lines.isEmpty()) {
        return null
    }

    val diffBody = extractStructuredFencedCode(lines)
        ?.trim()
        ?.takeIf(TurnDiffLineKind.Companion::detectVerifiedPatch)
        .orEmpty()
    val path = extractStructuredPath(lines)
        ?: extractStructuredPathFromDiff(diffBody)
        ?: return null
    val normalizedPath = path.trim().removePrefix("a/").removePrefix("b/")
    if (normalizedPath.isEmpty()) {
        return null
    }

    val totals = extractStructuredTotals(lines)
        ?: if (diffBody.isNotEmpty()) countStructuredDiffLines(diffBody.lines()) else (0 to 0)
    val actionLabel = extractStructuredKind(lines)
        ?: if (diffBody.isNotEmpty()) detectStructuredActionFromDiff(diffBody.lines()) else "Updated"

    return StructuredFileChangeSectionUi(
        path = normalizedPath,
        actionLabel = actionLabel,
        additions = totals.first,
        deletions = totals.second,
        diffBody = diffBody,
    )
}

private fun isStructuredPathLine(line: String): Boolean {
    return line.startsWith("Path:") || line.startsWith("**Path:**")
}

private fun extractStructuredPath(lines: List<String>): String? {
    lines.forEach { line ->
        val trimmed = line.trim()
        if (trimmed.startsWith("Path:") || trimmed.startsWith("**Path:**")) {
            return trimmed
                .removePrefix("**Path:**")
                .removePrefix("Path:")
                .trim()
                .trim('`')
                .takeIf(String::isNotEmpty)
        }
    }
    return null
}

private fun extractStructuredKind(lines: List<String>): String? {
    lines.forEach { line ->
        val trimmed = line.trim()
        if (trimmed.startsWith("Kind:", ignoreCase = true) || trimmed.startsWith("**Kind:**", ignoreCase = true)) {
            return fileChangeActionLabel(
                trimmed
                    .removePrefix("**Kind:**")
                    .removePrefix("Kind:")
                    .trim()
                    .trim('`'),
            )
        }
    }
    return null
}

private fun extractStructuredTotals(lines: List<String>): Pair<Int, Int>? {
    lines.forEach { line ->
        val trimmed = line.trim()
        if (trimmed.startsWith("Totals:", ignoreCase = true)) {
            val match = INLINE_TOTALS_REGEX.find(trimmed) ?: return@forEach
            return (match.groupValues.getOrNull(1)?.toIntOrNull() ?: 0) to
                (match.groupValues.getOrNull(2)?.toIntOrNull() ?: 0)
        }
    }
    return null
}

private fun extractStructuredFencedCode(lines: List<String>): String? {
    var inFence = false
    val codeLines = mutableListOf<String>()
    lines.forEach { line ->
        val trimmed = line.trim()
        if (trimmed.startsWith("```")) {
            if (inFence) {
                return codeLines.joinToString("\n")
            }
            inFence = true
            codeLines.clear()
            return@forEach
        }
        if (inFence) {
            codeLines += line
        }
    }
    return if (inFence && codeLines.isNotEmpty()) codeLines.joinToString("\n") else null
}

private fun extractStructuredPathFromDiff(diffBody: String): String? {
    diffBody.lines().forEach { line ->
        if (line.startsWith("+++ ")) {
            val candidate = normalizeStructuredDiffPath(line.removePrefix("+++ ").trim())
            if (candidate.isNotEmpty()) {
                return candidate
            }
        }
    }
    diffBody.lines().forEach { line ->
        if (line.startsWith("diff --git ")) {
            val parts = line.split(' ').filter(String::isNotBlank)
            val candidate = parts.getOrNull(3)?.let(::normalizeStructuredDiffPath).orEmpty()
            if (candidate.isNotEmpty()) {
                return candidate
            }
        }
    }
    return null
}

private fun normalizeStructuredDiffPath(rawValue: String): String {
    val trimmed = rawValue.trim()
    if (trimmed.isEmpty() || trimmed == "/dev/null") {
        return ""
    }
    return trimmed.removePrefix("a/").removePrefix("b/")
}

private fun countStructuredDiffLines(lines: List<String>): Pair<Int, Int> {
    var additions = 0
    var deletions = 0
    lines.forEach { line ->
        if (isStructuredDiffMetadataLine(line)) {
            return@forEach
        }
        if (line.startsWith("+")) {
            additions += 1
        } else if (line.startsWith("-")) {
            deletions += 1
        }
    }
    return additions to deletions
}

private fun detectStructuredActionFromDiff(lines: List<String>): String {
    return when {
        lines.any { it.startsWith("rename from ") || it.startsWith("rename to ") } -> "Moved"
        lines.any { it.startsWith("new file mode ") || it == "--- /dev/null" } -> "Added"
        lines.any { it.startsWith("deleted file mode ") || it == "+++ /dev/null" } -> "Deleted"
        else -> "Updated"
    }
}

private fun isStructuredDiffMetadataLine(line: String): Boolean {
    return line.startsWith("+++ ") ||
        line.startsWith("--- ") ||
        line.startsWith("diff --git ") ||
        line.startsWith("@@") ||
        line.startsWith("index ") ||
        line.startsWith("\\ No newline") ||
        line.startsWith("new file mode ") ||
        line.startsWith("deleted file mode ") ||
        line.startsWith("similarity index ") ||
        line.startsWith("rename from ") ||
        line.startsWith("rename to ")
}
