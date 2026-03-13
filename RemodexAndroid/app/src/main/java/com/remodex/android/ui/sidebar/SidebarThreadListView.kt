package com.remodex.android.ui.sidebar

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.DriveFileRenameOutline
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.sp
import com.remodex.android.data.model.ThreadSummary
import com.remodex.android.data.model.ThreadSyncState
import com.remodex.android.ui.shared.HapticFeedback
import com.remodex.android.ui.shared.relativeTimeLabel
import com.remodex.android.ui.shared.StatusTag
import com.remodex.android.ui.theme.Danger
import com.remodex.android.ui.theme.PlanAccent

@Composable
fun SidebarThreadListView(
    groups: List<SidebarThreadGroup>,
    selectedThreadId: String?,
    runningThreadIds: Set<String>,
    collapsedProjectGroupIds: Set<String>,
    onToggleProjectGroupCollapsed: (String) -> Unit,
    onSelectThread: (ThreadSummary) -> Unit,
    onCreateThreadInProject: (String?) -> Unit,
    onRequestRenameThread: (ThreadSummary) -> Unit,
    onRequestDeleteThread: (ThreadSummary) -> Unit,
    onArchiveToggleThread: (ThreadSummary) -> Unit,
    isFiltering: Boolean,
    isConnected: Boolean,
    isSearchActive: Boolean,
    modifier: Modifier = Modifier,
    bottomContentPadding: Dp = 0.dp,
) {
    var archivedExpanded by rememberSaveable { mutableStateOf(false) }
    var menuThreadId by rememberSaveable { mutableStateOf<String?>(null) }
    val hasVisibleThreads = groups.any { it.threads.isNotEmpty() }

    LaunchedEffect(selectedThreadId, groups) {
        val selectedProjectGroupId = groups.firstOrNull { group ->
            group.kind == SidebarThreadGroupKind.PROJECT && group.threads.any { it.id == selectedThreadId }
        }?.id
        if (selectedProjectGroupId != null && collapsedProjectGroupIds.contains(selectedProjectGroupId)) {
            onToggleProjectGroupCollapsed(selectedProjectGroupId)
        }
    }

    if (!hasVisibleThreads) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 20.dp),
        ) {
            Text(
                text = if (isFiltering) "No matching conversations" else if (isConnected) "No conversations" else "Connect to view conversations",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        return
    }

    LazyColumn(
        verticalArrangement = Arrangement.Top,
        modifier = modifier.fillMaxWidth(),
        contentPadding = PaddingValues(bottom = bottomContentPadding),
    ) {
        items(groups, key = { it.id }) { group ->
            when (group.kind) {
                SidebarThreadGroupKind.PROJECT -> {
                    val expanded = !collapsedProjectGroupIds.contains(group.id)
                    SidebarProjectGroupHeader(
                        label = group.label,
                        expanded = expanded,
                        onToggle = { onToggleProjectGroupCollapsed(group.id) },
                        onCreate = { onCreateThreadInProject(group.projectPath) },
                    )
                    AnimatedVisibility(visible = expanded) {
                        Column {
                            group.threads.forEach { thread ->
                                SidebarThreadRowView(
                                    thread = thread,
                                    isSelected = selectedThreadId == thread.id,
                                    isRunning = runningThreadIds.contains(thread.id),
                                    isMenuExpanded = menuThreadId == thread.id,
                                    onSelect = { onSelectThread(thread) },
                                    onExpandMenu = { menuThreadId = thread.id },
                                    onDismissMenu = { menuThreadId = null },
                                    onRename = {
                                        menuThreadId = null
                                        onRequestRenameThread(thread)
                                    },
                                    onArchiveToggle = {
                                        menuThreadId = null
                                        onArchiveToggleThread(thread)
                                    },
                                    onDelete = {
                                        menuThreadId = null
                                        onRequestDeleteThread(thread)
                                    },
                                )
                            }
                        }
                    }
                }

                SidebarThreadGroupKind.ARCHIVED -> {
                    SidebarArchivedGroupHeader(
                        expanded = archivedExpanded || isSearchActive,
                        onToggle = { archivedExpanded = !archivedExpanded },
                    )
                    AnimatedVisibility(visible = archivedExpanded || isSearchActive) {
                        Column {
                            group.threads.forEach { thread ->
                                SidebarThreadRowView(
                                    thread = thread,
                                    isSelected = selectedThreadId == thread.id,
                                    isRunning = runningThreadIds.contains(thread.id),
                                    isMenuExpanded = menuThreadId == thread.id,
                                    onSelect = { onSelectThread(thread) },
                                    onExpandMenu = { menuThreadId = thread.id },
                                    onDismissMenu = { menuThreadId = null },
                                    onRename = {
                                        menuThreadId = null
                                        onRequestRenameThread(thread)
                                    },
                                    onArchiveToggle = {
                                        menuThreadId = null
                                        onArchiveToggleThread(thread)
                                    },
                                    onDelete = {
                                        menuThreadId = null
                                        onRequestDeleteThread(thread)
                                    },
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SidebarProjectGroupHeader(
    label: String,
    expanded: Boolean,
    onToggle: () -> Unit,
    onCreate: () -> Unit,
) {
    val haptic = HapticFeedback.rememberHapticFeedback()
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .combinedClickable(
                onClick = {
                    haptic.triggerImpactFeedback()
                    onToggle()
                },
                onLongClick = {
                    haptic.triggerImpactFeedback(HapticFeedback.Style.MEDIUM)
                    onToggle()
                },
            )
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(
            modifier = Modifier.weight(1f),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(
                imageVector = Icons.Outlined.Folder,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurface,
            )
            Text(
                text = label,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f),
            )
            Icon(
                imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier
                    .size(18.dp)
                    .graphicsLayer { rotationZ = if (expanded) 90f else 0f },
            )
        }
        Icon(
            imageVector = Icons.Outlined.Add,
            contentDescription = "New chat in project",
            tint = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier
                .size(30.dp)
                .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f), RoundedCornerShape(999.dp))
                .padding(6.dp)
                .combinedClickable(
                    onClick = {
                        haptic.triggerImpactFeedback(HapticFeedback.Style.MEDIUM)
                        onCreate()
                    },
                    onLongClick = {
                        haptic.triggerImpactFeedback(HapticFeedback.Style.MEDIUM)
                        onCreate()
                    }
                ),
        )
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SidebarArchivedGroupHeader(
    expanded: Boolean,
    onToggle: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .combinedClickable(onClick = onToggle, onLongClick = onToggle)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(
            imageVector = Icons.Outlined.Archive,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurface,
        )
        Text(
            text = "Archived",
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.weight(1f),
        )
        Icon(
            imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier
                .size(18.dp)
                .graphicsLayer { rotationZ = if (expanded) 90f else 0f },
        )
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SidebarThreadRowView(
    thread: ThreadSummary,
    isSelected: Boolean,
    isRunning: Boolean,
    isMenuExpanded: Boolean,
    onSelect: () -> Unit,
    onExpandMenu: () -> Unit,
    onDismissMenu: () -> Unit,
    onRename: () -> Unit,
    onArchiveToggle: () -> Unit,
    onDelete: () -> Unit,
) {
    val haptic = HapticFeedback.rememberHapticFeedback()
    Box {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .combinedClickable(
                    onClick = {
                        haptic.triggerImpactFeedback()
                        onSelect()
                    },
                    onLongClick = {
                        haptic.triggerImpactFeedback(HapticFeedback.Style.MEDIUM)
                        onExpandMenu()
                    },
                )
                .background(
                    if (isSelected) MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.32f) else Color.Transparent,
                )
                .padding(vertical = 12.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Box(
                modifier = Modifier
                    .width(2.dp)
                    .height(52.dp)
                    .background(
                        if (isSelected) MaterialTheme.colorScheme.primary else Color.Transparent,
                    ),
            )
            Column(
                modifier = Modifier
                    .weight(1f)
                    .padding(start = 14.dp, end = 16.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    if (isRunning) {
                        Text(
                            text = "RUN",
                            style = MaterialTheme.typography.labelSmall.copy(
                                fontWeight = FontWeight.Bold,
                                fontSize = 10.sp,
                            ),
                            color = PlanAccent,
                            modifier = Modifier
                                .background(PlanAccent.copy(alpha = 0.1f), RoundedCornerShape(999.dp))
                                .padding(horizontal = 6.dp, vertical = 2.dp),
                        )
                    }
                    Text(
                        text = thread.displayTitle,
                        style = MaterialTheme.typography.bodyLarge,
                        fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Medium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    relativeTimeLabel(thread.updatedAt ?: thread.createdAt)?.let { label ->
                        Text(
                            text = label,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }

                Row(verticalAlignment = Alignment.CenterVertically) {
                    StatusTag(
                        text = thread.providerBadgeTitle,
                        containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.75f),
                        contentColor = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.width(8.dp))
                    if (thread.syncState == ThreadSyncState.ARCHIVED_LOCAL) {
                        Text(
                            text = "Archived",
                            style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Medium),
                            color = MaterialTheme.colorScheme.tertiary,
                            modifier = Modifier
                                .background(
                                    MaterialTheme.colorScheme.tertiary.copy(alpha = 0.12f),
                                    RoundedCornerShape(999.dp),
                                )
                                .padding(horizontal = 6.dp, vertical = 2.dp),
                        )
                        Spacer(Modifier.width(8.dp))
                    }
                    Text(
                        text = thread.projectDisplayName,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.72f),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                }

                thread.preview?.takeIf { it.isNotBlank() }?.let { preview ->
                    Text(
                        text = preview.replace('\n', ' '),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = if (isSelected) 2 else 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }

        DropdownMenu(
            expanded = isMenuExpanded,
            onDismissRequest = onDismissMenu,
        ) {
            DropdownMenuItem(
                text = { Text("Rename") },
                onClick = onRename,
                leadingIcon = {
                    Icon(Icons.Outlined.DriveFileRenameOutline, contentDescription = null)
                },
            )
            DropdownMenuItem(
                text = {
                    Text(
                        if (thread.syncState == ThreadSyncState.LIVE) "Archive" else "Unarchive",
                    )
                },
                onClick = onArchiveToggle,
                leadingIcon = {
                    Icon(Icons.Outlined.Archive, contentDescription = null)
                },
            )
            DropdownMenuItem(
                text = { Text("Delete", color = Danger) },
                onClick = onDelete,
                leadingIcon = {
                    Icon(Icons.Outlined.Delete, contentDescription = null, tint = Danger)
                },
            )
        }
    }
}
