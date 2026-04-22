package com.coderover.android.data.repository

import com.coderover.android.data.model.AppState
import com.coderover.android.data.model.ModelOption
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

class TurnStartRequestHelpersTest {
    @Test
    fun selectedTurnStartModelPrefersExplicitSelection() {
        val defaultModel = ModelOption(
            id = "default",
            title = "Default",
            model = "gpt-default",
            isDefault = true,
            supportedReasoningEfforts = listOf("low", "high"),
            defaultReasoningEffort = "low",
        )
        val selected = ModelOption(
            id = "selected",
            title = "Selected",
            model = "gpt-selected",
            isDefault = false,
            supportedReasoningEfforts = listOf("low", "high"),
            defaultReasoningEffort = "high",
        )
        val state = AppState(
            availableModels = listOf(defaultModel, selected),
            selectedModelId = "selected",
        )

        assertEquals(selected, state.selectedTurnStartModel())
    }

    @Test
    fun selectedTurnStartModelFallsBackToDefault() {
        val defaultModel = ModelOption(
            id = "default",
            title = "Default",
            model = "gpt-default",
            isDefault = true,
            supportedReasoningEfforts = listOf("low", "high"),
            defaultReasoningEffort = "low",
        )
        val secondary = ModelOption(
            id = "secondary",
            title = "Secondary",
            model = "gpt-secondary",
            isDefault = false,
            supportedReasoningEfforts = listOf("low", "high"),
            defaultReasoningEffort = "high",
        )
        val state = AppState(
            availableModels = listOf(secondary, defaultModel),
            selectedModelId = null,
        )

        assertEquals(defaultModel, state.selectedTurnStartModel())
    }

    @Test
    fun turnStartCollaborationModeReturnsDefaultWhenRuntimeSupportsPlanMode() {
        val model = ModelOption(
            id = "selected",
            title = "Selected",
            model = "gpt-selected",
            isDefault = false,
            supportedReasoningEfforts = listOf("low", "high"),
            defaultReasoningEffort = "high",
        )
        val state = AppState(selectedReasoningEffort = "high")

        val collaborationMode = state.turnStartCollaborationMode(
            runtimeSupportsPlanMode = true,
            usePlanMode = false,
            selectedModel = model,
        ) as? JsonObject

        assertNotNull(collaborationMode)
        assertEquals("default", collaborationMode?.get("mode")?.toString()?.trim('"'))
        assertNull(state.turnStartCollaborationMode(runtimeSupportsPlanMode = true, usePlanMode = true, selectedModel = null))
        assertNull(state.turnStartCollaborationMode(runtimeSupportsPlanMode = false, usePlanMode = false, selectedModel = model))
    }

    @Test
    fun turnStartCollaborationModeBuildsPlanSettings() {
        val model = ModelOption(
            id = "selected",
            title = "Selected",
            model = "gpt-selected",
            isDefault = false,
            supportedReasoningEfforts = listOf("low", "high"),
            defaultReasoningEffort = "high",
        )
        val state = AppState(selectedReasoningEffort = "high")

        val collaborationMode = state.turnStartCollaborationMode(
            runtimeSupportsPlanMode = true,
            usePlanMode = true,
            selectedModel = model,
        )

        val json = collaborationMode as? JsonObject
        assertNotNull(json)
        assertEquals("plan", json?.get("mode")?.toString()?.trim('"'))
        assertEquals(
            "gpt-selected",
            json?.get("settings")?.jsonObject?.get("model")?.toString()?.trim('"'),
        )
        assertEquals(
            "high",
            json?.get("settings")?.jsonObject?.get("reasoning_effort")?.toString()?.trim('"'),
        )
    }
}
