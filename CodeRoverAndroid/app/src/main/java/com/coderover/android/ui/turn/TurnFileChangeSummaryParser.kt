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

private class MutableFileChangeEntry(
    var path: String,
    var actionLabel: String,
    var additions: Int = 0,
    var deletions: Int = 0,
)

internal fun parseFileChangeEntries(text: String): List<FileChangeEntryUi> {
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
                line.startsWith("Deleted ") || line.startsWith("Created ") || line.startsWith("Renamed ") -> {
                val parts = line.split(' ', limit = 2)
                val action = parts.firstOrNull().orEmpty()
                val path = parts.getOrNull(1)?.substringBefore(" (+")?.substringBefore(" (-")?.trim().orEmpty()
                val normalizedAction = when (action) {
                    "Modified" -> "Updated"
                    "Created" -> "Added"
                    "Renamed" -> "Moved"
                    else -> action
                }
                upsert(path, normalizedAction)
            }

            currentKey != null && line.startsWith("+") && !line.startsWith("+++") -> {
                entries[currentKey]?.additions = (entries[currentKey]?.additions ?: 0) + 1
            }

            currentKey != null && line.startsWith("-") && !line.startsWith("---") -> {
                entries[currentKey]?.deletions = (entries[currentKey]?.deletions ?: 0) + 1
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
