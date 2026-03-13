package com.coderover.android.ui.turn

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ThinkingDisclosureParserTest {
    @Test
    fun mergesDuplicateSectionTitlesAndPreservesPreamble() {
        val parsed = parseThinkingDisclosure(
            """
            thinking...
            Initial context
            **Plan**
            First pass
            **Plan**
            Refined pass
            """.trimIndent(),
        )

        assertEquals(1, parsed.sections.size)
        assertEquals("Plan", parsed.sections.first().title)
        assertTrue(parsed.sections.first().detail.contains("Initial context"))
        assertTrue(parsed.sections.first().detail.contains("Refined pass"))
    }

    @Test
    fun fallsBackToPlainTextWhenNoSectionsExist() {
        val parsed = parseThinkingDisclosure("thinking...\nJust thinking out loud")

        assertTrue(parsed.sections.isEmpty())
        assertEquals("Just thinking out loud", parsed.fallbackText)
    }
}
