package com.coderover.android.data.model

import org.junit.Assert.assertEquals
import org.junit.Test

class RuntimeProviderCopilotTest {
    @Test
    fun threadSummaryUsesGitHubCopilotBadgeTitle() {
        val thread = ThreadSummary(id = "copilot-thread", provider = "copilot")

        assertEquals("GitHub Copilot", thread.providerBadgeTitle)
    }
}
