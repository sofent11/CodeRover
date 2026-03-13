package com.coderover.android.ui

import com.coderover.android.data.model.AccessMode
import com.coderover.android.data.model.AppFontStyle
import com.coderover.android.data.model.AppState
import com.coderover.android.data.model.ConnectionPhase
import com.coderover.android.data.model.PairingRecord
import com.coderover.android.data.model.PhoneIdentityState
import com.coderover.android.data.model.ThreadSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ContentViewModelTest {
    @Test
    fun shouldAttemptAutoConnectOnlyOnceWhenSavedPairingExists() {
        val viewModel = ContentViewModel()
        val state = appState(pairings = listOf(pairingRecord()))

        assertTrue(viewModel.shouldAttemptAutoConnect(state))
        assertFalse(viewModel.shouldAttemptAutoConnect(state))
    }

    @Test
    fun shouldReconnectOnForegroundResumeSkipsInitialResumeThenReconnects() {
        val viewModel = ContentViewModel()
        val state = appState(pairings = listOf(pairingRecord()))

        assertFalse(viewModel.shouldReconnectOnForegroundResume(state))
        assertTrue(viewModel.shouldReconnectOnForegroundResume(state))
    }

    @Test
    fun shouldNotReconnectWhileManualPairingIsVisible() {
        val viewModel = ContentViewModel()
        val state = appState(pairings = listOf(pairingRecord()))
        viewModel.startPairingFlow(ConnectionPhase.OFFLINE)

        assertFalse(viewModel.shouldAttemptForegroundReconnect(state))
    }

    @Test
    fun shouldNotReconnectWhileSettingsAreVisible() {
        val viewModel = ContentViewModel()
        val state = appState(pairings = listOf(pairingRecord()))
        viewModel.openSettings()

        assertFalse(viewModel.shouldAttemptForegroundReconnect(state))
    }

    @Test
    fun shouldNotAutoConnectWhilePendingTransportSelectionExists() {
        val viewModel = ContentViewModel()
        val state = appState(
            pairings = listOf(pairingRecord()),
            pendingTransportSelectionMacDeviceId = "mac-1",
        )

        assertFalse(viewModel.shouldAttemptAutoConnect(state))
        assertFalse(viewModel.shouldAttemptForegroundReconnect(state))
    }

    @Test
    fun maybeDismissPairingEntryClosesPairingAfterConnectionPhaseChanges() {
        val viewModel = ContentViewModel()
        viewModel.startPairingFlow(ConnectionPhase.OFFLINE)
        viewModel.markPairingSubmission()

        val shouldDismiss = viewModel.maybeDismissPairingEntry(
            appState(
                pairings = listOf(pairingRecord()),
                activePairingMacDeviceId = "mac-1",
                connectionPhase = ConnectionPhase.CONNECTING,
            ),
        )

        assertTrue(shouldDismiss)
        assertEquals(AppShellContent.EMPTY, viewModel.shellContent(appState()))
    }

    @Test
    fun maybeDismissPairingEntryStaysVisibleWhileTransportSelectionIsPending() {
        val viewModel = ContentViewModel()
        viewModel.startPairingFlow(ConnectionPhase.OFFLINE)
        viewModel.markPairingSubmission()

        val shouldDismiss = viewModel.maybeDismissPairingEntry(
            appState(
                pairings = listOf(pairingRecord()),
                activePairingMacDeviceId = "mac-1",
                pendingTransportSelectionMacDeviceId = "mac-1",
            ),
        )

        assertFalse(shouldDismiss)
        assertEquals(AppShellContent.PAIRING, viewModel.shellContent(appState()))
    }

    @Test
    fun shellContentReflectsSettingsPairingAndThreadPriority() {
        val viewModel = ContentViewModel()
        val threadState = appState(selectedThreadId = "thread-1", threads = listOf(threadSummary("thread-1")))

        assertEquals(AppShellContent.THREAD, viewModel.shellContent(threadState))

        viewModel.openSettings()
        assertEquals(AppShellContent.SETTINGS, viewModel.shellContent(threadState))

        viewModel.closeSettings()
        viewModel.startPairingFlow(ConnectionPhase.OFFLINE)
        assertEquals(AppShellContent.PAIRING, viewModel.shellContent(threadState))
    }

    private fun appState(
        pairings: List<PairingRecord> = emptyList(),
        activePairingMacDeviceId: String? = null,
        connectionPhase: ConnectionPhase = ConnectionPhase.OFFLINE,
        selectedThreadId: String? = null,
        threads: List<ThreadSummary> = emptyList(),
        pendingTransportSelectionMacDeviceId: String? = null,
    ): AppState {
        return AppState(
            onboardingSeen = true,
            fontStyle = AppFontStyle.SYSTEM,
            accessMode = AccessMode.ON_REQUEST,
            pairings = pairings,
            activePairingMacDeviceId = activePairingMacDeviceId,
            phoneIdentityState = PhoneIdentityState(
                phoneDeviceId = "phone-1",
                phoneIdentityPrivateKey = "private",
                phoneIdentityPublicKey = "public",
            ),
            connectionPhase = connectionPhase,
            threads = threads,
            selectedThreadId = selectedThreadId,
            pendingTransportSelectionMacDeviceId = pendingTransportSelectionMacDeviceId,
        )
    }

    private fun pairingRecord(): PairingRecord {
        return PairingRecord(
            bridgeId = "bridge-1",
            macDeviceId = "mac-1",
            macIdentityPublicKey = "pub",
            transportCandidates = emptyList(),
        )
    }

    private fun threadSummary(id: String): ThreadSummary {
        return ThreadSummary(
            id = id,
            title = "Thread",
        )
    }
}
