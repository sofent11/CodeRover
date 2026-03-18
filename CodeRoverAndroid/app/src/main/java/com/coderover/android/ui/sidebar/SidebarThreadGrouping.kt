package com.coderover.android.ui.sidebar

import com.coderover.android.data.model.ThreadSummary
import com.coderover.android.data.model.ThreadSyncState

enum class SidebarThreadGroupKind {
    PROJECT,
    ARCHIVED,
}

data class SidebarThreadGroup(
    val id: String,
    val label: String,
    val projectPath: String? = null,
    val kind: SidebarThreadGroupKind,
    val threads: List<ThreadSummary>,
    val totalThreadCount: Int,
)

val SidebarThreadGroup.hasMoreThreads: Boolean
    get() = kind == SidebarThreadGroupKind.PROJECT && threads.size < totalThreadCount

data class SidebarSubagentHierarchy(
    val rootThreads: List<ThreadSummary>,
    val childrenByParentId: Map<String, List<ThreadSummary>>,
)

fun buildSidebarThreadGroups(
    threads: List<ThreadSummary>,
    query: String,
    visibleCountByProjectId: Map<String, Int> = emptyMap(),
): List<SidebarThreadGroup> {
    val normalizedQuery = query.trim()
    val filteredThreads = if (normalizedQuery.isEmpty()) {
        threads
    } else {
        threads.filter { thread ->
            thread.displayTitle.contains(normalizedQuery, ignoreCase = true) ||
                thread.projectDisplayName.contains(normalizedQuery, ignoreCase = true) ||
                thread.preview.orEmpty().contains(normalizedQuery, ignoreCase = true)
        }
    }

    val liveProjectGroups = filteredThreads
        .filter { it.syncState == ThreadSyncState.LIVE }
        .groupBy { it.normalizedProjectPath ?: "__no_project__" }
        .map { (projectKey, groupThreads) ->
            val representative = groupThreads.first()
            SidebarThreadGroup(
                id = "project:$projectKey",
                label = representative.projectDisplayName,
                projectPath = representative.normalizedProjectPath,
                kind = SidebarThreadGroupKind.PROJECT,
                threads = groupThreads
                    .sortedByDescending { it.updatedAt ?: it.createdAt ?: 0L }
                    .take((visibleCountByProjectId["project:$projectKey"] ?: 10).coerceAtLeast(10)),
                totalThreadCount = groupThreads.size,
            )
        }
        .sortedWith(
            compareByDescending<SidebarThreadGroup> {
                it.threads.maxOfOrNull { thread -> thread.updatedAt ?: thread.createdAt ?: 0L } ?: 0L
            }.thenBy { it.label.lowercase() },
        )

    val archivedThreads = filteredThreads
        .filter { it.syncState == ThreadSyncState.ARCHIVED_LOCAL }
        .sortedByDescending { it.updatedAt ?: it.createdAt ?: 0L }

    return buildList {
        addAll(liveProjectGroups)
        if (archivedThreads.isNotEmpty()) {
            add(
                SidebarThreadGroup(
                    id = "archived",
                    label = "Archived",
                    kind = SidebarThreadGroupKind.ARCHIVED,
                    threads = archivedThreads,
                    totalThreadCount = archivedThreads.size,
                ),
            )
        }
    }
}

fun buildSidebarSubagentHierarchy(groupThreads: List<ThreadSummary>): SidebarSubagentHierarchy {
    val sortedThreads = groupThreads.sortedByDescending { it.updatedAt ?: it.createdAt ?: 0L }
    val childrenByParentId = sortedThreads
        .filter(ThreadSummary::isSubagent)
        .groupBy { it.parentThreadId.orEmpty() }
        .mapValues { (_, children) ->
            children.sortedByDescending { it.updatedAt ?: it.createdAt ?: 0L }
        }

    val threadIds = sortedThreads.map(ThreadSummary::id).toSet()
    val rootThreads = sortedThreads.filter { thread ->
        val parentId = thread.parentThreadId
        parentId.isNullOrBlank() || parentId !in threadIds
    }

    return SidebarSubagentHierarchy(
        rootThreads = rootThreads,
        childrenByParentId = childrenByParentId,
    )
}
