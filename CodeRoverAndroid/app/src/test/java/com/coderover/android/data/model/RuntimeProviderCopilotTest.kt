package com.coderover.android.data.model

import org.junit.Assert.assertEquals
import org.junit.Test

class RuntimeProviderCopilotTest {
    @Test
    fun threadSummaryUsesGitHubCopilotBadgeTitle() {
        val thread = ThreadSummary(id = "copilot-thread", provider = "copilot")

        assertEquals("GitHub Copilot", thread.providerBadgeTitle)
    }

    @Test
    fun threadSummaryUsesPMonogramForCopilot() {
        val copilotThread = ThreadSummary(id = "copilot-thread", provider = "copilot")
        val geminiThread = ThreadSummary(id = "gemini-thread", provider = "gemini")

        assertEquals("P", copilotThread.providerMonogram)
        assertEquals("G", geminiThread.providerMonogram)
    }
}
