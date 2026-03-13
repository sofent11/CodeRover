// FILE: CodeRoverService+IncomingPlanMode.swift
// Purpose: Handles plan-mode notifications and structured user-input requests.
// Layer: Service
// Exports: CodeRoverService plan-mode incoming handlers
// Depends on: CodeRoverService+Incoming shared routing helpers

import Foundation

extension CodeRoverService {
    // Applies the latest structured plan snapshot for a turn while plan text keeps streaming separately.
    func handleTurnPlanUpdated(_ paramsObject: IncomingParamsObject?) {
        guard let paramsObject,
              let threadId = normalizedPlanIdentifier(paramsObject["threadId"]?.stringValue),
              let turnId = normalizedPlanIdentifier(paramsObject["turnId"]?.stringValue) else {
            return
        }

        threadIdByTurnID[turnId] = threadId
        let explanation = normalizedOptionalPlanText(paramsObject["explanation"]?.stringValue)
        let steps = decodePlanSteps(from: paramsObject["plan"])

        upsertPlanMessage(
            threadId: threadId,
            turnId: turnId,
            itemId: nil,
            explanation: explanation,
            steps: steps,
            isStreaming: true
        )
    }

    // Streams the current proposed-plan text while treating the final item/completed body as authoritative.
    func appendPlanDelta(from paramsObject: IncomingParamsObject?) {
        guard let paramsObject,
              let threadId = normalizedPlanIdentifier(paramsObject["threadId"]?.stringValue),
              let turnId = normalizedPlanIdentifier(paramsObject["turnId"]?.stringValue),
              let itemId = normalizedPlanIdentifier(paramsObject["itemId"]?.stringValue) else {
            return
        }

        let delta = paramsObject["delta"]?.stringValue ?? ""
        guard !delta.isEmpty else {
            return
        }

        threadIdByTurnID[turnId] = threadId
        upsertPlanMessage(
            threadId: threadId,
            turnId: turnId,
            itemId: itemId,
            text: delta,
            isStreaming: true
        )
    }

    // Creates the inline question card used by plan mode when the server needs a structured answer.
    func handleStructuredUserInputRequest(
        requestID: JSONValue,
        paramsObject: IncomingParamsObject?
    ) {
        guard let paramsObject,
              let threadId = normalizedPlanIdentifier(paramsObject["threadId"]?.stringValue),
              let turnId = normalizedPlanIdentifier(paramsObject["turnId"]?.stringValue) else {
            return
        }

        threadIdByTurnID[turnId] = threadId
        let itemId = normalizedPlanIdentifier(paramsObject["itemId"]?.stringValue) ?? "request-\(idKey(from: requestID))"
        let questions = decodeStructuredUserInputQuestions(from: paramsObject["questions"])
        guard !questions.isEmpty else {
            return
        }

        upsertStructuredUserInputPrompt(
            threadId: threadId,
            turnId: turnId,
            itemId: itemId,
            request: CodeRoverStructuredUserInputRequest(
                requestID: requestID,
                questions: questions
            )
        )
    }

    // Removes inline question cards once the server confirms the request was resolved.
    func handleServerRequestResolved(_ paramsObject: IncomingParamsObject?) {
        guard let requestID = paramsObject?["requestId"] else {
            return
        }

        let threadId = normalizedPlanIdentifier(paramsObject?["threadId"]?.stringValue)
        removeStructuredUserInputPrompt(requestID: requestID, threadIdHint: threadId)
    }
}

private extension CodeRoverService {
    func normalizedPlanIdentifier(_ rawValue: String?) -> String? {
        guard let rawValue else {
            return nil
        }

        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    func normalizedOptionalPlanText(_ rawValue: String?) -> String? {
        guard let rawValue else {
            return nil
        }

        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    func decodePlanSteps(from value: JSONValue?) -> [CodeRoverPlanStep] {
        let items = value?.arrayValue ?? []
        return items.compactMap { value in
            guard let object = value.objectValue,
                  let step = normalizedOptionalPlanText(object["step"]?.stringValue),
                  let rawStatus = normalizedOptionalPlanText(object["status"]?.stringValue),
                  let status = CodeRoverPlanStepStatus(rawValue: rawStatus) else {
                return nil
            }

            return CodeRoverPlanStep(step: step, status: status)
        }
    }

    func decodeStructuredUserInputQuestions(from value: JSONValue?) -> [CodeRoverStructuredUserInputQuestion] {
        let items = value?.arrayValue ?? []
        return items.compactMap { value in
            guard let object = value.objectValue,
                  let id = normalizedPlanIdentifier(object["id"]?.stringValue),
                  let header = normalizedOptionalPlanText(object["header"]?.stringValue) ?? object["header"]?.stringValue,
                  let question = normalizedOptionalPlanText(object["question"]?.stringValue) ?? object["question"]?.stringValue else {
                return nil
            }

            let options = (object["options"]?.arrayValue ?? []).compactMap { optionValue -> CodeRoverStructuredUserInputOption? in
                guard let optionObject = optionValue.objectValue,
                      let label = normalizedPlanIdentifier(optionObject["label"]?.stringValue),
                      let description = normalizedOptionalPlanText(optionObject["description"]?.stringValue) ?? optionObject["description"]?.stringValue else {
                    return nil
                }
                return CodeRoverStructuredUserInputOption(label: label, description: description)
            }

            return CodeRoverStructuredUserInputQuestion(
                id: id,
                header: header,
                question: question,
                isOther: object["isOther"]?.boolValue ?? false,
                isSecret: object["isSecret"]?.boolValue ?? false,
                options: options
            )
        }
    }
}
