package com.remodex.android.app

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import com.remodex.android.data.model.AccessMode
import com.remodex.android.data.model.AppFontStyle
import com.remodex.android.data.repository.RemodexRepository
import kotlinx.serialization.json.JsonElement
import kotlinx.coroutines.flow.StateFlow

class AppViewModel(application: Application) : AndroidViewModel(application) {
    private val repository = RemodexRepository(application.applicationContext)
    val state: StateFlow<com.remodex.android.data.model.AppState> = repository.state

    fun completeOnboarding() = repository.completeOnboarding()

    fun setFontStyle(fontStyle: AppFontStyle) = repository.setFontStyle(fontStyle)

    fun setAccessMode(accessMode: AccessMode) = repository.setAccessMode(accessMode)

    fun setSelectedModelId(modelId: String?) = repository.setSelectedModelId(modelId)

    fun setSelectedReasoningEffort(reasoningEffort: String?) = repository.setSelectedReasoningEffort(reasoningEffort)

    fun updateImportText(value: String) = repository.updateImportText(value)

    fun importPairingPayload(rawText: String) = repository.importPairingPayload(rawText)

    fun connectActivePairing() = repository.connectActivePairing()

    fun disconnect() = repository.disconnect()

    fun removePairing(macDeviceId: String) = repository.removePairing(macDeviceId)

    fun selectPairing(macDeviceId: String) = repository.selectPairing(macDeviceId)

    fun selectThread(threadId: String) = repository.selectThread(threadId)

    fun createThread(preferredProjectPath: String? = null) = repository.createThread(preferredProjectPath)

    fun sendMessage(text: String, usePlanMode: Boolean = false) = repository.sendMessage(text, usePlanMode)

    fun interruptActiveTurn() = repository.interruptActiveTurn()

    fun approvePendingRequest(approve: Boolean) = repository.approvePendingRequest(approve)

    fun respondToStructuredUserInput(requestId: JsonElement, answersByQuestionId: Map<String, String>) =
        repository.respondToStructuredUserInput(requestId, answersByQuestionId)
}
