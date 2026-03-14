// FILE: ContentViewModel.swift
// Purpose: Owns non-visual orchestration logic for the root screen (bridge pairing, connection, sync throttling).
// Layer: ViewModel
// Exports: ContentViewModel
// Depends on: Foundation, Observation, CodeRoverService, SecureStore

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
        pairingPayload: CodeRoverPairingQRPayload,
        coderover: CodeRoverService,
        preferredTransportURL: String? = nil
    ) async {
        await stopAutoReconnectForManualScan(coderover: coderover)
        coderover.rememberBridgePairing(pairingPayload)

        do {
            if let preferredTransportURL = preferredTransportURL?
                .trimmingCharacters(in: .whitespacesAndNewlines),
               !preferredTransportURL.isEmpty {
                debugConnectLog("manual connect requested transport=\(preferredTransportURL)")
                try await connectWithAutoRecovery(
                    coderover: coderover,
                    serverURL: preferredTransportURL,
                    performAutoRetry: true,
                    transportLabel: "manual:\(preferredTransportURL)"
                )
                coderover.rememberSuccessfulTransportURL(preferredTransportURL)
            } else {
                try await connectUsingSavedPairing(coderover: coderover, performAutoRetry: true)
            }
        } catch {
            if coderover.lastErrorMessage?.isEmpty ?? true {
                coderover.lastErrorMessage = coderover.userFacingConnectFailureMessage(error)
            }
        }
    }

    // Connects or disconnects the paired bridge.
    func toggleConnection(coderover: CodeRoverService) async {
        guard !coderover.isConnecting, !isRunningForegroundReconnectLoop else {
            return
        }

        guard !coderover.requiresManualRePair else {
            coderover.shouldAutoReconnectOnForeground = false
            coderover.connectionRecoveryState = .idle
            return
        }

        if coderover.isConnected {
            await coderover.disconnect()
            return
        }

        guard coderover.hasSavedBridgePairing else {
            return
        }

        do {
            try await connectUsingSavedPairing(coderover: coderover, performAutoRetry: true)
        } catch {
            if coderover.lastErrorMessage?.isEmpty ?? true {
                coderover.lastErrorMessage = coderover.userFacingConnectFailureMessage(error)
            }
        }
    }

    func stopForegroundAutoReconnect(
        coderover: CodeRoverService,
        clearLastErrorMessage: Bool
    ) async {
        coderover.shouldAutoReconnectOnForeground = false
        coderover.connectionRecoveryState = .idle
        if clearLastErrorMessage {
            coderover.lastErrorMessage = nil
        }

        while isRunningForegroundReconnectLoop || coderover.isConnecting {
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
    }

    // Lets the manual QR flow take over instead of competing with the foreground reconnect loop.
    func stopAutoReconnectForManualScan(coderover: CodeRoverService) async {
        await stopForegroundAutoReconnect(coderover: coderover, clearLastErrorMessage: true)
    }

    // Keeps Settings from implicitly restarting a reconnect loop the user did not request.
    func stopAutoReconnectForSettings(coderover: CodeRoverService) async {
        await stopForegroundAutoReconnect(coderover: coderover, clearLastErrorMessage: false)
    }

    func switchSavedBridgePairing(
        macDeviceId: String,
        coderover: CodeRoverService
    ) async {
        let wasConnected = coderover.isConnected
        await stopAutoReconnectForSettings(coderover: coderover)
        guard coderover.setActiveSavedBridgePairing(macDeviceId: macDeviceId) else {
            return
        }

        guard wasConnected else {
            coderover.lastErrorMessage = nil
            return
        }

        do {
            try await connectUsingSavedPairing(coderover: coderover, performAutoRetry: true)
        } catch {
            if coderover.lastErrorMessage?.isEmpty ?? true {
                coderover.lastErrorMessage = coderover.userFacingConnectFailureMessage(error)
            }
        }
    }

    func removeSavedBridgePairing(
        macDeviceId: String,
        coderover: CodeRoverService
    ) async {
        let wasConnected = coderover.isConnected
        let wasActivePairing = coderover.activeSavedBridgePairing?.macDeviceId == macDeviceId
        await stopAutoReconnectForSettings(coderover: coderover)

        if wasConnected && wasActivePairing {
            await coderover.disconnect()
        }

        coderover.removeSavedBridgePairing(macDeviceId: macDeviceId)
        coderover.lastErrorMessage = nil

        guard wasConnected && coderover.hasSavedBridgePairing else {
            return
        }

        do {
            try await connectUsingSavedPairing(coderover: coderover, performAutoRetry: true)
        } catch {
            if coderover.lastErrorMessage?.isEmpty ?? true {
                coderover.lastErrorMessage = coderover.userFacingConnectFailureMessage(error)
            }
        }
    }

    // Attempts one automatic connection on app launch using the saved bridge pairing.
    func attemptAutoConnectOnLaunchIfNeeded(coderover: CodeRoverService) async {
        guard !hasAttemptedInitialAutoConnect else {
            return
        }
        hasAttemptedInitialAutoConnect = true

        guard !coderover.secureConnectionState.blocksAutomaticReconnect else {
            coderover.shouldAutoReconnectOnForeground = false
            coderover.connectionRecoveryState = .idle
            return
        }

        guard !coderover.isConnected, !coderover.isConnecting else {
            return
        }

        guard coderover.hasSavedBridgePairing else {
            return
        }

        do {
            try await connectUsingSavedPairing(coderover: coderover, performAutoRetry: true)
        } catch {
            // Keep the saved pairing so temporary Mac/network outages can recover on the next retry.
        }
    }

    // Reconnects after benign background disconnects.
    func attemptAutoReconnectOnForegroundIfNeeded(coderover: CodeRoverService) async {
        guard coderover.shouldAutoReconnectOnForeground, !isRunningForegroundReconnectLoop else {
            return
        }
        guard !coderover.secureConnectionState.blocksAutomaticReconnect else {
            coderover.shouldAutoReconnectOnForeground = false
            coderover.connectionRecoveryState = .idle
            return
        }

        isRunningForegroundReconnectLoop = true
        defer { isRunningForegroundReconnectLoop = false }

        var attempt = 0
        let maxAttempts = 20

        // Keep trying while the bridge pairing is still valid.
        // This lets network changes recover on their own instead of dropping back to a manual reconnect button.
        while coderover.shouldAutoReconnectOnForeground, attempt < maxAttempts {
            if coderover.secureConnectionState.blocksAutomaticReconnect {
                coderover.shouldAutoReconnectOnForeground = false
                coderover.connectionRecoveryState = .idle
                return
            }

            guard coderover.hasSavedBridgePairing else {
                coderover.shouldAutoReconnectOnForeground = false
                coderover.connectionRecoveryState = .idle
                return
            }

            if coderover.isConnected {
                coderover.shouldAutoReconnectOnForeground = false
                coderover.connectionRecoveryState = .idle
                coderover.lastErrorMessage = nil
                return
            }

            if coderover.isConnecting {
                try? await Task.sleep(nanoseconds: 300_000_000)
                continue
            }

            do {
                coderover.connectionRecoveryState = .retrying(
                    attempt: max(1, attempt + 1),
                    message: "Reconnecting..."
                )
                try await connectUsingSavedPairing(coderover: coderover, performAutoRetry: false)
                coderover.connectionRecoveryState = .idle
                coderover.lastErrorMessage = nil
                coderover.shouldAutoReconnectOnForeground = false
                return
            } catch {
                let isRetryable = coderover.isRecoverableTransientConnectionError(error)
                    || coderover.isBenignBackgroundDisconnect(error)

                guard isRetryable else {
                    coderover.connectionRecoveryState = .idle
                    coderover.shouldAutoReconnectOnForeground = false
                    coderover.presentConnectionErrorIfNeeded(error)
                    return
                }

                // Keep the foreground reconnect loop armed across transient failures.
                // `connectWithAutoRecovery` may clear the reconnect intent for a single failed
                // attempt, but the outer loop is responsible for continuing retries after
                // bridge restarts and short network gaps.
                coderover.shouldAutoReconnectOnForeground = true
                coderover.lastErrorMessage = nil
                coderover.connectionRecoveryState = .retrying(
                    attempt: attempt + 1,
                    message: coderover.recoveryStatusMessage(for: error)
                )

                let backoffIndex = min(attempt, autoReconnectBackoffNanoseconds.count - 1)
                let backoff = autoReconnectBackoffNanoseconds[backoffIndex]
                attempt += 1
                try? await Task.sleep(nanoseconds: backoff)
            }
        }

        // Exhausted all attempts — stop retrying but keep the saved pairing for next foreground cycle.
        if attempt >= maxAttempts {
            coderover.shouldAutoReconnectOnForeground = false
            coderover.connectionRecoveryState = .idle
            coderover.lastErrorMessage = "Could not reconnect. Tap Reconnect to try again."
        }
    }
}

extension ContentViewModel {
    func connectUsingSavedPairing(
        coderover: CodeRoverService,
        performAutoRetry: Bool
    ) async throws {
        let orderedCandidates = coderover.orderedTransportCandidates
        guard !orderedCandidates.isEmpty else {
            throw CodeRoverServiceError.invalidInput("No saved bridge transport is available.")
        }

        debugConnectLog(
            "ordered transports="
                + orderedCandidates.map(transportLogLabel).joined(separator: ", ")
                + " preferred=\(coderover.preferredTransportURL ?? "nil")"
                + " lastSuccessful=\(coderover.lastSuccessfulTransportURL ?? "nil")"
        )

        var lastError: Error?
        let shouldRetrySingleCandidate = performAutoRetry && orderedCandidates.count == 1
        if performAutoRetry && orderedCandidates.count > 1 {
            debugConnectLog("multiple saved transports detected; trying each candidate once before surfacing a timeout")
        }

        for candidate in orderedCandidates {
            do {
                try await connectWithAutoRecovery(
                    coderover: coderover,
                    serverURL: candidate.url,
                    performAutoRetry: shouldRetrySingleCandidate,
                    transportLabel: transportLogLabel(candidate)
                )
                coderover.rememberSuccessfulTransportURL(candidate.url)
                return
            } catch {
                lastError = error
                debugConnectLog("candidate failed transport=\(transportLogLabel(candidate)) error=\(error.localizedDescription)")
                if shouldStopTryingOtherCandidates(for: error) {
                    throw error
                }
            }
        }

        throw lastError ?? CodeRoverServiceError.disconnected
    }

    func shouldStopTryingOtherCandidates(for error: Error) -> Bool {
        guard let secureError = error as? CodeRoverSecureTransportError else {
            return false
        }

        switch secureError {
        case .secureError, .incompatibleVersion, .invalidHandshake, .decryptFailed:
            return true
        case .invalidQR, .timedOut:
            return false
        }
    }

    func connect(coderover: CodeRoverService, serverURL: String) async throws {
        try await coderover.connect(serverURL: serverURL, token: "")
    }

    func connectWithAutoRecovery(
        coderover: CodeRoverService,
        serverURL: String,
        performAutoRetry: Bool,
        transportLabel: String
    ) async throws {
        let maxAttemptIndex = performAutoRetry ? autoReconnectBackoffNanoseconds.count : 0
        var lastError: Error?

        for attemptIndex in 0...maxAttemptIndex {
            if attemptIndex > 0 {
                coderover.connectionRecoveryState = .retrying(
                    attempt: attemptIndex,
                    message: "Connection timed out. Retrying..."
                )
            }

            let attemptStartedAt = Date()
            debugConnectLog(
                "connecting transport=\(transportLabel) url=\(serverURL) attempt=\(attemptIndex + 1)/\(maxAttemptIndex + 1)"
            )
            do {
                try await connect(coderover: coderover, serverURL: serverURL)
                debugConnectLog(
                    "connected transport=\(transportLabel) elapsed=\(elapsedString(since: attemptStartedAt))"
                )
                coderover.connectionRecoveryState = .idle
                coderover.lastErrorMessage = nil
                coderover.shouldAutoReconnectOnForeground = false
                return
            } catch {
                lastError = error
                let isRetryable = coderover.isRecoverableTransientConnectionError(error)
                    || coderover.isBenignBackgroundDisconnect(error)
                debugConnectLog(
                    "connect failed transport=\(transportLabel) retryable=\(isRetryable) "
                        + "elapsed=\(elapsedString(since: attemptStartedAt)) error=\(error.localizedDescription)"
                )

                guard performAutoRetry,
                      isRetryable,
                      attemptIndex < autoReconnectBackoffNanoseconds.count else {
                    coderover.connectionRecoveryState = .idle
                    coderover.shouldAutoReconnectOnForeground = false
                    coderover.presentConnectionErrorIfNeeded(error)
                    throw error
                }

                coderover.lastErrorMessage = nil
                coderover.connectionRecoveryState = .retrying(
                    attempt: attemptIndex + 1,
                    message: coderover.recoveryStatusMessage(for: error)
                )
                try? await Task.sleep(nanoseconds: autoReconnectBackoffNanoseconds[attemptIndex])
            }
        }

        if let lastError {
            coderover.connectionRecoveryState = .idle
            coderover.shouldAutoReconnectOnForeground = false
            coderover.presentConnectionErrorIfNeeded(lastError)
            throw lastError
        }
    }

    private func debugConnectLog(_ message: String) {
        print("[CodeRoverConnect] \(message)")
    }

    private func transportLogLabel(_ candidate: CodeRoverTransportCandidate) -> String {
        let host = URL(string: candidate.url)?.host ?? candidate.url
        return "\(candidate.kind):\(host)"
    }

    private func elapsedString(since startedAt: Date) -> String {
        String(format: "%.2fs", Date().timeIntervalSince(startedAt))
    }
}
