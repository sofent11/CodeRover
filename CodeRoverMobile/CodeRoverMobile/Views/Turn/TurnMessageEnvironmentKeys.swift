// FILE: TurnMessageEnvironmentKeys.swift
// Purpose: SwiftUI environment keys for inline commit/push, assistant revert, and subagent actions.
// Layer: View Support
// Exports: EnvironmentValues.inlineCommitAndPushAction, EnvironmentValues.assistantRevertAction
// Depends on: SwiftUI, ChatMessage

import SwiftUI

private struct InlineCommitAndPushActionKey: EnvironmentKey {
    static let defaultValue: (() -> Void)? = nil
}

extension EnvironmentValues {
    var inlineCommitAndPushAction: (() -> Void)? {
        get { self[InlineCommitAndPushActionKey.self] }
        set { self[InlineCommitAndPushActionKey.self] = newValue }
    }
}

private struct AssistantRevertActionKey: EnvironmentKey {
    static let defaultValue: ((ChatMessage) -> Void)? = nil
}

extension EnvironmentValues {
    var assistantRevertAction: ((ChatMessage) -> Void)? {
        get { self[AssistantRevertActionKey.self] }
        set { self[AssistantRevertActionKey.self] = newValue }
    }
}

private struct SubagentOpenActionKey: EnvironmentKey {
    static let defaultValue: ((CodeRoverSubagentThreadPresentation) -> Void)? = nil
}

extension EnvironmentValues {
    var subagentOpenAction: ((CodeRoverSubagentThreadPresentation) -> Void)? {
        get { self[SubagentOpenActionKey.self] }
        set { self[SubagentOpenActionKey.self] = newValue }
    }
}
