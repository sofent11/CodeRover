package com.coderover.android.ui.screens

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
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Unarchive
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import com.coderover.android.ui.shared.HapticFeedback
import com.coderover.android.ui.shared.ParityListRow
import com.coderover.android.ui.shared.ParityToolbarItemSurface
import com.coderover.android.ui.shared.relativeTimeLabel
import com.coderover.android.ui.theme.Danger

@Composable
fun ArchivedChatsScreen(
    archivedThreads: List<ThreadSummary>,
    onUnarchiveThread: (String) -> Unit,
    onDeleteThread: (String) -> Unit,
    onBack: () -> Unit,
) {
    var threadPendingDeletion by remember { mutableStateOf<ThreadSummary?>(null) }
    val haptic = HapticFeedback.rememberHapticFeedback()

    if (archivedThreads.isEmpty()) {
        Column(
            modifier = Modifier.fillMaxSize(),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Icon(
                imageVector = Icons.Outlined.Archive,
                contentDescription = null,
                modifier = Modifier.size(40.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
            )
            Spacer(modifier = Modifier.size(12.dp))
            Text(
                text = "No archived chats",
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    } else {
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            items(archivedThreads, key = { it.id }) { thread ->
                ArchivedChatRow(
                    thread = thread,
                    onUnarchive = {
                        haptic.triggerImpactFeedback(HapticFeedback.Style.LIGHT)
                        onUnarchiveThread(thread.id)
                    },
                    onDeleteRequest = { threadPendingDeletion = thread },
                )
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
    ParityListRow(
        modifier = Modifier
            .fillMaxWidth()
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
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TextButton(onClick = onUnarchive) {
                Icon(
                    imageVector = Icons.Outlined.Unarchive,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(16.dp),
                )
                Text("Unarchive")
            }
            ParityToolbarItemSurface(
                size = 30.dp,
                onClick = onDeleteRequest,
            ) {
                Icon(
                    imageVector = Icons.Outlined.Delete,
                    contentDescription = "Delete archived chat",
                    tint = Danger,
                    modifier = Modifier.size(16.dp),
                )
            }
        }
    }
}
