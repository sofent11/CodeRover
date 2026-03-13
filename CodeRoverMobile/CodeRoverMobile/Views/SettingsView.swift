// FILE: SettingsView.swift
// Purpose: Settings for Local Mode (CodeRover runs on user's Mac and the iPhone connects over a paired bridge socket).
// Layer: View
// Exports: SettingsView

import SwiftUI
import UIKit

struct SettingsView: View {
    @Environment(CodeRoverService.self) private var coderover
    @Environment(\.dismiss) private var dismiss

    let viewModel: ContentViewModel

    @AppStorage("coderover.appFontStyle") private var appFontStyleRawValue = AppFont.defaultStoredStyleRawValue
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
                Text("Provider")
                Spacer()
                Picker("Provider", selection: runtimeProviderSelection) {
                    ForEach(coderover.availableProviders) { provider in
                        Text(provider.title).tag(provider.id)
                    }
                }
                .pickerStyle(.menu)
                .labelsHidden()
                .tint(.cyan)
            }

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
                    ForEach(runtimeAccessModes, id: \.self) { mode in
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

            Text("Security: \(coderover.secureConnectionState.statusLabel)")
                .font(AppFont.caption())
                .foregroundStyle(coderover.secureConnectionState == .encrypted ? .green : .secondary)

            if let fingerprint = coderover.secureMacFingerprint, !fingerprint.isEmpty {
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
                            Text(coderover.displayTitle(for: candidate)).tag(candidate.url)
                        }
                    }
                    .pickerStyle(.menu)
                    .labelsHidden()
                    .tint(.cyan)
                }

                if let candidate = selectedPreferredTransportCandidate {
                    Text("Current preference: \(coderover.displayTitle(for: candidate))")
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

            if case .retrying(_, let message) = coderover.connectionRecoveryState,
               !message.isEmpty {
                Text(message)
                    .font(AppFont.caption())
                    .foregroundStyle(.secondary)
            }

            if let error = coderover.lastErrorMessage, !error.isEmpty {
                Text(error)
                    .font(AppFont.caption())
                    .foregroundStyle(.red)
            }

            if coderover.isConnected {
                SettingsButton("Disconnect", role: .destructive) {
                    HapticFeedback.shared.triggerImpactFeedback()
                    disconnectBridge()
                }
                .disabled(isPerformingConnectionAction)
            }
        }
    }

    private var connectionPhaseShowsProgress: Bool {
        switch coderover.connectionPhase {
        case .connecting, .loadingChats, .syncing:
            return true
        case .offline, .connected:
            return false
        }
    }

    private var connectionStatusLabel: String {
        switch coderover.connectionPhase {
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
        switch coderover.connectionPhase {
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

    private var availableTransportCandidates: [CodeRoverTransportCandidate] {
        coderover.normalizedTransportCandidates.filter { candidate in
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

    private var selectedPreferredTransportCandidate: CodeRoverTransportCandidate? {
        guard let preferredTransportURL = coderover.preferredTransportURL?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !preferredTransportURL.isEmpty else {
            return nil
        }
        return availableTransportCandidates.first { $0.url == preferredTransportURL }
    }

    private var pairedMacs: [CodeRoverBridgePairingRecord] {
        coderover.orderedSavedBridgePairings
    }

    @ViewBuilder
    private func pairedMacRow(_ pairing: CodeRoverBridgePairingRecord) -> some View {
        let isActivePairing = pairing.macDeviceId == coderover.activeSavedBridgePairing?.macDeviceId
        let isConnectedPairing = isActivePairing && coderover.isConnected

        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(coderover.displayTitle(for: pairing))
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
                SettingsButton(coderover.isConnected ? "Switch to This Mac" : "Use This Mac") {
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
            coderover.shouldReturnHomeAfterDisconnect = true
            await coderover.disconnect()
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
            await viewModel.removeSavedBridgePairing(macDeviceId: macDeviceId, coderover: coderover)
        }
    }

    private func switchBridgePairing(to macDeviceId: String) {
        Task { @MainActor in
            guard !isPerformingConnectionAction else {
                return
            }
            isPerformingConnectionAction = true
            defer { isPerformingConnectionAction = false }
            await viewModel.switchSavedBridgePairing(macDeviceId: macDeviceId, coderover: coderover)
        }
    }

    // MARK: - Runtime bindings

    private var runtimeModelOptions: [ModelOption] {
        TurnComposerMetaMapper.orderedModels(from: coderover.availableModels)
    }

    private var runtimeAccessModes: [AccessMode] {
        coderover.availableAccessModes(for: coderover.selectedProviderID)
    }

    private var runtimeProviderSelection: Binding<String> {
        Binding(
            get: { coderover.selectedProviderID },
            set: { coderover.setSelectedProviderID($0) }
        )
    }

    private var runtimeReasoningOptions: [TurnComposerReasoningDisplayOption] {
        TurnComposerMetaMapper.reasoningDisplayOptions(
            from: coderover.supportedReasoningEffortsForSelectedModel().map(\.reasoningEffort)
        )
    }

    private var runtimeModelSelection: Binding<String> {
        Binding(
            get: { coderover.selectedModelOption()?.id ?? runtimeAutoValue },
            set: { selection in
                coderover.setSelectedModelId(selection == runtimeAutoValue ? nil : selection)
            }
        )
    }

    private var runtimeReasoningSelection: Binding<String> {
        Binding(
            get: { coderover.selectedReasoningEffort ?? runtimeAutoValue },
            set: { selection in
                coderover.setSelectedReasoningEffort(selection == runtimeAutoValue ? nil : selection)
            }
        )
    }

    private var runtimeAccessSelection: Binding<AccessMode> {
        Binding(
            get: { coderover.selectedAccessMode },
            set: { selectedMode in
                coderover.setSelectedAccessMode(selectedMode)
            }
        )
    }

    private var preferredTransportSelection: Binding<String> {
        Binding(
            get: {
                selectedPreferredTransportCandidate?.url ?? transportAutoValue
            },
            set: { selection in
                coderover.setPreferredTransportURL(selection == transportAutoValue ? nil : selection)
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
    @AppStorage("coderover.useLiquidGlass") private var useLiquidGlass = true

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
    @Environment(CodeRoverService.self) private var coderover
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

            if coderover.notificationAuthorizationStatus == .notDetermined {
                SettingsButton("Allow notifications") {
                    HapticFeedback.shared.triggerImpactFeedback()
                    Task {
                        await coderover.requestNotificationPermission()
                    }
                }
            }

            if coderover.notificationAuthorizationStatus == .denied {
                SettingsButton("Open iOS Settings") {
                    HapticFeedback.shared.triggerImpactFeedback()
                    if let url = URL(string: UIApplication.openNotificationSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                }
            }
        }
        .task {
            await coderover.refreshNotificationAuthorizationStatus()
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else {
                return
            }
            Task {
                await coderover.refreshNotificationAuthorizationStatus()
            }
        }
    }

    private var statusLabel: String {
        switch coderover.notificationAuthorizationStatus {
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
    @Environment(CodeRoverService.self) private var coderover

    private var archivedCount: Int {
        coderover.threads.filter { $0.syncState == .archivedLocal }.count
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
            .environment(CodeRoverService())
    }
}
