package com.coderover.android.ui.components

import androidx.compose.runtime.Composable
import com.coderover.android.app.AppViewModel
import com.coderover.android.data.model.AccessMode
import com.coderover.android.data.model.AppState
import com.coderover.android.data.model.ImageAttachment
import com.coderover.android.data.model.TurnSkillMention
import com.coderover.android.ui.turn.TurnComposer

@Composable
fun ComposerCard(
    state: AppState,
    input: String,
    onInputChanged: (String) -> Unit,
    isRunning: Boolean,
    onSend: (String, List<ImageAttachment>, List<TurnSkillMention>, Boolean) -> Unit,
    onStop: () -> Unit,
    onReconnect: () -> Unit,
    onSelectModel: (String?) -> Unit,
    onSelectReasoning: (String?) -> Unit,
    onSelectAccessMode: (AccessMode) -> Unit,
    viewModel: AppViewModel,
) {
    TurnComposer(
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
        viewModel = viewModel,
    )
}
