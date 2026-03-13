// FILE: AccessMode.swift
// Purpose: Runtime permission mode for thread/turn operations.
// Layer: Model
// Exports: AccessMode
// Depends on: Foundation

import Foundation

enum AccessMode: String, Codable, CaseIterable, Hashable, Sendable {
    case onRequest = "on-request"
    case fullAccess = "full-access"

    var displayName: String {
        switch self {
        case .onRequest:
            return "On-Request"
        case .fullAccess:
            return "Full access"
        }
    }

    // Tries modern server enum first, then legacy camelCase fallback.
    var approvalPolicyCandidates: [String] {
        switch self {
        case .onRequest:
            return ["on-request", "onRequest"]
        case .fullAccess:
            return ["never"]
        }
    }

    var sandboxLegacyValue: String {
        switch self {
        case .onRequest:
            return "workspaceWrite"
        case .fullAccess:
            return "dangerFullAccess"
        }
    }
}
