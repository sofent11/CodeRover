// FILE: CollaborationMode.swift
// Purpose: Shared collaboration-mode models used by composer sends and timeline rendering.
// Layer: Model
// Exports: CollaborationModeModeKind, CodeRoverPlanState, CodeRoverStructuredUserInputRequest
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
