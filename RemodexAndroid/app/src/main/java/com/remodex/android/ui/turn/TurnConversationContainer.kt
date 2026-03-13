package com.remodex.android.ui.turn

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.remodex.android.app.AppViewModel
import com.remodex.android.data.model.AccessMode
import com.remodex.android.data.model.AppState
import com.remodex.android.data.model.ApprovalRequest
import com.remodex.android.data.model.AssistantRevertPresentation
import com.remodex.android.data.model.ChatMessage
import com.remodex.android.data.model.CodexImageAttachment
import com.remodex.android.data.model.CodexTurnSkillMention

@Composable
internal fun TurnConversationContainer(
    state: AppState,
    input: String,
    messages: List<ChatMessage>,
    renderItems: List<TimelineRenderItem>,
    hasEarlierMessages: Boolean,
    onLoadEarlierMessages: () -> Unit,
    isRunning: Boolean,
    activeTurnId: String?,
    assistantRevertPresentationByMessageId: Map<String, AssistantRevertPresentation>,
    turnViewModel: TurnViewModel,
    pendingApproval: ApprovalRequest?,
    onInputChanged: (String) -> Unit,
    onSend: (String, List<CodexImageAttachment>, List<CodexTurnSkillMention>, Boolean) -> Unit,
    onStop: () -> Unit,
    onReconnect: () -> Unit,
    onSelectModel: (String?) -> Unit,
    onSelectReasoning: (String?) -> Unit,
    onSelectAccessMode: (AccessMode) -> Unit,
    onApprove: () -> Unit,
    onDeny: () -> Unit,
    onSubmitStructuredInput: (kotlinx.serialization.json.JsonElement, Map<String, String>) -> Unit,
    onTapAssistantRevert: (ChatMessage) -> Unit,
    viewModel: AppViewModel,
) {
    Column(modifier = Modifier.fillMaxSize()) {
        Box(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth(),
        ) {
            TurnTimeline(
                modifier = Modifier.fillMaxSize(),
                messages = messages,
                renderItems = renderItems,
                hasEarlierMessages = hasEarlierMessages,
                onLoadEarlierMessages = onLoadEarlierMessages,
                isRunning = isRunning,
                activeTurnId = activeTurnId,
                assistantRevertPresentationByMessageId = assistantRevertPresentationByMessageId,
                onTapAssistantRevert = onTapAssistantRevert,
                turnViewModel = turnViewModel,
                onSubmitStructuredInput = onSubmitStructuredInput,
            )
        }

        pendingApproval?.let { approval ->
            TurnApprovalBanner(
                approval = approval,
                onApprove = onApprove,
                onDeny = onDeny,
            )
        }

        TurnComposerSlot(
            state = state,
            input = input,
            isRunning = isRunning,
            onInputChanged = onInputChanged,
            onSend = onSend,
            onStop = onStop,
            onReconnect = onReconnect,
            onSelectModel = onSelectModel,
            onSelectReasoning = onSelectReasoning,
            onSelectAccessMode = onSelectAccessMode,
            turnViewModel = turnViewModel,
            viewModel = viewModel,
        )
    }
}

@Composable
internal fun TurnComposerSlot(
    state: AppState,
    input: String,
    isRunning: Boolean,
    onInputChanged: (String) -> Unit,
    onSend: (String, List<CodexImageAttachment>, List<CodexTurnSkillMention>, Boolean) -> Unit,
    onStop: () -> Unit,
    onReconnect: () -> Unit,
    onSelectModel: (String?) -> Unit,
    onSelectReasoning: (String?) -> Unit,
    onSelectAccessMode: (AccessMode) -> Unit,
    turnViewModel: TurnViewModel,
    viewModel: AppViewModel,
) {
    com.remodex.android.ui.turn.TurnComposerHost(
        state = state,
        input = input,
        onInputChanged = onInputChanged,
        isRunning = isRunning,
        onSend = onSend,
        onStop = onStop,
        onReconnect = onReconnect,
        onSelectModel = onSelectModel,
        onSelectReasoning = onSelectReasoning,
        onSelectAccessMode = onSelectAccessMode,
        turnViewModel = turnViewModel,
        viewModel = viewModel,
    )
}
