// FILE: CollaborationMode.swift
// Purpose: Shared collaboration-mode models used by composer sends and timeline rendering.
// Layer: Model
// Exports: CollaborationModeModeKind, CodeRoverPlanState, CodeRoverStructuredUserInputRequest,
//   CodeRoverSubagentAction
// Depends on: Foundation, JSONValue

import Foundation

enum CollaborationModeModeKind: String, Codable, Hashable, Sendable {
    case `default`
    case plan
}

enum CodeRoverPlanStepStatus: String, Codable, Hashable, Sendable {
    case pending
    case inProgress = "in_progress"
    case completed

    init?(wireValue: String) {
        let normalized = wireValue.trimmingCharacters(in: .whitespacesAndNewlines)
        switch normalized {
        case "pending":
            self = .pending
        case "in_progress", "inProgress":
            self = .inProgress
        case "completed":
            self = .completed
        default:
            return nil
        }
    }
}

struct CodeRoverPlanStep: Identifiable, Codable, Hashable, Sendable {
    let id: String
    let step: String
    let status: CodeRoverPlanStepStatus

    init(id: String = UUID().uuidString, step: String, status: CodeRoverPlanStepStatus) {
        self.id = id
        self.step = step
        self.status = status
    }
}

struct CodeRoverPlanState: Codable, Hashable, Sendable {
    var explanation: String?
    var steps: [CodeRoverPlanStep]

    init(explanation: String? = nil, steps: [CodeRoverPlanStep] = []) {
        self.explanation = explanation
        self.steps = steps
    }
}

struct CodeRoverProposedPlan: Codable, Hashable, Sendable {
    let body: String
    let summary: String?

    init(body: String, summary: String? = nil) {
        self.body = body
        self.summary = summary
    }
}

enum CodeRoverPlanPresentation: String, Codable, Hashable, Sendable {
    case progress
    case resultStreaming
    case resultCompletedItem
    case resultReady
    case resultClosed

    var isInlineResultVisible: Bool {
        self == .resultReady || self == .resultCompletedItem
    }
}

enum CodeRoverProposedPlanParser {
    private static let envelopeExpression = try? NSRegularExpression(
        pattern: "<proposed_plan>([\\s\\S]*?)</proposed_plan>",
        options: [.caseInsensitive]
    )

    private static let numberedStepExpression = try? NSRegularExpression(
        pattern: "(?m)^\\s*\\d+[\\.)]\\s+.+$"
    )

    static func parse(from rawText: String) -> CodeRoverProposedPlan? {
        guard let expression = envelopeExpression else {
            return nil
        }

        let range = NSRange(rawText.startIndex..<rawText.endIndex, in: rawText)
        guard let match = expression.firstMatch(in: rawText, options: [], range: range),
              let bodyRange = Range(match.range(at: 1), in: rawText) else {
            return nil
        }

        let body = rawText[bodyRange].trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else {
            return nil
        }

        return CodeRoverProposedPlan(body: body, summary: proposedPlanSummary(from: body))
    }

    static func containsEnvelope(in rawText: String) -> Bool {
        guard let expression = envelopeExpression else {
            return false
        }

        let range = NSRange(rawText.startIndex..<rawText.endIndex, in: rawText)
        return expression.firstMatch(in: rawText, options: [], range: range) != nil
    }

    static func removingEnvelope(from rawText: String) -> String? {
        guard let expression = envelopeExpression else {
            return normalizedText(rawText)
        }

        let range = NSRange(rawText.startIndex..<rawText.endIndex, in: rawText)
        let stripped = expression.stringByReplacingMatches(
            in: rawText,
            options: [],
            range: range,
            withTemplate: ""
        )
        return normalizedText(stripped)
    }

    static func parseAssistantFallback(from rawText: String) -> CodeRoverProposedPlan? {
        let body = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty,
              !containsEnvelope(in: body),
              looksLikeFallbackPlan(body) else {
            return nil
        }

        return CodeRoverProposedPlan(body: body, summary: proposedPlanSummary(from: body))
    }

    static func parsePlanItem(from rawText: String) -> CodeRoverProposedPlan? {
        let body = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else {
            return nil
        }

        return CodeRoverProposedPlan(body: body, summary: proposedPlanSummary(from: body))
    }

    private static func proposedPlanSummary(from body: String) -> String? {
        let lines = body
            .components(separatedBy: .newlines)
            .map { line in
                line.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            .filter { !$0.isEmpty }

        for line in lines {
            let normalized = line
                .replacingOccurrences(of: #"^[-*•\d\.\)\s#]+"#, with: "", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !normalized.isEmpty {
                return normalized
            }
        }

        return nil
    }

    private static func normalizedText(_ rawText: String) -> String? {
        let trimmed = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func looksLikeFallbackPlan(_ body: String) -> Bool {
        guard let expression = numberedStepExpression else {
            return false
        }

        let range = NSRange(body.startIndex..<body.endIndex, in: body)
        let matches = expression.matches(in: body, options: [], range: range)
        guard matches.count >= 2 else {
            return false
        }

        let firstLine = body
            .components(separatedBy: .newlines)
            .first?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            ?? ""
        let normalizedFirstLine = firstLine.lowercased()

        return normalizedFirstLine.contains("plan")
            || normalizedFirstLine.contains("roadmap")
            || normalizedFirstLine.contains("proposal")
            || normalizedFirstLine.contains("approach")
            || normalizedFirstLine.contains("implementation")
    }
}

struct CodeRoverStructuredUserInputOption: Identifiable, Codable, Hashable, Sendable {
    let id: String
    let label: String
    let description: String

    init(id: String = UUID().uuidString, label: String, description: String) {
        self.id = id
        self.label = label
        self.description = description
    }
}

struct CodeRoverStructuredUserInputQuestion: Identifiable, Codable, Hashable, Sendable {
    let id: String
    let header: String
    let question: String
    let isOther: Bool
    let isSecret: Bool
    let options: [CodeRoverStructuredUserInputOption]

    init(
        id: String,
        header: String,
        question: String,
        isOther: Bool,
        isSecret: Bool,
        options: [CodeRoverStructuredUserInputOption]
    ) {
        self.id = id
        self.header = header
        self.question = question
        self.isOther = isOther
        self.isSecret = isSecret
        self.options = options
    }
}

struct CodeRoverStructuredUserInputRequest: Codable, Hashable, Sendable {
    let requestID: JSONValue
    let questions: [CodeRoverStructuredUserInputQuestion]

    init(requestID: JSONValue, questions: [CodeRoverStructuredUserInputQuestion]) {
        self.requestID = requestID
        self.questions = questions
    }
}

struct CodeRoverSubagentRef: Codable, Hashable, Sendable {
    let threadId: String
    let agentId: String?
    let nickname: String?
    let role: String?
    let model: String?
    let prompt: String?

    init(
        threadId: String,
        agentId: String? = nil,
        nickname: String? = nil,
        role: String? = nil,
        model: String? = nil,
        prompt: String? = nil
    ) {
        self.threadId = threadId
        self.agentId = agentId
        self.nickname = nickname
        self.role = role
        self.model = model
        self.prompt = prompt
    }
}

struct CodeRoverSubagentState: Codable, Hashable, Sendable {
    let threadId: String
    var status: String
    var message: String?

    init(threadId: String, status: String, message: String? = nil) {
        self.threadId = threadId
        self.status = status
        self.message = message
    }
}

struct CodeRoverSubagentThreadPresentation: Identifiable, Hashable, Sendable {
    let threadId: String
    let agentId: String?
    let nickname: String?
    let role: String?
    let model: String?
    let modelIsRequestedHint: Bool
    let prompt: String?
    let fallbackStatus: String?
    let fallbackMessage: String?

    var id: String { threadId }

    var displayLabel: String {
        let trimmedNickname = sanitizedAgentIdentity(nickname)
        let trimmedRole = sanitizedAgentIdentity(role)

        if let trimmedNickname, !trimmedNickname.isEmpty,
           let trimmedRole, !trimmedRole.isEmpty {
            return "\(trimmedNickname) [\(trimmedRole)]"
        }

        if let trimmedNickname, !trimmedNickname.isEmpty {
            return trimmedNickname
        }

        if let trimmedRole, !trimmedRole.isEmpty {
            return trimmedRole.capitalized
        }

        let compactThreadId = threadId.trimmingCharacters(in: .whitespacesAndNewlines)
        if compactThreadId.count > 14 {
            return "Agent \(compactThreadId.suffix(8))"
        }
        return compactThreadId.isEmpty ? "Agent" : compactThreadId
    }

    private func sanitizedAgentIdentity(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        let lowered = trimmed.lowercased()
        if lowered == "collabagenttoolcall" || lowered == "collabtoolcall" {
            return nil
        }

        return trimmed
    }
}

struct CodeRoverSubagentAction: Codable, Hashable, Sendable {
    var tool: String
    var status: String
    var prompt: String?
    var model: String?
    var receiverThreadIds: [String]
    var receiverAgents: [CodeRoverSubagentRef]
    var agentStates: [String: CodeRoverSubagentState]

    init(
        tool: String,
        status: String,
        prompt: String? = nil,
        model: String? = nil,
        receiverThreadIds: [String] = [],
        receiverAgents: [CodeRoverSubagentRef] = [],
        agentStates: [String: CodeRoverSubagentState] = [:]
    ) {
        self.tool = tool
        self.status = status
        self.prompt = prompt
        self.model = model
        self.receiverThreadIds = receiverThreadIds
        self.receiverAgents = receiverAgents
        self.agentStates = agentStates
    }

    var agentRows: [CodeRoverSubagentThreadPresentation] {
        var orderedThreadIds: [String] = []
        for threadId in receiverThreadIds where !orderedThreadIds.contains(threadId) {
            orderedThreadIds.append(threadId)
        }
        for agent in receiverAgents where !orderedThreadIds.contains(agent.threadId) {
            orderedThreadIds.append(agent.threadId)
        }
        for threadId in agentStates.keys.sorted() where !orderedThreadIds.contains(threadId) {
            orderedThreadIds.append(threadId)
        }

        return orderedThreadIds.map { threadId in
            let matchingAgent = receiverAgents.first(where: { $0.threadId == threadId })
            let matchingState = agentStates[threadId]
            return CodeRoverSubagentThreadPresentation(
                threadId: threadId,
                agentId: matchingAgent?.agentId,
                nickname: matchingAgent?.nickname,
                role: matchingAgent?.role,
                model: matchingAgent?.model ?? model,
                modelIsRequestedHint: matchingAgent?.model == nil && model != nil,
                prompt: matchingAgent?.prompt,
                fallbackStatus: matchingState?.status,
                fallbackMessage: matchingState?.message
            )
        }
    }

    var normalizedTool: String {
        tool.trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: "_", with: "")
            .replacingOccurrences(of: "-", with: "")
    }

    var normalizedStatus: String {
        status.trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: "_", with: "")
            .replacingOccurrences(of: "-", with: "")
    }

    var summaryText: String {
        let count = max(1, max(agentRows.count, receiverThreadIds.count, receiverAgents.count))
        let noun = count == 1 ? "agent" : "agents"

        switch normalizedTool {
        case "spawnagent":
            return "Spawning \(count) \(noun)"
        case "wait", "waitagent":
            return "Waiting on \(count) \(noun)"
        case "sendinput":
            return "Sending input to \(count) \(noun)"
        case "resumeagent":
            return "Resuming \(count) \(noun)"
        case "closeagent":
            return "Closing \(count) \(noun)"
        default:
            return "Coordinating \(count) \(noun)"
        }
    }
}
