// FILE: TurnFileAutocompleteTokenTests.swift
// Purpose: Verifies trailing `@` token parsing and replacement in composer input.
// Layer: Unit Test
// Exports: TurnFileAutocompleteTokenTests
// Depends on: XCTest, CodeRoverMobile

import XCTest
@testable import CodeRoverMobile

@MainActor
final class TurnFileAutocompleteTokenTests: XCTestCase {
    func testTrailingTokenParsesOnlyWhenItIsFinalToken() {
        let token = TurnViewModel.trailingFileAutocompleteToken(in: "fix @turnv")
        XCTAssertEqual(token?.query, "turnv")
    }

    func testTrailingTokenAllowsFilePathsWithSpacesWhenTheyLookLikeAPath() {
        let token = TurnViewModel.trailingFileAutocompleteToken(
            in: "update @CodeRover Mobile App Plan/CodeRover iOS Recap TLDR.md"
        )

        XCTAssertEqual(token?.query, "CodeRover Mobile App Plan/CodeRover iOS Recap TLDR.md")
    }

    func testTrailingTokenDoesNotParseEmailAddress() {
        XCTAssertNil(TurnViewModel.trailingFileAutocompleteToken(in: "email@test.com"))
    }

    func testTrailingTokenDoesNotParseWhenAtTokenIsNotFinal() {
        XCTAssertNil(TurnViewModel.trailingFileAutocompleteToken(in: "fix @turnv please"))
    }

    func testReplacingTrailingTokenUpdatesOnlyFinalAtToken() {
        let updated = TurnViewModel.replacingTrailingFileAutocompleteToken(
            in: "compare @first and @turnv",
            with: "Views/Turn/TurnView.swift"
        )

        XCTAssertEqual(updated, "compare @first and @Views/Turn/TurnView.swift ")
    }

    func testReplacingMentionAliasesNormalizesDifferentFilenameStyles() {
        let mention = TurnComposerMentionedFile(
            fileName: "CodeRover iOS Recap TLDR.md",
            path: "CodeRover Mobile App Plan/CodeRover iOS Recap TLDR.md"
        )
        let source = """
        review @coderover-ios-recap-tldr.md
        compare @coderover_ios_recap_tldr
        check @CodeRoverIOSRecapTLDR.md
        inspect @coderoveriosrecaptldr
        """

        let replaced = TurnViewModel.replacingFileMentionAliases(in: source, with: mention)

        XCTAssertTrue(replaced.contains("@CodeRover Mobile App Plan/CodeRover iOS Recap TLDR.md"))
        XCTAssertFalse(replaced.contains("@coderover-ios-recap-tldr.md"))
        XCTAssertFalse(replaced.contains("@coderover_ios_recap_tldr"))
        XCTAssertFalse(replaced.contains("@CodeRoverIOSRecapTLDR.md"))
        XCTAssertFalse(replaced.contains("@coderoveriosrecaptldr"))
    }

    func testReplacingMentionAliasesRequiresFolderContextWhenFileNameIsAmbiguous() {
        let mention = TurnComposerMentionedFile(
            fileName: "Notes.md",
            path: "Docs/Notes.md"
        )
        let source = "compare @Notes.md and @Docs/Notes.md"

        let replaced = TurnViewModel.replacingFileMentionAliases(
            in: source,
            with: mention,
            allowFileNameAliases: false
        )

        XCTAssertEqual(replaced, "compare @Notes.md and @Docs/Notes.md")
    }

    func testAmbiguousFileNameAliasKeysMarksDuplicateBasenames() {
        let mentions = [
            TurnComposerMentionedFile(fileName: "Notes.md", path: "Docs/Notes.md"),
            TurnComposerMentionedFile(fileName: "Notes.md", path: "Archive/Notes.md"),
            TurnComposerMentionedFile(fileName: "Plan.md", path: "Docs/Plan.md"),
        ]

        XCTAssertEqual(TurnViewModel.ambiguousFileNameAliasKeys(in: mentions), ["notes.md"])
    }
}
