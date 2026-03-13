// FILE: ConversationThreadStartProjectBindingTests.swift
// Purpose: Verifies thread/start project binding params and cwd fallback behavior.
// Layer: Unit Test
// Exports: ConversationThreadStartProjectBindingTests
// Depends on: XCTest, CodeRoverMobile

import XCTest
@testable import CodeRoverMobile

final class ConversationThreadStartProjectBindingTests: XCTestCase {
    func testMakeThreadStartParamsIncludesModelAndCwd() {
        let params = ConversationThreadStartProjectBinding.makeThreadStartParams(
            modelIdentifier: "gpt-5",
            preferredProjectPath: "/Users/me/work/project",
            provider: "claude"
        )

        XCTAssertEqual(params["model"]?.stringValue, "gpt-5")
        XCTAssertEqual(params["cwd"]?.stringValue, "/Users/me/work/project")
        XCTAssertEqual(params["provider"]?.stringValue, "claude")
    }

    func testMakeThreadStartParamsSkipsEmptyCwd() {
        let normalized = ConversationThreadStartProjectBinding.normalizedProjectPath("   ")
        let params = ConversationThreadStartProjectBinding.makeThreadStartParams(
            modelIdentifier: nil,
            preferredProjectPath: normalized,
            provider: nil
        )

        XCTAssertNil(params["cwd"])
        XCTAssertTrue(params.isEmpty)
    }

    func testApplyFallbackSetsCwdWhenMissingInResponse() {
        let responseThread = ConversationThread(id: "thread-1", cwd: nil)
        let patched = ConversationThreadStartProjectBinding.applyPreferredProjectFallback(
            to: responseThread,
            preferredProjectPath: "/Users/me/work/project"
        )

        XCTAssertEqual(patched.cwd, "/Users/me/work/project")
    }

    func testApplyFallbackDoesNotOverrideExistingCwd() {
        let responseThread = ConversationThread(id: "thread-1", cwd: "/server/path")
        let patched = ConversationThreadStartProjectBinding.applyPreferredProjectFallback(
            to: responseThread,
            preferredProjectPath: "/Users/me/work/project"
        )

        XCTAssertEqual(patched.cwd, "/server/path")
    }

    func testGitWorkingDirectoryReturnsNormalizedThreadPath() {
        let thread = ConversationThread(id: "thread-1", cwd: "/Users/me/work/project///")

        XCTAssertEqual(thread.gitWorkingDirectory, "/Users/me/work/project")
    }

    func testGitWorkingDirectoryIsNilForUnboundThread() {
        let thread = ConversationThread(id: "thread-1", cwd: "   ")

        XCTAssertNil(thread.gitWorkingDirectory)
    }
}
