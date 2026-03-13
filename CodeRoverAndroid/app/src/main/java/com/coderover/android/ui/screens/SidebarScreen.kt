package com.coderover.android.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.coderover.android.data.model.AppState
import com.coderover.android.data.model.ThreadSummary
import com.coderover.android.data.model.ThreadSyncState
import com.coderover.android.ui.sidebar.SidebarFloatingSettingsButton
import com.coderover.android.ui.sidebar.SidebarHeaderView
import com.coderover.android.ui.sidebar.SidebarNewChatButton
import com.coderover.android.ui.sidebar.SidebarProjectPickerSheet
import com.coderover.android.ui.sidebar.SidebarSearchField
import com.coderover.android.ui.sidebar.SidebarThreadListView
import com.coderover.android.ui.sidebar.buildSidebarThreadGroups
import com.coderover.android.ui.theme.Danger
import com.coderover.android.ui.turn.TurnSessionDiffSummaryCalculator

@Composable
fun SidebarScreen(
    state: AppState,
    onCreateThread: (String?, String) -> Unit,
    onSelectProvider: (String) -> Unit,
    onSelectThread: (String) -> Unit,
    onOpenSettings: () -> Unit,
    onDeleteThread: (String) -> Unit,
    onArchiveThread: (String) -> Unit,
    onUnarchiveThread: (String) -> Unit,
    onRenameThread: (String, String) -> Unit,
    onSearchActiveChanged: (Boolean) -> Unit = {},
    onToggleProjectGroupCollapsed: (String) -> Unit,
) {
    var query by rememberSaveable { mutableStateOf("") }
    var isSearchActive by rememberSaveable { mutableStateOf(false) }
    var showProjectPicker by rememberSaveable { mutableStateOf(false) }
    var threadPendingRename by remember { mutableStateOf<ThreadSummary?>(null) }
    var threadPendingDeletion by remember { mutableStateOf<ThreadSummary?>(null) }
    var threadPendingArchiveToggle by remember { mutableStateOf<ThreadSummary?>(null) }

    val groups = remember(state.threads, query) {
        buildSidebarThreadGroups(state.threads, query)
    }
    val projectPaths = remember(state.threads) {
        state.threads
            .mapNotNull { it.normalizedProjectPath }
            .distinct()
            .sorted()
    }

    val diffTotalsByThreadId = remember(state.messagesByThread) {
        state.messagesByThread.mapValues { (_, messages) ->
            TurnSessionDiffSummaryCalculator.totals(messages)
        }.filterValues { it != null }.mapValues { it.value!! }
    }

    Box(
        modifier = Modifier
            .fillMaxHeight()
            .background(MaterialTheme.colorScheme.surface),
    ) {
        Column(modifier = Modifier.fillMaxHeight()) {
            SidebarHeaderView()
            SidebarSearchField(
                value = query,
                onValueChange = { query = it },
                onActiveChange = { isActive ->
                    isSearchActive = isActive
                    onSearchActiveChanged(isActive)
                },
            )
            SidebarNewChatButton(
                enabled = state.isConnected,
                onClick = {
                    if (projectPaths.isEmpty()) {
                        onCreateThread(null, state.selectedProviderId)
                    } else {
                        showProjectPicker = true
                    }
                },
            )
            SidebarThreadListView(
                groups = groups,
                selectedThreadId = state.selectedThreadId,
                runningThreadIds = state.runningThreadIds,
                diffTotalsByThreadId = diffTotalsByThreadId,
                collapsedProjectGroupIds = state.collapsedProjectGroupIds,
                onToggleProjectGroupCollapsed = onToggleProjectGroupCollapsed,
                onSelectThread = { onSelectThread(it.id) },
                onCreateThreadInProject = { projectPath ->
                    onCreateThread(projectPath, state.selectedProviderId)
                },
                onRequestRenameThread = { threadPendingRename = it },
                onRequestDeleteThread = { threadPendingDeletion = it },
                onArchiveToggleThread = { thread ->
                    threadPendingArchiveToggle = thread
                },
                isFiltering = query.isNotBlank(),
                isConnected = state.isConnected,
                isSearchActive = isSearchActive,
                modifier = Modifier.weight(1f),
                bottomContentPadding = 96.dp,
            )
        }
        SidebarFloatingSettingsButton(
            onClick = onOpenSettings,
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .padding(end = 16.dp, bottom = 16.dp),
        )
    }

    if (showProjectPicker) {
        SidebarProjectPickerSheet(
            projectPaths = projectPaths,
            onDismiss = { showProjectPicker = false },
            providers = state.availableProviders,
            selectedProviderId = state.selectedProviderId,
            onSelectProvider = onSelectProvider,
            onSelectProject = { projectPath, providerId ->
                showProjectPicker = false
                onCreateThread(projectPath, providerId)
            },
        )
    }

    threadPendingRename?.let { thread ->
        var newName by rememberSaveable(thread.id) {
            mutableStateOf(thread.name ?: thread.title ?: "")
        }
        AlertDialog(
            onDismissRequest = { threadPendingRename = null },
            title = { Text("Rename Chat") },
            text = {
                OutlinedTextField(
                    value = newName,
                    onValueChange = { newName = it },
                    label = { Text("Chat Name") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        onRenameThread(thread.id, newName)
                        threadPendingRename = null
                    },
                ) {
                    Text("Rename")
                }
            },
            dismissButton = {
                TextButton(onClick = { threadPendingRename = null }) {
                    Text("Cancel")
                }
            },
        )
    }

    threadPendingDeletion?.let { thread ->
        AlertDialog(
            onDismissRequest = { threadPendingDeletion = null },
            title = { Text("Delete Chat") },
            text = {
                Text("Delete \"${thread.displayTitle}\"? This cannot be undone.")
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        onDeleteThread(thread.id)
                        threadPendingDeletion = null
                    },
                ) {
                    Text("Delete", color = Danger)
                }
            },
            dismissButton = {
                TextButton(onClick = { threadPendingDeletion = null }) {
                    Text("Cancel")
                }
            },
        )
    }

    threadPendingArchiveToggle?.let { thread ->
        val isArchiving = thread.syncState == ThreadSyncState.LIVE
        AlertDialog(
            onDismissRequest = { threadPendingArchiveToggle = null },
            title = {
                Text(if (isArchiving) "Archive Chat" else "Unarchive Chat")
            },
            text = {
                Text(
                    if (isArchiving) {
                        "Archive \"${thread.displayTitle}\"?"
                    } else {
                        "Unarchive \"${thread.displayTitle}\"?"
                    },
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        if (isArchiving) {
                            onArchiveThread(thread.id)
                        } else {
                            onUnarchiveThread(thread.id)
                        }
                        threadPendingArchiveToggle = null
                    },
                ) {
                    Text(if (isArchiving) "Archive" else "Unarchive")
                }
            },
            dismissButton = {
                TextButton(onClick = { threadPendingArchiveToggle = null }) {
                    Text("Cancel")
                }
            },
        )
    }
}
