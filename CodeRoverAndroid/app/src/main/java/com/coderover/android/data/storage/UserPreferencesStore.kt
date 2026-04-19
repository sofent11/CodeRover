package com.coderover.android.data.storage

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json

class UserPreferencesStore(context: Context) {
    private val prefs: SharedPreferences = context.getSharedPreferences("coderover_prefs", Context.MODE_PRIVATE)
    private val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
    }

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

    fun getLastPresentedWhatsNewVersion(): String? {
        return prefs.getString(KEY_LAST_PRESENTED_WHATS_NEW_VERSION, null)
    }

    fun setLastPresentedWhatsNewVersion(version: String?) {
        prefs.edit {
            putString(KEY_LAST_PRESENTED_WHATS_NEW_VERSION, version)
        }
    }

    fun getAssociatedManagedWorktreePaths(): Map<String, String> {
        val encoded = prefs.getString(KEY_ASSOCIATED_MANAGED_WORKTREE_PATHS, null) ?: return emptyMap()
        return runCatching {
            json.decodeFromString(
                MapSerializer(String.serializer(), String.serializer()),
                encoded,
            )
        }.getOrDefault(emptyMap())
    }

    fun setAssociatedManagedWorktreePaths(pathsByThreadId: Map<String, String>) {
        prefs.edit {
            if (pathsByThreadId.isEmpty()) {
                remove(KEY_ASSOCIATED_MANAGED_WORKTREE_PATHS)
            } else {
                putString(
                    KEY_ASSOCIATED_MANAGED_WORKTREE_PATHS,
                    json.encodeToString(
                        MapSerializer(String.serializer(), String.serializer()),
                        pathsByThreadId,
                    ),
                )
            }
        }
    }

    companion object {
        private const val KEY_COLLAPSED_GROUPS = "collapsed_project_group_ids"
        private const val KEY_LAST_PRESENTED_WHATS_NEW_VERSION = "last_presented_whats_new_version"
        private const val KEY_ASSOCIATED_MANAGED_WORKTREE_PATHS = "associated_managed_worktree_paths"
    }
}
