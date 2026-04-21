package com.coderover.android.ui.turn

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
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
    threadId: String,
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
    onTapSubagentThread: (String) -> Unit,
    viewModel: AppViewModel,
) {
    var isShowingPinnedPlanSheet by remember(threadId) { mutableStateOf(false) }
    val pinnedTaskPlanMessage = remember(messages) {
        messages.lastOrNull { it.kind == com.coderover.android.data.model.MessageKind.PLAN }
    }
    val timelineMessages = remember(messages) {
        messages.filterNot { it.kind == com.coderover.android.data.model.MessageKind.PLAN }
    }
    val timelineRenderItems = remember(renderItems, timelineMessages) {
        renderItems.filter { item ->
            (item as? TimelineRenderItem.Message)?.message?.kind != com.coderover.android.data.model.MessageKind.PLAN
        }
    }

    Column(modifier = Modifier.fillMaxSize()) {
        Box(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth(),
        ) {
            TurnTimeline(
                modifier = Modifier.fillMaxSize(),
                messages = timelineMessages,
                renderItems = timelineRenderItems,
                suppressEmptyState = pinnedTaskPlanMessage != null && timelineMessages.isEmpty(),
                hasEarlierMessages = hasEarlierMessages,
                onLoadEarlierMessages = onLoadEarlierMessages,
                hasOlderHistory = hasOlderHistory,
                isLoadingOlderHistory = isLoadingOlderHistory,
                onLoadOlderHistory = onLoadOlderHistory,
                isRunning = isRunning,
                activeTurnId = activeTurnId,
                assistantRevertPresentationByMessageId = assistantRevertPresentationByMessageId,
                onTapAssistantRevert = onTapAssistantRevert,
                onTapSubagentThread = onTapSubagentThread,
                turnViewModel = turnViewModel,
                onSubmitStructuredInput = onSubmitStructuredInput,
            )
        }

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(bottom = 4.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            pendingApproval?.let { approval ->
                TurnApprovalBanner(
                    approval = approval,
                    onApprove = onApprove,
                    onDeny = onDeny,
                )
            }

            pinnedTaskPlanMessage?.let { planMessage ->
                PlanExecutionAccessory(
                    message = planMessage,
                    onTap = { isShowingPinnedPlanSheet = true },
                    modifier = Modifier.padding(horizontal = 12.dp),
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

    if (isShowingPinnedPlanSheet && pinnedTaskPlanMessage != null) {
        PlanExecutionSheet(
            message = pinnedTaskPlanMessage,
            onDismiss = { isShowingPinnedPlanSheet = false },
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
