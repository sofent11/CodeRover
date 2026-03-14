package com.coderover.android.data.repository

import com.coderover.android.data.model.SecureConnectionState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectionFailureResolutionTest {
    @Test
    fun staleBridgePairingStopsTryingOtherTransports() {
        val resolution = resolveConnectionFailure(
            failure = IllegalStateException("This bridge pairing is no longer valid. Scan a new QR code to pair again."),
            fallback = SecureConnectionState.TRUSTED_MAC,
        )

        assertEquals(SecureConnectionState.RE_PAIR_REQUIRED, resolution.secureConnectionState)
        assertTrue(resolution.shouldStopTryingOtherTransports)
    }

    @Test
    fun updateRequiredStopsTryingOtherTransports() {
        val resolution = resolveConnectionFailure(
            failure = IllegalStateException("Update required before reconnecting to this bridge."),
            fallback = SecureConnectionState.TRUSTED_MAC,
        )

        assertEquals(SecureConnectionState.UPDATE_REQUIRED, resolution.secureConnectionState)
        assertTrue(resolution.shouldStopTryingOtherTransports)
    }

    @Test
    fun transientTimeoutKeepsTryingOtherTransports() {
        val resolution = resolveConnectionFailure(
            failure = IllegalStateException("Connection timed out. Check the selected bridge transport and network."),
            fallback = SecureConnectionState.TRUSTED_MAC,
        )

        assertEquals(SecureConnectionState.TRUSTED_MAC, resolution.secureConnectionState)
        assertFalse(resolution.shouldStopTryingOtherTransports)
    }
}
