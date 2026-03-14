// FILE: TurnConversationContainerView.swift
// Purpose: Composes the turn timeline, empty state, composer slot, and top overlays into one focused container.
// Layer: View Component
// Exports: TurnConversationContainerView
// Depends on: SwiftUI, TurnTimelineView

import SwiftUI

struct TurnConversationContainerView: View {
    let threadID: String
    let messages: [ChatMessage]
    let timelineChangeToken: Int
    let activeTurnID: String?
    let isThreadRunning: Bool
    let latestTurnTerminalState: CodeRoverTurnTerminalState?
    let stoppedTurnIDs: Set<String>
    let assistantRevertStatesByMessageID: [String: AssistantRevertPresentation]
    let errorMessage: String?
    let hasOlderHistory: Bool
    let isLoadingOlderHistory: Bool
    let shouldAnchorToAssistantResponse: Binding<Bool>
    let isScrolledToBottom: Binding<Bool>
    let emptyState: AnyView
    let composer: AnyView
    let repositoryLoadingToastOverlay: AnyView
    let usageToastOverlay: AnyView
    let isRepositoryLoadingToastVisible: Bool
    let onRetryUserMessage: (String) -> Void
    let onTapAssistantRevert: (ChatMessage) -> Void
    let onTapOutsideComposer: () -> Void
    let onLoadOlderHistory: () -> Void

    // ─── ENTRY POINT ─────────────────────────────────────────────
    var body: some View {
        ZStack(alignment: .top) {
            VStack(spacing: 0) {
                TurnTimelineView(
                    threadID: threadID,
                    messages: messages,
                    timelineChangeToken: timelineChangeToken,
                    activeTurnID: activeTurnID,
                    isThreadRunning: isThreadRunning,
                    latestTurnTerminalState: latestTurnTerminalState,
                    stoppedTurnIDs: stoppedTurnIDs,
                    assistantRevertStatesByMessageID: assistantRevertStatesByMessageID,
                    isRetryAvailable: !isThreadRunning,
                    errorMessage: errorMessage,
                    hasOlderHistory: hasOlderHistory,
                    isLoadingOlderHistory: isLoadingOlderHistory,
                    shouldAnchorToAssistantResponse: shouldAnchorToAssistantResponse,
                    isScrolledToBottom: isScrolledToBottom,
                    onRetryUserMessage: onRetryUserMessage,
                    onTapAssistantRevert: onTapAssistantRevert,
                    onTapOutsideComposer: onTapOutsideComposer,
                    onLoadOlderHistory: onLoadOlderHistory
                ) {
                    emptyState
                } composer: {
                    composer
                }
            }

            VStack(spacing: 0) {
                repositoryLoadingToastOverlay
                if !isRepositoryLoadingToastVisible {
                    usageToastOverlay
                }
            }
        }
    }
}
