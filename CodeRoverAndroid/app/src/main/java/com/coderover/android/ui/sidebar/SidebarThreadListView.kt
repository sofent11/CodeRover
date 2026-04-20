package com.coderover.android.ui.sidebar

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
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
import com.coderover.android.data.model.ThreadSummary
import com.coderover.android.data.model.ThreadRunBadgeState
import com.coderover.android.data.model.ThreadSyncState
import com.coderover.android.ui.shared.HapticFeedback
import com.coderover.android.ui.shared.relativeTimeLabel
import com.coderover.android.ui.theme.Danger
import com.coderover.android.ui.theme.monoFamily
import com.coderover.android.ui.turn.TurnSessionDiffTotals

@Composable
fun SidebarThreadListView(
    groups: List<SidebarThreadGroup>,
    selectedThreadId: String?,
    runBadgeStateByThreadId: Map<String, ThreadRunBadgeState>,
    diffTotalsByThreadId: Map<String, TurnSessionDiffTotals>,
    collapsedProjectGroupIds: Set<String>,
    onToggleProjectGroupCollapsed: (String) -> Unit,
    onSelectThread: (ThreadSummary) -> Unit,
    onCreateThreadInProject: (String?) -> Unit,
    onRequestRenameThread: (ThreadSummary) -> Unit,
    onRequestDeleteThread: (ThreadSummary) -> Unit,
    onArchiveToggleThread: (ThreadSummary) -> Unit,
    onLoadMoreProjectGroup: (SidebarThreadGroup) -> Unit,
    isFiltering: Boolean,
    isConnected: Boolean,
    isSearchActive: Boolean,
    modifier: Modifier = Modifier,
    bottomContentPadding: Dp = 0.dp,
) {
    var archivedExpanded by rememberSaveable { mutableStateOf(false) }
    var menuThreadId by rememberSaveable { mutableStateOf<String?>(null) }
    var expandedSubagentParentIds by rememberSaveable { mutableStateOf<Set<String>>(emptySet()) }
    val hasVisibleThreads = groups.any { it.threads.isNotEmpty() }

    LaunchedEffect(selectedThreadId, groups) {
        val selectedProjectGroupId = groups.firstOrNull { group ->
            group.kind == SidebarThreadGroupKind.PROJECT && group.threads.any { it.id == selectedThreadId }
        }?.id
        if (selectedProjectGroupId != null && collapsedProjectGroupIds.contains(selectedProjectGroupId)) {
            onToggleProjectGroupCollapsed(selectedProjectGroupId)
        }

        val threadById = groups
            .flatMap { it.threads }
            .associateBy(ThreadSummary::id)
        val selectedThread = selectedThreadId?.let(threadById::get)
        if (selectedThread?.isSubagent == true) {
            val ancestorIds = linkedSetOf<String>()
            var parentId = selectedThread.parentThreadId
            while (!parentId.isNullOrBlank() && ancestorIds.add(parentId)) {
                parentId = threadById[parentId]?.parentThreadId
            }
            expandedSubagentParentIds = expandedSubagentParentIds + ancestorIds
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
                            val hierarchy = buildSidebarSubagentHierarchy(group.threads)
                            hierarchy.rootThreads.forEach { thread ->
                                SidebarThreadTree(
                                    thread = thread,
                                    hierarchy = hierarchy,
                                    depth = 0,
                                    selectedThreadId = selectedThreadId,
                                    runBadgeStateByThreadId = runBadgeStateByThreadId,
                                    diffTotalsByThreadId = diffTotalsByThreadId,
                                    menuThreadId = menuThreadId,
                                    expandedSubagentParentIds = expandedSubagentParentIds,
                                    onToggleSubagentExpansion = { parentId ->
                                        expandedSubagentParentIds = if (expandedSubagentParentIds.contains(parentId)) {
                                            expandedSubagentParentIds - parentId
                                        } else {
                                            expandedSubagentParentIds + parentId
                                        }
                                    },
                                    onSelectThread = onSelectThread,
                                    onExpandMenu = { menuThreadId = it },
                                    onDismissMenu = { menuThreadId = null },
                                    onRequestRenameThread = onRequestRenameThread,
                                    onArchiveToggleThread = onArchiveToggleThread,
                                    onRequestDeleteThread = onRequestDeleteThread,
                                )
                            }
                            if (group.hasMoreThreads) {
                                val haptic = HapticFeedback.rememberHapticFeedback()
                                androidx.compose.foundation.layout.Box(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .clickable {
                                            haptic.triggerImpactFeedback()
                                            onLoadMoreProjectGroup(group)
                                        }
                                        .padding(horizontal = 18.dp, vertical = 8.dp),
                                ) {
                                    Text(
                                        text = "More",
                                        style = MaterialTheme.typography.bodyMedium,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
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
                                    depth = 0,
                                    isSelected = selectedThreadId == thread.id,
                                    runBadgeState = runBadgeStateByThreadId[thread.id],
                                    diffTotals = diffTotalsByThreadId[thread.id],
                                    childSubagentCount = 0,
                                    isSubagentExpanded = false,
                                    isMenuExpanded = menuThreadId == thread.id,
                                    onSelect = { onSelectThread(thread) },
                                    onToggleSubagents = null,
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

@Composable
private fun SidebarThreadTree(
    thread: ThreadSummary,
    hierarchy: SidebarSubagentHierarchy,
    depth: Int,
    selectedThreadId: String?,
    runBadgeStateByThreadId: Map<String, ThreadRunBadgeState>,
    diffTotalsByThreadId: Map<String, TurnSessionDiffTotals>,
    menuThreadId: String?,
    expandedSubagentParentIds: Set<String>,
    onToggleSubagentExpansion: (String) -> Unit,
    onSelectThread: (ThreadSummary) -> Unit,
    onExpandMenu: (String) -> Unit,
    onDismissMenu: () -> Unit,
    onRequestRenameThread: (ThreadSummary) -> Unit,
    onArchiveToggleThread: (ThreadSummary) -> Unit,
    onRequestDeleteThread: (ThreadSummary) -> Unit,
) {
    val childThreads = hierarchy.childrenByParentId[thread.id].orEmpty()
    val isExpanded = expandedSubagentParentIds.contains(thread.id)

    Column {
        SidebarThreadRowView(
            thread = thread,
            depth = depth,
            isSelected = selectedThreadId == thread.id,
            runBadgeState = runBadgeStateByThreadId[thread.id],
            diffTotals = diffTotalsByThreadId[thread.id],
            childSubagentCount = childThreads.size,
            isSubagentExpanded = isExpanded,
            isMenuExpanded = menuThreadId == thread.id,
            onSelect = { onSelectThread(thread) },
            onToggleSubagents = if (childThreads.isNotEmpty()) {
                { onToggleSubagentExpansion(thread.id) }
            } else {
                null
            },
            onExpandMenu = { onExpandMenu(thread.id) },
            onDismissMenu = onDismissMenu,
            onRename = {
                onDismissMenu()
                onRequestRenameThread(thread)
            },
            onArchiveToggle = {
                onDismissMenu()
                onArchiveToggleThread(thread)
            },
            onDelete = {
                onDismissMenu()
                onRequestDeleteThread(thread)
            },
        )

        AnimatedVisibility(visible = isExpanded && childThreads.isNotEmpty()) {
            Column {
                childThreads.forEach { child ->
                    SidebarThreadTree(
                        thread = child,
                        hierarchy = hierarchy,
                        depth = depth + 1,
                        selectedThreadId = selectedThreadId,
                        runBadgeStateByThreadId = runBadgeStateByThreadId,
                        diffTotalsByThreadId = diffTotalsByThreadId,
                        menuThreadId = menuThreadId,
                        expandedSubagentParentIds = expandedSubagentParentIds,
                        onToggleSubagentExpansion = onToggleSubagentExpansion,
                        onSelectThread = onSelectThread,
                        onExpandMenu = onExpandMenu,
                        onDismissMenu = onDismissMenu,
                        onRequestRenameThread = onRequestRenameThread,
                        onArchiveToggleThread = onArchiveToggleThread,
                        onRequestDeleteThread = onRequestDeleteThread,
                    )
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
            .padding(start = 16.dp, top = 18.dp, end = 16.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(
            modifier = Modifier
                .weight(1f)
                .combinedClickable(
                    onClick = {
                        haptic.triggerImpactFeedback()
                        onToggle()
                    },
                    onLongClick = {
                        haptic.triggerImpactFeedback(HapticFeedback.Style.MEDIUM)
                        onToggle()
                    },
                ),
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
                maxLines = 1,
                modifier = Modifier.weight(1f, fill = false),
            )
        }
        Icon(
            imageVector = Icons.Outlined.Add,
            contentDescription = "New chat in project",
            tint = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier
                .size(30.dp)
                .background(
                    MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f),
                    RoundedCornerShape(999.dp)
                )
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
                    haptic.triggerImpactFeedback(HapticFeedback.Style.LIGHT)
                    onToggle()
                },
            )
            .padding(start = 16.dp, top = 18.dp, end = 16.dp, bottom = 10.dp),
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
            maxLines = 1,
            modifier = Modifier.weight(1f, fill = false),
        )
        Spacer(modifier = Modifier.weight(1f))
        Icon(
            imageVector = Icons.AutoMirrored.Outlined.KeyboardArrowRight,
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
    depth: Int,
    isSelected: Boolean,
    runBadgeState: ThreadRunBadgeState?,
    diffTotals: TurnSessionDiffTotals?,
    childSubagentCount: Int,
    isSubagentExpanded: Boolean,
    isMenuExpanded: Boolean,
    onSelect: () -> Unit,
    onToggleSubagents: (() -> Unit)?,
    onExpandMenu: () -> Unit,
    onDismissMenu: () -> Unit,
    onRename: () -> Unit,
    onArchiveToggle: () -> Unit,
    onDelete: () -> Unit,
) {
    val haptic = HapticFeedback.rememberHapticFeedback()
    val leadingPadding = (16 + depth * 18).dp
    val expansionIconTint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.72f)
    Box {
        androidx.compose.foundation.layout.Box(
            modifier = Modifier
                .padding(start = leadingPadding, end = 16.dp)
                .background(
                    if (isSelected) {
                        MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.8f)
                    } else {
                        Color.Transparent
                    },
                    shape = RoundedCornerShape(14.dp),
                )
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
                .padding(vertical = 12.dp, horizontal = 16.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (childSubagentCount > 0 && onToggleSubagents != null) {
                    Icon(
                        imageVector = Icons.AutoMirrored.Outlined.KeyboardArrowRight,
                        contentDescription = null,
                        tint = expansionIconTint,
                        modifier = Modifier
                            .size(18.dp)
                            .graphicsLayer { rotationZ = if (isSubagentExpanded) 90f else 0f }
                            .clickable {
                                haptic.triggerImpactFeedback(HapticFeedback.Style.LIGHT)
                                onToggleSubagents()
                            },
                    )
                } else {
                    Spacer(modifier = Modifier.width(18.dp))
                }

                Row(
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.weight(1f),
                ) {
                    if (!thread.isSubagent && runBadgeState != null) {
                        SidebarThreadRunBadgeView(state = runBadgeState)
                    }
                    SidebarThreadAgentTypeIcon(thread = thread)
                    if (thread.isSubagent) {
                        SidebarSubagentTitle(thread)
                    } else {
                        Text(
                            text = thread.displayTitle,
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Medium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            color = MaterialTheme.colorScheme.onSurface,
                        )
                    }
                }

                Row(
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (thread.syncState == ThreadSyncState.ARCHIVED_LOCAL) {
                        Text(
                            text = "Archived",
                            style = MaterialTheme.typography.labelSmall,
                            fontWeight = FontWeight.Medium,
                            color = androidx.compose.ui.graphics.Color(0xFFFF9800),
                            modifier = Modifier
                                .background(
                                    androidx.compose.ui.graphics.Color(0xFFFF9800).copy(alpha = 0.12f),
                                    RoundedCornerShape(999.dp),
                                )
                                .padding(horizontal = 5.dp, vertical = 2.dp),
                        )
                    }
                    if (diffTotals != null) {
                        Row(horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                            Text(
                                text = "+${diffTotals.additions}",
                                style = MaterialTheme.typography.labelSmall.copy(fontFamily = monoFamily),
                                color = Color(0xFF4CAF50),
                            )
                            Text(
                                text = "-${diffTotals.deletions}",
                                style = MaterialTheme.typography.labelSmall.copy(fontFamily = monoFamily),
                                color = Color(0xFFE53935),
                            )
                        }
                    }
                    relativeTimeLabel(thread.updatedAt ?: thread.createdAt)?.let { label ->
                        Text(
                            text = label,
                            style = if (thread.isSubagent) {
                                MaterialTheme.typography.labelSmall
                            } else {
                                MaterialTheme.typography.bodySmall
                            },
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                        )
                    }
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

@Composable
private fun SidebarThreadAgentTypeIcon(thread: ThreadSummary) {
    val title = when {
        thread.isSubagent -> {
            thread.agentRole?.trim()?.takeIf(String::isNotEmpty)
                ?: parseSubagentLabel(thread.preferredSubagentLabel ?: thread.displayTitle).second
                    .removePrefix(" (")
                    .removeSuffix(")")
                    .trim()
                    .takeIf(String::isNotEmpty)
                ?: thread.providerBadgeTitle
        }
        else -> thread.providerBadgeTitle
    }
    val initial = if (thread.isSubagent) {
        title.firstOrNull { it.isLetterOrDigit() }?.uppercaseChar()?.toString() ?: "A"
    } else {
        thread.providerMonogram
    }
    val tint = subagentNicknameColor(title)

    Box(
        modifier = Modifier
            .size(22.dp)
            .background(tint.copy(alpha = 0.14f), CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = initial,
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.SemiBold,
            color = tint,
            maxLines = 1,
        )
    }
}

@Composable
private fun SidebarSubagentTitle(thread: ThreadSummary) {
    val source = thread.preferredSubagentLabel ?: thread.displayTitle
    val parts = parseSubagentLabel(source)
    Row(horizontalArrangement = Arrangement.spacedBy(0.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(
            text = parts.first.ifEmpty { "Subagent" },
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.SemiBold,
            color = subagentNicknameColor(parts.first.ifEmpty { "Subagent" }),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (parts.second.isNotEmpty()) {
            Text(
                text = parts.second,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

private fun parseSubagentLabel(title: String): Pair<String, String> {
    val trimmed = title.trim()
    if (!trimmed.endsWith("]")) {
        return trimmed to ""
    }
    val openBracket = trimmed.lastIndexOf('[')
    if (openBracket < 0) {
        return trimmed to ""
    }
    val nickname = trimmed.substring(0, openBracket).trim()
    val role = trimmed.substring(openBracket + 1, trimmed.length - 1).trim()
    if (role.isEmpty()) {
        return (nickname.ifEmpty { trimmed }) to ""
    }
    val resolvedName = nickname.ifEmpty { role.replaceFirstChar { it.uppercase() } }
    return resolvedName to " ($role)"
}

private fun subagentNicknameColor(name: String): Color {
    val palette = listOf(
        Color(0xFFE54D4D),
        Color(0xFF4DBF8C),
        Color(0xFF668CF2),
        Color(0xFFD99A40),
        Color(0xFF9C6BE5),
        Color(0xFF35B7C4),
        Color(0xFFE57A94),
        Color(0xFF8CBF40),
    )
    var hash = 5381L
    name.forEach { char ->
        hash = ((hash shl 5) + hash) + char.code
    }
    return palette[(hash % palette.size).toInt().let { if (it < 0) it + palette.size else it }]
}
