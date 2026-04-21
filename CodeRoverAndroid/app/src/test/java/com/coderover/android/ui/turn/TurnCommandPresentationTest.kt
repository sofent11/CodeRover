package com.coderover.android.ui.turn

import com.coderover.android.data.model.ChatMessage
import com.coderover.android.data.model.CommandPhase
import com.coderover.android.data.model.CommandState
import com.coderover.android.data.model.MessageKind
import com.coderover.android.data.model.MessageRole
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TurnCommandPresentationTest {
    @Test
    fun parseCommandPreviewUsesIosStyleFailedLabel() {
        val preview = parseCommandPreview(
            text = "npm test\nError: 1 test failed",
            isStreaming = false,
        )

        assertEquals("failed", preview.statusLabel)
    }

    @Test
    fun buildCommandDetailNormalizesCommandPhaseLabel() {
        val message = ChatMessage(
            id = "command-1",
            threadId = "thread-1",
            role = MessageRole.SYSTEM,
            kind = MessageKind.COMMAND_EXECUTION,
            text = "Command failed",
            turnId = "turn-1",
            orderIndex = 1,
            commandState = CommandState(
                shortCommand = "npm test",
                fullCommand = "npm test",
                phase = CommandPhase.FAILED,
                exitCode = 1,
                outputTail = "Error: 1 test failed",
            ),
        )

        val detail = buildCommandDetail(
            message = message,
            preview = CommandPreviewUi(
                command = "npm test",
                outputLines = emptyList(),
                statusLabel = "failed",
            ),
        )

        assertEquals("failed", detail.statusLabel)
    }

    @Test
    fun parseCommandPreviewParsesRawTranscriptMetadataIntoCommandCardPreview() {
        val preview = parseCommandPreview(
            text = """
                Chunk ID: call_123
                Wall time: 1.2 seconds
                Process exited with code 0
                Output:
                REMOTE /api/jobs/123
                {
                  "ok": true
                }
            """.trimIndent(),
            isStreaming = false,
        )

        assertEquals("completed", preview.statusLabel)
        assertEquals("command", preview.command)
        assertEquals(
            listOf("REMOTE /api/jobs/123", "{", "  \"ok\": true", "}"),
            preview.outputLines,
        )
    }

    @Test
    fun isCommandTranscriptMessageDetectsChatMessageWithShellTranscriptBody() {
        val message = ChatMessage(
            id = "chat-1",
            threadId = "thread-1",
            role = MessageRole.ASSISTANT,
            kind = MessageKind.CHAT,
            text = """
                Chunk ID: call_123
                Wall time: 1.2 seconds
                Process exited with code 0
                Output:
                ok
            """.trimIndent(),
            turnId = "turn-1",
            orderIndex = 1,
        )

        assertTrue(isCommandTranscriptMessage(message))
    }
}
