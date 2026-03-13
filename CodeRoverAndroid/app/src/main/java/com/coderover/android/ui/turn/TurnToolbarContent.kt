package com.coderover.android.ui.turn

import androidx.compose.runtime.Composable
import com.coderover.android.data.model.AccessMode
import com.coderover.android.data.model.AppState

@Composable
internal fun TurnToolbarContent(
    state: AppState,
    turnViewModel: TurnViewModel,
    onSelectAccessMode: (AccessMode) -> Unit,
    onRefreshGitBranches: () -> Unit,
    onCheckoutGitBranch: (String) -> Unit,
    onSelectGitBaseBranch: (String) -> Unit,
) {
    ComposerSecondaryToolbar(
        state = state,
        turnViewModel = turnViewModel,
        onSelectAccessMode = onSelectAccessMode,
        onRefreshGitBranches = onRefreshGitBranches,
        onCheckoutGitBranch = onCheckoutGitBranch,
        onSelectGitBaseBranch = onSelectGitBaseBranch,
    )
}
