// FILE: CodexRuntimeProvider.swift
// Purpose: Represents runtime provider metadata and capability flags exposed by the bridge.
// Layer: Model
// Exports: CodexRuntimeProvider, CodexRuntimeCapabilities, CodexRuntimeAccessModeOption
// Depends on: Foundation

import Foundation

struct CodexRuntimeCapabilities: Codable, Hashable, Sendable {
    let planMode: Bool
    let structuredUserInput: Bool
    let inlineApproval: Bool
    let turnSteer: Bool
    let reasoningOptions: Bool
    let desktopRefresh: Bool

    static let codexDefault = CodexRuntimeCapabilities(
        planMode: true,
        structuredUserInput: true,
        inlineApproval: true,
        turnSteer: true,
        reasoningOptions: true,
        desktopRefresh: true
    )

    private enum CodingKeys: String, CodingKey {
        case planMode
        case structuredUserInput
        case inlineApproval
        case turnSteer
        case reasoningOptions
        case desktopRefresh
    }
}

struct CodexRuntimeAccessModeOption: Codable, Hashable, Sendable, Identifiable {
    let id: String
    let title: String
}

struct CodexRuntimeProvider: Codable, Hashable, Sendable, Identifiable {
    let id: String
    let title: String
    let supports: CodexRuntimeCapabilities
    let accessModes: [CodexRuntimeAccessModeOption]
    let defaultModelId: String?

    static let codexDefault = CodexRuntimeProvider(
        id: "codex",
        title: "Codex",
        supports: .codexDefault,
        accessModes: [
            CodexRuntimeAccessModeOption(id: "on-request", title: "On-Request"),
            CodexRuntimeAccessModeOption(id: "full-access", title: "Full access"),
        ],
        defaultModelId: nil
    )
}
