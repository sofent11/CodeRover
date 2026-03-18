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
    let onTapSubagent: (CodeRoverSubagentThreadPresentation) -> Void
    let onTapOutsideComposer: () -> Void
    let onLoadOlderHistory: () -> Void

    @State private var isShowingPinnedPlanSheet = false

    private var pinnedTaskPlanMessage: ChatMessage? {
        messages.last { $0.role == .system && $0.kind == .plan }
    }

    private var timelineMessages: [ChatMessage] {
        messages.filter { !($0.role == .system && $0.kind == .plan) }
    }

    private var timelineEmptyState: AnyView {
        guard pinnedTaskPlanMessage != nil, timelineMessages.isEmpty else {
            return emptyState
        }
        return AnyView(
            Color.clear
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        )
    }

    // ─── ENTRY POINT ─────────────────────────────────────────────
    var body: some View {
        ZStack(alignment: .top) {
            TurnTimelineView(
                threadID: threadID,
                messages: timelineMessages,
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
                onTapSubagent: onTapSubagent,
                onTapOutsideComposer: onTapOutsideComposer,
                onLoadOlderHistory: onLoadOlderHistory
            ) {
                timelineEmptyState
            } composer: {
                VStack(spacing: 8) {
                    if let pinnedTaskPlanMessage {
                        PlanExecutionAccessory(message: pinnedTaskPlanMessage) {
                            isShowingPinnedPlanSheet = true
                        }
                        .padding(.horizontal, 12)
                        .padding(.top, 8)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                    }

                    composer
                }
                .animation(.easeInOut(duration: 0.18), value: pinnedTaskPlanMessage?.id)
            }

            VStack(spacing: 0) {
                repositoryLoadingToastOverlay
                if !isRepositoryLoadingToastVisible {
                    usageToastOverlay
                }
            }
        }
        .onChange(of: pinnedTaskPlanMessage?.id) { _, newValue in
            if newValue == nil {
                isShowingPinnedPlanSheet = false
            }
        }
        .sheet(isPresented: $isShowingPinnedPlanSheet) {
            if let pinnedTaskPlanMessage {
                PlanExecutionSheet(message: pinnedTaskPlanMessage)
            }
        }
    }
}
