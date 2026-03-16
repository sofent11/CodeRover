// FILE: RuntimeProvider.swift
// Purpose: Represents runtime provider metadata and capability flags exposed by the bridge.
// Layer: Model
// Exports: RuntimeProvider, RuntimeCapabilities, RuntimeAccessModeOption
// Depends on: Foundation

import Foundation

struct RuntimeCapabilities: Codable, Hashable, Sendable {
    let planMode: Bool
    let structuredUserInput: Bool
    let inlineApproval: Bool
    let turnSteer: Bool
    let reasoningOptions: Bool
    let desktopRefresh: Bool
    let desktopRestart: Bool

    static let codexDefault = RuntimeCapabilities(
        planMode: true,
        structuredUserInput: true,
        inlineApproval: true,
        turnSteer: true,
        reasoningOptions: true,
        desktopRefresh: true,
        desktopRestart: true
    )

    private enum CodingKeys: String, CodingKey {
        case planMode
        case structuredUserInput
        case inlineApproval
        case turnSteer
        case reasoningOptions
        case desktopRefresh
        case desktopRestart
    }
}

struct RuntimeAccessModeOption: Codable, Hashable, Sendable, Identifiable {
    let id: String
    let title: String
}

struct RuntimeProvider: Codable, Hashable, Sendable, Identifiable {
    let id: String
    let title: String
    let supports: RuntimeCapabilities
    let accessModes: [RuntimeAccessModeOption]
    let defaultModelId: String?

    static let codexDefault = RuntimeProvider(
        id: "codex",
        title: "Codex",
        supports: .codexDefault,
        accessModes: [
            RuntimeAccessModeOption(id: "on-request", title: "On-Request"),
            RuntimeAccessModeOption(id: "full-access", title: "Full access"),
        ],
        defaultModelId: nil
    )
}
