// FILE: TurnTimelineView.swift
// Purpose: Renders timeline scrolling, bottom-anchor behavior and the footer container.
// Layer: View Component
// Exports: TurnTimelineView
// Depends on: SwiftUI, TurnTimelineReducer, TurnScrollStateTracker, MessageRow

import SwiftUI

private enum TurnAutoScrollMode {
    case followBottom
    case anchorAssistantResponse
    case manual
}

private struct TurnTimelineCommandBurstGroup: Identifiable, Equatable {
    static let collapsedVisibleCount = 5

    let id: String
    let messages: [ChatMessage]

    init(messages: [ChatMessage]) {
        self.messages = messages
        self.id = "command-burst:\(messages.first?.id ?? "unknown")"
    }

    var pinnedMessages: [ChatMessage] {
        Array(messages.prefix(Self.collapsedVisibleCount))
    }

    var overflowMessages: [ChatMessage] {
        Array(messages.dropFirst(Self.collapsedVisibleCount))
    }

    var hiddenCount: Int {
        overflowMessages.count
    }
}

private enum TurnTimelineRenderItem: Identifiable, Equatable {
    case message(ChatMessage)
    case commandBurst(TurnTimelineCommandBurstGroup)

    var id: String {
        switch self {
        case .message(let message):
            return message.id
        case .commandBurst(let group):
            return group.id
        }
    }
}

private enum TurnTimelineRenderProjection {
    static func project(messages: [ChatMessage]) -> [TurnTimelineRenderItem] {
        var items: [TurnTimelineRenderItem] = []
        var bufferedCommandMessages: [ChatMessage] = []

        func flushBufferedCommandMessages() {
            guard !bufferedCommandMessages.isEmpty else { return }
            if bufferedCommandMessages.count > TurnTimelineCommandBurstGroup.collapsedVisibleCount {
                items.append(.commandBurst(TurnTimelineCommandBurstGroup(messages: bufferedCommandMessages)))
            } else {
                items.append(contentsOf: bufferedCommandMessages.map(TurnTimelineRenderItem.message))
            }
            bufferedCommandMessages.removeAll(keepingCapacity: true)
        }

        for message in messages {
            guard isCommandBurstCandidate(message) else {
                flushBufferedCommandMessages()
                items.append(.message(message))
                continue
            }

            if let previous = bufferedCommandMessages.last,
               !canShareCommandBurst(previous: previous, incoming: message) {
                flushBufferedCommandMessages()
            }

            bufferedCommandMessages.append(message)
        }

        flushBufferedCommandMessages()
        return items
    }

    private static func isCommandBurstCandidate(_ message: ChatMessage) -> Bool {
        guard message.role == .system else {
            return false
        }

        switch message.kind {
        case .toolActivity, .commandExecution:
            return true
        case .thinking, .chat, .plan, .userInputPrompt, .fileChange, .subagentAction:
            return false
        }
    }

    private static func canShareCommandBurst(previous: ChatMessage, incoming: ChatMessage) -> Bool {
        let previousTurnID = normalizedIdentifier(previous.turnId)
        let incomingTurnID = normalizedIdentifier(incoming.turnId)

        guard let previousTurnID, let incomingTurnID else {
            return true
        }

        return previousTurnID == incomingTurnID
    }

    private static func normalizedIdentifier(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}

private struct TurnTimelineMessageRow: View {
    let message: ChatMessage
    let isRetryAvailable: Bool
    let assistantRevertStatesByMessageID: [String: AssistantRevertPresentation]
    let cachedBlockInfoByMessageID: [String: String]
    let cachedAggregatedFileChangePresentationByMessageID: [String: FileChangeBlockPresentation]
    let suppressedFileChangeActionMessageIDs: Set<String>
    let cachedLastFileChangeMessageID: String?
    let isScrolledToBottom: Bool
    let onRetryUserMessage: (String) -> Void
    let onTapAssistantRevert: (ChatMessage) -> Void
    let onTapSubagent: (CodeRoverSubagentThreadPresentation) -> Void

    var body: some View {
        MessageRow(
            message: message,
            isRetryAvailable: isRetryAvailable,
            onRetryUserMessage: onRetryUserMessage,
            assistantRevertPresentation: assistantRevertStatesByMessageID[message.id],
            copyBlockText: cachedBlockInfoByMessageID[message.id],
            aggregatedFileChangePresentation: cachedAggregatedFileChangePresentationByMessageID[message.id],
            suppressFileChangeActions: suppressedFileChangeActionMessageIDs.contains(message.id),
            showInlineCommit: message.id == cachedLastFileChangeMessageID,
            showsStreamingAnimations: isScrolledToBottom
        )
        .equatable()
        .environment(\.assistantRevertAction, onTapAssistantRevert)
        .environment(\.subagentOpenAction, onTapSubagent)
        .id(message.id)
    }
}

private struct TurnTimelineCommandBurstView: View {
    let group: TurnTimelineCommandBurstGroup
    let isRetryAvailable: Bool
    let assistantRevertStatesByMessageID: [String: AssistantRevertPresentation]
    let cachedBlockInfoByMessageID: [String: String]
    let cachedAggregatedFileChangePresentationByMessageID: [String: FileChangeBlockPresentation]
    let suppressedFileChangeActionMessageIDs: Set<String>
    let cachedLastFileChangeMessageID: String?
    let isScrolledToBottom: Bool
    let onRetryUserMessage: (String) -> Void
    let onTapAssistantRevert: (ChatMessage) -> Void
    let onTapSubagent: (CodeRoverSubagentThreadPresentation) -> Void

    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(group.pinnedMessages) { message in
                TurnTimelineMessageRow(
                    message: message,
                    isRetryAvailable: isRetryAvailable,
                    assistantRevertStatesByMessageID: assistantRevertStatesByMessageID,
                    cachedBlockInfoByMessageID: cachedBlockInfoByMessageID,
                    cachedAggregatedFileChangePresentationByMessageID: cachedAggregatedFileChangePresentationByMessageID,
                    suppressedFileChangeActionMessageIDs: suppressedFileChangeActionMessageIDs,
                    cachedLastFileChangeMessageID: cachedLastFileChangeMessageID,
                    isScrolledToBottom: isScrolledToBottom,
                    onRetryUserMessage: onRetryUserMessage,
                    onTapAssistantRevert: onTapAssistantRevert,
                    onTapSubagent: onTapSubagent
                )
            }

            if group.hiddenCount > 0 {
                Button {
                    withAnimation(.easeInOut(duration: 0.18)) {
                        isExpanded.toggle()
                    }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "chevron.right")
                            .font(AppFont.system(size: 10, weight: .semibold))
                            .foregroundStyle(.secondary)
                            .rotationEffect(.degrees(isExpanded ? 90 : 0))
                        Text("+\(group.hiddenCount) command steps")
                            .font(AppFont.subheadline(weight: .medium))
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }

            if isExpanded {
                ForEach(group.overflowMessages) { message in
                    TurnTimelineMessageRow(
                        message: message,
                        isRetryAvailable: isRetryAvailable,
                        assistantRevertStatesByMessageID: assistantRevertStatesByMessageID,
                        cachedBlockInfoByMessageID: cachedBlockInfoByMessageID,
                        cachedAggregatedFileChangePresentationByMessageID: cachedAggregatedFileChangePresentationByMessageID,
                        suppressedFileChangeActionMessageIDs: suppressedFileChangeActionMessageIDs,
                        cachedLastFileChangeMessageID: cachedLastFileChangeMessageID,
                        isScrolledToBottom: isScrolledToBottom,
                        onRetryUserMessage: onRetryUserMessage,
                        onTapAssistantRevert: onTapAssistantRevert,
                        onTapSubagent: onTapSubagent
                    )
                }
            }
        }
    }
}

struct TurnTimelineView<EmptyState: View, Composer: View>: View {
    let threadID: String
    let messages: [ChatMessage]
    let timelineChangeToken: Int
    let displayActivationToken: Int
    let activeTurnID: String?
    let isThreadRunning: Bool
    let latestTurnTerminalState: CodeRoverTurnTerminalState?
    let stoppedTurnIDs: Set<String>
    let assistantRevertStatesByMessageID: [String: AssistantRevertPresentation]
    let isRetryAvailable: Bool
    let errorMessage: String?
    let hasOlderHistory: Bool
    let isLoadingOlderHistory: Bool

    @Binding var shouldAnchorToAssistantResponse: Bool
    @Binding var isScrolledToBottom: Bool

    let onRetryUserMessage: (String) -> Void
    let onTapAssistantRevert: (ChatMessage) -> Void
    let onTapSubagent: (CodeRoverSubagentThreadPresentation) -> Void
    let onTapOutsideComposer: () -> Void
    let onLoadOlderHistory: () -> Void
    @ViewBuilder let emptyState: () -> EmptyState
    @ViewBuilder let composer: () -> Composer

    private let scrollBottomAnchorID = "turn-scroll-bottom-anchor"
    /// Number of messages to show per page.  Only the tail slice is rendered;
    /// scrolling to the top reveals a "Load earlier messages" button.
    private static var pageSize: Int { 40 }

    @State private var visibleTailCount: Int = pageSize
    @State private var viewportHeight: CGFloat = 0
    // Cached per-render artifacts to avoid O(n) recomputation inside the body.
    @State private var cachedBlockInfoByMessageID: [String: String] = [:]
    @State private var cachedAggregatedFileChangePresentationByMessageID: [String: FileChangeBlockPresentation] = [:]
    @State private var suppressedFileChangeActionMessageIDs: Set<String> = []
    @State private var cachedLastFileChangeMessageID: String? = nil
    @State private var blockInfoInputKey: Int = 0
    @State private var scrollSessionThreadID: String?
    @State private var autoScrollMode: TurnAutoScrollMode = .followBottom
    @State private var isUserInteractingWithScroll = false
    @State private var initialRecoverySnapPendingThreadID: String?
    @State private var initialRecoverySnapTask: Task<Void, Never>?
    @State private var followBottomScrollTask: Task<Void, Never>?

    /// The tail slice of messages currently rendered in the timeline.
    private var visibleMessages: ArraySlice<ChatMessage> {
        let startIndex = max(messages.count - visibleTailCount, 0)
        return messages[startIndex...]
    }

    private var visibleRenderItems: [TurnTimelineRenderItem] {
        TurnTimelineRenderProjection.project(messages: Array(visibleMessages))
    }

    private var hasEarlierMessages: Bool {
        visibleTailCount < messages.count
    }

    var body: some View {
        if messages.isEmpty {
            // Keep new/empty chats static to avoid scroll indicators and inert scrolling.
            emptyTimelineState
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(.systemBackground))
                .contentShape(Rectangle())
                .onTapGesture {
                    onTapOutsideComposer()
                }
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    footer()
                }
                .onAppear {
                    beginScrollSessionIfNeeded()
                    logTimelineRender(reason: "emptyAppear")
                }
                .onChange(of: threadID) { _, _ in
                    beginScrollSessionIfNeeded(force: true)
                    logTimelineRender(reason: "emptyThreadChange")
                }
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: 0) {
                        LazyVStack(spacing: 20) {
                            if hasOlderHistory || isLoadingOlderHistory {
                                VStack(spacing: 8) {
                                    if isLoadingOlderHistory {
                                        ProgressView()
                                            .controlSize(.small)
                                    } else {
                                        Text("Loading earlier messages…")
                                            .font(AppFont.caption())
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 8)
                                .onAppear {
                                    guard hasOlderHistory, !isLoadingOlderHistory else { return }
                                    onLoadOlderHistory()
                                }
                            }

                            if hasEarlierMessages {
                                Button {
                                    withAnimation(.easeOut(duration: 0.15)) {
                                        visibleTailCount = min(
                                            visibleTailCount + Self.pageSize,
                                            messages.count
                                        )
                                    }
                                } label: {
                                    Text("Load earlier messages")
                                        .font(AppFont.subheadline())
                                        .foregroundStyle(.secondary)
                                        .frame(maxWidth: .infinity)
                                        .padding(.vertical, 10)
                                }
                                .buttonStyle(.plain)
                            }

                            ForEach(visibleRenderItems) { item in
                                switch item {
                                case .message(let message):
                                    TurnTimelineMessageRow(
                                        message: message,
                                        isRetryAvailable: isRetryAvailable,
                                        assistantRevertStatesByMessageID: assistantRevertStatesByMessageID,
                                        cachedBlockInfoByMessageID: cachedBlockInfoByMessageID,
                                        cachedAggregatedFileChangePresentationByMessageID: cachedAggregatedFileChangePresentationByMessageID,
                                        suppressedFileChangeActionMessageIDs: suppressedFileChangeActionMessageIDs,
                                        cachedLastFileChangeMessageID: cachedLastFileChangeMessageID,
                                        isScrolledToBottom: isScrolledToBottom,
                                        onRetryUserMessage: onRetryUserMessage,
                                        onTapAssistantRevert: onTapAssistantRevert,
                                        onTapSubagent: onTapSubagent
                                    )
                                case .commandBurst(let group):
                                    TurnTimelineCommandBurstView(
                                        group: group,
                                        isRetryAvailable: isRetryAvailable,
                                        assistantRevertStatesByMessageID: assistantRevertStatesByMessageID,
                                        cachedBlockInfoByMessageID: cachedBlockInfoByMessageID,
                                        cachedAggregatedFileChangePresentationByMessageID: cachedAggregatedFileChangePresentationByMessageID,
                                        suppressedFileChangeActionMessageIDs: suppressedFileChangeActionMessageIDs,
                                        cachedLastFileChangeMessageID: cachedLastFileChangeMessageID,
                                        isScrolledToBottom: isScrolledToBottom,
                                        onRetryUserMessage: onRetryUserMessage,
                                        onTapAssistantRevert: onTapAssistantRevert,
                                        onTapSubagent: onTapSubagent
                                    )
                                }
                            }
                        }
                        .padding(.horizontal, 16)
                        .padding(.top, 12)

                        // Keep bottom anchor outside LazyVStack so it is always laid out.
                        Color.clear
                            .frame(height: 1)
                            .id(scrollBottomAnchorID)
                            .allowsHitTesting(false)
                            .padding(.bottom, 12)
                    }
                }
                .accessibilityIdentifier("turn.timeline.scrollview")
                .background(Color(.systemBackground))
                .defaultScrollAnchor(.bottom)
                .scrollDismissesKeyboard(.interactively)
                .onScrollPhaseChange { _, newPhase in
                    isUserInteractingWithScroll = Self.isUserInitiatedScrollPhase(newPhase)
                }
                .simultaneousGesture(
                    TapGesture().onEnded {
                        onTapOutsideComposer()
                    }
                )
                .onScrollGeometryChange(for: ScrollBottomGeometry.self) { geometry in
                    let vh = geometry.visibleRect.height
                    let isAtBottom: Bool
                    if geometry.contentSize.height <= 0 || vh <= 0 {
                        isAtBottom = true
                    } else if geometry.contentSize.height <= vh {
                        isAtBottom = true
                    } else {
                        isAtBottom = geometry.visibleRect.maxY
                            >= geometry.contentSize.height - TurnScrollStateTracker.bottomThreshold
                    }
                    return ScrollBottomGeometry(isAtBottom: isAtBottom, viewportHeight: vh)
                } action: { old, new in
                    if new.viewportHeight != old.viewportHeight, new.viewportHeight > 0 {
                        viewportHeight = new.viewportHeight
                        performInitialRecoverySnapIfNeeded(using: proxy)
                        if old.viewportHeight > 0,
                           autoScrollMode == .followBottom,
                           isScrolledToBottom,
                           !messages.isEmpty {
                            scheduleFollowBottomScroll(using: proxy)
                        }
                    }
                    if new.isAtBottom != old.isAtBottom {
                        handleScrolledToBottomChanged(
                            new.isAtBottom,
                            isUserInitiatedScroll: isUserInteractingWithScroll,
                            using: proxy
                        )
                    }
                }
                // React to every timeline mutation so streamed text growth stays pinned
                // when the user is already at the bottom.
                .onChange(of: timelineChangeToken) { _, _ in
                    recomputeBlockInfoIfNeeded()
                    handleTimelineMutation(using: proxy)
                }
                .onChange(of: displayActivationToken) { _, _ in
                    beginScrollSessionIfNeeded(force: true)
                    handleTimelineMutation(using: proxy)
                }
                .onChange(of: isThreadRunning) { _, _ in
                    recomputeBlockInfoIfNeeded()
                }
                .onChange(of: threadID) { _, _ in
                    beginScrollSessionIfNeeded(force: true)
                    recomputeBlockInfoIfNeeded()
                    handleTimelineMutation(using: proxy)
                }
                .onChange(of: activeTurnID) { _, _ in
                    recomputeBlockInfoIfNeeded()
                    handleTimelineMutation(using: proxy)
                }
                .onChange(of: latestTurnTerminalState) { _, _ in
                    recomputeBlockInfoIfNeeded()
                }
                .onChange(of: stoppedTurnIDs) { _, _ in
                    recomputeBlockInfoIfNeeded()
                }
                .onChange(of: shouldAnchorToAssistantResponse) { _, newValue in
                    if newValue {
                        autoScrollMode = .anchorAssistantResponse
                        handleTimelineMutation(using: proxy)
                    } else if autoScrollMode == .anchorAssistantResponse {
                        autoScrollMode = isScrolledToBottom ? .followBottom : .manual
                    }
                }
                // Keeps footer pinned to bottom without adding a solid spacer block above it.
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    footer(scrollToBottomAction: {
                        autoScrollMode = .followBottom
                        initialRecoverySnapPendingThreadID = nil
                        scrollToBottom(using: proxy, animated: true)
                    })
                }
                .onAppear {
                    beginScrollSessionIfNeeded()
                    recomputeBlockInfoIfNeeded()
                    handleTimelineMutation(using: proxy)
                    logTimelineRender(reason: "messagesAppear")
                }
                .onDisappear {
                    cancelScrollTasks()
                }
                .onChange(of: timelineChangeToken) { _, _ in
                    logTimelineRender(reason: "timelineChange")
                }
            }
        }
    }

    /// Recomputes assistantBlockInfo and lastFileChangeIndex only when inputs actually changed.
    /// Works over the visible slice only so cost stays bounded regardless of total history.
    private func recomputeBlockInfoIfNeeded() {
        let visible = Array(visibleMessages)
        let key = blockInfoInputKey(for: visible)
        guard key != blockInfoInputKey else { return }
        blockInfoInputKey = key

        let cachedBlockInfo = Self.assistantBlockInfo(
            for: visible,
            activeTurnID: activeTurnID,
            isThreadRunning: isThreadRunning,
            latestTurnTerminalState: latestTurnTerminalState,
            stoppedTurnIDs: stoppedTurnIDs
        )
        cachedBlockInfoByMessageID = Dictionary(
            uniqueKeysWithValues: zip(visible, cachedBlockInfo).compactMap { message, blockText in
                guard let blockText else { return nil }
                return (message.id, blockText)
            }
        )
        let aggregatedFileChangeInfo = Self.aggregatedFileChangeInfo(for: visible)
        cachedAggregatedFileChangePresentationByMessageID = aggregatedFileChangeInfo.presentationByMessageID
        suppressedFileChangeActionMessageIDs = aggregatedFileChangeInfo.suppressedMessageIDs
        cachedLastFileChangeMessageID = !isThreadRunning
            ? visible.last(where: { $0.role == .system && $0.kind == .fileChange })?.id
            : nil
    }

    // Hashes structural fields that drive block aggregation and inline commit placement.
    // Excludes message.text intentionally: text hashing is O(n) over potentially large
    // strings and the copy-button text is hidden during streaming anyway.  Structural
    // changes (count, isStreaming flip, isThreadRunning) already trigger a fresh recompute
    // that picks up the final text content.
    private func blockInfoInputKey(for messages: [ChatMessage]) -> Int {
        var hasher = Hasher()
        hasher.combine(messages.count)
        hasher.combine(isThreadRunning)
        hasher.combine(activeTurnID)
        hasher.combine(latestTurnTerminalState)
        hasher.combine(stoppedTurnIDs)

        for message in messages {
            hasher.combine(message.id)
            hasher.combine(message.role)
            hasher.combine(message.kind)
            hasher.combine(message.turnId)
            hasher.combine(message.isStreaming)
        }

        return hasher.finalize()
    }

    @ViewBuilder
    private var emptyTimelineState: some View {
        if isThreadRunning {
            VStack(spacing: 12) {
                Spacer()
                ProgressView()
                    .controlSize(.large)
                Text("Working on it...")
                    .font(AppFont.title3(weight: .semibold))
                Text("The run is still active. You can stop it below if needed.")
                    .font(AppFont.body())
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 28)
                Spacer()
            }
        } else {
            emptyState()
        }
    }

    private func footer(scrollToBottomAction: (() -> Void)? = nil) -> some View {
        VStack(spacing: 0) {
            if let errorMessage, !errorMessage.isEmpty {
                Text(errorMessage)
                    .font(AppFont.caption())
                    .foregroundStyle(.red)
                    .padding(.horizontal, 16)
                    .padding(.top, 4)
            }

            composer()
        }
        .overlay(alignment: .top) {
            if shouldShowScrollToLatestButton, let scrollToBottomAction {
                Button {
                    HapticFeedback.shared.triggerImpactFeedback(style: .light)
                    shouldAnchorToAssistantResponse = false
                    scrollToBottomAction()
                } label: {
                    Image(systemName: "arrow.down")
                        .font(AppFont.system(size: 13, weight: .semibold))
                        .foregroundStyle(.primary)
                        .frame(width: 34, height: 34)
                        .adaptiveGlass(.regular, in: Circle())
                }
                .frame(width: 44, height: 44)
                .buttonStyle(TurnFloatingButtonPressStyle())
                .contentShape(Circle())
                .accessibilityLabel("Scroll to latest message")
                .offset(y: -(44 + 18))
                .transition(.opacity.combined(with: .scale(scale: 0.85)))
            }
        }
        .animation(.easeInOut(duration: 0.2), value: shouldShowScrollToLatestButton)
    }

    private var shouldShowScrollToLatestButton: Bool {
        TurnScrollStateTracker.shouldShowScrollToLatestButton(
            messageCount: messages.count,
            isScrolledToBottom: isScrolledToBottom
        )
    }

    // Resets per-thread scroll intent so each opened conversation gets one fresh
    // post-layout recovery snap and starts in bottom-follow mode.
    private func beginScrollSessionIfNeeded(force: Bool = false) {
        guard force || scrollSessionThreadID != threadID else { return }

        cancelScrollTasks()
        scrollSessionThreadID = threadID
        visibleTailCount = Self.pageSize
        isScrolledToBottom = true
        autoScrollMode = shouldAnchorToAssistantResponse ? .anchorAssistantResponse : .followBottom
        initialRecoverySnapPendingThreadID = threadID
    }

    private func logTimelineRender(reason: String) {
        let visibleCount = visibleMessages.count
        let visibleTail = visibleMessages.suffix(3).map(Self.describeMessage).joined(separator: ",")
        coderoverDiagnosticLog(
            "CodeRoverView",
            "TurnTimelineView \(reason) thread=\(threadID) messages=\(messages.count) visible=\(visibleCount) hasEarlier=\(hasEarlierMessages) older=\(hasOlderHistory) loadingOlder=\(isLoadingOlderHistory) running=\(isThreadRunning) revision=\(timelineChangeToken) tail=[\(visibleTail)]"
        )
    }

    private static func describeMessage(_ message: ChatMessage) -> String {
        let text = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let preview = String(text.prefix(24)).replacingOccurrences(of: "\n", with: "\\n")
        return "\(message.role.rawValue):\(message.kind.rawValue):\(message.id.prefix(6)):\(preview)"
    }

    // Cancels any delayed scroll work so old thread sessions cannot move the new one.
    private func cancelScrollTasks() {
        initialRecoverySnapTask?.cancel()
        initialRecoverySnapTask = nil
        followBottomScrollTask?.cancel()
        followBottomScrollTask = nil
    }

    private static func isUserInitiatedScrollPhase(_ phase: ScrollPhase) -> Bool {
        switch phase {
        case .tracking, .interacting, .decelerating:
            return true
        case .idle, .animating:
            return false
        @unknown default:
            return true
        }
    }

    // Stops follow-bottom only when the user drags away. Layout growth from streaming
    // can temporarily report "not at bottom"; keep following and repair it next frame.
    private func handleScrolledToBottomChanged(
        _ nextValue: Bool,
        isUserInitiatedScroll: Bool,
        using proxy: ScrollViewProxy
    ) {
        let shouldPreserveFollowBottom = TurnScrollStateTracker.shouldPreserveFollowBottomOnBottomLoss(
            wasScrolledToBottom: isScrolledToBottom,
            autoScrollIsFollowing: autoScrollMode == .followBottom,
            isUserInitiatedScroll: isUserInitiatedScroll
        )
        let nextScrolledToBottom = TurnScrollStateTracker.nextIsScrolledToBottom(
            nextIsAtBottom: nextValue,
            wasScrolledToBottom: isScrolledToBottom,
            autoScrollIsFollowing: autoScrollMode == .followBottom,
            isUserInitiatedScroll: isUserInitiatedScroll
        )
        guard nextScrolledToBottom != isScrolledToBottom || shouldPreserveFollowBottom else { return }

        if nextScrolledToBottom {
            isScrolledToBottom = true
            if autoScrollMode != .anchorAssistantResponse {
                autoScrollMode = .followBottom
            }
            if shouldPreserveFollowBottom {
                scheduleFollowBottomScroll(using: proxy)
            }
        } else if TurnScrollStateTracker.shouldEnterManualMode(
            nextIsAtBottom: nextValue,
            isUserInitiatedScroll: isUserInitiatedScroll
        ) {
            followBottomScrollTask?.cancel()
            followBottomScrollTask = nil
            isScrolledToBottom = false
            if autoScrollMode != .anchorAssistantResponse {
                autoScrollMode = .manual
            }
        } else if shouldPreserveFollowBottom {
            scheduleFollowBottomScroll(using: proxy)
        }
    }

    // Repairs the initial white/blank viewport race by doing a deferred snap, then
    // one follow-up verification snap after the footer/lazy rows finish settling.
    private func performInitialRecoverySnapIfNeeded(using proxy: ScrollViewProxy) {
        guard initialRecoverySnapPendingThreadID == threadID,
              initialRecoverySnapTask == nil,
              !messages.isEmpty,
              viewportHeight > 0,
              autoScrollMode == .followBottom,
              !shouldAnchorToAssistantResponse else {
            return
        }

        let expectedThreadID = threadID
        initialRecoverySnapTask = Task { @MainActor in
            await Task.yield()
            guard !Task.isCancelled,
                  initialRecoverySnapPendingThreadID == expectedThreadID,
                  scrollSessionThreadID == expectedThreadID,
                  !messages.isEmpty,
                  viewportHeight > 0,
                  autoScrollMode == .followBottom,
                  !shouldAnchorToAssistantResponse else {
                initialRecoverySnapTask = nil
                return
            }

            scrollToBottom(using: proxy, animated: false)

            // A second snap one frame later fixes the common case where the composer
            // inset or lazy cell heights settle just after the first recovery jump.
            try? await Task.sleep(nanoseconds: 16_000_000)
            guard !Task.isCancelled,
                  initialRecoverySnapPendingThreadID == expectedThreadID,
                  scrollSessionThreadID == expectedThreadID,
                  !messages.isEmpty,
                  viewportHeight > 0,
                  autoScrollMode == .followBottom,
                  !shouldAnchorToAssistantResponse else {
                initialRecoverySnapTask = nil
                return
            }

            scrollToBottom(using: proxy, animated: false)
            initialRecoverySnapPendingThreadID = nil
            initialRecoverySnapTask = nil
        }
    }

    private func anchorToAssistantResponseIfNeeded(using proxy: ScrollViewProxy) -> Bool {
        guard shouldAnchorToAssistantResponse,
              let assistantMessageID = TurnTimelineReducer.assistantResponseAnchorMessageID(
                in: Array(visibleMessages),
                activeTurnID: activeTurnID
              ) else {
            return false
        }

        withAnimation(.easeInOut(duration: 0.2)) {
            proxy.scrollTo(assistantMessageID, anchor: .top)
        }
        shouldAnchorToAssistantResponse = false
        autoScrollMode = .manual
        initialRecoverySnapPendingThreadID = nil
        return true
    }

    // Centralizes all automatic scrolling so first-load recovery, response anchoring,
    // and bottom-following do not compete with one another.
    private func handleTimelineMutation(using proxy: ScrollViewProxy) {
        performInitialRecoverySnapIfNeeded(using: proxy)

        switch autoScrollMode {
        case .anchorAssistantResponse:
            _ = anchorToAssistantResponseIfNeeded(using: proxy)
        case .followBottom:
            if isScrolledToBottom {
                scheduleFollowBottomScroll(using: proxy)
            }
        case .manual:
            return
        }
    }

    /// Coalesces rapid follow-bottom scrolls into a settle pair so streamed text
    /// growth and footer height changes cannot leave the viewport stranded in
    /// a transient blank region between layout passes.
    private func scheduleFollowBottomScroll(using proxy: ScrollViewProxy) {
        guard followBottomScrollTask == nil else { return }
        let expectedThreadID = threadID
        followBottomScrollTask = Task { @MainActor in
            defer { followBottomScrollTask = nil }
            try? await Task.sleep(nanoseconds: 16_000_000) // ~1 display frame
            guard !Task.isCancelled,
                  scrollSessionThreadID == expectedThreadID,
                  autoScrollMode == .followBottom,
                  isScrolledToBottom else {
                return
            }

            scrollToBottom(using: proxy, animated: false)

            // Verify one frame later after LazyVStack rows, markdown layout, and
            // footer inset animations have had time to settle.
            try? await Task.sleep(nanoseconds: 16_000_000)
            guard !Task.isCancelled,
                  scrollSessionThreadID == expectedThreadID,
                  autoScrollMode == .followBottom,
                  isScrolledToBottom else {
                return
            }

            scrollToBottom(using: proxy, animated: false)
        }
    }

    /// For each message index, returns the aggregated assistant block text if the message
    /// is the last non-user message before the next user message (or end of list).
    /// Returns nil for all other indices.
    static func assistantBlockInfo(
        for messages: [ChatMessage],
        activeTurnID: String?,
        isThreadRunning: Bool,
        latestTurnTerminalState: CodeRoverTurnTerminalState?,
        stoppedTurnIDs: Set<String>
    ) -> [String?] {
        var result = [String?](repeating: nil, count: messages.count)
        let latestBlockEnd = messages.lastIndex(where: { $0.role != .user })
        var i = messages.count - 1
        while i >= 0 {
            guard messages[i].role != .user else { i -= 1; continue }
            // Found end of an assistant block — walk backwards to collect all non-user messages.
            let blockEnd = i
            var blockStart = i
            while blockStart > 0 && messages[blockStart - 1].role != .user {
                blockStart -= 1
            }
            let blockText = messages[blockStart...blockEnd]
                .map { $0.text.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
                .joined(separator: "\n\n")
            let blockTurnID = messages[blockStart...blockEnd]
                .reversed()
                .compactMap(\.turnId)
                .first
            let isLatestBlock = latestBlockEnd == blockEnd
            if !blockText.isEmpty,
               shouldShowCopyButton(
                blockTurnID: blockTurnID,
                activeTurnID: activeTurnID,
                isThreadRunning: isThreadRunning,
                isLatestBlock: isLatestBlock,
                latestTurnTerminalState: latestTurnTerminalState,
                stoppedTurnIDs: stoppedTurnIDs
               ) {
                result[blockEnd] = blockText
            }
            i = blockStart - 1
        }
        return result
    }

    private static func aggregatedFileChangeInfo(
        for messages: [ChatMessage]
    ) -> (
        presentationByMessageID: [String: FileChangeBlockPresentation],
        suppressedMessageIDs: Set<String>
    ) {
        guard !messages.isEmpty else {
            return ([:], [])
        }

        var presentationByMessageID: [String: FileChangeBlockPresentation] = [:]
        var suppressedMessageIDs: Set<String> = []
        var index = 0

        while index < messages.count {
            if messages[index].role == .user {
                index += 1
                continue
            }

            let blockStart = index
            var blockEnd = index
            while blockEnd + 1 < messages.count, messages[blockEnd + 1].role != .user {
                blockEnd += 1
            }

            let stableFileChangeMessages = Array(messages[blockStart...blockEnd].filter {
                $0.role == .system && $0.kind == .fileChange && !$0.isStreaming
            })
            if let lastFileChangeMessage = stableFileChangeMessages.last,
               let presentation = FileChangeBlockPresentationBuilder.build(from: stableFileChangeMessages) {
                presentationByMessageID[lastFileChangeMessage.id] = presentation
                for message in stableFileChangeMessages.dropLast() {
                    suppressedMessageIDs.insert(message.id)
                }
            }

            index = blockEnd + 1
        }

        return (presentationByMessageID, suppressedMessageIDs)
    }

    // Keeps Copy aligned with real run completion instead of per-message streaming heuristics.
    private static func shouldShowCopyButton(
        blockTurnID: String?,
        activeTurnID: String?,
        isThreadRunning: Bool,
        isLatestBlock: Bool,
        latestTurnTerminalState: CodeRoverTurnTerminalState?,
        stoppedTurnIDs: Set<String>
    ) -> Bool {
        if let blockTurnID, stoppedTurnIDs.contains(blockTurnID) {
            return false
        }

        if isLatestBlock, latestTurnTerminalState == .stopped {
            return false
        }

        guard isThreadRunning else {
            return true
        }

        if let blockTurnID, let activeTurnID {
            return blockTurnID != activeTurnID
        }

        return !isLatestBlock
    }

    // Scrolls to the bottom sentinel; used by manual jump button and initial recovery snap.
    // Streaming follow-bottom uses the throttled scheduleFollowBottomScroll instead.
    private func scrollToBottom(using proxy: ScrollViewProxy, animated: Bool) {
        guard !messages.isEmpty else { return }

        if animated {
            withAnimation(.easeInOut(duration: 0.2)) {
                proxy.scrollTo(scrollBottomAnchorID, anchor: .bottom)
            }
        } else {
            proxy.scrollTo(scrollBottomAnchorID, anchor: .bottom)
        }
    }
}

private struct ScrollBottomGeometry: Equatable {
    let isAtBottom: Bool
    let viewportHeight: CGFloat
}

private struct TurnFloatingButtonPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.9 : 1)
            .opacity(configuration.isPressed ? 0.82 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}
