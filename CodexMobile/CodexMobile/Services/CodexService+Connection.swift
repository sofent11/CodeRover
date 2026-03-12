// FILE: CodexService+Connection.swift
// Purpose: Connection lifecycle and initialization handshake.
// Layer: Service
// Exports: CodexService connection APIs
// Depends on: Network.NWConnection

import Foundation
import Network
import UIKit

extension CodexService {
    // Opens the WebSocket and performs initialize/initialized handshake.
    func connect(
        serverURL: String,
        token: String,
        role: String? = nil,
        performInitialSync: Bool = true
    ) async throws {
        guard !isConnecting else {
            lastErrorMessage = "Connection already in progress"
            throw CodexServiceError.invalidInput("Connection already in progress")
        }

        isConnecting = true
        defer { isConnecting = false }

        await disconnect(preserveReconnectIntent: true)

        let normalizedServerURL = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        let url = try validateConnectionURL(normalizedServerURL)
        let serverIdentity = normalizedBridgeId.map { "bridge:\($0)" }
            ?? canonicalServerIdentity(for: url)
        if let previousIdentity = connectedServerIdentity, previousIdentity != serverIdentity {
            resetThreadRuntimeStateForServerSwitch()
        }
        connectedServerIdentity = serverIdentity

        let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        let connection: NWConnection
        do {
            connection = try await establishWebSocketConnection(url: url, token: trimmedToken, role: role)
        } catch {
            let friendlyMessage = userFacingConnectError(
                error: error,
                attemptedURL: normalizedServerURL,
                host: url.host
            )
            if isRecoverableTransientConnectionError(error) {
                connectionRecoveryState = .retrying(attempt: 0, message: recoveryStatusMessage(for: error))
                lastErrorMessage = nil
            } else {
                lastErrorMessage = friendlyMessage
            }
            throw CodexServiceError.invalidInput(friendlyMessage)
        }
        webSocketConnection = connection
        startReceiveLoop(with: connection)
        clearHydrationCaches()

        do {
            try await performSecureHandshake()

            isConnected = true
            shouldAutoReconnectOnForeground = false
            connectionRecoveryState = .idle
            lastErrorMessage = nil
            try await initializeSession()

            startSyncLoop()
            if performInitialSync {
                schedulePostConnectSyncPass()
            }
        } catch {
            presentConnectionErrorIfNeeded(error)
            await disconnect()
            throw error
        }
    }

    // Closes the socket and fails any in-flight requests.
    func disconnect(preserveReconnectIntent: Bool = false) async {
        if let connection = webSocketConnection {
            connection.stateUpdateHandler = nil
            webSocketConnection = nil
            connection.cancel()
        }

        isConnected = false
        isInitialized = false
        isLoadingThreads = false
        isLoadingModels = false
        isBootstrappingConnectionSync = false
        pendingApproval = nil
        finalizeAllStreamingState()
        messagePersistenceDebounceTask?.cancel()
        messagePersistenceDebounceTask = nil
        messagePersistence.save(messagesByThread)
        assistantCompletionFingerprintByThread.removeAll()
        recentActivityLineByThread.removeAll()
        runningThreadIDs.removeAll()
        protectedRunningFallbackThreadIDs.removeAll()
        readyThreadIDs.removeAll()
        failedThreadIDs.removeAll()
        runningThreadWatchByID.removeAll()
        pendingNotificationOpenThreadID = nil
        endBackgroundRunGraceTask(reason: "disconnect")
        if !preserveReconnectIntent {
            shouldAutoReconnectOnForeground = false
            connectionRecoveryState = .idle
        }
        supportsStructuredSkillInput = true
        supportsTurnCollaborationMode = false
        stopSyncLoop()
        postConnectSyncTask?.cancel()
        postConnectSyncTask = nil
        postConnectSyncToken = nil
        clearHydrationCaches()
        resumedThreadIDs.removeAll()
        resetSecureTransportState()

        failAllPendingRequests(with: CodexServiceError.disconnected)
    }

    // Clears the remembered bridge pairing when the remote Mac session is gone for good.
    func clearSavedBridgePairing() {
        guard let pairedMacDeviceId = activeSavedBridgePairing?.macDeviceId ?? normalizedPairedMacDeviceId else {
            return
        }
        removeSavedBridgePairing(macDeviceId: pairedMacDeviceId)
    }

    // Explicit user action that drops the live connection and forgets the current pairing.
    func unpair() async {
        await disconnect()
        clearSavedBridgePairing()
        lastErrorMessage = nil
    }

    func initializeSession() async throws {
        let appVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1.0"
        let clientInfo: JSONValue = .object([
            "name": .string("codexmobile_ios"),
            "title": .string("CodexMobile iOS"),
            "version": .string(appVersion),
        ])

        // Ask for experimental APIs up front so plan mode can use `collaborationMode`
        // on runtimes that support it, while keeping a legacy handshake fallback.
        let modernParams: JSONValue = .object([
            "clientInfo": clientInfo,
            "capabilities": .object([
                "experimentalApi": .bool(true),
            ]),
        ])

        do {
            _ = try await sendRequest(method: "initialize", params: modernParams)
            supportsTurnCollaborationMode = await runtimeSupportsPlanCollaborationMode()
        } catch {
            guard shouldRetryInitializeWithoutCapabilities(error) else {
                throw error
            }

            let legacyParams: JSONValue = .object([
                "clientInfo": clientInfo,
            ])
            _ = try await sendRequest(method: "initialize", params: legacyParams)
            supportsTurnCollaborationMode = false
        }

        try await sendNotification(method: "initialized", params: nil)
        isInitialized = true
    }

    // Classifies socket failures so transient bridge hiccups reconnect while pairing stays intact.
    func handleReceiveError(_ error: Error) {
        if Task.isCancelled {
            return
        }

        if let connection = webSocketConnection {
            connection.stateUpdateHandler = nil
            webSocketConnection = nil
            connection.cancel()
        }

        let appIsActive: Bool = {
            if ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil {
                return isAppInForeground
            }
            return UIApplication.shared.applicationState == .active
        }()
        let isBenignDisconnect = isBenignBackgroundDisconnect(error)
        let shouldSuppressMessage = isBenignDisconnect && (!isAppInForeground || !appIsActive)
        let shouldAttemptAutoRecovery = isRecoverableTransientConnectionError(error) || isBenignDisconnect
        isConnected = false
        isInitialized = false
        shouldAutoReconnectOnForeground = shouldSuppressMessage || shouldAttemptAutoRecovery
        postConnectSyncTask?.cancel()
        postConnectSyncTask = nil
        postConnectSyncToken = nil
        isBootstrappingConnectionSync = false
        if shouldAttemptAutoRecovery {
            connectionRecoveryState = .retrying(attempt: 0, message: recoveryStatusMessage(for: error))
            lastErrorMessage = nil
        } else {
            connectionRecoveryState = .idle
        }
        if !shouldSuppressMessage && !shouldAttemptAutoRecovery {
            lastErrorMessage = error.localizedDescription
        }
        finalizeAllStreamingState()
        endBackgroundRunGraceTask(reason: "receive-error")
        stopSyncLoop()
        failAllPendingRequests(with: error)
    }
}

extension CodexService {
    func schedulePostConnectSyncPass(preferredThreadId: String? = nil) {
        postConnectSyncTask?.cancel()
        isBootstrappingConnectionSync = true

        let syncToken = UUID()
        postConnectSyncToken = syncToken
        let preferredThreadId = preferredThreadId
        postConnectSyncTask = Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                if self.postConnectSyncToken == syncToken {
                    self.isBootstrappingConnectionSync = false
                    self.postConnectSyncTask = nil
                    self.postConnectSyncToken = nil
                }
            }
            await self.performPostConnectSyncPass(preferredThreadId: preferredThreadId)
        }
    }

    // Runs the post-connect sync work that is useful but not required to mark the socket usable.
    func performPostConnectSyncPass(preferredThreadId: String? = nil) async {
        try? await listModels()
        try? await listThreads()
        let resolvedPreferredThreadId = normalizedInterruptIdentifier(preferredThreadId)
        if let resolvedPreferredThreadId {
            activeThreadId = resolvedPreferredThreadId
        }
        if let threadId = activeThreadId
            ?? resolvedPreferredThreadId
            ?? threads.first(where: { $0.syncState == .live })?.id {
            await refreshInFlightTurnState(threadId: threadId)
            if threadHasActiveOrRunningTurn(threadId) {
                _ = try? await ensureThreadResumed(threadId: threadId, force: true)
                if activeThreadId == threadId {
                    currentOutput = messages(for: threadId)
                        .reversed()
                        .first(where: { $0.role == .assistant && !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })?
                        .text ?? ""
                }
            }
        }
    }

    // Clears volatile runtime state on server switch.
    func resetThreadRuntimeStateForServerSwitch() {
        activeThreadId = nil
        activeTurnId = nil
        activeTurnIdByThread.removeAll()
        threadIdByTurnID.removeAll()
        pendingApproval = nil
        currentOutput = ""
        lastErrorMessage = nil
        isLoadingModels = false
        modelsErrorMessage = nil
        assistantCompletionFingerprintByThread.removeAll()
        recentActivityLineByThread.removeAll()
        runningThreadIDs.removeAll()
        protectedRunningFallbackThreadIDs.removeAll()
        readyThreadIDs.removeAll()
        failedThreadIDs.removeAll()
        runningThreadWatchByID.removeAll()
        pendingNotificationOpenThreadID = nil
        endBackgroundRunGraceTask(reason: "server-switch")
        shouldAutoReconnectOnForeground = false
        connectionRecoveryState = .idle
        supportsStructuredSkillInput = true
        supportsTurnCollaborationMode = false
        resumedThreadIDs.removeAll()
        clearHydrationCaches()
        resetSecureTransportState()
    }

    // Detects runtimes that still reject `initialize.capabilities`.
    func shouldRetryInitializeWithoutCapabilities(_ error: Error) -> Bool {
        guard let serviceError = error as? CodexServiceError,
              case .rpcError(let rpcError) = serviceError else {
            return false
        }

        if rpcError.code != -32600 && rpcError.code != -32602 {
            return false
        }

        let message = rpcError.message.lowercased()
        guard message.contains("capabilities") || message.contains("experimentalapi") else {
            return false
        }

        return message.contains("unknown")
            || message.contains("unexpected")
            || message.contains("unrecognized")
            || message.contains("invalid")
            || message.contains("unsupported")
            || message.contains("field")
    }

    // Uses the documented experimental listing endpoint instead of assuming initialize implies plan support.
    func runtimeSupportsPlanCollaborationMode() async -> Bool {
        do {
            let response = try await sendRequest(method: "collaborationMode/list", params: nil)
            return responseContainsPlanCollaborationMode(response)
        } catch {
            return false
        }
    }

    // Accepts the current app-server result shapes without depending on one exact field name.
    func responseContainsPlanCollaborationMode(_ response: RPCMessage) -> Bool {
        let candidateArrays: [[JSONValue]?] = [
            response.result?.arrayValue,
            response.result?.objectValue?["modes"]?.arrayValue,
            response.result?.objectValue?["collaborationModes"]?.arrayValue,
            response.result?.objectValue?["items"]?.arrayValue,
        ]

        for candidateArray in candidateArrays {
            guard let candidateArray else { continue }
            for entry in candidateArray {
                let modeName = entry.objectValue?["mode"]?.stringValue
                    ?? entry.objectValue?["name"]?.stringValue
                    ?? entry.objectValue?["id"]?.stringValue
                    ?? entry.stringValue
                if modeName == CodexCollaborationModeKind.plan.rawValue {
                    return true
                }
            }
        }

        return false
    }

    func canonicalServerIdentity(for url: URL) -> String {
        let scheme = (url.scheme ?? "ws").lowercased()
        let host = (url.host ?? "unknown-host").lowercased()
        let defaultPort = (scheme == "wss") ? 443 : 80
        let port = url.port ?? defaultPort
        let path = url.path.isEmpty ? "/" : url.path
        return "\(scheme)://\(host):\(port)\(path)"
    }

    func validateConnectionURL(_ serverURL: String) throws -> URL {
        guard let url = URL(string: serverURL) else {
            let message = CodexServiceError.invalidServerURL(serverURL).localizedDescription
            lastErrorMessage = message
            throw CodexServiceError.invalidServerURL(serverURL)
        }

        return url
    }

    func userFacingConnectError(error: Error, attemptedURL: String, host: String?) -> String {
        if let nwError = error as? NWError {
            switch nwError {
            case .posix(let code) where code == .ECONNREFUSED:
                return "Connection refused by bridge transport at \(attemptedURL)."
            case .posix(let code) where code == .ETIMEDOUT:
                return "Connection timed out. Check the selected bridge transport and network."
            case .dns(let code):
                return "Cannot resolve bridge host (\(code)). Check the saved transport."
            default:
                break
            }
        }

        if isRecoverableTransientConnectionError(error) {
            return "Connection timed out. Check the selected bridge transport and network."
        }

        return error.localizedDescription
    }

    func isBenignBackgroundDisconnect(_ error: Error) -> Bool {
        if let serviceError = error as? CodexServiceError {
            if case .disconnected = serviceError {
                return true
            }
        }

        guard let nwError = error as? NWError else {
            return false
        }

        if case .posix(let code) = nwError,
           code == .ECONNABORTED || code == .ECANCELED || code == .ENOTCONN {
            return true
        }

        return false
    }

    func isRecoverableTransientConnectionError(_ error: Error) -> Bool {
        if let serviceError = error as? CodexServiceError {
            if case .invalidInput(let message) = serviceError {
                return message.localizedCaseInsensitiveContains("timed out")
            }
        }

        if let nwError = error as? NWError {
            if case .posix(let code) = nwError,
               code == .ETIMEDOUT {
                return true
            }
        }

        let nsError = error as NSError
        return nsError.domain == NSPOSIXErrorDomain
            && nsError.code == Int(POSIXErrorCode.ETIMEDOUT.rawValue)
    }

    // Suppresses only background disconnect noise; foreground timeouts should still tell the user why sync stopped.
    func shouldSuppressUserFacingConnectionError(_ error: Error) -> Bool {
        isBenignBackgroundDisconnect(error) && !isAppInForeground
    }

    // Surfaces only meaningful connection failures to the UI and keeps reconnect noise silent.
    func presentConnectionErrorIfNeeded(_ error: Error, fallbackMessage: String? = nil) {
        guard !shouldSuppressUserFacingConnectionError(error) else {
            return
        }

        let message = (fallbackMessage ?? userFacingConnectFailureMessage(error))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty else {
            return
        }

        // Preserve a more specific connection message instead of replacing it with a generic disconnect.
        if message == CodexServiceError.disconnected.localizedDescription,
           let lastErrorMessage,
           !lastErrorMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return
        }

        lastErrorMessage = message
    }

    func recoveryStatusMessage(for error: Error) -> String {
        if isRecoverableTransientConnectionError(error) {
            return "Connection timed out. Retrying..."
        }
        return "Reconnecting..."
    }

    func userFacingConnectFailureMessage(_ error: Error) -> String {
        if isBenignBackgroundDisconnect(error) {
            return "Connection was interrupted. Tap Reconnect to try again."
        }
        if isRecoverableTransientConnectionError(error) {
            return "Connection timed out. Check the selected bridge transport and network."
        }
        return error.localizedDescription
    }

    func isTransientConnectionStatusMessage(_ message: String) -> Bool {
        let normalized = message.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !normalized.isEmpty else {
            return false
        }

        return normalized.hasPrefix("connection was interrupted")
            || normalized.hasPrefix("connection timed out")
            || normalized.hasPrefix("connection refused by bridge transport")
            || normalized.hasPrefix("could not reconnect")
            || normalized == "reconnecting..."
    }

    var isRunningOnSimulator: Bool {
#if targetEnvironment(simulator)
        true
#else
        false
#endif
    }

    func isLoopbackHost(_ host: String?) -> Bool {
        guard let host = host?.lowercased() else {
            return false
        }
        if host == "localhost" || host == "::1" {
            return true
        }
        return host == "127.0.0.1" || host.hasPrefix("127.")
    }
}
