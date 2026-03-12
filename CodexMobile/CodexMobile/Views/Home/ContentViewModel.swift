// FILE: ContentViewModel.swift
// Purpose: Owns non-visual orchestration logic for the root screen (bridge pairing, connection, sync throttling).
// Layer: ViewModel
// Exports: ContentViewModel
// Depends on: Foundation, Observation, CodexService, SecureStore

import Foundation
import Observation

@MainActor
@Observable
final class ContentViewModel {
    private var hasAttemptedInitialAutoConnect = false
    private var lastSidebarOpenSyncAt: Date = .distantPast
    private let autoReconnectBackoffNanoseconds: [UInt64] = [1_000_000_000, 3_000_000_000]
    private(set) var isRunningForegroundReconnectLoop = false

    var isAttemptingAutoReconnect: Bool {
        isRunningForegroundReconnectLoop
    }

    // Throttles sidebar-open sync requests to avoid redundant thread refresh churn.
    func shouldRequestSidebarFreshSync(isConnected: Bool) -> Bool {
        guard isConnected else {
            return false
        }

        let now = Date()
        guard now.timeIntervalSince(lastSidebarOpenSyncAt) >= 0.8 else {
            return false
        }

        lastSidebarOpenSyncAt = now
        return true
    }

    // Connects to the local/tailnet bridge using a scanned QR code payload.
    func connectToBridge(
        pairingPayload: CodexPairingQRPayload,
        codex: CodexService,
        preferredTransportURL: String? = nil
    ) async {
        await stopAutoReconnectForManualScan(codex: codex)
        codex.rememberBridgePairing(pairingPayload)

        do {
            if let preferredTransportURL = preferredTransportURL?
                .trimmingCharacters(in: .whitespacesAndNewlines),
               !preferredTransportURL.isEmpty {
                try await connectWithAutoRecovery(
                    codex: codex,
                    serverURL: preferredTransportURL,
                    performAutoRetry: true
                )
                codex.rememberSuccessfulTransportURL(preferredTransportURL)
            } else {
                try await connectUsingSavedPairing(codex: codex, performAutoRetry: true)
            }
        } catch {
            if codex.lastErrorMessage?.isEmpty ?? true {
                codex.lastErrorMessage = codex.userFacingConnectFailureMessage(error)
            }
        }
    }

    // Connects or disconnects the paired bridge.
    func toggleConnection(codex: CodexService) async {
        guard !codex.isConnecting, !isRunningForegroundReconnectLoop else {
            return
        }

        if codex.isConnected {
            await codex.disconnect()
            return
        }

        guard codex.hasSavedBridgePairing else {
            return
        }

        do {
            try await connectUsingSavedPairing(codex: codex, performAutoRetry: true)
        } catch {
            if codex.lastErrorMessage?.isEmpty ?? true {
                codex.lastErrorMessage = codex.userFacingConnectFailureMessage(error)
            }
        }
    }

    func stopForegroundAutoReconnect(
        codex: CodexService,
        clearLastErrorMessage: Bool
    ) async {
        codex.shouldAutoReconnectOnForeground = false
        codex.connectionRecoveryState = .idle
        if clearLastErrorMessage {
            codex.lastErrorMessage = nil
        }

        while isRunningForegroundReconnectLoop || codex.isConnecting {
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
    }

    // Lets the manual QR flow take over instead of competing with the foreground reconnect loop.
    func stopAutoReconnectForManualScan(codex: CodexService) async {
        await stopForegroundAutoReconnect(codex: codex, clearLastErrorMessage: true)
    }

    // Keeps Settings from implicitly restarting a reconnect loop the user did not request.
    func stopAutoReconnectForSettings(codex: CodexService) async {
        await stopForegroundAutoReconnect(codex: codex, clearLastErrorMessage: false)
    }

    func switchSavedBridgePairing(
        macDeviceId: String,
        codex: CodexService
    ) async {
        let wasConnected = codex.isConnected
        await stopAutoReconnectForSettings(codex: codex)
        guard codex.setActiveSavedBridgePairing(macDeviceId: macDeviceId) else {
            return
        }

        guard wasConnected else {
            codex.lastErrorMessage = nil
            return
        }

        do {
            try await connectUsingSavedPairing(codex: codex, performAutoRetry: true)
        } catch {
            if codex.lastErrorMessage?.isEmpty ?? true {
                codex.lastErrorMessage = codex.userFacingConnectFailureMessage(error)
            }
        }
    }

    func removeSavedBridgePairing(
        macDeviceId: String,
        codex: CodexService
    ) async {
        let wasConnected = codex.isConnected
        let wasActivePairing = codex.activeSavedBridgePairing?.macDeviceId == macDeviceId
        await stopAutoReconnectForSettings(codex: codex)

        if wasConnected && wasActivePairing {
            await codex.disconnect()
        }

        codex.removeSavedBridgePairing(macDeviceId: macDeviceId)
        codex.lastErrorMessage = nil

        guard wasConnected && codex.hasSavedBridgePairing else {
            return
        }

        do {
            try await connectUsingSavedPairing(codex: codex, performAutoRetry: true)
        } catch {
            if codex.lastErrorMessage?.isEmpty ?? true {
                codex.lastErrorMessage = codex.userFacingConnectFailureMessage(error)
            }
        }
    }

    // Attempts one automatic connection on app launch using the saved bridge pairing.
    func attemptAutoConnectOnLaunchIfNeeded(codex: CodexService) async {
        guard !hasAttemptedInitialAutoConnect else {
            return
        }
        hasAttemptedInitialAutoConnect = true

        guard !codex.isConnected, !codex.isConnecting else {
            return
        }

        guard codex.hasSavedBridgePairing else {
            return
        }

        do {
            try await connectUsingSavedPairing(codex: codex, performAutoRetry: true)
        } catch {
            // Keep the saved pairing so temporary Mac/network outages can recover on the next retry.
        }
    }

    // Reconnects after benign background disconnects.
    func attemptAutoReconnectOnForegroundIfNeeded(codex: CodexService) async {
        guard codex.shouldAutoReconnectOnForeground, !isRunningForegroundReconnectLoop else {
            return
        }

        isRunningForegroundReconnectLoop = true
        defer { isRunningForegroundReconnectLoop = false }

        var attempt = 0
        let maxAttempts = 20

        // Keep trying while the bridge pairing is still valid.
        // This lets network changes recover on their own instead of dropping back to a manual reconnect button.
        while codex.shouldAutoReconnectOnForeground, attempt < maxAttempts {
            guard codex.hasSavedBridgePairing else {
                codex.shouldAutoReconnectOnForeground = false
                codex.connectionRecoveryState = .idle
                return
            }

            if codex.isConnected {
                codex.shouldAutoReconnectOnForeground = false
                codex.connectionRecoveryState = .idle
                codex.lastErrorMessage = nil
                return
            }

            if codex.isConnecting {
                try? await Task.sleep(nanoseconds: 300_000_000)
                continue
            }

            do {
                codex.connectionRecoveryState = .retrying(
                    attempt: max(1, attempt + 1),
                    message: "Reconnecting..."
                )
                try await connectUsingSavedPairing(codex: codex, performAutoRetry: false)
                codex.connectionRecoveryState = .idle
                codex.lastErrorMessage = nil
                codex.shouldAutoReconnectOnForeground = false
                return
            } catch {
                let isRetryable = codex.isRecoverableTransientConnectionError(error)
                    || codex.isBenignBackgroundDisconnect(error)

                guard isRetryable else {
                    codex.connectionRecoveryState = .idle
                    codex.shouldAutoReconnectOnForeground = false
                    codex.lastErrorMessage = codex.userFacingConnectFailureMessage(error)
                    return
                }

                // Keep the foreground reconnect loop armed across transient failures.
                // `connectWithAutoRecovery` may clear the reconnect intent for a single failed
                // attempt, but the outer loop is responsible for continuing retries after
                // bridge restarts and short network gaps.
                codex.shouldAutoReconnectOnForeground = true
                codex.lastErrorMessage = nil
                codex.connectionRecoveryState = .retrying(
                    attempt: attempt + 1,
                    message: codex.recoveryStatusMessage(for: error)
                )

                let backoffIndex = min(attempt, autoReconnectBackoffNanoseconds.count - 1)
                let backoff = autoReconnectBackoffNanoseconds[backoffIndex]
                attempt += 1
                try? await Task.sleep(nanoseconds: backoff)
            }
        }

        // Exhausted all attempts — stop retrying but keep the saved pairing for next foreground cycle.
        if attempt >= maxAttempts {
            codex.shouldAutoReconnectOnForeground = false
            codex.connectionRecoveryState = .idle
            codex.lastErrorMessage = "Could not reconnect. Tap Reconnect to try again."
        }
    }
}

extension ContentViewModel {
    func connectUsingSavedPairing(
        codex: CodexService,
        performAutoRetry: Bool
    ) async throws {
        let candidateURLs = codex.orderedTransportCandidateURLs
        guard !candidateURLs.isEmpty else {
            throw CodexServiceError.invalidInput("No saved bridge transport is available.")
        }

        var lastError: Error?
        for candidateURL in candidateURLs {
            do {
                try await connectWithAutoRecovery(
                    codex: codex,
                    serverURL: candidateURL,
                    performAutoRetry: performAutoRetry
                )
                codex.rememberSuccessfulTransportURL(candidateURL)
                return
            } catch {
                lastError = error
                if shouldStopTryingOtherCandidates(for: error) {
                    throw error
                }
            }
        }

        throw lastError ?? CodexServiceError.disconnected
    }

    func shouldStopTryingOtherCandidates(for error: Error) -> Bool {
        guard let secureError = error as? CodexSecureTransportError else {
            return false
        }

        switch secureError {
        case .secureError, .incompatibleVersion, .invalidHandshake, .decryptFailed:
            return true
        case .invalidQR, .timedOut:
            return false
        }
    }

    func connect(codex: CodexService, serverURL: String) async throws {
        try await codex.connect(serverURL: serverURL, token: "")
    }

    func connectWithAutoRecovery(
        codex: CodexService,
        serverURL: String,
        performAutoRetry: Bool
    ) async throws {
        let maxAttemptIndex = performAutoRetry ? autoReconnectBackoffNanoseconds.count : 0
        var lastError: Error?

        for attemptIndex in 0...maxAttemptIndex {
            if attemptIndex > 0 {
                codex.connectionRecoveryState = .retrying(
                    attempt: attemptIndex,
                    message: "Connection timed out. Retrying..."
                )
            }

            do {
                try await connect(codex: codex, serverURL: serverURL)
                codex.connectionRecoveryState = .idle
                codex.lastErrorMessage = nil
                codex.shouldAutoReconnectOnForeground = false
                return
            } catch {
                lastError = error
                let isRetryable = codex.isRecoverableTransientConnectionError(error)
                    || codex.isBenignBackgroundDisconnect(error)

                guard performAutoRetry,
                      isRetryable,
                      attemptIndex < autoReconnectBackoffNanoseconds.count else {
                    codex.connectionRecoveryState = .idle
                    codex.shouldAutoReconnectOnForeground = false
                    codex.lastErrorMessage = codex.userFacingConnectFailureMessage(error)
                    throw error
                }

                codex.lastErrorMessage = nil
                codex.connectionRecoveryState = .retrying(
                    attempt: attemptIndex + 1,
                    message: codex.recoveryStatusMessage(for: error)
                )
                try? await Task.sleep(nanoseconds: autoReconnectBackoffNanoseconds[attemptIndex])
            }
        }

        if let lastError {
            codex.connectionRecoveryState = .idle
            codex.shouldAutoReconnectOnForeground = false
            codex.lastErrorMessage = codex.userFacingConnectFailureMessage(lastError)
            throw lastError
        }
    }
}
