// FILE: CodeRoverStructuredUserInputDecodeTests.swift
// Purpose: Verifies history/live decoders reconstruct `$skill` tokens from structured input items.
// Layer: Unit Test
// Exports: CodeRoverStructuredUserInputDecodeTests
// Depends on: XCTest, CodeRoverMobile

import XCTest
@testable import CodeRoverMobile

@MainActor
final class CodeRoverStructuredUserInputDecodeTests: XCTestCase {
    private static var retainedServices: [CodeRoverService] = []

    func testDecodeItemTextReconstructsSkillMentionsFromStructuredInput() {
        let service = makeService()
        let itemObject: [String: JSONValue] = [
            "content": .array([
                .object([
                    "type": .string("skill"),
                    "id": .string("review"),
                ]),
                .object([
                    "type": .string("text"),
                    "text": .string("please check latest changes"),
                ]),
            ]),
        ]

        let decoded = service.decodeItemText(from: itemObject)

        XCTAssertEqual(decoded, "$review\nplease check latest changes")
    }

    func testExtractIncomingMessageTextReconstructsSkillMentionsFromStructuredInput() {
        let service = makeService()
        let itemObject: [String: JSONValue] = [
            "content": .array([
                .object([
                    "type": .string("skill"),
                    "name": .string("check-code"),
                ]),
                .object([
                    "type": .string("text"),
                    "text": .string("run the audit"),
                ]),
            ]),
        ]

        let decoded = service.extractIncomingMessageText(from: itemObject)

        XCTAssertEqual(decoded, "$check-code\nrun the audit")
    }

    private func makeService() -> CodeRoverService {
        let suiteName = "CodeRoverStructuredUserInputDecodeTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defaults.removePersistentDomain(forName: suiteName)
        let service = CodeRoverService(defaults: defaults)
        service.messagesByThread = [:]

        Self.retainedServices.append(service)
        return service
    }
}
