package com.coderover.android.data.repository

import com.coderover.android.data.model.AppState
import com.coderover.android.data.model.ModelOption
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

internal fun AppState.selectedTurnStartModel(): ModelOption? {
    return availableModels.firstOrNull {
        it.id == selectedModelId || it.model == selectedModelId
    } ?: availableModels.firstOrNull { it.isDefault }
        ?: availableModels.firstOrNull()
}

internal fun AppState.turnStartCollaborationMode(
    runtimeSupportsPlanMode: Boolean,
    usePlanMode: Boolean,
    selectedModel: ModelOption?,
): JsonElement? {
    if (!runtimeSupportsPlanMode) {
        return null
    }
    if (!usePlanMode) {
        return JsonObject(
            mapOf(
                "mode" to JsonPrimitive("default"),
            ),
        )
    }
    if (selectedModel == null) {
        return null
    }
    return JsonObject(
        mapOf(
            "mode" to JsonPrimitive("plan"),
            "settings" to JsonObject(
                mapOf(
                    "model" to JsonPrimitive(selectedModel.model),
                    "reasoning_effort" to (selectedReasoningEffort?.let(::JsonPrimitive) ?: JsonNull),
                    "developer_instructions" to JsonNull,
                ),
            ),
        ),
    )
}
