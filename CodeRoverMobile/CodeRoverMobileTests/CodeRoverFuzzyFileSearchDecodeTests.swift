// FILE: CodeRoverFuzzyFileSearchDecodeTests.swift
// Purpose: Verifies fuzzyFileSearch response decoding and path normalization helpers.
// Layer: Unit Test
// Exports: CodeRoverFuzzyFileSearchDecodeTests
// Depends on: XCTest, CodeRoverMobile

import XCTest
@testable import CodeRoverMobile

@MainActor
final class CodeRoverFuzzyFileSearchDecodeTests: XCTestCase {
    private static var retainedServices: [CodeRoverService] = []

    func testDecodeFuzzyFileSearchParsesResultFiles() {
        let service = makeService()
        let result: JSONValue = .object([
            "files": .array([
                .object([
                    "root": .string("/workspace"),
                    "path": .string("Sources/App.swift"),
                    "file_name": .string("App.swift"),
                    "score": .integer(93),
                    "indices": .array([.integer(0), .integer(3)]),
                ]),
            ]),
        ])

        let files = service.decodeFuzzyFileMatches(from: result)

        XCTAssertEqual(files?.count, 1)
        XCTAssertEqual(files?.first?.root, "/workspace")
        XCTAssertEqual(files?.first?.path, "Sources/App.swift")
        XCTAssertEqual(files?.first?.fileName, "App.swift")
        XCTAssertEqual(files?.first?.score, 93)
        XCTAssertEqual(files?.first?.indices, [0, 3])
    }

    func testNormalizeFuzzyFilePathConvertsAbsolutePathToRelative() {
        let service = makeService()
        let normalized = service.normalizeFuzzyFilePath(
            path: "/workspace/Sources/App.swift",
            root: "/workspace"
        )
        XCTAssertEqual(normalized, "Sources/App.swift")
    }

    private func makeService() -> CodeRoverService {
        let suiteName = "CodeRoverFuzzyFileSearchDecodeTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defaults.removePersistentDomain(forName: suiteName)
        let service = CodeRoverService(defaults: defaults)
        service.messagesByThread = [:]

        // CodeRoverService currently crashes while deallocating in unit-test environment.
        // Keep instances alive for process lifetime so assertions remain deterministic.
        Self.retainedServices.append(service)
        return service
    }
}
