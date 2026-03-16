// FILE: DesktopAppRestartService.swift
// Purpose: Sends explicit desktop app restart requests over the existing bridge connection.
// Layer: Service
// Exports: DesktopAppRestartService, DesktopAppRestartError
// Depends on: Foundation, CodeRoverService

import Foundation

enum DesktopAppRestartError: LocalizedError {
    case disconnected
    case invalidResponse
    case bridgeError(code: String?, message: String?)

    var errorDescription: String? {
        switch self {
        case .disconnected:
            return "Not connected to your Mac."
        case .invalidResponse:
            return "The Mac bridge did not return a valid response."
        case .bridgeError(let code, let message):
            return userMessage(for: code, fallback: message)
        }
    }

    private func userMessage(for code: String?, fallback: String?) -> String {
        switch code {
        case "missing_thread_id":
            return "This chat does not have a valid thread id yet."
        case "unsupported_platform":
            return "Desktop restart works only when the bridge is running on macOS."
        case "unsupported_provider":
            return fallback ?? "This provider does not support desktop restart."
        case "restart_failed", "restart_timeout":
            return fallback ?? "Could not restart the Codex desktop app on your Mac."
        default:
            return fallback ?? "Could not restart the desktop app on your Mac."
        }
    }
}

@MainActor
final class DesktopAppRestartService {
    private let coderover: CodeRoverService

    init(coderover: CodeRoverService) {
        self.coderover = coderover
    }

    func restartApp(provider: String, threadId: String) async throws {
        let normalizedProvider = provider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let trimmedThreadID = threadId.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !trimmedThreadID.isEmpty else {
            throw DesktopAppRestartError.bridgeError(
                code: "missing_thread_id",
                message: "This chat does not have a valid thread id yet."
            )
        }

        let params: JSONValue = .object([
            "provider": .string(normalizedProvider.isEmpty ? "codex" : normalizedProvider),
            "threadId": .string(trimmedThreadID),
        ])

        do {
            let response = try await coderover.sendRequest(method: "desktop/restartApp", params: params)
            guard let resultObject = response.result?.objectValue,
                  resultObject["success"]?.boolValue == true else {
                throw DesktopAppRestartError.invalidResponse
            }
        } catch let error as CodeRoverServiceError {
            switch error {
            case .disconnected:
                throw DesktopAppRestartError.disconnected
            case .rpcError(let rpcError):
                let errorCode = rpcError.data?.objectValue?["errorCode"]?.stringValue
                throw DesktopAppRestartError.bridgeError(code: errorCode, message: rpcError.message)
            default:
                throw DesktopAppRestartError.bridgeError(code: nil, message: error.errorDescription)
            }
        }
    }
}
