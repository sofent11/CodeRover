package com.coderover.android.ui.turn

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TurnFileChangeSummaryParserTest {
    @Test
    fun parsesUnifiedDiffIntoSummaries() {
        val entries = parseFileChangeEntries(
            """
            diff --git a/app/src/A.kt b/app/src/A.kt
            --- a/app/src/A.kt
            +++ b/app/src/A.kt
            +added
            -removed
            """.trimIndent(),
        )

        assertEquals(1, entries.size)
        assertEquals("app/src/A.kt", entries.first().path)
        assertEquals("Changed", entries.first().actionLabel)
        assertEquals(1, entries.first().additions)
        assertEquals(1, entries.first().deletions)
    }

    @Test
    fun groupsEntriesByActionLabelInInsertionOrder() {
        val groups = groupFileChangeEntries(
            listOf(
                FileChangeEntryUi("a.kt", "Added", 1, 0),
                FileChangeEntryUi("b.kt", "Updated", 2, 1),
                FileChangeEntryUi("c.kt", "Added", 3, 0),
            ),
        )

        assertEquals(listOf("Added", "Updated"), groups.map(FileChangeGroupUi::actionLabel))
        assertEquals(2, groups.first().entries.size)
        assertTrue(groups.first().entries.any { it.path == "c.kt" })
    }
}
