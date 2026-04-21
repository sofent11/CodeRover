package com.coderover.android.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.coderover.android.data.model.ThreadSummary
import com.coderover.android.ui.shared.AppBackdrop
import com.coderover.android.ui.shared.HapticFeedback
import com.coderover.android.ui.shared.ParityListRow
import com.coderover.android.ui.shared.ParityToolbarItemSurface
import com.coderover.android.ui.shared.relativeTimeLabel
import com.coderover.android.ui.theme.Danger

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ArchivedChatsScreen(
    archivedThreads: List<ThreadSummary>,
    onUnarchiveThread: (String) -> Unit,
    onDeleteThread: (String) -> Unit,
    onBack: () -> Unit,
) {
    var threadPendingDeletion by remember { mutableStateOf<ThreadSummary?>(null) }
    val haptic = HapticFeedback.rememberHapticFeedback()

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = "Archived Chats",
                        style = MaterialTheme.typography.titleMedium,
                    )
                },
                navigationIcon = {
                    ParityToolbarItemSurface(
                        modifier = Modifier.padding(start = 10.dp),
                        onClick = onBack,
                    ) {
                        Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Back")
                    }
                },
            )
        }
    ) { paddingValues ->
        if (archivedThreads.isEmpty()) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(paddingValues),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Icon(
                    imageVector = Icons.Outlined.Archive,
                    contentDescription = null,
                    modifier = Modifier.size(48.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f),
                )
                Spacer(modifier = Modifier.padding(8.dp))
                Text(
                    text = "No archived chats",
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        } else {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(paddingValues),
            ) {
                AppBackdrop(modifier = Modifier.fillMaxSize())
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(bottom = 16.dp, top = 8.dp),
                ) {
                    items(archivedThreads, key = { it.id }) { thread ->
                        ArchivedChatRow(
                            thread = thread,
                            onUnarchive = {
                                haptic.triggerImpactFeedback(HapticFeedback.Style.LIGHT)
                                onUnarchiveThread(thread.id)
                            },
                            onDeleteRequest = { threadPendingDeletion = thread }
                        )
                    }
                }
            }
        }
    }

    threadPendingDeletion?.let { thread ->
        AlertDialog(
            onDismissRequest = { threadPendingDeletion = null },
            title = { Text("Delete \"${thread.displayTitle}\"?") },
            text = { Text("This action cannot be undone.") },
            confirmButton = {
                TextButton(
                    onClick = {
                        onDeleteThread(thread.id)
                        threadPendingDeletion = null
                    }
                ) {
                    Text("Delete", color = Danger)
                }
            },
            dismissButton = {
                TextButton(onClick = { threadPendingDeletion = null }) {
                    Text("Cancel")
                }
            }
        )
    }
}

@Composable
private fun ArchivedChatRow(
    thread: ThreadSummary,
    onUnarchive: () -> Unit,
    onDeleteRequest: () -> Unit,
) {
    var showMenu by remember { mutableStateOf(false) }

    ParityListRow(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { showMenu = true }
            .padding(horizontal = 16.dp, vertical = 12.dp),
        isSelected = false,
    ) {
        Column(
            modifier = Modifier
                .weight(1f)
                .padding(end = 16.dp),
        ) {
            Text(
                text = thread.displayTitle,
                style = MaterialTheme.typography.bodyLarge,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            relativeTimeLabel(thread.updatedAt ?: thread.createdAt)?.let { dateStr ->
                Text(
                    text = dateStr,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Icon(
            imageVector = Icons.Outlined.Archive,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }

    DropdownMenu(
        expanded = showMenu,
        onDismissRequest = { showMenu = false }
    ) {
        DropdownMenuItem(
            text = { Text("Unarchive") },
            onClick = {
                showMenu = false
                onUnarchive()
            }
        )
        DropdownMenuItem(
            text = { Text("Delete", color = Danger) },
            onClick = {
                showMenu = false
                onDeleteRequest()
            }
        )
    }
}
