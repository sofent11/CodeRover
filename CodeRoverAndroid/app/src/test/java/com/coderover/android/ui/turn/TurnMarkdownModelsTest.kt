package com.coderover.android.ui.turn

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TurnMarkdownModelsTest {
    @Test
    fun splitsMarkdownIntoProseAndCodeSegments() {
        val segments = parseMarkdownSegments(
            """
            Intro

            ```kotlin
            val x = 1
            ```

            Outro
            """.trimIndent(),
        )

        assertEquals(3, segments.size)
        assertTrue(segments[0] is MarkdownSegmentUi.Prose)
        assertTrue(segments[1] is MarkdownSegmentUi.CodeBlock)
        assertTrue(segments[2] is MarkdownSegmentUi.Prose)
    }

    @Test
    fun parsesHeadingsQuotesAndLists() {
        val blocks = parseMarkdownBlocks(
            """
            # Title

            > quoted

            1. one
            2. two
            """.trimIndent(),
        )

        assertTrue(blocks[0] is MarkdownBlockUi.Heading)
        assertTrue(blocks[1] is MarkdownBlockUi.Quote)
        assertTrue(blocks[2] is MarkdownBlockUi.ListBlock)
        assertEquals(true, (blocks[2] as MarkdownBlockUi.ListBlock).ordered)
    }
}
