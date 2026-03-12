// FILE: SettingsView.swift
// Purpose: Settings for Local Mode (Codex runs on user's Mac and the iPhone connects over a paired bridge socket).
// Layer: View
// Exports: SettingsView

import SwiftUI
import UIKit

struct SettingsView: View {
    @Environment(CodexService.self) private var codex
    @Environment(\.dismiss) private var dismiss

    let viewModel: ContentViewModel

    @AppStorage("codex.appFontStyle") private var appFontStyleRawValue = AppFont.defaultStoredStyleRawValue
    @State private var isPerformingConnectionAction = false

    private let runtimeAutoValue = "__AUTO__"
    private let transportAutoValue = "__AUTO_TRANSPORT__"

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                SettingsArchivedChatsCard()
                SettingsAppearanceCard(appFontStyle: appFontStyleBinding)
                SettingsNotificationsCard()
                runtimeDefaultsSection
                connectionSection
                SettingsAboutCard()
            }
            .padding()
        }
        .font(AppFont.body())
        .navigationTitle("Settings")
    }

    private var appFontStyleBinding: Binding<AppFont.Style> {
        Binding(
            get: { AppFont.Style(rawValue: appFontStyleRawValue) ?? AppFont.defaultStyle },
            set: { appFontStyleRawValue = $0.rawValue }
        )
    }

    // MARK: - Runtime defaults

    @ViewBuilder private var runtimeDefaultsSection: some View {
        SettingsCard(title: "Runtime defaults") {
            HStack {
                Text("Model")
                Spacer()
                Picker("Model", selection: runtimeModelSelection) {
                    Text("Auto").tag(runtimeAutoValue)
                    ForEach(runtimeModelOptions, id: \.id) { model in
                        Text(TurnComposerMetaMapper.modelTitle(for: model))
                            .tag(model.id)
                    }
                }
                .pickerStyle(.menu)
                .labelsHidden()
                .tint(.cyan)
            }

            HStack {
                Text("Reasoning")
                Spacer()
                Picker("Reasoning", selection: runtimeReasoningSelection) {
                    Text("Auto").tag(runtimeAutoValue)
                    ForEach(runtimeReasoningOptions, id: \.id) { option in
                        Text(option.title).tag(option.effort)
                    }
                }
                .pickerStyle(.menu)
                .labelsHidden()
                .tint(.cyan)
                .disabled(runtimeReasoningOptions.isEmpty)
            }

            HStack {
                Text("Access")
                Spacer()
                Picker("Access", selection: runtimeAccessSelection) {
                    ForEach(CodexAccessMode.allCases, id: \.self) { mode in
                        Text(mode.displayName).tag(mode)
                    }
                }
                .pickerStyle(.menu)
                .labelsHidden()
                .tint(.cyan)
            }
        }
    }

    // MARK: - Connection

    @ViewBuilder private var connectionSection: some View {
        SettingsCard(title: "Connection") {
            Text("Status: \(connectionStatusLabel)")
                .font(AppFont.caption())
                .foregroundStyle(.secondary)

            Text("Security: \(codex.secureConnectionState.statusLabel)")
                .font(AppFont.caption())
                .foregroundStyle(codex.secureConnectionState == .encrypted ? .green : .secondary)

            if let fingerprint = codex.secureMacFingerprint, !fingerprint.isEmpty {
                Text("Trusted Mac: \(fingerprint)")
                    .font(AppFont.caption())
                    .foregroundStyle(.secondary)
            }

            if !pairedMacs.isEmpty {
                Text("Paired Macs: \(pairedMacs.count)")
                    .font(AppFont.caption())
                    .foregroundStyle(.secondary)

                VStack(alignment: .leading, spacing: 12) {
                    ForEach(pairedMacs) { pairing in
                        pairedMacRow(pairing)
                    }
                }
            }

            if availableTransportCandidates.count > 1 {
                HStack {
                    Text("Transport")
                    Spacer()
                    Picker("Transport", selection: preferredTransportSelection) {
                        Text("Auto").tag(transportAutoValue)
                        ForEach(availableTransportCandidates, id: \.url) { candidate in
                            Text(codex.displayTitle(for: candidate)).tag(candidate.url)
                        }
                    }
                    .pickerStyle(.menu)
                    .labelsHidden()
                    .tint(.cyan)
                }

                if let candidate = selectedPreferredTransportCandidate {
                    Text("Current preference: \(codex.displayTitle(for: candidate))")
                        .font(AppFont.caption())
                        .foregroundStyle(.secondary)
                } else {
                    Text("Current preference: Auto")
                        .font(AppFont.caption())
                        .foregroundStyle(.secondary)
                }
            }

            if connectionPhaseShowsProgress {
                HStack(spacing: 8) {
                    ProgressView()
                    Text(connectionProgressLabel)
                        .font(AppFont.caption())
                        .foregroundStyle(.secondary)
                }
            }

            if case .retrying(_, let message) = codex.connectionRecoveryState,
               !message.isEmpty {
                Text(message)
                    .font(AppFont.caption())
                    .foregroundStyle(.secondary)
            }

            if let error = codex.lastErrorMessage, !error.isEmpty {
                Text(error)
                    .font(AppFont.caption())
                    .foregroundStyle(.red)
            }

            if codex.isConnected {
                SettingsButton("Disconnect", role: .destructive) {
                    HapticFeedback.shared.triggerImpactFeedback()
                    disconnectBridge()
                }
                .disabled(isPerformingConnectionAction)
            }
        }
    }

    private var connectionPhaseShowsProgress: Bool {
        switch codex.connectionPhase {
        case .connecting, .loadingChats, .syncing:
            return true
        case .offline, .connected:
            return false
        }
    }

    private var connectionStatusLabel: String {
        switch codex.connectionPhase {
        case .offline:
            return "offline"
        case .connecting:
            return "connecting"
        case .loadingChats:
            return "loading chats"
        case .syncing:
            return "syncing"
        case .connected:
            return "connected"
        }
    }

    private var connectionProgressLabel: String {
        switch codex.connectionPhase {
        case .connecting:
            return "Connecting to bridge..."
        case .loadingChats:
            return "Loading chats..."
        case .syncing:
            return "Syncing workspace..."
        case .offline, .connected:
            return ""
        }
    }

    private var availableTransportCandidates: [CodexTransportCandidate] {
        codex.normalizedTransportCandidates.filter { candidate in
            guard let url = URL(string: candidate.url),
                  let host = url.host?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !host.isEmpty else {
                return false
            }
            if candidate.kind == "local_ipv4" {
                return !host.hasPrefix("169.254.")
            }
            return true
        }
    }

    private var selectedPreferredTransportCandidate: CodexTransportCandidate? {
        guard let preferredTransportURL = codex.preferredTransportURL?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !preferredTransportURL.isEmpty else {
            return nil
        }
        return availableTransportCandidates.first { $0.url == preferredTransportURL }
    }

    private var pairedMacs: [CodexBridgePairingRecord] {
        codex.orderedSavedBridgePairings
    }

    @ViewBuilder
    private func pairedMacRow(_ pairing: CodexBridgePairingRecord) -> some View {
        let isActivePairing = pairing.macDeviceId == codex.activeSavedBridgePairing?.macDeviceId
        let isConnectedPairing = isActivePairing && codex.isConnected

        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(codex.displayTitle(for: pairing))
                    .font(AppFont.subheadline(weight: .semibold))
                    .foregroundStyle(.primary)

                Spacer()

                Text(isConnectedPairing ? "Connected" : (isActivePairing ? "Selected" : "Saved"))
                    .font(AppFont.caption(weight: .semibold))
                    .foregroundStyle(isConnectedPairing ? .green : .secondary)
            }

            Text("\(pairing.transportCandidates.count) saved transport\(pairing.transportCandidates.count == 1 ? "" : "s")")
                .font(AppFont.caption())
                .foregroundStyle(.secondary)

            if !isActivePairing {
                SettingsButton(codex.isConnected ? "Switch to This Mac" : "Use This Mac") {
                    HapticFeedback.shared.triggerImpactFeedback()
                    switchBridgePairing(to: pairing.macDeviceId)
                }
                .disabled(isPerformingConnectionAction)
            }

            SettingsButton(isActivePairing ? "Remove This Mac" : "Remove", role: .destructive) {
                HapticFeedback.shared.triggerImpactFeedback()
                removeBridgePairing(pairing.macDeviceId)
            }
            .disabled(isPerformingConnectionAction)
        }
        .padding(.vertical, 2)
    }

    // MARK: - Actions

    private func disconnectBridge() {
        Task { @MainActor in
            guard !isPerformingConnectionAction else {
                return
            }
            isPerformingConnectionAction = true
            defer { isPerformingConnectionAction = false }
            codex.shouldReturnHomeAfterDisconnect = true
            await codex.disconnect()
            dismiss()
        }
    }

    private func removeBridgePairing(_ macDeviceId: String) {
        Task { @MainActor in
            guard !isPerformingConnectionAction else {
                return
            }
            isPerformingConnectionAction = true
            defer { isPerformingConnectionAction = false }
            await viewModel.removeSavedBridgePairing(macDeviceId: macDeviceId, codex: codex)
        }
    }

    private func switchBridgePairing(to macDeviceId: String) {
        Task { @MainActor in
            guard !isPerformingConnectionAction else {
                return
            }
            isPerformingConnectionAction = true
            defer { isPerformingConnectionAction = false }
            await viewModel.switchSavedBridgePairing(macDeviceId: macDeviceId, codex: codex)
        }
    }

    // MARK: - Runtime bindings

    private var runtimeModelOptions: [CodexModelOption] {
        TurnComposerMetaMapper.orderedModels(from: codex.availableModels)
    }

    private var runtimeReasoningOptions: [TurnComposerReasoningDisplayOption] {
        TurnComposerMetaMapper.reasoningDisplayOptions(
            from: codex.supportedReasoningEffortsForSelectedModel().map(\.reasoningEffort)
        )
    }

    private var runtimeModelSelection: Binding<String> {
        Binding(
            get: { codex.selectedModelOption()?.id ?? runtimeAutoValue },
            set: { selection in
                codex.setSelectedModelId(selection == runtimeAutoValue ? nil : selection)
            }
        )
    }

    private var runtimeReasoningSelection: Binding<String> {
        Binding(
            get: { codex.selectedReasoningEffort ?? runtimeAutoValue },
            set: { selection in
                codex.setSelectedReasoningEffort(selection == runtimeAutoValue ? nil : selection)
            }
        )
    }

    private var runtimeAccessSelection: Binding<CodexAccessMode> {
        Binding(
            get: { codex.selectedAccessMode },
            set: { codex.setSelectedAccessMode($0) }
        )
    }

    private var preferredTransportSelection: Binding<String> {
        Binding(
            get: {
                selectedPreferredTransportCandidate?.url ?? transportAutoValue
            },
            set: { selection in
                codex.setPreferredTransportURL(selection == transportAutoValue ? nil : selection)
            }
        )
    }
}

// MARK: - Reusable card / button components

struct SettingsCard<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title.uppercased())
                .font(AppFont.caption(weight: .semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 4)
                .padding(.bottom, 8)
            VStack(alignment: .leading, spacing: 12) {
                content
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.tertiarySystemFill).opacity(0.5), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        }
    }
}

struct SettingsButton: View {
    let title: String
    var role: ButtonRole?
    var isLoading: Bool = false
    let action: () -> Void

    init(_ title: String, role: ButtonRole? = nil, isLoading: Bool = false, action: @escaping () -> Void) {
        self.title = title
        self.role = role
        self.isLoading = isLoading
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            Group {
                if isLoading {
                    ProgressView()
                } else {
                    Text(title)
                }
            }
            .font(AppFont.subheadline(weight: .medium))
            .foregroundStyle(role == .destructive ? .red : (role == .cancel ? .secondary : .primary))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .background(
                (role == .destructive ? Color.red : Color.primary).opacity(0.08),
                in: RoundedRectangle(cornerRadius: 10)
            )
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Extracted independent section views

private struct SettingsAppearanceCard: View {
    @Binding var appFontStyle: AppFont.Style
    @AppStorage("codex.useLiquidGlass") private var useLiquidGlass = true

    var body: some View {
        SettingsCard(title: "Appearance") {
            HStack {
                Text("Font")
                Spacer()
                Picker("Font", selection: $appFontStyle) {
                    ForEach(AppFont.Style.allCases) { style in
                        Text(style.title).tag(style)
                    }
                }
                .pickerStyle(.menu)
                .labelsHidden()
                .tint(.cyan)
            }

            Text(appFontStyle.subtitle)
                .font(AppFont.caption())
                .foregroundStyle(.secondary)

            if GlassPreference.isSupported {
                Divider()

                Toggle("Liquid Glass", isOn: $useLiquidGlass)
                    .tint(.cyan)

                Text(useLiquidGlass
                     ? "Liquid Glass effects are enabled."
                     : "Using solid material fallback.")
                    .font(AppFont.caption())
                    .foregroundStyle(.secondary)
            }
        }
    }
}

private struct SettingsNotificationsCard: View {
    @Environment(CodexService.self) private var codex
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        SettingsCard(title: "Notifications") {
            HStack(spacing: 10) {
                Image(systemName: "bell.badge")
                    .foregroundStyle(.primary)
                Text("Status")
                Spacer()
                Text(statusLabel)
                    .foregroundStyle(.secondary)
            }

            Text("Used for local alerts when a run finishes while the app is in background.")
                .font(AppFont.caption())
                .foregroundStyle(.secondary)

            if codex.notificationAuthorizationStatus == .notDetermined {
                SettingsButton("Allow notifications") {
                    HapticFeedback.shared.triggerImpactFeedback()
                    Task {
                        await codex.requestNotificationPermission()
                    }
                }
            }

            if codex.notificationAuthorizationStatus == .denied {
                SettingsButton("Open iOS Settings") {
                    HapticFeedback.shared.triggerImpactFeedback()
                    if let url = URL(string: UIApplication.openNotificationSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                }
            }
        }
        .task {
            await codex.refreshNotificationAuthorizationStatus()
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else {
                return
            }
            Task {
                await codex.refreshNotificationAuthorizationStatus()
            }
        }
    }

    private var statusLabel: String {
        switch codex.notificationAuthorizationStatus {
        case .authorized: "Authorized"
        case .denied: "Denied"
        case .provisional: "Provisional"
        case .ephemeral: "Ephemeral"
        case .notDetermined: "Not requested"
        @unknown default: "Unknown"
        }
    }
}

private struct SettingsArchivedChatsCard: View {
    @Environment(CodexService.self) private var codex

    private var archivedCount: Int {
        codex.threads.filter { $0.syncState == .archivedLocal }.count
    }

    var body: some View {
        SettingsCard(title: "Archived Chats") {
            NavigationLink {
                ArchivedChatsView()
            } label: {
                HStack {
                    Label("Archived Chats", systemImage: "archivebox")
                        .font(AppFont.subheadline(weight: .medium))
                    Spacer()
                    if archivedCount > 0 {
                        Text("\(archivedCount)")
                            .font(AppFont.caption(weight: .medium))
                            .foregroundStyle(.secondary)
                    }
                    Image(systemName: "chevron.right")
                        .font(AppFont.caption(weight: .semibold))
                        .foregroundStyle(.tertiary)
                }
            }
            .buttonStyle(.plain)
        }
    }
}

private struct SettingsAboutCard: View {
    var body: some View {
        SettingsCard(title: "About") {
            Text("Chats are end-to-end encrypted between your iPhone and Mac. Local and tailnet transports only carry the encrypted wire stream and connection metadata.")
                .font(AppFont.caption())
                .foregroundStyle(.secondary)
        }
    }
}

#Preview {
    NavigationStack {
        SettingsView(viewModel: ContentViewModel())
            .environment(CodexService())
    }
}
