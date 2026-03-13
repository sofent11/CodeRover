package com.coderover.android.ui.turn

internal sealed interface MarkdownSegmentUi {
    data class Prose(val text: String) : MarkdownSegmentUi
    data class CodeBlock(val language: String?, val code: String) : MarkdownSegmentUi
}

internal sealed interface MarkdownBlockUi {
    data class Paragraph(val text: String) : MarkdownBlockUi
    data class Heading(val level: Int, val text: String) : MarkdownBlockUi
    data class Quote(val text: String) : MarkdownBlockUi
    data class ListBlock(
        val items: List<String>,
        val ordered: Boolean,
        val startIndex: Int = 1,
    ) : MarkdownBlockUi
}

internal fun parseMarkdownBlocks(text: String): List<MarkdownBlockUi> {
    return text
        .split(Regex("""\n{2,}"""))
        .map(String::trim)
        .filter(String::isNotEmpty)
        .map { block ->
            val lines = block.lines().map(String::trim).filter(String::isNotEmpty)
            when {
                lines.size == 1 && block.startsWith("### ") ->
                    MarkdownBlockUi.Heading(level = 3, text = block.removePrefix("### ").trim())

                lines.size == 1 && block.startsWith("## ") ->
                    MarkdownBlockUi.Heading(level = 2, text = block.removePrefix("## ").trim())

                lines.size == 1 && block.startsWith("# ") ->
                    MarkdownBlockUi.Heading(level = 1, text = block.removePrefix("# ").trim())

                lines.isNotEmpty() && lines.all { it.startsWith(">") } ->
                    MarkdownBlockUi.Quote(
                        text = lines.joinToString("\n") { line ->
                            line.removePrefix(">").trimStart()
                        },
                    )

                lines.isNotEmpty() && lines.all { it.matches(Regex("""[-*+] .+""")) } ->
                    MarkdownBlockUi.ListBlock(
                        items = lines.map { it.drop(2).trim() },
                        ordered = false,
                    )

                lines.isNotEmpty() && lines.all { it.matches(Regex("""\d+\. .+""")) } -> {
                    val startIndex = lines.first().substringBefore('.').toIntOrNull() ?: 1
                    MarkdownBlockUi.ListBlock(
                        items = lines.map { it.substringAfter(". ").trim() },
                        ordered = true,
                        startIndex = startIndex,
                    )
                }

                else -> MarkdownBlockUi.Paragraph(block)
            }
        }
}

internal fun parseMarkdownSegments(text: String): List<MarkdownSegmentUi> {
    val regex = Regex("""(?m)^[ \t]{0,3}```([^\n`]*)\n([\s\S]*?)(?:\n[ \t]{0,3}```|$)""")
    val segments = mutableListOf<MarkdownSegmentUi>()
    var lastEnd = 0
    regex.findAll(text).forEach { match ->
        if (match.range.first > lastEnd) {
            val prose = text.substring(lastEnd, match.range.first).trim('\n')
            if (prose.isNotBlank()) {
                segments += MarkdownSegmentUi.Prose(prose)
            }
        }
        val language = match.groupValues[1].trim().ifEmpty { null }
        val code = match.groupValues[2]
        segments += MarkdownSegmentUi.CodeBlock(language = language, code = code)
        lastEnd = match.range.last + 1
    }
    if (lastEnd < text.length) {
        val trailing = text.substring(lastEnd).trim('\n')
        if (trailing.isNotBlank()) {
            segments += MarkdownSegmentUi.Prose(trailing)
        }
    }
    if (segments.isEmpty()) {
        segments += MarkdownSegmentUi.Prose(text)
    }
    return segments
}
