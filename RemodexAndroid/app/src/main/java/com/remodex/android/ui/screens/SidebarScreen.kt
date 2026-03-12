package com.remodex.android.ui.screens

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.remodex.android.data.model.AppState
import com.remodex.android.data.model.ThreadSyncState
import com.remodex.android.ui.relativeTimeLabel
import com.remodex.android.ui.theme.Border
import com.remodex.android.ui.theme.Danger
import com.remodex.android.ui.theme.PlanAccent
import com.remodex.android.ui.theme.monoFamily

@OptIn(ExperimentalFoundationApi::class, ExperimentalMaterial3Api::class)
@Composable
fun SidebarScreen(
    state: AppState,
    onCreateThread: (String?) -> Unit,
    onSelectThread: (String) -> Unit,
    onOpenSettings: () -> Unit,
    onDeleteThread: (String) -> Unit,
    onArchiveThread: (String) -> Unit,
    onUnarchiveThread: (String) -> Unit,
    onRenameThread: (String, String) -> Unit,
) {
    var query by rememberSaveable { mutableStateOf("") }
    val filteredThreads = remember(state.threads, query) {
        state.threads.filter { thread ->
            query.isBlank() || 
            thread.displayTitle.contains(query, ignoreCase = true) || 
            (thread.projectDisplayName.contains(query, ignoreCase = true))
        }
    }

    val uniqueProjects = remember(state.threads) {
        state.threads.mapNotNull { it.normalizedProjectPath }.distinct().sorted()
    }

    var showProjectPicker by rememberSaveable { mutableStateOf(false) }
    var showThreadMenuFor by rememberSaveable { mutableStateOf<String?>(null) }
    var showRenameDialogFor by rememberSaveable { mutableStateOf<String?>(null) }
    var showDeleteConfirmFor by rememberSaveable { mutableStateOf<String?>(null) }

    Column(
        modifier = Modifier
            .fillMaxHeight()
            .background(MaterialTheme.colorScheme.surface)
    ) {
        // Search Bar
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 12.dp)
                .height(40.dp)
                .background(
                    MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
                    RoundedCornerShape(20.dp)
                ),
            contentAlignment = Alignment.CenterStart
        ) {
            Row(
                modifier = Modifier.padding(horizontal = 12.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Icon(
                    imageVector = Icons.Outlined.Search,
                    contentDescription = null,
                    modifier = Modifier.size(18.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Spacer(Modifier.width(8.dp))
                BasicTextField(
                    value = query,
                    onValueChange = { query = it },
                    modifier = Modifier.weight(1f),
                    singleLine = true,
                    textStyle = MaterialTheme.typography.bodyMedium.copy(
                        color = MaterialTheme.colorScheme.onSurface
                    ),
                    cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                    decorationBox = { innerTextField ->
                        if (query.isEmpty()) {
                            Text(
                                "Search conversations",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                        innerTextField()
                    }
                )
            }
        }

        // New Chat Button
        FilledTonalButton(
            onClick = {
                if (uniqueProjects.isNotEmpty()) {
                    showProjectPicker = true
                } else {
                    onCreateThread(null)
                }
            },
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 4.dp),
            shape = RoundedCornerShape(12.dp),
        ) {
            Icon(Icons.Outlined.Add, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
            Text("New Chat", style = MaterialTheme.typography.labelLarge)
        }

        Spacer(Modifier.height(8.dp))

        // Thread List
        LazyColumn(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.Top,
        ) {
            items(filteredThreads, key = { it.id }) { thread ->
                ThreadListItem(
                    thread = thread,
                    isSelected = state.selectedThreadId == thread.id,
                    isRunning = state.runningThreadIds.contains(thread.id),
                    onSelect = { onSelectThread(thread.id) },
                    onLongClick = { showThreadMenuFor = thread.id }
                )

                // Context Menu
                DropdownMenu(
                    expanded = showThreadMenuFor == thread.id,
                    onDismissRequest = { showThreadMenuFor = null }
                ) {
                    DropdownMenuItem(
                        text = { Text("Rename") },
                        onClick = {
                            showThreadMenuFor = null
                            showRenameDialogFor = thread.id
                        }
                    )
                    if (thread.syncState == ThreadSyncState.LIVE) {
                        DropdownMenuItem(
                            text = { Text("Archive") },
                            onClick = {
                                showThreadMenuFor = null
                                onArchiveThread(thread.id)
                            }
                        )
                    } else {
                        DropdownMenuItem(
                            text = { Text("Unarchive") },
                            onClick = {
                                showThreadMenuFor = null
                                onUnarchiveThread(thread.id)
                            }
                        )
                    }
                    DropdownMenuItem(
                        text = { Text("Delete", color = Danger) },
                        onClick = {
                            showThreadMenuFor = null
                            showDeleteConfirmFor = thread.id
                        }
                    )
                }
            }
        }

        // Bottom Footer
        HorizontalDivider(color = Border.copy(alpha = 0.5f))
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable { onOpenSettings() }
                .padding(horizontal = 16.dp, vertical = 16.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(
                imageVector = Icons.Outlined.Settings,
                contentDescription = "Settings",
                modifier = Modifier.size(20.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Spacer(Modifier.width(12.dp))
            Text(
                text = "Settings",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }

    // Project Picker Bottom Sheet
    if (showProjectPicker) {
        val sheetState = rememberModalBottomSheetState()
        ModalBottomSheet(
            onDismissRequest = { showProjectPicker = false },
            sheetState = sheetState,
            dragHandle = null,
            containerColor = MaterialTheme.colorScheme.surface,
        ) {
            Column(
                modifier = Modifier
                    .padding(16.dp)
                    .padding(bottom = 32.dp)
            ) {
                Text(
                    text = "Start new chat",
                    style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Bold),
                    modifier = Modifier.padding(bottom = 16.dp, start = 8.dp)
                )
                
                Surface(
                    onClick = {
                        showProjectPicker = false
                        onCreateThread(null)
                    },
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(12.dp),
                    color = Color.Transparent
                ) {
                    Row(
                        modifier = Modifier.padding(12.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Icon(
                            Icons.Outlined.Add,
                            contentDescription = null,
                            modifier = Modifier.size(24.dp),
                            tint = MaterialTheme.colorScheme.primary
                        )
                        Spacer(Modifier.width(12.dp))
                        Text("No Project", style = MaterialTheme.typography.bodyLarge)
                    }
                }

                uniqueProjects.forEach { project ->
                    ProjectPickerItem(
                        name = project.substringAfterLast('/'),
                        path = project,
                        onClick = {
                            showProjectPicker = false
                            onCreateThread(project)
                        }
                    )
                }
            }
        }
    }

    // Rename Dialog
    if (showRenameDialogFor != null) {
        val thread = state.threads.firstOrNull { it.id == showRenameDialogFor }
        if (thread != null) {
            var newName by rememberSaveable(thread.id) { mutableStateOf(thread.name ?: thread.title ?: "") }
            AlertDialog(
                onDismissRequest = { showRenameDialogFor = null },
                title = { Text("Rename Chat") },
                text = {
                    OutlinedTextField(
                        value = newName,
                        onValueChange = { newName = it },
                        label = { Text("Chat Name") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                },
                confirmButton = {
                    TextButton(
                        onClick = {
                            onRenameThread(thread.id, newName)
                            showRenameDialogFor = null
                        }
                    ) { Text("Rename") }
                },
                dismissButton = {
                    TextButton(onClick = { showRenameDialogFor = null }) { Text("Cancel") }
                }
            )
        } else {
            showRenameDialogFor = null
        }
    }

    // Delete Confirmation
    if (showDeleteConfirmFor != null) {
        AlertDialog(
            onDismissRequest = { showDeleteConfirmFor = null },
            title = { Text("Delete Chat") },
            text = { Text("Are you sure you want to delete this chat? This cannot be undone.") },
            confirmButton = {
                TextButton(
                    onClick = {
                        onDeleteThread(showDeleteConfirmFor!!)
                        showDeleteConfirmFor = null
                    }
                ) { Text("Delete", color = Danger) }
            },
            dismissButton = {
                TextButton(onClick = { showDeleteConfirmFor = null }) { Text("Cancel") }
            }
        )
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ThreadListItem(
    thread: com.remodex.android.data.model.ThreadSummary,
    isSelected: Boolean,
    isRunning: Boolean,
    onSelect: () -> Unit,
    onLongClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .combinedClickable(
                onClick = onSelect,
                onLongClick = onLongClick
            )
            .background(if (isSelected) MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.3f) else Color.Transparent)
            .padding(vertical = 12.dp),
        verticalAlignment = Alignment.Top
    ) {
        // Indicator
        Box(
            modifier = Modifier
                .width(2.dp)
                .height(48.dp)
                .background(if (isSelected) MaterialTheme.colorScheme.primary else Color.Transparent)
        )

        Column(
            modifier = Modifier
                .weight(1f)
                .padding(start = 14.dp, end = 16.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = thread.displayTitle,
                    style = MaterialTheme.typography.bodyLarge.copy(
                        fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Medium
                    ),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f)
                )
                
                relativeTimeLabel(thread.updatedAt ?: thread.createdAt)?.let { label ->
                    Text(
                        text = label,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }

            Spacer(Modifier.height(2.dp))

            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = thread.projectDisplayName,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f)
                )

                if (isRunning) {
                    Spacer(Modifier.width(8.dp))
                    Text(
                        text = "RUN",
                        style = MaterialTheme.typography.labelSmall.copy(
                            fontWeight = FontWeight.Bold,
                            fontSize = 10.sp
                        ),
                        color = PlanAccent,
                        modifier = Modifier
                            .background(PlanAccent.copy(alpha = 0.1f), RoundedCornerShape(4.dp))
                            .padding(horizontal = 4.dp, vertical = 2.dp)
                    )
                }
            }

            thread.preview?.let { preview ->
                Spacer(Modifier.height(4.dp))
                AnimatedContent(
                    targetState = isSelected,
                    transitionSpec = { fadeIn() togetherWith fadeOut() },
                    label = "previewLines"
                ) { selected ->
                    Text(
                        text = preview.replace('\n', ' '),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = if (selected) 2 else 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.animateContentSize()
                    )
                }
            }
        }
    }
}

@Composable
private fun ProjectPickerItem(
    name: String,
    path: String,
    onClick: () -> Unit,
) {
    Surface(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        color = Color.Transparent,
    ) {
        Row(
            modifier = Modifier.padding(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                Icons.Outlined.Folder,
                contentDescription = null,
                modifier = Modifier.size(24.dp),
                tint = MaterialTheme.colorScheme.primary,
            )
            Spacer(Modifier.width(12.dp))
            Column {
                Text(
                    text = name,
                    style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Bold),
                )
                Text(
                    text = path,
                    style = MaterialTheme.typography.labelSmall.copy(fontFamily = monoFamily),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}
