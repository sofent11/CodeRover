// FILE: TurnTimelineReducer.swift
// Purpose: Projects raw service timelines into render-ready message lists.
// Layer: View Helper
// Exports: TurnTimelineReducer, TurnTimelineProjection
// Depends on: ChatMessage

import Foundation

struct TurnTimelineProjection {
    let messages: [ChatMessage]
}

enum TurnTimelineReducer {
    // ─── ENTRY POINT ─────────────────────────────────────────────

    // Applies all render-only timeline transforms in one pass.
    static func project(messages: [ChatMessage]) -> TurnTimelineProjection {
        let visibleMessages = removeHiddenSystemMarkers(in: messages)
        let reordered = enforceIntraTurnOrder(in: visibleMessages)
        let collapsedThinking = collapseThinkingMessages(in: reordered)
        let withoutCommandThinkingEchoes = removeRedundantThinkingCommandActivityMessages(in: collapsedThinking)
        let dedupedUsers = removeDuplicateUserMessages(in: withoutCommandThinkingEchoes)
        let dedupedFileChanges = removeDuplicateFileChangeMessages(in: dedupedUsers)
        let dedupedSubagentActions = removeDuplicateSubagentActionMessages(in: dedupedFileChanges)
        let dedupedAssistant = removeDuplicateAssistantMessages(in: dedupedSubagentActions)
        return TurnTimelineProjection(messages: dedupedAssistant)
    }

    // Resolves where the viewport should anchor when assistant output starts streaming.
    static func assistantResponseAnchorMessageID(
        in messages: [ChatMessage],
        activeTurnID: String?
    ) -> String? {
        if let activeTurnID,
           let message = messages.last(where: { $0.role == .assistant && $0.turnId == activeTurnID }) {
            return message.id
        }

        return messages.last(where: { $0.role == .assistant && $0.isStreaming })?.id
    }

    // Ensures correct visual order within each turn: user → thinking → assistant → file changes.
    // Works on non-consecutive messages: collects ALL indices per turnId across the entire
    // array, sorts each turn's messages by role priority, and places them back into their
    // original slot positions. Messages without a turnId are never moved.
    //
    // Multi-item turns (thinking → response → thinking → response) are detected by checking
    // whether a thinking row arrives after an assistant row in chronological order. When
    // detected, only user messages are floated to the top; the interleaved flow is preserved.
    static func enforceIntraTurnOrder(in messages: [ChatMessage]) -> [ChatMessage] {
        // Collect indices belonging to each turnId (may be scattered across the array).
        var indicesByTurn: [String: [Int]] = [:]
        for (index, message) in messages.enumerated() {
            guard let turnId = message.turnId, !turnId.isEmpty else { continue }
            indicesByTurn[turnId, default: []].append(index)
        }

        var result = messages

        for (_, indices) in indicesByTurn {
            guard indices.count > 1 else { continue }

            let turnMessages = indices.map { result[$0] }

            let sorted: [ChatMessage]
            if hasInterleavedUserFlow(turnMessages) {
                sorted = turnMessages.sorted { $0.orderIndex < $1.orderIndex }
            } else if hasInterleavedAssistantActivityFlow(turnMessages) {
                sorted = turnMessages.sorted { a, b in
                    let userCount = turnMessages.reduce(into: 0) { partialResult, message in
                        if message.role == .user {
                            partialResult += 1
                        }
                    }
                    let openingUserID = userCount == 1
                        ? turnMessages
                            .filter { $0.role == .user }
                            .min(by: { $0.orderIndex < $1.orderIndex })?
                            .id
                        : nil
                    let aIsOpeningUser = openingUserID != nil && a.id == openingUserID
                    let bIsOpeningUser = openingUserID != nil && b.id == openingUserID
                    if aIsOpeningUser != bIsOpeningUser { return aIsOpeningUser }
                    return a.orderIndex < b.orderIndex
                }
            } else {
                // Single-item turn: apply normal role-based ordering.
                sorted = turnMessages.sorted { a, b in
                    let pA = intraTurnPriority(a)
                    let pB = intraTurnPriority(b)
                    if pA != pB { return pA < pB }
                    return a.orderIndex < b.orderIndex
                }
            }

            // Place sorted messages back into the same slot positions.
            for (i, originalIndex) in indices.enumerated() {
                result[originalIndex] = sorted[i]
            }
        }

        return result
    }

    private static func hasInterleavedUserFlow(_ turnMessages: [ChatMessage]) -> Bool {
        if shouldTreatLateSingleUserAsOpeningMessage(turnMessages) {
            return false
        }

        let ordered = turnMessages.sorted { $0.orderIndex < $1.orderIndex }
        var seenNonUser = false

        for message in ordered {
            if message.role == .user {
                if seenNonUser {
                    return true
                }
            } else {
                seenNonUser = true
            }
        }

        return false
    }

    private static func shouldTreatLateSingleUserAsOpeningMessage(_ turnMessages: [ChatMessage]) -> Bool {
        let userMessages = turnMessages.filter { $0.role == .user }
        guard userMessages.count == 1,
              let userMessage = userMessages.first,
              isProvisionalOpeningUserMessage(userMessage) else {
            return false
        }

        let ordered = turnMessages.sorted { $0.orderIndex < $1.orderIndex }
        guard let userIndex = ordered.firstIndex(where: { $0.id == userMessage.id }),
              userIndex > 0 else {
            return false
        }

        return ordered[..<userIndex].contains(where: { $0.role != .user })
            && turnMessages.contains(where: { message in
                message.id != userMessage.id && normalizedIdentifier(message.itemId) != nil
            })
    }

    private static func isProvisionalOpeningUserMessage(_ message: ChatMessage) -> Bool {
        guard message.role == .user else {
            return false
        }

        let messageID = normalizedIdentifier(message.id)
        let itemID = normalizedIdentifier(message.itemId)
        return itemID == nil || itemID != messageID
    }

    // Detects multi-item turns where visible system activity appears on BOTH sides of an
    // assistant message (thinking/command → response → thinking/command). This distinguishes true
    // interleaved flows from single-item turns where events arrived out of order.
    private static func hasInterleavedAssistantActivityFlow(_ turnMessages: [ChatMessage]) -> Bool {
        // Multiple distinct assistant item IDs = definitive multi-item turn.
        let distinctAssistantItemIds = Set(
            turnMessages
                .filter { $0.role == .assistant }
                .compactMap { normalizedIdentifier($0.itemId) }
        )
        if distinctAssistantItemIds.count > 1 {
            return true
        }

        // Check pattern: activity → assistant → activity (system activity on both sides).
        let ordered = turnMessages.sorted { $0.orderIndex < $1.orderIndex }
        var hasActivityBeforeAssistant = false
        var seenAssistant = false
        for message in ordered {
            if message.role == .assistant {
                seenAssistant = true
            } else if isInterleavableSystemActivity(message) {
                if !seenAssistant {
                    hasActivityBeforeAssistant = true
                } else if hasActivityBeforeAssistant {
                    return true
                }
            }
        }
        return false
    }

    private static func isInterleavableSystemActivity(_ message: ChatMessage) -> Bool {
        guard message.role == .system else {
            return false
        }

        switch message.kind {
        case .thinking, .toolActivity, .commandExecution:
            return true
        case .chat, .plan, .userInputPrompt, .fileChange, .subagentAction:
            return false
        }
    }

    private static func intraTurnPriority(_ message: ChatMessage) -> Int {
        switch message.role {
        case .user:
            return 0
        case .system:
            switch message.kind {
            case .thinking:
                return 1
            case .toolActivity:
                return 2
            case .commandExecution:
                return 3
            case .subagentAction:
                return 4
            case .chat:
                return 5
            case .plan:
                return 5
            case .userInputPrompt:
                return 7
            case .fileChange:
                // Keep edited-file cards at the end of the turn timeline.
                return 6
            }
        case .assistant:
            return 4
        }
    }

    // Hides persisted technical markers that exist only to reset per-chat diff totals.
    private static func removeHiddenSystemMarkers(in messages: [ChatMessage]) -> [ChatMessage] {
        messages.filter { message in
            !(message.role == .system && message.itemId == TurnSessionDiffResetMarker.manualPushItemID)
        }
    }

    // Collapses repeated thinking placeholders/activity rows within one turn segment so
    // command cards can interleave without leaving stacked empty "Thinking..." rows behind.
    static func collapseThinkingMessages(in messages: [ChatMessage]) -> [ChatMessage] {
        var result: [ChatMessage] = []
        result.reserveCapacity(messages.count)

        for message in messages {
            guard message.role == .system, message.kind == .thinking else {
                result.append(message)
                continue
            }

            guard let previousIndex = latestReusableThinkingIndex(in: result, for: message) else {
                result.append(message)
                continue
            }

            var previous = result[previousIndex]

            guard shouldMergeThinkingRows(previous: previous, incoming: message) else {
                result.append(message)
                continue
            }

            let incoming = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !incoming.isEmpty {
                previous.text = mergeThinkingText(existing: previous.text, incoming: incoming)
            }

            // The newest thinking row should own the final streaming/completed state.
            previous.isStreaming = message.isStreaming
            previous.turnId = message.turnId ?? previous.turnId
            previous.itemId = message.itemId ?? previous.itemId
            result[previousIndex] = previous
        }

        return result
    }

    private static func latestReusableThinkingIndex(
        in messages: [ChatMessage],
        for incoming: ChatMessage
    ) -> Int? {
        for index in messages.indices.reversed() {
            let candidate = messages[index]
            if candidate.role == .assistant || candidate.role == .user {
                break
            }

            guard candidate.role == .system, candidate.kind == .thinking else {
                continue
            }

            if shouldMergeThinkingRows(previous: candidate, incoming: incoming) {
                return index
            }
        }

        return nil
    }

    private static func shouldMergeThinkingRows(previous: ChatMessage, incoming: ChatMessage) -> Bool {
        let previousItemId = normalizedIdentifier(previous.itemId)
        let incomingItemId = normalizedIdentifier(incoming.itemId)
        if let previousItemId, let incomingItemId,
           previousItemId == incomingItemId {
            return true
        }

        guard hasCompatibleThinkingTurnScope(previous: previous, incoming: incoming) else {
            return false
        }

        if isPlaceholderThinkingRow(previous) {
            return true
        }

        let previousHasStableIdentity = hasStableThinkingIdentity(previous)
        let incomingHasStableIdentity = hasStableThinkingIdentity(incoming)

        if previousHasStableIdentity,
           incomingHasStableIdentity,
           previousItemId != nil,
           incomingItemId != nil {
            return false
        }

        if isPlaceholderThinkingRow(incoming) {
            return !previousHasStableIdentity
        }

        if !previousHasStableIdentity || !incomingHasStableIdentity {
            return thinkingSnapshotsOverlap(previous: previous, incoming: incoming)
        }

        return false
    }

    private static func hasCompatibleThinkingTurnScope(previous: ChatMessage, incoming: ChatMessage) -> Bool {
        let previousTurnId = normalizedIdentifier(previous.turnId)
        let incomingTurnId = normalizedIdentifier(incoming.turnId)
        guard let previousTurnId, let incomingTurnId else {
            return true
        }
        return previousTurnId == incomingTurnId
    }

    private static func hasStableThinkingIdentity(_ message: ChatMessage) -> Bool {
        guard let itemId = normalizedIdentifier(message.itemId) else {
            return false
        }
        return !(itemId.hasPrefix("turn:") && itemId.contains("|kind:\(ChatMessageKind.thinking.rawValue)"))
    }

    private static func isPlaceholderThinkingRow(_ message: ChatMessage) -> Bool {
        ThinkingDisclosureParser.normalizedThinkingContent(from: message.text).isEmpty
    }

    private static func thinkingSnapshotsOverlap(previous: ChatMessage, incoming: ChatMessage) -> Bool {
        let previousText = ThinkingDisclosureParser.normalizedThinkingContent(from: previous.text)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let incomingText = ThinkingDisclosureParser.normalizedThinkingContent(from: incoming.text)
            .trimmingCharacters(in: .whitespacesAndNewlines)

        guard !previousText.isEmpty, !incomingText.isEmpty else {
            return previousText.isEmpty || incomingText.isEmpty
        }

        let previousLower = previousText.lowercased()
        let incomingLower = incomingText.lowercased()
        return previousLower == incomingLower
            || previousLower.contains(incomingLower)
            || incomingLower.contains(previousLower)
    }

    private static func normalizedIdentifier(_ value: String?) -> String? {
        guard let value else {
            return nil
        }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    // Preserves useful activity lines while still allowing newer thinking snapshots to win.
    private static func mergeThinkingText(existing: String, incoming: String) -> String {
        let existingTrimmed = existing.trimmingCharacters(in: .whitespacesAndNewlines)
        let incomingTrimmed = incoming.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !incomingTrimmed.isEmpty else { return existingTrimmed }
        guard !existingTrimmed.isEmpty else { return incomingTrimmed }

        let placeholderValues: Set<String> = ["thinking..."]
        let existingLower = existingTrimmed.lowercased()
        let incomingLower = incomingTrimmed.lowercased()

        if placeholderValues.contains(incomingLower) {
            return existingTrimmed
        }
        if placeholderValues.contains(existingLower) {
            return incomingTrimmed
        }

        if incomingLower == existingLower {
            return incomingTrimmed
        }
        if incomingTrimmed.contains(existingTrimmed) {
            return incomingTrimmed
        }
        if existingTrimmed.contains(incomingTrimmed) {
            return existingTrimmed
        }

        return "\(existingTrimmed)\n\(incomingTrimmed)"
    }

    private static func removeRedundantThinkingCommandActivityMessages(
        in messages: [ChatMessage]
    ) -> [ChatMessage] {
        let commandKeysByTurn = messages.reduce(into: [String: Set<String>]()) { partialResult, message in
            guard message.role == .system,
                  message.kind == .commandExecution,
                  let turnId = normalizedIdentifier(message.turnId),
                  let commandKey = commandActivityKey(from: message.text) else {
                return
            }
            partialResult[turnId, default: Set<String>()].insert(commandKey)
        }

        guard !commandKeysByTurn.isEmpty else {
            return messages
        }

        return messages.filter { message in
            guard message.role == .system,
                  message.kind == .thinking,
                  let turnId = normalizedIdentifier(message.turnId),
                  let commandKeys = commandKeysByTurn[turnId] else {
                return true
            }

            let normalizedThinking = ThinkingDisclosureParser.normalizedThinkingContent(from: message.text)
            let lines = normalizedThinking
                .split(separator: "\n", omittingEmptySubsequences: false)
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }

            guard !lines.isEmpty else {
                return true
            }

            return !lines.allSatisfy { line in
                guard let commandKey = commandActivityKey(from: line) else {
                    return false
                }
                return commandKeys.contains(commandKey)
            }
        }
    }

    private static func commandActivityKey(from text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return nil
        }

        let normalized = trimmed
            .replacingOccurrences(
                of: #"\s+"#,
                with: " ",
                options: .regularExpression
            )
            .lowercased()
        return normalized.isEmpty ? nil : normalized
    }

    // Collapses optimistic local user rows with their confirmed realtime/history echoes.
    static func removeDuplicateUserMessages(in messages: [ChatMessage]) -> [ChatMessage] {
        var result: [ChatMessage] = []
        result.reserveCapacity(messages.count)

        for message in messages {
            guard message.role == .user else {
                result.append(message)
                continue
            }

            let matchingIndices = result.indices.reversed().filter { index in
                shouldMergeUserMessages(previous: result[index], incoming: message)
            }
            guard matchingIndices.count == 1,
                  let previousIndex = matchingIndices.first else {
                result.append(message)
                continue
            }

            result[previousIndex] = mergedUserMessage(previous: result[previousIndex], incoming: message)
        }

        return result
    }

    private static func shouldMergeUserMessages(previous: ChatMessage, incoming: ChatMessage) -> Bool {
        guard previous.role == .user,
              incoming.role == .user,
              previous.threadId == incoming.threadId,
              normalizedMessageText(previous.text) == normalizedMessageText(incoming.text),
              userMessageAttachmentsLookCompatible(previous: previous, incoming: incoming) else {
            return false
        }

        let previousTurnId = normalizedIdentifier(previous.turnId)
        let incomingTurnId = normalizedIdentifier(incoming.turnId)
        if let previousTurnId, let incomingTurnId {
            return previousTurnId == incomingTurnId
                && previous.deliveryState == .pending
                && incoming.deliveryState == .confirmed
                && abs(incoming.createdAt.timeIntervalSince(previous.createdAt)) <= 12
        }

        let isPendingToConfirmedUpgrade = previous.deliveryState == .pending
            && incoming.deliveryState == .confirmed
        let isTurnBindingUpgrade = previousTurnId == nil && incomingTurnId != nil
        guard isPendingToConfirmedUpgrade || isTurnBindingUpgrade else {
            return false
        }

        return abs(incoming.createdAt.timeIntervalSince(previous.createdAt)) <= 12
    }

    private static func mergedUserMessage(previous: ChatMessage, incoming: ChatMessage) -> ChatMessage {
        var merged = previous

        if merged.deliveryState == .pending || incoming.deliveryState == .confirmed {
            merged.deliveryState = incoming.deliveryState
        }
        if merged.turnId == nil {
            merged.turnId = incoming.turnId
        }
        if merged.itemId == nil {
            merged.itemId = incoming.itemId
        }
        if merged.attachments.isEmpty && !incoming.attachments.isEmpty {
            merged.attachments = incoming.attachments
        }

        let incomingText = incoming.text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !incomingText.isEmpty {
            merged.text = incoming.text
        }

        return merged
    }

    private static func normalizedMessageText(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func attachmentSignature(for message: ChatMessage) -> String {
        message.attachments
            .map { attachment in
                attachment.payloadDataURL ?? attachment.sourceURL ?? attachment.thumbnailBase64JPEG
            }
            .joined(separator: "|")
    }

    private static func userMessageAttachmentsLookCompatible(previous: ChatMessage, incoming: ChatMessage) -> Bool {
        let previousAttachments = attachmentSignature(for: previous)
        let incomingAttachments = attachmentSignature(for: incoming)
        if !previousAttachments.isEmpty,
           !incomingAttachments.isEmpty,
           previousAttachments != incomingAttachments {
            return false
        }

        return true
    }

    // Hides duplicated assistant rows caused by mixed completion/history payloads.
    static func removeDuplicateAssistantMessages(in messages: [ChatMessage]) -> [ChatMessage] {
        var seenKeys: Set<String> = []
        var firstIndexByTurnTextWithoutConcreteItem: [String: Int] = [:]
        var seenNoTurnByText: [String: Date] = [:]
        var result: [ChatMessage] = []
        result.reserveCapacity(messages.count)

        for message in messages {
            guard message.role == .assistant else {
                result.append(message)
                continue
            }

            let normalizedText = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !normalizedText.isEmpty else {
                result.append(message)
                continue
            }

            if let turnId = message.turnId, !turnId.isEmpty {
                let dedupeScope = normalizedIdentifier(message.itemId)
                let key = "\(turnId)|\(dedupeScope ?? "no-item")|\(normalizedText)"
                if seenKeys.contains(key) {
                    continue
                }

                let turnTextKey = "\(turnId)|\(normalizedText)"
                if let dedupeScope {
                    if let existingIndex = firstIndexByTurnTextWithoutConcreteItem[turnTextKey] {
                        result[existingIndex] = message
                        seenKeys.insert(key)
                        firstIndexByTurnTextWithoutConcreteItem.removeValue(forKey: turnTextKey)
                        continue
                    }
                } else if seenKeys.contains("\(turnId)|no-item|\(normalizedText)") {
                    continue
                } else {
                    firstIndexByTurnTextWithoutConcreteItem[turnTextKey] = result.count
                }

                seenKeys.insert(key)
                result.append(message)
                continue
            }

            if let previous = seenNoTurnByText[normalizedText],
               abs(message.createdAt.timeIntervalSince(previous)) <= 12 {
                continue
            }

            seenNoTurnByText[normalizedText] = message.createdAt
            result.append(message)
        }

        return result
    }

    // Keeps only the newest matching file-change card when multiple event channels emit the same diff.
    static func removeDuplicateFileChangeMessages(in messages: [ChatMessage]) -> [ChatMessage] {
        let signatures = messages.map { fileChangeDedupSignature(for: $0) }
        var supersededIndices: Set<Int> = []

        for olderIndex in messages.indices {
            guard let olderSignature = signatures[olderIndex] else {
                continue
            }

            for newerIndex in messages.indices where newerIndex > olderIndex {
                guard let newerSignature = signatures[newerIndex],
                      fileChangeMessage(newerSignature, supersedes: olderSignature) else {
                    continue
                }
                supersededIndices.insert(olderIndex)
                break
            }
        }

        return messages.enumerated().compactMap { index, message in
            if signatures[index] != nil, supersededIndices.contains(index) {
                return nil
            }
            return message
        }
    }

    static func removeDuplicateSubagentActionMessages(in messages: [ChatMessage]) -> [ChatMessage] {
        var result: [ChatMessage] = []
        result.reserveCapacity(messages.count)

        for message in messages {
            guard let action = message.subagentAction,
                  message.role == .system,
                  message.kind == .subagentAction else {
                result.append(message)
                continue
            }

            guard let previous = result.last,
                  let previousAction = previous.subagentAction,
                  shouldMergeSubagentActionMessages(
                      previous: previous,
                      previousAction: previousAction,
                      incoming: message,
                      incomingAction: action
                  ) else {
                result.append(message)
                continue
            }

            result[result.count - 1] = preferredSubagentActionMessage(previous: previous, incoming: message)
        }

        return result
    }

    private static func shouldMergeSubagentActionMessages(
        previous: ChatMessage,
        previousAction: CodeRoverSubagentAction,
        incoming: ChatMessage,
        incomingAction: CodeRoverSubagentAction
    ) -> Bool {
        guard previous.role == .system,
              previous.kind == .subagentAction,
              previous.threadId == incoming.threadId,
              normalizedIdentifier(previous.turnId) == normalizedIdentifier(incoming.turnId),
              previousAction.normalizedTool == incomingAction.normalizedTool,
              previous.text == incoming.text else {
            return false
        }

        guard let previousItemId = normalizedIdentifier(previous.itemId),
              let incomingItemId = normalizedIdentifier(incoming.itemId),
              previousItemId == incomingItemId else {
            return false
        }

        let previousRows = previousAction.agentRows
        let incomingRows = incomingAction.agentRows
        if previousRows.isEmpty && !incomingRows.isEmpty {
            return true
        }
        return previousRows == incomingRows
    }

    private static func preferredSubagentActionMessage(previous: ChatMessage, incoming: ChatMessage) -> ChatMessage {
        let previousRows = previous.subagentAction?.agentRows ?? []
        let incomingRows = incoming.subagentAction?.agentRows ?? []

        if previousRows.isEmpty && !incomingRows.isEmpty {
            return incoming
        }

        if incoming.isStreaming != previous.isStreaming {
            return incoming.isStreaming ? previous : incoming
        }

        return incoming.orderIndex >= previous.orderIndex ? incoming : previous
    }

    // Keys file-change cards by turn + rendered payload so repeated turn/diff snapshots collapse to one row.
    private static func duplicateFileChangeKey(for message: ChatMessage) -> String? {
        let turnLabel = normalizedIdentifier(message.turnId) ?? "turnless"

        if let summaryKey = TurnFileChangeSummaryParser.dedupeKey(from: message.text) {
            return "\(turnLabel)|\(summaryKey)"
        }

        let normalizedText = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedText.isEmpty else {
            return nil
        }
        return "\(turnLabel)|\(normalizedText)"
    }

    private static func fileChangeDedupSignature(for message: ChatMessage) -> FileChangeDedupSignature? {
        guard message.role == .system,
              message.kind == .fileChange else {
            return nil
        }

        let turnId = normalizedIdentifier(message.turnId)
        let key = duplicateFileChangeKey(for: message)
        let entries = TurnFileChangeSummaryParser.parse(from: message.text)?.entries ?? []
        let paths = Set(entries.map(\.path))
        let singleEntryDescriptor: FileChangeSingleEntryDescriptor? = {
            guard entries.count == 1, let entry = entries.first else { return nil }
            return FileChangeSingleEntryDescriptor(
                path: entry.path,
                additions: entry.additions,
                deletions: entry.deletions,
                action: entry.action
            )
        }()

        guard key != nil || !paths.isEmpty || singleEntryDescriptor != nil else {
            return nil
        }

        return FileChangeDedupSignature(
            turnId: turnId,
            key: key,
            paths: paths,
            singleEntryDescriptor: singleEntryDescriptor,
            isStreaming: message.isStreaming
        )
    }

    private static func fileChangeMessage(
        _ newer: FileChangeDedupSignature,
        supersedes older: FileChangeDedupSignature
    ) -> Bool {
        let sameTurn: Bool
        if let newerTurn = newer.turnId, let olderTurn = older.turnId {
            sameTurn = newerTurn == olderTurn
        } else {
            sameTurn = older.turnId == nil || newer.turnId == nil
        }
        guard sameTurn else {
            return false
        }

        if let newerKey = newer.key, let olderKey = older.key, newerKey == olderKey {
            return true
        }

        if let newerSingle = newer.singleEntryDescriptor,
           let olderSingle = older.singleEntryDescriptor,
           (older.isStreaming || older.turnId == nil),
           singleFileChangeLooksLikePathUpgrade(newer: newerSingle, older: olderSingle) {
            return true
        }

        return !newer.paths.isEmpty && !older.paths.isEmpty && newer.paths == older.paths
    }

    private static func singleFileChangeLooksLikePathUpgrade(
        newer: FileChangeSingleEntryDescriptor,
        older: FileChangeSingleEntryDescriptor
    ) -> Bool {
        guard newer.path == older.path else {
            return false
        }

        if newer.action == older.action,
           newer.additions == older.additions,
           newer.deletions == older.deletions {
            return true
        }

        if newer.action == older.action,
           newer.additions >= older.additions,
           newer.deletions >= older.deletions {
            return true
        }

        return false
    }
}

private struct FileChangeDedupSignature {
    let turnId: String?
    let key: String?
    let paths: Set<String>
    let singleEntryDescriptor: FileChangeSingleEntryDescriptor?
    let isStreaming: Bool
}

private struct FileChangeSingleEntryDescriptor {
    let path: String
    let additions: Int
    let deletions: Int
    let action: TurnFileChangeAction?
}
