package com.coderover.android.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.coderover.android.data.model.AppState
import com.coderover.android.data.model.ConnectionPhase

internal enum class AppShellContent {
    SETTINGS,
    PAIRING,
    ARCHIVED_CHATS,
    THREAD,
    EMPTY,
}

internal class ContentViewModel {
    private var hasAttemptedInitialAutoConnect by mutableStateOf(false)
    private var hasObservedInitialResume by mutableStateOf(false)
    private var lastSidebarOpenSyncAt by mutableLongStateOf(0L)

    var showSettings by mutableStateOf(false)
        private set

    var showArchivedChats by mutableStateOf(false)
        private set

    var showPairingEntry by mutableStateOf(false)
        private set

    var pendingPairingDismiss by mutableStateOf(false)
        private set

    var pairingEntryBaselinePhase by mutableStateOf(ConnectionPhase.OFFLINE)
        private set

    fun shellContent(state: AppState): AppShellContent {
        return when {
            showArchivedChats -> AppShellContent.ARCHIVED_CHATS
            showSettings -> AppShellContent.SETTINGS
            showPairingEntry -> AppShellContent.PAIRING
            state.selectedThread != null -> AppShellContent.THREAD
            else -> AppShellContent.EMPTY
        }
    }

    fun shouldAttemptAutoConnect(state: AppState): Boolean {
        if (hasAttemptedInitialAutoConnect ||
            state.pairings.isEmpty() ||
            state.isConnected ||
            state.pendingTransportSelectionMacDeviceId != null
        ) {
            return false
        }
        hasAttemptedInitialAutoConnect = true
        return true
    }

    fun shouldAttemptForegroundReconnect(state: AppState): Boolean {
        return state.pairings.isNotEmpty() &&
            !state.isConnected &&
            state.pendingTransportSelectionMacDeviceId == null &&
            !showSettings &&
            !showPairingEntry
    }

    fun shouldReconnectOnForegroundResume(state: AppState): Boolean {
        if (!hasObservedInitialResume) {
            hasObservedInitialResume = true
            return false
        }
        return shouldAttemptForegroundReconnect(state)
    }

    fun shouldRequestSidebarFreshSync(isConnected: Boolean): Boolean {
        if (!isConnected) {
            return false
        }
        val now = System.currentTimeMillis()
        if (now - lastSidebarOpenSyncAt < 800L) {
            return false
        }
        lastSidebarOpenSyncAt = now
        return true
    }

    fun openSettings() {
        showPairingEntry = false
        showArchivedChats = false
        showSettings = true
    }

    fun closeSettings() {
        showSettings = false
    }

    fun openArchivedChats() {
        showPairingEntry = false
        showSettings = false
        showArchivedChats = true
    }

    fun closeArchivedChats() {
        showArchivedChats = false
        // Opening archived chats means we are probably in settings,
        // but if we just close it, we fall back to thread or empty.
        // Wait, in iOS ArchivedChats is pushed onto the nav stack on top of Settings.
        // To approximate this, we just go back to Settings.
        showSettings = true
    }

    fun startPairingFlow(currentPhase: ConnectionPhase) {
        showSettings = false
        showArchivedChats = false
        pairingEntryBaselinePhase = currentPhase
        pendingPairingDismiss = false
        showPairingEntry = true
    }

    fun markPairingSubmission() {
        pendingPairingDismiss = true
    }

    fun clearPairingPendingDismiss() {
        pendingPairingDismiss = false
    }

    fun closePairingFlow() {
        pendingPairingDismiss = false
        showPairingEntry = false
    }

    fun selectThread() {
        showSettings = false
        showArchivedChats = false
        showPairingEntry = false
        pendingPairingDismiss = false
    }

    fun maybeDismissPairingEntry(state: AppState): Boolean {
        if (!showPairingEntry || !pendingPairingDismiss) {
            return false
        }
        if (state.lastErrorMessage != null) {
            pendingPairingDismiss = false
            return false
        }
        if (state.pendingTransportSelectionMacDeviceId != null) {
            return false
        }
        if (state.connectionPhase != pairingEntryBaselinePhase || state.activePairingMacDeviceId != null) {
            showPairingEntry = false
            pendingPairingDismiss = false
            return true
        }
        return false
    }
}
