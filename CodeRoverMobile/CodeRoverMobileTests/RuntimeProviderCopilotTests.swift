// FILE: RuntimeProviderCopilotTests.swift
// Purpose: Verifies Copilot provider normalization and presentation on iOS.
// Layer: Unit Test
// Exports: RuntimeProviderCopilotTests
// Depends on: XCTest, CodeRoverMobile

import XCTest
@testable import CodeRoverMobile

@MainActor
final class RuntimeProviderCopilotTests: XCTestCase {
    func testRuntimeProviderIDAcceptsCopilot() {
        let suiteName = "RuntimeProviderCopilotTests.runtimeProviderID"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        let service = CodeRoverService(defaults: defaults)

        XCTAssertEqual(service.runtimeProviderID(for: "copilot"), "copilot")
        XCTAssertEqual(service.runtimeProviderID(for: "  COPILOT  "), "copilot")
    }

    func testSelectedProviderRestoresCopilotFromDefaults() {
        let suiteName = "RuntimeProviderCopilotTests.selectedProvider"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        defaults.set("copilot", forKey: CodeRoverService.selectedProviderDefaultsKey)

        let service = CodeRoverService(defaults: defaults)

        XCTAssertEqual(service.selectedProviderID, "copilot")
    }

    func testConversationThreadProviderBadgeTitleUsesGitHubCopilotLabel() {
        let thread = ConversationThread(id: "copilot-thread", provider: "copilot")

        XCTAssertEqual(thread.providerBadgeTitle, "GitHub Copilot")
    }
}
