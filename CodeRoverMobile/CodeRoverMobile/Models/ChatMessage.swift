// FILE: ChatMessage.swift
// Purpose: Defines chat messages rendered in each thread conversation timeline.
// Layer: Model
// Exports: ChatMessage, ChatMessageRole
// Depends on: Foundation

import Foundation

enum ChatMessageRole: String, Codable, Hashable, Sendable {
    case user
    case assistant
    case system
}

enum ChatMessageDeliveryState: String, Codable, Hashable, Sendable {
    case pending
    case confirmed
    case failed
}

enum ChatMessageKind: String, Codable, Hashable, Sendable {
    case chat
    case thinking
    case fileChange
    case commandExecution
    case subagentAction
    case plan
    case userInputPrompt
}

struct ChatMessage: Identifiable, Codable, Hashable, Sendable {
    let id: String
    let threadId: String
    var role: ChatMessageRole
    var kind: ChatMessageKind
    var text: String
    let createdAt: Date
    var turnId: String?
    var itemId: String?
    var isStreaming: Bool
    var deliveryState: ChatMessageDeliveryState
    var attachments: [ImageAttachment]
    var planState: CodeRoverPlanState?
    var subagentAction: CodeRoverSubagentAction?
    var structuredUserInputRequest: CodeRoverStructuredUserInputRequest?
    var providerItemId: String?
    var timelineOrdinal: Int?
    var timelineStatus: String?

    /// Monotonically increasing counter that preserves insertion order.
    /// Used as primary sort key so messages are never reordered by timestamp drift.
    var orderIndex: Int

    var timelineItemId: String { id }

    init(
        id: String = UUID().uuidString,
        threadId: String,
        role: ChatMessageRole,
        kind: ChatMessageKind = .chat,
        text: String,
        createdAt: Date = Date(),
        turnId: String? = nil,
        itemId: String? = nil,
        isStreaming: Bool = false,
        deliveryState: ChatMessageDeliveryState = .confirmed,
        attachments: [ImageAttachment] = [],
        planState: CodeRoverPlanState? = nil,
        subagentAction: CodeRoverSubagentAction? = nil,
        structuredUserInputRequest: CodeRoverStructuredUserInputRequest? = nil,
        providerItemId: String? = nil,
        timelineOrdinal: Int? = nil,
        timelineStatus: String? = nil,
        orderIndex: Int? = nil
    ) {
        self.id = id
        self.threadId = threadId
        self.role = role
        self.kind = kind
        self.text = text
        self.createdAt = createdAt
        self.turnId = turnId
        self.itemId = itemId
        self.isStreaming = isStreaming
        self.deliveryState = deliveryState
        self.attachments = attachments
        self.planState = planState
        self.subagentAction = subagentAction
        self.structuredUserInputRequest = structuredUserInputRequest
        self.providerItemId = providerItemId
        self.timelineOrdinal = timelineOrdinal
        self.timelineStatus = timelineStatus
        self.orderIndex = orderIndex ?? MessageOrderCounter.next()
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case threadId
        case role
        case kind
        case text
        case createdAt
        case turnId
        case itemId
        case isStreaming
        case deliveryState
        case attachments
        case planState
        case subagentAction
        case structuredUserInputRequest
        case providerItemId
        case timelineOrdinal
        case timelineStatus
        case orderIndex
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        threadId = try container.decode(String.self, forKey: .threadId)
        role = try container.decode(ChatMessageRole.self, forKey: .role)
        kind = try container.decodeIfPresent(ChatMessageKind.self, forKey: .kind) ?? .chat
        text = try container.decode(String.self, forKey: .text)
        createdAt = try container.decode(Date.self, forKey: .createdAt)
        turnId = try container.decodeIfPresent(String.self, forKey: .turnId)
        itemId = try container.decodeIfPresent(String.self, forKey: .itemId)
        isStreaming = try container.decodeIfPresent(Bool.self, forKey: .isStreaming) ?? false
        deliveryState = try container.decodeIfPresent(ChatMessageDeliveryState.self, forKey: .deliveryState) ?? .confirmed
        attachments = try container.decodeIfPresent([ImageAttachment].self, forKey: .attachments) ?? []
        planState = try container.decodeIfPresent(CodeRoverPlanState.self, forKey: .planState)
        subagentAction = try container.decodeIfPresent(CodeRoverSubagentAction.self, forKey: .subagentAction)
        structuredUserInputRequest = try container.decodeIfPresent(
            CodeRoverStructuredUserInputRequest.self,
            forKey: .structuredUserInputRequest
        )
        providerItemId = try container.decodeIfPresent(String.self, forKey: .providerItemId)
        timelineOrdinal = try container.decodeIfPresent(Int.self, forKey: .timelineOrdinal)
        timelineStatus = try container.decodeIfPresent(String.self, forKey: .timelineStatus)
        orderIndex = try container.decodeIfPresent(Int.self, forKey: .orderIndex) ?? MessageOrderCounter.next()
    }
}
