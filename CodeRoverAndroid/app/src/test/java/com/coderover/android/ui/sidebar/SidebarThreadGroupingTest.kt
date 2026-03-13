package com.coderover.android.ui.sidebar

import com.coderover.android.data.model.ThreadSummary
import com.coderover.android.data.model.ThreadSyncState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SidebarThreadGroupingTest {
    @Test
    fun buildSidebarThreadGroupsGroupsLiveThreadsByProjectAndAppendsArchivedSection() {
        val groups = buildSidebarThreadGroups(
            threads = listOf(
                thread(
                    id = "live-a",
                    cwd = "/tmp/project-a",
                    updatedAt = 300L,
                ),
                thread(
                    id = "live-b",
                    cwd = "/tmp/project-b",
                    updatedAt = 200L,
                ),
                thread(
                    id = "archived-1",
                    cwd = "/tmp/project-a",
                    updatedAt = 100L,
                    syncState = ThreadSyncState.ARCHIVED_LOCAL,
                ),
            ),
            query = "",
        )

        assertEquals(3, groups.size)
        assertEquals("project:/tmp/project-a", groups[0].id)
        assertEquals("project:/tmp/project-b", groups[1].id)
        assertEquals(SidebarThreadGroupKind.ARCHIVED, groups[2].kind)
        assertEquals(listOf("archived-1"), groups[2].threads.map { it.id })
    }

    @Test
    fun buildSidebarThreadGroupsFiltersByTitleProjectAndPreview() {
        val groups = buildSidebarThreadGroups(
            threads = listOf(
                thread(
                    id = "1",
                    title = "Fix timeline",
                    cwd = "/tmp/project-a",
                    preview = "anchor mode",
                ),
                thread(
                    id = "2",
                    title = "Other",
                    cwd = "/tmp/coderover",
                    preview = "transport candidate",
                ),
            ),
            query = "transport",
        )

        assertEquals(1, groups.size)
        assertEquals(listOf("2"), groups.single().threads.map { it.id })
    }

    @Test
    fun buildSidebarThreadGroupsSortsThreadsWithinProjectByRecentActivity() {
        val groups = buildSidebarThreadGroups(
            threads = listOf(
                thread(
                    id = "older",
                    cwd = "/tmp/project-a",
                    updatedAt = 100L,
                ),
                thread(
                    id = "newer",
                    cwd = "/tmp/project-a",
                    updatedAt = 500L,
                ),
            ),
            query = "",
        )

        assertTrue(groups.isNotEmpty())
        assertEquals(listOf("newer", "older"), groups.first().threads.map { it.id })
    }

    private fun thread(
        id: String,
        title: String = id,
        cwd: String? = null,
        preview: String? = null,
        updatedAt: Long? = null,
        syncState: ThreadSyncState = ThreadSyncState.LIVE,
    ): ThreadSummary {
        return ThreadSummary(
            id = id,
            title = title,
            preview = preview,
            updatedAt = updatedAt,
            cwd = cwd,
            syncState = syncState,
        )
    }
}
