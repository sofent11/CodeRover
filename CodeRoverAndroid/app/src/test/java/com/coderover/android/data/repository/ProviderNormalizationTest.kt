package com.coderover.android.data.repository

import org.junit.Assert.assertEquals
import org.junit.Test

class ProviderNormalizationTest {
    @Test
    fun normalizeProviderIdAcceptsCopilot() {
        assertEquals("copilot", normalizeProviderId("copilot"))
        assertEquals("copilot", normalizeProviderId("  COPILOT  "))
        assertEquals("codex", normalizeProviderId("unknown"))
    }
}
