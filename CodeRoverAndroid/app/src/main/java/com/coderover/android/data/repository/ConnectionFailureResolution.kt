package com.coderover.android.data.repository

import com.coderover.android.data.model.SecureConnectionState
import com.coderover.android.data.model.blocksAutomaticReconnect

internal data class ConnectionFailureResolution(
    val secureConnectionState: SecureConnectionState,
    val shouldStopTryingOtherTransports: Boolean,
)

internal fun resolveConnectionFailure(
    failure: Throwable,
    fallback: SecureConnectionState,
): ConnectionFailureResolution {
    val message = failure.message?.lowercase().orEmpty()
    val secureState = when {
        message.isEmpty() -> fallback
        message.contains("update required") -> SecureConnectionState.UPDATE_REQUIRED
        message.contains("scan a new qr code to pair again") ||
            message.contains("scan a fresh qr code to pair again") ||
            message.contains("bridge pairing is no longer valid") ||
            message.contains("pair again") ||
            message.contains("not trusted by the current bridge session") ||
            message.contains("trusted iphone identity does not match") ||
            message.contains("pairing qr code has expired") ||
            message.contains("secure mac identity does not match the paired device") ||
            message.contains("secure handshake returned the wrong bridge session") ||
            message.contains("secure handshake returned the wrong mac device")
            -> SecureConnectionState.RE_PAIR_REQUIRED
        else -> fallback
    }

    return ConnectionFailureResolution(
        secureConnectionState = secureState,
        shouldStopTryingOtherTransports = secureState.blocksAutomaticReconnect,
    )
}
