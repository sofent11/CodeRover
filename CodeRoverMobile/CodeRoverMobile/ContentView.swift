// FILE: ContentView.swift
// Purpose: Root layout orchestrator — navigation shell, sidebar drawer, and top-level state wiring.
// Layer: View
// Exports: ContentView
// Depends on: SidebarView, TurnView, SettingsView, CodeRoverService, ContentViewModel

import SwiftUI

struct ContentView: View {
    @Environment(CodeRoverService.self) private var coderover
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.colorScheme) private var colorScheme

    @State private var viewModel = ContentViewModel()
    @State private var isSidebarOpen = false
    @State private var sidebarDragOffset: CGFloat = 0
    @State private var selectedThread: ConversationThread?
    @State private var navigationPath = NavigationPath()
    @State private var showSettings = false
    @State private var isShowingSettingsScreen = false
    @State private var isShowingManualScanner = false
    @State private var isSearchActive = false
    @State private var pendingTransportSelection: PendingTransportSelection?
    @AppStorage("coderover.hasSeenOnboarding") private var hasSeenOnboarding = false

    private let sidebarWidth: CGFloat = 330
    private static let sidebarSpring = Animation.spring(response: 0.35, dampingFraction: 0.85)

    var body: some View {
        rootContent
            // Keep launch/foreground reconnect observers alive even while the QR scanner is visible.
            .task {
                await viewModel.attemptAutoConnectOnLaunchIfNeeded(coderover: coderover)
            }
            .onChange(of: showSettings) { _, show in
                if show {
                    Task {
                        await viewModel.stopAutoReconnectForSettings(coderover: coderover)
                    }
                    navigationPath.append("settings")
                    showSettings = false
                }
            }
            .onChange(of: isSidebarOpen) { wasOpen, isOpen in
                guard !wasOpen, isOpen else {
                    return
                }
                if viewModel.shouldRequestSidebarFreshSync(isConnected: coderover.isConnected) {
                    coderover.requestImmediateSync(threadId: coderover.activeThreadId)
                }
            }
            .onChange(of: navigationPath) { _, _ in
                if isSidebarOpen {
                    closeSidebar()
                }
            }
            .onChange(of: selectedThread) { previousThread, thread in
                coderover.handleDisplayedThreadChange(
                    from: previousThread?.id,
                    to: thread?.id
                )
                coderover.activeThreadId = thread?.id
            }
            .onChange(of: coderover.activeThreadId) { _, activeThreadId in
                guard let activeThreadId,
                      let matchingThread = coderover.threads.first(where: { $0.id == activeThreadId }),
                      selectedThread?.id != matchingThread.id else {
                    return
                }
                selectedThread = matchingThread
            }
            .onChange(of: coderover.threads) { _, threads in
                syncSelectedThread(with: threads)
            }
            .onChange(of: scenePhase) { _, phase in
                coderover.setForegroundState(phase != .background)
                if phase == .active {
                    guard !isShowingSettingsScreen else {
                        return
                    }
                    Task {
                        await viewModel.attemptAutoReconnectOnForegroundIfNeeded(coderover: coderover)
                    }
                }
            }
            .onChange(of: coderover.shouldAutoReconnectOnForeground) { _, shouldReconnect in
                guard shouldReconnect, scenePhase == .active, !isShowingSettingsScreen else {
                    return
                }
                Task {
                    await viewModel.attemptAutoReconnectOnForegroundIfNeeded(coderover: coderover)
                }
            }
            .onChange(of: coderover.isConnected) { _, isConnected in
                if !isConnected, coderover.shouldReturnHomeAfterDisconnect {
                    returnToHomeAfterManualDisconnect()
                    return
                }

                guard isConnected else {
                    return
                }
                isShowingManualScanner = false
            }
            .sheet(item: $pendingTransportSelection) { selection in
                TransportSelectionView(
                    pairingPayload: selection.pairingPayload,
                    onSelect: { candidate in
                        pendingTransportSelection = nil
                        isShowingManualScanner = false
                        Task {
                            await viewModel.connectToBridge(
                                pairingPayload: selection.pairingPayload,
                                coderover: coderover,
                                preferredTransportURL: candidate.url
                            )
                        }
                    },
                    onCancel: {
                        pendingTransportSelection = nil
                    }
                )
                .presentationDetents([.medium, .large])
            }
    }

    @ViewBuilder
    private var rootContent: some View {
        if !hasSeenOnboarding {
            OnboardingView {
                withAnimation { hasSeenOnboarding = true }
            }
        } else if shouldPresentManualScanner {
            qrScannerBody
        } else if coderover.isConnected || viewModel.isAttemptingAutoReconnect || shouldShowReconnectShell {
            mainAppBody
        } else {
            qrScannerBody
        }
    }

    private var qrScannerBody: some View {
        QRScannerView { pairingPayload in
            let usableCandidates = pairingPayload.transportCandidates.filter { candidate in
                !candidate.url.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            }

            if usableCandidates.count > 1 {
                pendingTransportSelection = PendingTransportSelection(pairingPayload: pairingPayload)
                return
            }

            Task {
                isShowingManualScanner = false
                await viewModel.connectToBridge(
                    pairingPayload: pairingPayload,
                    coderover: coderover,
                    preferredTransportURL: usableCandidates.first?.url
                )
            }
        }
    }

    private var effectiveSidebarWidth: CGFloat {
        isSearchActive ? UIScreen.main.bounds.width : sidebarWidth
    }

    private var mainAppBody: some View {
        ZStack(alignment: .leading) {
            if sidebarVisible {
                SidebarView(
                    selectedThread: $selectedThread,
                    showSettings: $showSettings,
                    isSearchActive: $isSearchActive,
                    onClose: { closeSidebar() }
                )
                .frame(width: effectiveSidebarWidth)
                .animation(.easeInOut(duration: 0.25), value: isSearchActive)
            }

            mainNavigationLayer
                .offset(x: contentOffset)

            if sidebarVisible {
                (colorScheme == .dark ? Color.white : Color.black)
                    .opacity(contentDimOpacity)
                    .ignoresSafeArea()
                    .offset(x: contentOffset)
                    .allowsHitTesting(isSidebarOpen)
                    .onTapGesture { closeSidebar() }
            }
        }
        .gesture(edgeDragGesture)
    }

    // MARK: - Layers

    private var mainNavigationLayer: some View {
        NavigationStack(path: $navigationPath) {
            mainContent
                .adaptiveNavigationBar()
                .navigationDestination(for: String.self) { destination in
                    if destination == "settings" {
                        SettingsView(viewModel: viewModel)
                            .adaptiveNavigationBar()
                            .onAppear {
                                isShowingSettingsScreen = true
                                Task {
                                    await viewModel.stopAutoReconnectForSettings(coderover: coderover)
                                }
                            }
                            .onDisappear {
                                isShowingSettingsScreen = false
                                guard coderover.shouldAutoReconnectOnForeground,
                                      scenePhase == .active else {
                                    return
                                }
                                Task {
                                    await viewModel.attemptAutoReconnectOnForegroundIfNeeded(coderover: coderover)
                                }
                            }
                    }
                }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private var mainContent: some View {
        if let thread = selectedThread {
            TurnView(thread: thread)
                .id(thread.id)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        hamburgerButton
                    }
                }
        } else {
            HomeEmptyStateView(
                connectionPhase: homeConnectionPhase,
                securityLabel: coderover.secureConnectionState.statusLabel,
                onToggleConnection: {
                    Task {
                        await viewModel.toggleConnection(coderover: coderover)
                    }
                }
            ) {
                if homeConnectionPhase == .connecting || (coderover.hasSavedBridgePairing && !coderover.isConnected) {
                    Button("Scan New QR Code") {
                        Task {
                            await viewModel.stopAutoReconnectForManualScan(coderover: coderover)
                        }
                        isShowingManualScanner = true
                    }
                    .font(AppFont.subheadline(weight: .semibold))
                    .foregroundStyle(.primary)
                    .buttonStyle(.plain)
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    hamburgerButton
                }
            }
        }
    }

    private var hamburgerButton: some View {
        Button {
            HapticFeedback.shared.triggerImpactFeedback(style: .light)
            toggleSidebar()
        } label: {
            TwoLineHamburgerIcon()
                .foregroundStyle(colorScheme == .dark ? Color.white : Color.black)
                .padding(8)
                .contentShape(Circle())
                .adaptiveToolbarItem(in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Menu")
    }

    // MARK: - Sidebar Geometry

    private var sidebarVisible: Bool {
        isSidebarOpen || sidebarDragOffset > 0
    }

    private var contentOffset: CGFloat {
        if isSidebarOpen {
            return max(0, effectiveSidebarWidth + sidebarDragOffset)
        } else {
            return max(0, sidebarDragOffset)
        }
    }

    private var contentDimOpacity: Double {
        let progress = min(1, contentOffset / effectiveSidebarWidth)
        return 0.08 * progress
    }

    // MARK: - Gestures

    private var edgeDragGesture: some Gesture {
        DragGesture(minimumDistance: 15)
            .onChanged { value in
                guard navigationPath.isEmpty else { return }

                if !isSidebarOpen {
                    guard value.startLocation.x < 30 else { return }
                    sidebarDragOffset = max(0, value.translation.width)
                } else {
                    sidebarDragOffset = min(0, value.translation.width)
                }
            }
            .onEnded { value in
                guard navigationPath.isEmpty else { return }

                let currentWidth = effectiveSidebarWidth
                let threshold = currentWidth * 0.4

                if !isSidebarOpen {
                    guard value.startLocation.x < 30 else {
                        sidebarDragOffset = 0
                        return
                    }
                    let shouldOpen = value.translation.width > threshold
                        || value.predictedEndTranslation.width > currentWidth * 0.5
                    finishGesture(open: shouldOpen)
                } else {
                    let shouldClose = -value.translation.width > threshold
                        || -value.predictedEndTranslation.width > currentWidth * 0.5
                    finishGesture(open: !shouldClose)
                }
            }
    }

    // MARK: - Sidebar Actions

    private func toggleSidebar() {
        HapticFeedback.shared.triggerImpactFeedback(style: .light)
        withAnimation(Self.sidebarSpring) {
            isSidebarOpen.toggle()
            sidebarDragOffset = 0
        }
    }

    private func closeSidebar() {
        HapticFeedback.shared.triggerImpactFeedback(style: .light)
        withAnimation(Self.sidebarSpring) {
            isSidebarOpen = false
            sidebarDragOffset = 0
        }
    }

    // Shows the remembered pairing shell after app relaunch so the user can reconnect without rescanning.
    private var shouldShowReconnectShell: Bool {
        coderover.hasSavedBridgePairing && !isShowingManualScanner
    }

    private var shouldPresentManualScanner: Bool {
        isShowingManualScanner && !coderover.isConnected && !viewModel.isAttemptingAutoReconnect
    }

    // Keeps home status honest during reconnect loops while letting post-connect sync show separately.
    private var homeConnectionPhase: CodeRoverConnectionPhase {
        if viewModel.isAttemptingAutoReconnect && !coderover.isConnected {
            return .connecting
        }
        return coderover.connectionPhase
    }

    private func finishGesture(open: Bool) {
        HapticFeedback.shared.triggerImpactFeedback(style: .light)
        withAnimation(Self.sidebarSpring) {
            isSidebarOpen = open
            sidebarDragOffset = 0
        }
    }

    private func returnToHomeAfterManualDisconnect() {
        coderover.shouldReturnHomeAfterDisconnect = false
        coderover.activeThreadId = nil
        isShowingManualScanner = false
        closeSidebar()
        navigationPath = NavigationPath()
        selectedThread = nil
    }

    // Keeps selected thread coherent with server list updates.
    private func syncSelectedThread(with threads: [ConversationThread]) {
        if let selected = selectedThread,
           !threads.contains(where: { $0.id == selected.id }) {
            if coderover.activeThreadId == selected.id {
                return
            }
            selectedThread = coderover.pendingNotificationOpenThreadID == nil ? threads.first : nil
            return
        }

        if let selected = selectedThread,
           let refreshed = threads.first(where: { $0.id == selected.id }) {
            selectedThread = refreshed
            return
        }

        if selectedThread == nil,
           coderover.activeThreadId == nil,
           coderover.pendingNotificationOpenThreadID == nil,
           let first = threads.first {
            selectedThread = first
        }
    }
}

private struct PendingTransportSelection: Identifiable {
    let pairingPayload: CodeRoverPairingQRPayload
    let id = UUID()
}

private struct TransportSelectionView: View {
    let pairingPayload: CodeRoverPairingQRPayload
    let onSelect: (CodeRoverTransportCandidate) -> Void
    let onCancel: () -> Void

    var body: some View {
        NavigationStack {
            List(pairingPayload.transportCandidates, id: \.self) { candidate in
                Button {
                    onSelect(candidate)
                } label: {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(candidateDisplayTitle(candidate))
                            .font(AppFont.body(weight: .semibold))
                            .foregroundStyle(.primary)

                        Text(candidate.url)
                            .font(AppFont.footnote())
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                            .lineLimit(3)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 4)
                }
                .buttonStyle(.plain)
            }
            .navigationTitle("Choose Connection")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        onCancel()
                    }
                }
            }
        }
    }

    private func candidateDisplayTitle(_ candidate: CodeRoverTransportCandidate) -> String {
        if let label = candidate.label?.trimmingCharacters(in: .whitespacesAndNewlines),
           !label.isEmpty {
            return "\(label) (\(candidate.kind))"
        }
        return candidate.kind
    }
}

private struct TwoLineHamburgerIcon: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            RoundedRectangle(cornerRadius: 1)
                .frame(width: 20, height: 2)

            RoundedRectangle(cornerRadius: 1)
                .frame(width: 10, height: 2)
        }
        .frame(width: 20, height: 14, alignment: .leading)
    }
}

#Preview {
    ContentView()
        .environment(CodeRoverService())
}
