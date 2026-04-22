// FILE: CodeRoverPlanModeTests.swift
// Purpose: Verifies plan-mode turn/start payloads and inline timeline state for plan events.
// Layer: Unit Test
// Exports: CodeRoverPlanModeTests
// Depends on: XCTest, CodeRoverMobile

import XCTest
import UserNotifications
@testable import CodeRoverMobile

@MainActor
final class CodeRoverPlanModeTests: XCTestCase {
    private static var retainedServices: [CodeRoverService] = []
    private static var retainedViewModels: [TurnViewModel] = []

    private final class MockNotificationCenter: CodeRoverUserNotificationCentering {
        var delegate: UNUserNotificationCenterDelegate?
        var status: UNAuthorizationStatus = .authorized
        private(set) var addedRequests: [UNNotificationRequest] = []

        func requestAuthorization(options: UNAuthorizationOptions) async throws -> Bool {
            true
        }

        func add(_ request: UNNotificationRequest) async throws {
            addedRequests.append(request)
        }

        func authorizationStatus() async -> UNAuthorizationStatus {
            status
        }
    }

    func testSendTurnUsesPlanModeOnceAndThenReturnsToDefaultMode() async {
        let service = makeService()
        service.isConnected = true
        service.supportsTurnCollaborationMode = true
        service.availableModels = [makeModel()]
        service.setSelectedModelId("gpt-5-coderover")

        var capturedTurnStartParams: [JSONValue] = []
        service.requestTransportOverride = { method, params in
            XCTAssertEqual(method, "turn/start")
            capturedTurnStartParams.append(params ?? .null)
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object(["turnId": .string("turn-live")]),
                includeJSONRPC: false
            )
        }

        let viewModel = makeViewModel()
        viewModel.input = "Plan this refactor"
        viewModel.setPlanModeArmed(true)
        viewModel.sendTurn(coderover: service, threadID: "thread-plan")
        await waitForSendCompletion(viewModel)

        XCTAssertFalse(viewModel.isPlanModeArmed)
        XCTAssertEqual(capturedTurnStartParams.count, 1)
        XCTAssertEqual(
            capturedTurnStartParams[0].objectValue?["collaborationMode"]?.objectValue?["mode"]?.stringValue,
            "plan"
        )
        XCTAssertEqual(
            capturedTurnStartParams[0].objectValue?["model"]?.stringValue,
            "gpt-5-coderover"
        )
        XCTAssertEqual(
            capturedTurnStartParams[0].objectValue?["effort"]?.stringValue,
            "medium"
        )

        viewModel.input = "Normal follow-up"
        viewModel.sendTurn(coderover: service, threadID: "thread-plan")
        await waitForSendCompletion(viewModel)

        XCTAssertEqual(capturedTurnStartParams.count, 2)
        XCTAssertEqual(
            capturedTurnStartParams[1].objectValue?["collaborationMode"]?.objectValue?["mode"]?.stringValue,
            "default"
        )
    }

    func testUnsupportedPlanModeFallsBackToNormalTurnAndStopsRetryingPlanField() async throws {
        let service = makeService()
        service.isConnected = true
        service.supportsTurnCollaborationMode = true
        service.availableModels = [makeModel()]
        service.setSelectedModelId("gpt-5-coderover")

        let threadID = "thread-\(UUID().uuidString)"
        var capturedTurnStartParams: [JSONValue] = []

        service.requestTransportOverride = { method, params in
            XCTAssertEqual(method, "turn/start")
            let requestParams = params ?? .null
            capturedTurnStartParams.append(requestParams)

            if capturedTurnStartParams.count == 1 {
                throw CodeRoverServiceError.rpcError(
                    RPCError(
                        code: -32600,
                        message: "turn/start.collaborationMode requires experimentalApi capability"
                    )
                )
            }

            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object(["turnId": .string("turn-live")]),
                includeJSONRPC: false
            )
        }

        try await service.sendTurnStart("Plan this flow", to: threadID, collaborationMode: .plan)

        XCTAssertEqual(capturedTurnStartParams.count, 2)
        XCTAssertEqual(
            capturedTurnStartParams[0].objectValue?["collaborationMode"]?.objectValue?["mode"]?.stringValue,
            "plan"
        )
        XCTAssertNil(capturedTurnStartParams[1].objectValue?["collaborationMode"])
        XCTAssertFalse(service.supportsTurnCollaborationMode)
        XCTAssertEqual(
            service.messages(for: threadID).last(where: { $0.role == .system })?.text,
            "Plan mode is not supported by this runtime. Sent as a normal turn instead."
        )

        capturedTurnStartParams.removeAll()
        try await service.sendTurnStart("Try plan mode again", to: threadID, collaborationMode: .plan)

        XCTAssertEqual(capturedTurnStartParams.count, 1)
        XCTAssertNil(capturedTurnStartParams[0].objectValue?["collaborationMode"])
    }

    func testRuntimeSupportsPlanCollaborationModeUsesCollaborationModeList() async {
        let service = makeService()

        service.requestTransportOverride = { method, _ in
            XCTAssertEqual(method, "collaborationMode/list")
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object([
                    "modes": .array([
                        .object(["mode": .string("default")]),
                        .object(["mode": .string("plan")]),
                    ]),
                ]),
                includeJSONRPC: false
            )
        }

        let isSupported = await service.runtimeSupportsPlanCollaborationMode()
        XCTAssertTrue(isSupported)
    }

    func testRuntimeSupportsPlanCollaborationModeReturnsFalseWhenPlanMissing() async {
        let service = makeService()

        service.requestTransportOverride = { method, _ in
            XCTAssertEqual(method, "collaborationMode/list")
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object([
                    "modes": .array([
                        .object(["mode": .string("default")]),
                    ]),
                ]),
                includeJSONRPC: false
            )
        }

        let isSupported = await service.runtimeSupportsPlanCollaborationMode()
        XCTAssertFalse(isSupported)
    }

    func testPlanModeSendFailureRearmsToggleAndSkipsFallbackRequest() async {
        let service = makeService()
        service.isConnected = true

        var attemptedRequestCount = 0
        service.requestTransportOverride = { _, _ in
            attemptedRequestCount += 1
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object([:]),
                includeJSONRPC: false
            )
        }

        let viewModel = makeViewModel()
        viewModel.input = "Plan this flow"
        viewModel.setPlanModeArmed(true)
        viewModel.sendTurn(coderover: service, threadID: "thread-plan-failure")
        await waitForSendCompletion(viewModel)

        XCTAssertEqual(attemptedRequestCount, 0)
        XCTAssertTrue(viewModel.isPlanModeArmed)
        XCTAssertEqual(viewModel.input, "Plan this flow")
        XCTAssertEqual(
            service.lastErrorMessage,
            "Plan mode requires an available model before starting a plan turn."
        )
    }

    func testTurnPlanNotificationsKeepStructuredStateAndFinalText() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let itemID = "item-\(UUID().uuidString)"

        service.handleNotification(
            method: "turn/plan/updated",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "explanation": .string("We should break the work into safe slices."),
                "plan": .array([
                    .object([
                        "step": .string("Audit the current flow"),
                        "status": .string("completed"),
                    ]),
                    .object([
                        "step": .string("Implement the UI toggle"),
                        "status": .string("in_progress"),
                    ]),
                ]),
            ])
        )

        service.handleNotification(
            method: "item/plan/delta",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "itemId": .string(itemID),
                "delta": .string("1. Audit the current flow\n2. Implement the UI toggle"),
            ])
        )

        service.handleNotification(
            method: "item/completed",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "item": .object([
                    "id": .string(itemID),
                    "type": .string("plan"),
                    "content": .array([
                        .object([
                            "type": .string("text"),
                            "text": .string("1. Audit the current flow\n2. Implement the UI toggle\n3. Add tests"),
                        ]),
                    ]),
                ]),
            ])
        )

        let planMessages = service.messages(for: threadID).filter { $0.kind == .plan }
        XCTAssertEqual(planMessages.count, 1)
        XCTAssertEqual(planMessages[0].text, "1. Audit the current flow\n2. Implement the UI toggle\n3. Add tests")
        XCTAssertEqual(planMessages[0].planState?.explanation, "We should break the work into safe slices.")
        XCTAssertEqual(planMessages[0].planState?.steps.count, 2)
        XCTAssertEqual(planMessages[0].planState?.steps[0].status, .completed)
    }

    func testStructuredUserInputRequestCreatesAndResolvedRemovesPromptCard() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let itemID = "item-\(UUID().uuidString)"
        let requestID: JSONValue = .string("request-\(UUID().uuidString)")

        service.handleIncomingRPCMessage(
            RPCMessage(
                id: requestID,
                method: "item/tool/requestUserInput",
                params: .object([
                    "threadId": .string(threadID),
                    "turnId": .string(turnID),
                    "itemId": .string(itemID),
                    "questions": .array([
                        .object([
                            "id": .string("mode"),
                            "header": .string("Direction"),
                            "question": .string("Which path should we take?"),
                            "isOther": .bool(false),
                            "isSecret": .bool(false),
                            "options": .array([
                                .object([
                                    "label": .string("Ship it"),
                                    "description": .string("Build the fastest version"),
                                ]),
                            ]),
                        ]),
                    ]),
                ]),
                includeJSONRPC: false
            )
        )

        let promptMessages = service.messages(for: threadID).filter { $0.kind == .userInputPrompt }
        XCTAssertEqual(promptMessages.count, 1)
        XCTAssertEqual(promptMessages[0].structuredUserInputRequest?.questions.first?.header, "Direction")

        service.handleNotification(
            method: "serverRequest/resolved",
            params: .object([
                "threadId": .string(threadID),
                "requestId": requestID,
            ])
        )

        XCTAssertTrue(service.messages(for: threadID).filter { $0.kind == .userInputPrompt }.isEmpty)
    }

    func testStructuredUserInputRequestSchedulesBackgroundPromptNotification() async {
        let notificationCenter = MockNotificationCenter()
        let service = makeService(userNotificationCenter: notificationCenter)
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let requestID: JSONValue = .string("request-\(UUID().uuidString)")
        service.threads = [ConversationThread(id: threadID, title: "Plan Thread")]
        service.isAppInForeground = false

        service.handleIncomingRPCMessage(
            RPCMessage(
                id: requestID,
                method: "item/tool/requestUserInput",
                params: .object([
                    "threadId": .string(threadID),
                    "turnId": .string(turnID),
                    "questions": .array([
                        .object([
                            "id": .string("mode"),
                            "header": .string("Direction"),
                            "question": .string("Which path should we take?"),
                            "options": .array([
                                .object([
                                    "label": .string("Ship it"),
                                    "description": .string("Build the fastest version"),
                                ]),
                            ]),
                        ]),
                    ]),
                ]),
                includeJSONRPC: false
            )
        )

        await Task.yield()
        await Task.yield()

        XCTAssertEqual(notificationCenter.addedRequests.count, 1)
        XCTAssertEqual(notificationCenter.addedRequests[0].content.title, "Plan Thread")
        XCTAssertEqual(notificationCenter.addedRequests[0].content.body, "Plan mode needs your input")
    }

    func testPendingStructuredUserInputSuppressesRunCompletionNotification() async {
        let notificationCenter = MockNotificationCenter()
        let service = makeService(userNotificationCenter: notificationCenter)
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let requestID: JSONValue = .string("request-\(UUID().uuidString)")
        service.threads = [ConversationThread(id: threadID, title: "Plan Thread")]
        service.isAppInForeground = false

        service.handleIncomingRPCMessage(
            RPCMessage(
                id: requestID,
                method: "item/tool/requestUserInput",
                params: .object([
                    "threadId": .string(threadID),
                    "turnId": .string(turnID),
                    "questions": .array([
                        .object([
                            "id": .string("mode"),
                            "header": .string("Direction"),
                            "question": .string("Which path should we take?"),
                            "options": .array([
                                .object([
                                    "label": .string("Ship it"),
                                    "description": .string("Build the fastest version"),
                                ]),
                            ]),
                        ]),
                    ]),
                ]),
                includeJSONRPC: false
            )
        )
        service.handleNotification(
            method: "turn/completed",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
            ])
        )

        await Task.yield()
        await Task.yield()

        XCTAssertEqual(notificationCenter.addedRequests.count, 1)
        XCTAssertEqual(notificationCenter.addedRequests[0].content.body, "Plan mode needs your input")
        XCTAssertFalse(service.readyThreadIDs.contains(threadID))
    }

    func testStructuredUserInputPromptDoesNotPersistAcrossRelaunch() {
        let suiteName = "CodeRoverPlanModeTests.Persistence.\(UUID().uuidString)"
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let itemID = "item-\(UUID().uuidString)"
        let requestID: JSONValue = .string("request-\(UUID().uuidString)")

        let firstService = makeService(suiteName: suiteName)
        firstService.handleIncomingRPCMessage(
            RPCMessage(
                id: requestID,
                method: "item/tool/requestUserInput",
                params: .object([
                    "threadId": .string(threadID),
                    "turnId": .string(turnID),
                    "itemId": .string(itemID),
                    "questions": .array([
                        .object([
                            "id": .string("path"),
                            "header": .string("Direction"),
                            "question": .string("Which path should we take?"),
                            "isOther": .bool(false),
                            "isSecret": .bool(false),
                            "options": .array([
                                .object([
                                    "label": .string("Ship it"),
                                    "description": .string("Build the fastest version"),
                                ]),
                            ]),
                        ]),
                    ]),
                ]),
                includeJSONRPC: false
            )
        )

        let relaunchedService = makeService(suiteName: suiteName, reset: false)
        let promptMessages = relaunchedService.messages(for: threadID).filter { $0.kind == .userInputPrompt }
        XCTAssertTrue(promptMessages.isEmpty)
    }

    func testBuildStructuredUserInputResponseMatchesServerShape() {
        let service = makeService()

        let response = service.buildStructuredUserInputResponse(
            answersByQuestionID: [
                "path": ["Ship it"],
                "notes": ["Keep the old composer styling"],
            ]
        )

        let answers = response.objectValue?["answers"]?.objectValue
        XCTAssertEqual(
            answers?["path"]?.objectValue?["answers"]?.arrayValue?.compactMap(\.stringValue),
            ["Ship it"]
        )
        XCTAssertEqual(
            answers?["notes"]?.objectValue?["answers"]?.arrayValue?.compactMap(\.stringValue),
            ["Keep the old composer styling"]
        )
    }

    func testHistoryPlanItemsRestoreStructuredState() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let itemID = "item-\(UUID().uuidString)"

        let messages = service.decodeMessagesFromThreadRead(
            threadId: threadID,
            threadObject: [
                "createdAt": .double(1_700_000_000),
                "turns": .array([
                    .object([
                        "id": .string(turnID),
                        "items": .array([
                            .object([
                                "id": .string(itemID),
                                "type": .string("plan"),
                                "content": .array([
                                    .object([
                                        "type": .string("text"),
                                        "text": .string("1. Audit\n2. Implement\n3. Verify"),
                                    ]),
                                ]),
                                "explanation": .string("Break the work into safe slices."),
                                "plan": .array([
                                    .object([
                                        "step": .string("Audit"),
                                        "status": .string("completed"),
                                    ]),
                                    .object([
                                        "step": .string("Implement"),
                                        "status": .string("in_progress"),
                                    ]),
                                ]),
                            ]),
                        ]),
                    ]),
                ]),
            ]
        )

        XCTAssertEqual(messages.count, 1)
        XCTAssertEqual(messages[0].kind, .plan)
        XCTAssertEqual(messages[0].text, "1. Audit\n2. Implement\n3. Verify")
        XCTAssertEqual(messages[0].planState?.explanation, "Break the work into safe slices.")
        XCTAssertEqual(messages[0].planState?.steps.count, 2)
        XCTAssertEqual(messages[0].planState?.steps.last?.status, .inProgress)
    }

    func testHistoryDecodeRestoresReviewAndContextCompactionItems() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        let messages = service.decodeMessagesFromThreadRead(
            threadId: threadID,
            threadObject: [
                "createdAt": .double(1_700_000_000),
                "turns": .array([
                    .object([
                        "id": .string(turnID),
                        "items": .array([
                            .object([
                                "id": .string("review-enter"),
                                "type": .string("entered_review_mode"),
                                "review": .string("current changes"),
                            ]),
                            .object([
                                "id": .string("review-exit"),
                                "type": .string("exited_review_mode"),
                                "review": .string("Tighten the nil checks before merging."),
                            ]),
                            .object([
                                "id": .string("compact"),
                                "type": .string("context_compaction"),
                            ]),
                        ]),
                    ]),
                ]),
            ]
        )

        XCTAssertEqual(messages.map(\.kind), [.commandExecution, .chat, .commandExecution])
        XCTAssertEqual(messages.map(\.role), [.system, .assistant, .system])
        XCTAssertEqual(messages[0].text, "Reviewing current changes...")
        XCTAssertEqual(messages[1].text, "Tighten the nil checks before merging.")
        XCTAssertEqual(messages[2].text, "Context compacted")
    }

    func testAssistantMessagesDeriveProposedPlanFromEnvelope() {
        let message = ChatMessage(
            threadId: "thread-plan",
            role: .assistant,
            kind: .chat,
            text: """
            Intro text

            <proposed_plan>
            # Ship
            1. Audit
            2. Implement
            </proposed_plan>
            """
        )

        XCTAssertEqual(message.proposedPlan?.summary, "Ship")
        XCTAssertEqual(
            message.proposedPlan?.body,
            "# Ship\n1. Audit\n2. Implement"
        )
    }

    private func makeService(
        suiteName: String = "CodeRoverPlanModeTests.\(UUID().uuidString)",
        reset: Bool = true,
        userNotificationCenter: CodeRoverUserNotificationCentering? = nil
    ) -> CodeRoverService {
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        if reset {
            defaults.removePersistentDomain(forName: suiteName)
        }
        let service = CodeRoverService(
            defaults: defaults,
            userNotificationCenter: userNotificationCenter ?? MockNotificationCenter()
        )
        if reset {
            service.messagesByThread = [:]
        }
        Self.retainedServices.append(service)
        return service
    }

    private func makeViewModel() -> TurnViewModel {
        let viewModel = TurnViewModel()
        Self.retainedViewModels.append(viewModel)
        return viewModel
    }

    private func makeModel() -> ModelOption {
        ModelOption(
            id: "gpt-5-coderover",
            model: "gpt-5-coderover",
            displayName: "GPT-5 CodeRover",
            description: "Test model",
            isDefault: true,
            supportedReasoningEfforts: [
                ReasoningEffortOption(reasoningEffort: "medium", description: "Medium"),
            ],
            defaultReasoningEffort: "medium"
        )
    }

    private func waitForSendCompletion(_ viewModel: TurnViewModel) async {
        for _ in 0..<120 {
            if !viewModel.isSending {
                return
            }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("Expected send to complete")
    }
}
