package com.coderover.android.ui.turn

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
import com.coderover.android.app.AppViewModel
import com.coderover.android.data.model.AccessMode
import com.coderover.android.data.model.AppState
import com.coderover.android.data.model.ApprovalRequest
import com.coderover.android.data.model.AssistantRevertPresentation
import com.coderover.android.data.model.ChatMessage
import com.coderover.android.data.model.CodeRoverReviewTarget
import com.coderover.android.data.model.ImageAttachment
import com.coderover.android.data.model.TurnSkillMention

@Composable
internal fun TurnConversationContainer(
    state: AppState,
    input: String,
    messages: List<ChatMessage>,
    renderItems: List<TimelineRenderItem>,
    hasEarlierMessages: Boolean,
    onLoadEarlierMessages: () -> Unit,
    hasOlderHistory: Boolean,
    isLoadingOlderHistory: Boolean,
    onLoadOlderHistory: () -> Unit,
    isRunning: Boolean,
    activeTurnId: String?,
    assistantRevertPresentationByMessageId: Map<String, AssistantRevertPresentation>,
    turnViewModel: TurnViewModel,
    pendingApproval: ApprovalRequest?,
    onInputChanged: (String) -> Unit,
    onSend: (String, List<ImageAttachment>, List<TurnSkillMention>, Boolean) -> Unit,
    onStartReview: (String, CodeRoverReviewTarget, String?) -> Unit,
    onShowStatus: () -> Unit,
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
                hasOlderHistory = hasOlderHistory,
                isLoadingOlderHistory = isLoadingOlderHistory,
                onLoadOlderHistory = onLoadOlderHistory,
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
            onStartReview = onStartReview,
            onShowStatus = onShowStatus,
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
    onSend: (String, List<ImageAttachment>, List<TurnSkillMention>, Boolean) -> Unit,
    onStartReview: (String, CodeRoverReviewTarget, String?) -> Unit,
    onShowStatus: () -> Unit,
    onStop: () -> Unit,
    onReconnect: () -> Unit,
    onSelectModel: (String?) -> Unit,
    onSelectReasoning: (String?) -> Unit,
    onSelectAccessMode: (AccessMode) -> Unit,
    turnViewModel: TurnViewModel,
    viewModel: AppViewModel,
) {
    com.coderover.android.ui.turn.TurnComposerHost(
        state = state,
        input = input,
        onInputChanged = onInputChanged,
        isRunning = isRunning,
        onSend = onSend,
        onStartReview = onStartReview,
        onShowStatus = onShowStatus,
        onStop = onStop,
        onReconnect = onReconnect,
        onSelectModel = onSelectModel,
        onSelectReasoning = onSelectReasoning,
        onSelectAccessMode = onSelectAccessMode,
        turnViewModel = turnViewModel,
        viewModel = viewModel,
    )
}
