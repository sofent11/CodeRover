package com.coderover.android.ui.turn

import com.coderover.android.data.model.AppState
import com.coderover.android.data.model.ConnectionPhase
import com.coderover.android.data.model.ThreadHistoryState
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TurnComposerControlsTest {
    @Test
    fun hidesDisconnectedBannerWhileConnectedTransportIsHydrating() {
        val state = AppState(
            connectionPhase = ConnectionPhase.SYNCING,
            selectedThreadId = "thread-1",
        )

        assertFalse(shouldShowComposerDisconnectedBanner(state, "thread-1"))
    }

    @Test
    fun hidesDisconnectedBannerWhenThreadRefreshIsActiveDespiteStaleOfflinePhase() {
        val state = AppState(
            connectionPhase = ConnectionPhase.OFFLINE,
            selectedThreadId = "thread-1",
            historyStateByThread = mapOf(
                "thread-1" to ThreadHistoryState(isTailRefreshing = true),
            ),
        )

        assertFalse(shouldShowComposerDisconnectedBanner(state, "thread-1"))
    }

    @Test
    fun showsDisconnectedBannerWhenOfflineAndNotRefreshing() {
        val state = AppState(
            connectionPhase = ConnectionPhase.OFFLINE,
            selectedThreadId = "thread-1",
        )

        assertTrue(shouldShowComposerDisconnectedBanner(state, "thread-1"))
    }
}
