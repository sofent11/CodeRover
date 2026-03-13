package com.coderover.android.ui.turn

internal data class ThinkingSectionUi(
    val id: String,
    val title: String,
    val detail: String,
)

internal data class ThinkingContentUi(
    val sections: List<ThinkingSectionUi>,
    val fallbackText: String,
)

internal fun parseThinkingDisclosure(rawText: String): ThinkingContentUi {
    val normalized = normalizeThinkingContent(rawText)
    if (normalized.isBlank()) {
        return ThinkingContentUi(sections = emptyList(), fallbackText = "")
    }

    val lines = normalized.split('\n')
    val sections = mutableListOf<ThinkingSectionUi>()
    val preambleLines = mutableListOf<String>()
    var currentTitle: String? = null
    var currentDetailLines = mutableListOf<String>()

    fun flushCurrentSection() {
        val title = currentTitle ?: return
        val detail = currentDetailLines.joinToString("\n").trim()
        sections += ThinkingSectionUi(
            id = "${sections.size}-$title",
            title = title,
            detail = detail,
        )
        currentDetailLines = mutableListOf()
    }

    lines.forEach { line ->
        val summaryTitle = extractThinkingSummaryTitle(line)
        if (summaryTitle != null) {
            flushCurrentSection()
            currentTitle = summaryTitle
        } else if (currentTitle == null) {
            preambleLines += line
        } else {
            currentDetailLines += line
        }
    }
    flushCurrentSection()

    if (sections.isEmpty()) {
        return ThinkingContentUi(sections = emptyList(), fallbackText = normalized)
    }

    val preamble = preambleLines.joinToString("\n").trim()
    val normalizedSections = sections.toMutableList()
    if (preamble.isNotBlank()) {
        val first = normalizedSections.first()
        normalizedSections[0] = first.copy(
            detail = listOf(preamble, first.detail).filter(String::isNotBlank).joinToString("\n\n"),
        )
    }

    return ThinkingContentUi(
        sections = coalesceThinkingSections(normalizedSections),
        fallbackText = normalized,
    )
}

private fun normalizeThinkingContent(rawText: String): String {
    val trimmed = rawText.trim()
    if (trimmed.isBlank()) {
        return ""
    }
    val lowered = trimmed.lowercase()
    return when {
        lowered.startsWith("thinking...") -> trimmed.drop("thinking...".length).trim()
        lowered == "thinking" -> ""
        else -> trimmed
    }
}

private fun extractThinkingSummaryTitle(line: String): String? {
    val match = Regex("""^\s*\*\*(.+?)\*\*\s*$""").matchEntire(line) ?: return null
    return match.groupValues[1].trim().takeIf(String::isNotEmpty)
}

private fun coalesceThinkingSections(sections: List<ThinkingSectionUi>): List<ThinkingSectionUi> {
    val collapsed = mutableListOf<ThinkingSectionUi>()
    sections.forEach { section ->
        val previous = collapsed.lastOrNull()
        if (previous != null && previous.title == section.title) {
            val mergedDetail = when {
                previous.detail == section.detail || section.detail.isBlank() -> previous.detail
                previous.detail.isBlank() || section.detail.contains(previous.detail) -> section.detail
                previous.detail.contains(section.detail) -> previous.detail
                else -> listOf(previous.detail, section.detail).joinToString("\n\n")
            }
            collapsed[collapsed.lastIndex] = previous.copy(detail = mergedDetail)
        } else {
            collapsed += section
        }
    }
    return collapsed
}
