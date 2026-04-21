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

    @Test
    fun parsesInlineEditedRowsIntoUpdatedEntries() {
        val entries = parseFileChangeEntries(
            """
            Edited app/src/main/java/com/example/MainActivity.kt +12 -3
            Renamed app/src/Old.kt +0 -0
            """.trimIndent(),
        )

        assertEquals(2, entries.size)
        assertEquals("app/src/main/java/com/example/MainActivity.kt", entries[0].path)
        assertEquals("Updated", entries[0].actionLabel)
        assertEquals(12, entries[0].additions)
        assertEquals(3, entries[0].deletions)
        assertEquals("Moved", entries[1].actionLabel)
    }

    @Test
    fun removesInlineEditingRowsFromFallbackBody() {
        val body = removeInlineEditingRows(
            """
            Edited app/src/A.kt +3 -1

            ```diff
            diff --git a/app/src/A.kt b/app/src/A.kt
            ```
            """.trimIndent(),
        )

        assertEquals(
            """
            ```diff
            diff --git a/app/src/A.kt b/app/src/A.kt
            ```
            """.trimIndent(),
            body,
        )
    }

    @Test
    fun parsesStructuredFileChangeSectionsWithPatchedKindAndDiffFence() {
        val entries = parseFileChangeEntries(
            """
            Path: apps/node-service-api/package.json
            Kind: patched
            Totals: +2 -1

            ```diff
            diff --git a/apps/node-service-api/package.json b/apps/node-service-api/package.json
            index 1111111..2222222 100644
            --- a/apps/node-service-api/package.json
            +++ b/apps/node-service-api/package.json
            @@ -1,5 +1,6 @@
             {
            -  "name": "old"
            +  "name": "new",
            +  "private": true
             }
            ```
            """.trimIndent(),
        )

        assertEquals(1, entries.size)
        assertEquals("apps/node-service-api/package.json", entries[0].path)
        assertEquals("Updated", entries[0].actionLabel)
        assertEquals(2, entries[0].additions)
        assertEquals(1, entries[0].deletions)
    }
}
