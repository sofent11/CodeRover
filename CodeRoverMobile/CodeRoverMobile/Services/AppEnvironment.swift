// FILE: AppEnvironment.swift
// Purpose: Centralizes local runtime defaults for bridge connections.
// Layer: Service
// Exports: AppEnvironment
// Depends on: Foundation

import Foundation

enum AppEnvironment {
    private static let defaultLocalPortInfoPlistKey = "CODEROVER_DEFAULT_LOCAL_PORT"
    private static let defaultTailnetBaseURLInfoPlistKey = "CODEROVER_DEFAULT_TAILNET_BASE_URL"

    static let defaultLocalPort = 8765
    static let defaultAppVersion = "1.0"

    static var localPort: Int {
        if let infoPort = resolvedString(forInfoPlistKey: defaultLocalPortInfoPlistKey),
           let parsedPort = Int(infoPort) {
            return parsedPort
        }
        return defaultLocalPort
    }

    static var tailnetBaseURL: String? {
        resolvedString(forInfoPlistKey: defaultTailnetBaseURLInfoPlistKey)
    }

    static var appVersion: String {
        resolvedString(forInfoPlistKey: "CFBundleShortVersionString") ?? defaultAppVersion
    }
}

private extension AppEnvironment {
    static func resolvedString(forInfoPlistKey key: String) -> String? {
        guard let rawValue = Bundle.main.object(forInfoDictionaryKey: key) as? String else {
            return nil
        }

        let trimmedValue = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedValue.isEmpty else {
            return nil
        }

        if trimmedValue.hasPrefix("$("), trimmedValue.hasSuffix(")") {
            return nil
        }

        return trimmedValue
    }
}
