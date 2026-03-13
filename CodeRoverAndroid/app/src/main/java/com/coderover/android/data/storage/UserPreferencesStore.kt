package com.coderover.android.data.storage

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit

class UserPreferencesStore(context: Context) {
    private val prefs: SharedPreferences = context.getSharedPreferences("coderover_prefs", Context.MODE_PRIVATE)

    fun getCollapsedProjectGroupIds(): Set<String> {
        return prefs.getStringSet(KEY_COLLAPSED_GROUPS, emptySet()) ?: emptySet()
    }

    fun setCollapsedProjectGroupIds(groupIds: Set<String>) {
        prefs.edit {
            putStringSet(KEY_COLLAPSED_GROUPS, groupIds)
        }
    }

    fun isCollapsed(groupId: String): Boolean {
        return getCollapsedProjectGroupIds().contains(groupId)
    }

    fun toggleCollapsed(groupId: String) {
        val current = getCollapsedProjectGroupIds().toMutableSet()
        if (current.contains(groupId)) {
            current.remove(groupId)
        } else {
            current.add(groupId)
        }
        setCollapsedProjectGroupIds(current)
    }

    companion object {
        private const val KEY_COLLAPSED_GROUPS = "collapsed_project_group_ids"
    }
}
