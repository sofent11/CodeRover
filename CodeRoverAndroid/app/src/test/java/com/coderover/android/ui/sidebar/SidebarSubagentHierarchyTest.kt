package com.coderover.android.ui.sidebar

import com.coderover.android.data.model.ThreadSummary
import org.junit.Assert.assertEquals
import org.junit.Test

class SidebarSubagentHierarchyTest {
    @Test
    fun buildSidebarSubagentHierarchyNestsChildThreadsUnderParent() {
        val hierarchy = buildSidebarSubagentHierarchy(
            listOf(
                ThreadSummary(id = "parent", title = "Parent", updatedAt = 300L),
                ThreadSummary(id = "child-a", parentThreadId = "parent", agentNickname = "Scout", updatedAt = 200L),
                ThreadSummary(id = "child-b", parentThreadId = "parent", agentNickname = "Builder", updatedAt = 100L),
            ),
        )

        assertEquals(listOf("parent"), hierarchy.rootThreads.map { it.id })
        assertEquals(listOf("child-a", "child-b"), hierarchy.childrenByParentId["parent"]?.map { it.id })
    }
}
