package com.coderover.android.data.model

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RuntimeCapabilitiesTest {
    @Test
    fun codexDefaultEnablesDesktopRestart() {
        assertTrue(RuntimeCapabilities.CODEX_DEFAULT.desktopRestart)
    }

    @Test
    fun fromJsonReadsDesktopRestartCapability() {
        val capabilities = RuntimeCapabilities.fromJson(
            JsonObject(
                mapOf(
                    "desktopRestart" to JsonPrimitive(false),
                    "desktopRefresh" to JsonPrimitive(true),
                ),
            ),
        )

        assertFalse(capabilities.desktopRestart)
        assertTrue(capabilities.desktopRefresh)
    }
}
