// FILE: TurnComposerSendAvailabilityTests.swift
// Purpose: Locks send-button enable/disable truth table after composer refactor.
// Layer: Unit Test
// Exports: TurnComposerSendAvailabilityTests
// Depends on: XCTest, CodeRoverMobile

import XCTest
@testable import CodeRoverMobile

@MainActor
final class TurnComposerSendAvailabilityTests: XCTestCase {
    private static var retainedServices: [CodeRoverService] = []

    func testSendDisabledWhenDisconnected() {
        let state = makeState(isConnected: false)
        XCTAssertTrue(state.isSendDisabled)
    }

    func testSendDisabledWhenSendingInFlight() {
        let state = makeState(isSending: true)
        XCTAssertTrue(state.isSendDisabled)
    }

    func testSendEnabledWhenActiveTurnExistsAndPayloadIsValid() {
        let state = makeState(trimmedInput: "queue this")
        XCTAssertFalse(state.isSendDisabled)
    }

    func testSendDisabledWhenInputAndImagesAreEmpty() {
        let state = makeState(trimmedInput: "", hasReadyImages: false)
        XCTAssertTrue(state.isSendDisabled)
    }

    func testSendDisabledWhenAttachmentStateIsBlocking() {
        let state = makeState(hasBlockingAttachmentState: true)
        XCTAssertTrue(state.isSendDisabled)
    }

    func testSendEnabledWhenConnectedAndPayloadIsValid() {
        let textState = makeState(trimmedInput: "Ship it", hasReadyImages: false)
        XCTAssertFalse(textState.isSendDisabled)

        let imageState = makeState(trimmedInput: "", hasReadyImages: true)
        XCTAssertFalse(imageState.isSendDisabled)
    }

    func testSendTurnRestoresRawDraftWhenStartTurnFails() async {
        let service = makeService()
        service.isConnected = true

        let viewModel = TurnViewModel()
        let rawInput = "Please update TurnView.swift"
        let attachment = ImageAttachment(
            thumbnailBase64JPEG: "thumb",
            payloadDataURL: "data:image/jpeg;base64,AAAA"
        )

        viewModel.input = rawInput
        viewModel.composerAttachments = [
            TurnComposerImageAttachment(id: "attachment-1", state: .ready(attachment))
        ]

        viewModel.sendTurn(coderover: service, threadID: "thread-send-failure")
        await waitForSendCompletion(viewModel)

        XCTAssertFalse(viewModel.isSending)
        XCTAssertEqual(viewModel.input, rawInput)
        XCTAssertEqual(viewModel.readyComposerAttachments, [attachment])
        XCTAssertEqual(viewModel.composerAttachments.count, 1)
    }

    private func makeState(
        isSending: Bool = false,
        isConnected: Bool = true,
        trimmedInput: String = "hello",
        hasReadyImages: Bool = false,
        hasBlockingAttachmentState: Bool = false
    ) -> TurnComposerSendAvailability {
        TurnComposerSendAvailability(
            isSending: isSending,
            isConnected: isConnected,
            trimmedInput: trimmedInput,
            hasReadyImages: hasReadyImages,
            hasBlockingAttachmentState: hasBlockingAttachmentState
        )
    }

    private func waitForSendCompletion(_ viewModel: TurnViewModel, maxPollCount: Int = 120) async {
        for _ in 0..<maxPollCount where viewModel.isSending {
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
    }

    private func makeService() -> CodeRoverService {
        let suiteName = "TurnComposerSendAvailabilityTests.\(UUID().uuidString)"
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
