package com.coderover.android.ui.turn

import com.coderover.android.data.model.ChatMessage
import com.coderover.android.data.model.FileChangeEntry
import com.coderover.android.data.model.MessageKind
import com.coderover.android.data.model.MessageRole
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TurnDiffPresentationTest {
    @Test
    fun buildRepositoryDiffFilesParsesStructuredSectionsIntoDiffHunks() {
        val files = buildRepositoryDiffFiles(
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

        assertEquals(1, files.size)
        assertEquals("apps/node-service-api/package.json", files[0].path)
        assertEquals("Updated", files[0].actionLabel)
        assertEquals(2, files[0].additions)
        assertEquals(1, files[0].deletions)
        assertTrue(files[0].hunks.isNotEmpty())
    }

    @Test
    fun buildDiffDetailFilesPrefersStructuredTextWhenFileChangesAreSkeletonOnly() {
        val message = ChatMessage(
            id = "file-1",
            threadId = "thread-1",
            role = MessageRole.SYSTEM,
            kind = MessageKind.FILE_CHANGE,
            text = """
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
            turnId = "turn-1",
            orderIndex = 1,
            fileChanges = listOf(
                FileChangeEntry(
                    path = "apps/node-service-api/package.json",
                    kind = "patched",
                    diff = "",
                    additions = null,
                    deletions = null,
                ),
            ),
        )

        val files = buildDiffDetailFiles(message)

        assertEquals(1, files.size)
        assertEquals(2, files[0].additions)
        assertEquals(1, files[0].deletions)
        assertTrue(files[0].rawBody.contains("@@ -1,5 +1,6 @@"))
    }

    @Test
    fun buildFileChangeBlockPresentationPrefersStructuredTextCountsWhenFileChangesAreZeroed() {
        val message = ChatMessage(
            id = "file-1",
            threadId = "thread-1",
            role = MessageRole.SYSTEM,
            kind = MessageKind.FILE_CHANGE,
            text = """
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
            turnId = "turn-1",
            orderIndex = 1,
            fileChanges = listOf(
                FileChangeEntry(
                    path = "apps/node-service-api/package.json",
                    kind = "patched",
                    diff = "",
                    additions = null,
                    deletions = null,
                ),
            ),
        )

        val presentation = buildFileChangeBlockPresentation(listOf(message))

        assertEquals(1, presentation?.entries?.size)
        assertEquals(2, presentation?.entries?.first()?.additions)
        assertEquals(1, presentation?.entries?.first()?.deletions)
    }
}
