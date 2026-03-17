// FILE: CodeRoverAcpSessionLifecycleTests.swift
// Purpose: Verifies ACP-native initialization, session listing, and session lifecycle mapping.
// Layer: Unit Test
// Exports: CodeRoverAcpSessionLifecycleTests
// Depends on: XCTest, CodeRoverMobile

import XCTest
@testable import CodeRoverMobile

@MainActor
final class CodeRoverAcpSessionLifecycleTests: XCTestCase {
    private static var retainedServices: [CodeRoverService] = []

    func testInitializeAndListEndpointsMapAcpPayloads() async throws {
        let service = makeService()

        service.requestTransportOverride = { method, params in
            switch method {
            case "initialize":
                return RPCMessage(id: .integer(1), result: .object([:]))

            case "_coderover/agent/list":
                return RPCMessage(
                    id: .integer(2),
                    result: .object([
                        "agents": .array([
                            .object([
                                "id": .string("codex"),
                                "name": .string("Codex Local"),
                                "_meta": .object([
                                    "coderover": .object([
                                        "defaultModelId": .string("gpt-5-codex"),
                                        "supports": .object([
                                            "planMode": .bool(true),
                                            "structuredUserInput": .bool(true),
                                            "inlineApproval": .bool(true),
                                            "turnSteer": .bool(false),
                                            "reasoningOptions": .bool(true),
                                            "desktopRefresh": .bool(true),
                                            "desktopRestart": .bool(true),
                                        ]),
                                    ]),
                                ]),
                            ]),
                        ]),
                    ])
                )

            case "_coderover/model/list":
                XCTAssertEqual(
                    params?.objectValue?["_meta"]?.objectValue?["coderover"]?.objectValue?["agentId"]?.stringValue,
                    "codex"
                )
                return RPCMessage(
                    id: .integer(3),
                    result: .object([
                        "items": .array([
                            .object([
                                "id": .string("gpt-5-codex"),
                                "name": .string("GPT-5 Codex"),
                                "description": .string("Primary model"),
                                "isDefault": .bool(true),
                            ]),
                            .object([
                                "id": .string("gpt-4.1"),
                                "name": .string("GPT-4.1"),
                                "description": .string("Fallback model"),
                                "isDefault": .bool(false),
                            ]),
                        ]),
                    ])
                )

            case "session/list":
                let isArchived = params?.objectValue?["_meta"]?.objectValue?["coderover"]?.objectValue?["archived"]?.boolValue ?? false
                if isArchived {
                    return RPCMessage(
                        id: .integer(5),
                        result: .object([
                            "sessions": .array([
                                .object([
                                    "sessionId": .string("session-archived"),
                                    "title": .string("Archived Session"),
                                    "archived": .bool(true),
                                    "_meta": .object([
                                        "coderover": .object([
                                            "agentId": .string("codex"),
                                            "preview": .string("archived preview"),
                                        ]),
                                    ]),
                                ]),
                            ]),
                            "nextCursor": .null,
                        ])
                    )
                }

                return RPCMessage(
                    id: .integer(4),
                    result: .object([
                        "sessions": .array([
                            .object([
                                "sessionId": .string("session-live"),
                                "title": .string("Live Session"),
                                "cwd": .string("/tmp/project-a"),
                                "updatedAt": .string("2026-03-17T10:00:00.000Z"),
                                "_meta": .object([
                                    "coderover": .object([
                                        "agentId": .string("codex"),
                                        "preview": .string("live preview"),
                                    ]),
                                ]),
                            ]),
                        ]),
                        "nextCursor": .null,
                    ])
                )

            default:
                XCTFail("Unexpected ACP method: \(method)")
                return RPCMessage(id: .integer(999), result: .object([:]))
            }
        }

        try await service.initializeSession()
        try await service.listProviders()
        try await service.listModels(provider: "codex")
        try await service.listThreads(limit: 10)

        XCTAssertTrue(service.isInitialized)
        XCTAssertTrue(service.supportsTurnCollaborationMode)
        XCTAssertEqual(service.availableProviders.map(\.id), ["codex"])
        XCTAssertEqual(service.availableProviders.first?.title, "Codex Local")
        XCTAssertEqual(service.availableProviders.first?.defaultModelId, "gpt-5-codex")
        XCTAssertEqual(service.availableModels.map(\.id), ["gpt-5-codex", "gpt-4.1"])
        XCTAssertEqual(service.selectedModelOption()?.id, "gpt-5-codex")

        let liveThread = try XCTUnwrap(service.threads.first(where: { $0.id == "session-live" }))
        let archivedThread = try XCTUnwrap(service.threads.first(where: { $0.id == "session-archived" }))
        XCTAssertEqual(liveThread.syncState, .live)
        XCTAssertEqual(archivedThread.syncState, .archivedLocal)
        XCTAssertEqual(liveThread.providerBadgeTitle, "Codex Local")
    }

    func testStartThreadHydrateAndResumeApplyAcpSessionState() async throws {
        let service = makeService()
        service.availableProviders = [.codexDefault]

        service.requestTransportOverride = { [weak service] method, _ in
            guard let service else {
                XCTFail("Service deallocated during test")
                return RPCMessage(id: .integer(999), result: .object([:]))
            }

            switch method {
            case "session/new":
                return RPCMessage(
                    id: .integer(1),
                    result: .object([
                        "sessionId": .string("session-new"),
                        "modes": .object([
                            "currentModeId": .string("default"),
                            "availableModes": .array([
                                .object(["id": .string("default")]),
                                .object(["id": .string("plan")]),
                            ]),
                        ]),
                        "models": .object([
                            "currentModelId": .string("gpt-5-codex"),
                        ]),
                    ])
                )

            case "session/load":
                await MainActor.run {
                    service.handleIncomingRPCMessage(
                        RPCMessage(
                            method: "session/update",
                            params: .object([
                                "sessionId": .string("session-new"),
                                "update": .object([
                                    "sessionUpdate": .string("session_info_update"),
                                    "_meta": .object([
                                        "coderover": .object([
                                            "agentId": .string("codex"),
                                            "runState": .string("running"),
                                            "turnId": .string("turn-live"),
                                        ]),
                                    ]),
                                ]),
                            ])
                        )
                    )
                    service.handleIncomingRPCMessage(
                        RPCMessage(
                            method: "session/update",
                            params: .object([
                                "sessionId": .string("session-new"),
                                "update": .object([
                                    "sessionUpdate": .string("user_message_chunk"),
                                    "messageId": .string("user-1"),
                                    "content": .array([
                                        .object([
                                            "content": .object([
                                                "type": .string("text"),
                                                "text": .string("Please add tests"),
                                            ]),
                                        ]),
                                    ]),
                                    "_meta": .object([
                                        "coderover": .object([
                                            "turnId": .string("turn-live"),
                                            "itemId": .string("user-1"),
                                        ]),
                                    ]),
                                ]),
                            ])
                        )
                    )
                    service.handleIncomingRPCMessage(
                        RPCMessage(
                            method: "session/update",
                            params: .object([
                                "sessionId": .string("session-new"),
                                "update": .object([
                                    "sessionUpdate": .string("agent_message_chunk"),
                                    "messageId": .string("assistant-1"),
                                    "content": .array([
                                        .object([
                                            "content": .object([
                                                "type": .string("text"),
                                                "text": .string("On it"),
                                            ]),
                                        ]),
                                    ]),
                                    "_meta": .object([
                                        "coderover": .object([
                                            "turnId": .string("turn-live"),
                                            "itemId": .string("assistant-1"),
                                        ]),
                                    ]),
                                ]),
                            ])
                        )
                    )
                }

                return RPCMessage(
                    id: .integer(2),
                    result: .object([
                        "sessionId": .string("session-new"),
                        "modes": .object([
                            "currentModeId": .string("plan"),
                            "availableModes": .array([
                                .object(["id": .string("default")]),
                                .object(["id": .string("plan")]),
                            ]),
                        ]),
                        "models": .object([
                            "currentModelId": .string("gpt-5-codex"),
                        ]),
                    ])
                )

            case "session/resume":
                return RPCMessage(
                    id: .integer(3),
                    result: .object([
                        "sessionId": .string("session-new"),
                        "modes": .object([
                            "currentModeId": .string("default"),
                            "availableModes": .array([
                                .object(["id": .string("default")]),
                                .object(["id": .string("plan")]),
                            ]),
                        ]),
                        "models": .object([
                            "currentModelId": .string("gpt-5.1"),
                        ]),
                    ])
                )

            default:
                XCTFail("Unexpected ACP method: \(method)")
                return RPCMessage(id: .integer(999), result: .object([:]))
            }
        }

        let thread = try await service.startThread(preferredProjectPath: "/tmp/project-b", provider: "codex")
        XCTAssertEqual(thread.id, "session-new")
        XCTAssertEqual(thread.cwd, "/tmp/project-b")
        XCTAssertEqual(thread.metadata?["currentModeId"]?.stringValue, "default")
        XCTAssertEqual(thread.metadata?["currentModelId"]?.stringValue, "gpt-5-codex")
        XCTAssertEqual(service.activeThreadId, "session-new")

        _ = try await service.hydrateThreadTranscript(threadId: "session-new", forceReload: true)

        let hydratedMessages = try XCTUnwrap(service.messagesByThread["session-new"])
        XCTAssertEqual(hydratedMessages.map(\.id), ["user-1", "assistant-1"])
        XCTAssertEqual(hydratedMessages.map(\.text), ["Please add tests", "On it"])
        XCTAssertEqual(service.activeTurnID(for: "session-new"), "turn-live")
        XCTAssertTrue(service.runningThreadIDs.contains("session-new"))
        XCTAssertEqual(
            service.threads.first(where: { $0.id == "session-new" })?.metadata?["currentModeId"]?.stringValue,
            "plan"
        )

        _ = try await service.ensureThreadResumed(threadId: "session-new", force: true)

        XCTAssertEqual(
            service.threads.first(where: { $0.id == "session-new" })?.metadata?["currentModeId"]?.stringValue,
            "default"
        )
        XCTAssertEqual(
            service.threads.first(where: { $0.id == "session-new" })?.metadata?["currentModelId"]?.stringValue,
            "gpt-5.1"
        )
    }

    func testListThreadsRebindsStaleActiveThreadToFirstLiveSession() async throws {
        let service = makeService()
        service.availableProviders = [.codexDefault]
        service.activeThreadId = "session-stale"

        service.requestTransportOverride = { method, params in
            switch method {
            case "session/list":
                let isArchived = params?.objectValue?["_meta"]?.objectValue?["coderover"]?.objectValue?["archived"]?.boolValue ?? false
                if isArchived {
                    return RPCMessage(
                        id: .integer(2),
                        result: .object([
                            "sessions": .array([]),
                            "nextCursor": .null,
                        ])
                    )
                }

                return RPCMessage(
                    id: .integer(1),
                    result: .object([
                        "sessions": .array([
                            .object([
                                "sessionId": .string("session-live"),
                                "title": .string("Live Session"),
                                "_meta": .object([
                                    "coderover": .object([
                                        "agentId": .string("codex"),
                                    ]),
                                ]),
                            ]),
                        ]),
                        "nextCursor": .null,
                    ])
                )

            default:
                XCTFail("Unexpected ACP method: \(method)")
                return RPCMessage(id: .integer(999), result: .object([:]))
            }
        }

        try await service.listThreads(limit: 10)

        XCTAssertEqual(service.threads.map(\.id), ["session-live"])
        XCTAssertEqual(service.activeThreadId, "session-live")
    }

    func testListThreadsWithoutExplicitLimitConsumesAllACPActivePages() async throws {
        let service = makeService()
        service.availableProviders = [.codexDefault]

        var activeRequests = 0
        service.requestTransportOverride = { method, params in
            switch method {
            case "session/list":
                let isArchived = params?.objectValue?["_meta"]?.objectValue?["coderover"]?.objectValue?["archived"]?.boolValue ?? false
                if isArchived {
                    return RPCMessage(
                        id: .integer(30),
                        result: .object([
                            "sessions": .array([]),
                            "nextCursor": .null,
                        ])
                    )
                }

                activeRequests += 1
                if activeRequests == 1 {
                    return RPCMessage(
                        id: .integer(31),
                        result: .object([
                            "sessions": .array([
                                .object([
                                    "sessionId": .string("session-1"),
                                    "title": .string("Session 1"),
                                    "_meta": .object([
                                        "coderover": .object([
                                            "agentId": .string("codex"),
                                        ]),
                                    ]),
                                ]),
                            ]),
                            "nextCursor": .string("cursor-2"),
                        ])
                    )
                }

                XCTAssertEqual(params?.objectValue?["cursor"]?.stringValue, "cursor-2")
                return RPCMessage(
                    id: .integer(32),
                    result: .object([
                        "sessions": .array([
                            .object([
                                "sessionId": .string("session-2"),
                                "title": .string("Session 2"),
                                "_meta": .object([
                                    "coderover": .object([
                                        "agentId": .string("codex"),
                                    ]),
                                ]),
                            ]),
                        ]),
                        "nextCursor": .null,
                    ])
                )

            default:
                XCTFail("Unexpected ACP method: \(method)")
                return RPCMessage(id: .integer(999), result: .object([:]))
            }
        }

        try await service.listThreads()

        XCTAssertEqual(service.threads.map(\.id), ["session-2", "session-1"])
        XCTAssertEqual(activeRequests, 2)
        XCTAssertFalse(service.activeThreadListHasMore)
    }

    private func makeService() -> CodeRoverService {
        let suiteName = "CodeRoverAcpSessionLifecycleTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defaults.removePersistentDomain(forName: suiteName)
        let service = CodeRoverService(defaults: defaults)
        service.messagesByThread = [:]
        Self.retainedServices.append(service)
        return service
    }
}
