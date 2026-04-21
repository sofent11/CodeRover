package com.coderover.android.data.repository

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CommandExecutionTranscriptParserTest {
    @Test
    fun parseCommandExecutionTranscriptExtractsCommandStatusAndOutput() {
        val parsed = parseCommandExecutionTranscript(
            """
            Chunk ID: 6d6974
            Wall time: 0.0000 seconds
            Process exited with code 0
            Original token count: 1235
            Output:
            ** WARNING: connection is not using a post-quantum key exchange algorithm.
            ===== REMOTE /api/jobs/95383/status =====
            HTTP/1.1 200 OK
            """.trimIndent(),
        )

        assertEquals("completed", parsed.status)
        assertTrue(parsed.command == null)
        assertEquals(
            """
            ** WARNING: connection is not using a post-quantum key exchange algorithm.
            ===== REMOTE /api/jobs/95383/status =====
            HTTP/1.1 200 OK
            """.trimIndent(),
            parsed.outputText,
        )
    }

    @Test
    fun parseCommandExecutionTranscriptReadsCompactTranscriptLine() {
        val parsed = parseCommandExecutionTranscript(
            """
            Output:
            | <> ls -lh /Users/sofent/work completed
            Chunk ID: abc123
            """.trimIndent(),
        )

        assertEquals("ls -lh /Users/sofent/work", parsed.command)
        assertEquals("completed", parsed.status)
    }
}
