// FILE: SidebarView.swift
// Purpose: Orchestrates the sidebar experience with modular presentation components.
// Layer: View
// Exports: SidebarView
// Depends on: CodexService, Sidebar* components/helpers

import SwiftUI

struct SidebarView: View {
    @Environment(CodexService.self) private var codex
    @Environment(\.colorScheme) private var colorScheme

    @Binding var selectedThread: CodexThread?
    @Binding var showSettings: Bool
    @Binding var isSearchActive: Bool

    let onClose: () -> Void

    @State private var searchText = ""
    @State private var isCreatingThread = false
    @State private var groupedThreads: [SidebarThreadGroup] = []
    @State private var isShowingNewChatProjectPicker = false
    @State private var projectGroupPendingArchive: SidebarThreadGroup? = nil
    @State private var threadPendingDeletion: CodexThread? = nil
    @State private var createThreadErrorMessage: String? = nil

    var body: some View {
        sidebarContent
        .background(Color(.systemBackground))
        .task {
            rebuildGroupedThreads()
            if codex.isConnected, codex.threads.isEmpty {
                await refreshThreads()
            }
        }
        .onChange(of: codex.threads) { _, _ in
            rebuildGroupedThreads()
        }
        .onChange(of: searchText) { _, _ in
            rebuildGroupedThreads()
        }
        .overlay {
            if codex.isLoadingThreads {
                ProgressView()
                    .padding()
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
            }
        }
        .sheet(isPresented: $isShowingNewChatProjectPicker, content: newChatSheet)
        .confirmationDialog(
            "Archive \"\(projectGroupPendingArchive?.label ?? "project")\"?",
            isPresented: isArchiveDialogPresented,
            titleVisibility: .visible
        ) {
            Button("Archive Project") {
                archivePendingProjectGroup()
            }
            Button("Cancel", role: .cancel) {
                projectGroupPendingArchive = nil
            }
        } message: {
            Text("All active chats in this project will be archived.")
        }
        .confirmationDialog(
            "Delete \"\(threadPendingDeletion?.displayTitle ?? "conversation")\"?",
            isPresented: isDeleteDialogPresented,
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                if let thread = threadPendingDeletion {
                    if selectedThread?.id == thread.id {
                        selectedThread = nil
                    }
                    codex.deleteThread(thread.id)
                }
                threadPendingDeletion = nil
            }
            Button("Cancel", role: .cancel) {
                threadPendingDeletion = nil
            }
        }
        .alert(
            "Action failed",
            isPresented: isCreateThreadErrorPresented,
            actions: {
                Button("OK", role: .cancel) {
                    createThreadErrorMessage = nil
                }
            },
            message: {
                Text(createThreadErrorMessage ?? "Please try again.")
            }
        )
    }

    private var sidebarContent: some View {
        VStack(alignment: .leading, spacing: 0) {
            SidebarHeaderView()

            SidebarSearchField(text: $searchText, isActive: $isSearchActive)
                .padding(.horizontal, 16)
                .padding(.top, 6)
                .padding(.bottom, 6)

            SidebarNewChatButton(
                isCreatingThread: isCreatingThread,
                isEnabled: canCreateThread,
                statusMessage: nil,
                action: handleNewChatButtonTap
            )
            .padding(.horizontal, 16)
            .padding(.bottom, 10)

            threadListView

            HStack(spacing: 10) {
                SidebarFloatingSettingsButton(colorScheme: colorScheme, action: openSettings)
            }
            .padding(.horizontal, 16)
            .padding(.top, 10)
        }
        .frame(maxHeight: .infinity)
    }

    private var threadListView: some View {
        SidebarThreadListView(
            isFiltering: !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            isConnected: codex.isConnected,
            isCreatingThread: isCreatingThread,
            threads: codex.threads,
            groups: groupedThreads,
            selectedThread: selectedThread,
            bottomContentInset: 0,
            timingLabelProvider: { SidebarRelativeTimeFormatter.compactLabel(for: $0) },
            diffTotalsByThreadID: sidebarDiffTotalsByThreadID,
            runBadgeStateByThreadID: runBadgeStateByThreadID,
            onSelectThread: selectThread,
            onCreateThreadInProjectGroup: { group in
                handleNewChatTap(
                    preferredProjectPath: group.projectPath,
                    providerID: codex.selectedProviderID
                )
            },
            onArchiveProjectGroup: { group in
                projectGroupPendingArchive = group
            },
            onRenameThread: { thread, newName in
                codex.renameThread(thread.id, name: newName)
            },
            onArchiveToggleThread: { thread in
                if thread.syncState == .archivedLocal {
                    codex.unarchiveThread(thread.id)
                } else {
                    codex.archiveThread(thread.id)
                    if selectedThread?.id == thread.id {
                        selectedThread = nil
                    }
                }
            },
            onDeleteThread: { thread in
                threadPendingDeletion = thread
            }
        )
        .refreshable {
            await refreshThreads()
        }
    }

    private func newChatSheet() -> some View {
        SidebarNewChatProjectPickerSheet(
            choices: newChatProjectChoices,
            providers: codex.availableProviders,
            selectedProviderID: Binding(
                get: { codex.selectedProviderID },
                set: { codex.setSelectedProviderID($0) }
            ),
            onSelectProject: { projectPath, providerID in
                handleNewChatTap(preferredProjectPath: projectPath, providerID: providerID)
            },
            onSelectWithoutProject: { providerID in
                handleNewChatTap(preferredProjectPath: nil, providerID: providerID)
            }
        )
    }

    private var isArchiveDialogPresented: Binding<Bool> {
        Binding(
            get: { projectGroupPendingArchive != nil },
            set: { if !$0 { projectGroupPendingArchive = nil } }
        )
    }

    private var isDeleteDialogPresented: Binding<Bool> {
        Binding(
            get: { threadPendingDeletion != nil },
            set: { if !$0 { threadPendingDeletion = nil } }
        )
    }

    private var isCreateThreadErrorPresented: Binding<Bool> {
        Binding(
            get: { createThreadErrorMessage != nil },
            set: { if !$0 { createThreadErrorMessage = nil } }
        )
    }

    // MARK: - Actions

    private func refreshThreads() async {
        guard codex.isConnected else { return }
        do {
            try await codex.listThreads()
        } catch {
            // Error stored in CodexService.
        }
    }

    // Shows a native sheet so folder names and full paths stay readable on small screens.
    private func handleNewChatButtonTap() {
        if newChatProjectChoices.isEmpty {
            handleNewChatTap(preferredProjectPath: nil, providerID: codex.selectedProviderID)
            return
        }

        isShowingNewChatProjectPicker = true
    }

    private func handleNewChatTap(preferredProjectPath: String?, providerID: String) {
        Task { @MainActor in
            guard codex.isConnected else {
                createThreadErrorMessage = "Connect to runtime first."
                return
            }
            guard codex.isInitialized else {
                createThreadErrorMessage = "Runtime is still initializing. Wait a moment and retry."
                return
            }

            createThreadErrorMessage = nil
            isCreatingThread = true
            defer { isCreatingThread = false }

            do {
                codex.setSelectedProviderID(providerID)
                let thread = try await codex.startThread(
                    preferredProjectPath: preferredProjectPath,
                    provider: providerID
                )
                selectedThread = thread
                onClose()
            } catch {
                let message = error.localizedDescription
                codex.lastErrorMessage = message
                createThreadErrorMessage = message.isEmpty ? "Unable to create a chat right now." : message
            }
        }
    }

    private func selectThread(_ thread: CodexThread) {
        searchText = ""
        codex.activeThreadId = thread.id
        codex.markThreadAsViewed(thread.id)
        selectedThread = thread
        onClose()
    }

    private func openSettings() {
        searchText = ""
        showSettings = true
        onClose()
    }

    // Archives every live chat in the selected project group and clears the current selection if needed.
    private func archivePendingProjectGroup() {
        guard let group = projectGroupPendingArchive else { return }

        let threadIDs = SidebarThreadGrouping.liveThreadIDsForProjectGroup(group, in: codex.threads)
        let selectedThreadWasArchived = selectedThread.map { selected in
            threadIDs.contains(selected.id)
        } ?? false

        _ = codex.archiveThreadGroup(threadIDs: threadIDs)

        if selectedThreadWasArchived {
            selectedThread = codex.threads.first(where: { thread in
                thread.syncState == .live && !threadIDs.contains(thread.id)
            })
        }

        projectGroupPendingArchive = nil
    }

    // Rebuilds sidebar sections only when the source thread array changes.
    private func rebuildGroupedThreads() {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        let source: [CodexThread]
        if query.isEmpty {
            source = codex.threads
        } else {
            source = codex.threads.filter {
                $0.displayTitle.localizedCaseInsensitiveContains(query)
                || $0.projectDisplayName.localizedCaseInsensitiveContains(query)
            }
        }
        groupedThreads = SidebarThreadGrouping.makeGroups(from: source)
    }

    private var runBadgeStateByThreadID: [String: CodexThreadRunBadgeState] {
        var byThreadID: [String: CodexThreadRunBadgeState] = [:]
        for thread in codex.threads {
            if let state = codex.threadRunBadgeState(for: thread.id) {
                byThreadID[thread.id] = state
            }
        }
        return byThreadID
    }

    private var sidebarDiffTotalsByThreadID: [String: TurnSessionDiffTotals] {
        var byThreadID: [String: TurnSessionDiffTotals] = [:]

        for thread in codex.threads {
            let messages = codex.messages(for: thread.id)
            if let totals = TurnSessionDiffSummaryCalculator.totals(
                from: messages,
                scope: .unpushedSession
            ) {
                byThreadID[thread.id] = totals
            }
        }

        return byThreadID
    }

    // Keeps the chooser in sync with the same project buckets shown in the sidebar.
    private var newChatProjectChoices: [SidebarProjectChoice] {
        SidebarThreadGrouping.makeProjectChoices(from: codex.threads)
    }

    private var canCreateThread: Bool {
        codex.isConnected && codex.isInitialized
    }
}

private struct SidebarNewChatProjectPickerSheet: View {
    let choices: [SidebarProjectChoice]
    let providers: [CodexRuntimeProvider]
    @Binding var selectedProviderID: String
    let onSelectProject: (String, String) -> Void
    let onSelectWithoutProject: (String) -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Choose a project for this chat.")
                        .font(AppFont.body())
                        .foregroundStyle(.secondary)
                        .listRowBackground(Color.clear)
                }

                Section("Runtime") {
                    Picker("Provider", selection: $selectedProviderID) {
                        ForEach(providers) { provider in
                            Text(provider.title).tag(provider.id)
                        }
                    }
                    .pickerStyle(.inline)
                }

                Section("Projects") {
                    ForEach(choices) { choice in
                        Button {
                            dismiss()
                            onSelectProject(choice.projectPath, selectedProviderID)
                        } label: {
                            HStack(alignment: .top, spacing: 12) {
                                Image(systemName: "folder")
                                    .font(AppFont.body(weight: .medium))
                                    .foregroundStyle(.secondary)

                                VStack(alignment: .leading, spacing: 4) {
                                    Text(choice.label)
                                        .font(AppFont.body(weight: .semibold))
                                        .foregroundStyle(.primary)
                                        .frame(maxWidth: .infinity, alignment: .leading)

                                    Text(choice.projectPath)
                                        .font(AppFont.mono(.caption))
                                        .foregroundStyle(.secondary)
                                        .lineLimit(2)
                                        .truncationMode(.middle)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                            }
                            .padding(.vertical, 2)
                        }
                    }
                }

                Section {
                    Button {
                        dismiss()
                        onSelectWithoutProject(selectedProviderID)
                    } label: {
                        HStack(alignment: .top, spacing: 12) {
                            Image(systemName: "plus.bubble")
                                .font(AppFont.body(weight: .medium))
                                .foregroundStyle(.secondary)

                            VStack(alignment: .leading, spacing: 4) {
                                Text("No Project")
                                    .font(AppFont.body(weight: .semibold))
                                    .foregroundStyle(.primary)
                                    .frame(maxWidth: .infinity, alignment: .leading)

                                Text("Start a chat without a working directory.")
                                    .font(AppFont.body())
                                    .foregroundStyle(.secondary)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                }

                Section {
                    // Explains the existing scoping rule at the exact moment the user chooses it.
                    Text("Chats started in a project stay scoped to that working directory. If you pick No Project, the chat is global.")
                        .font(AppFont.caption())
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .listRowBackground(Color.clear)
                }
            }
            .navigationTitle("Start new chat")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") {
                        dismiss()
                    }
                }
            }
        }
        .presentationDetents(choices.count > 4 ? [.medium, .large] : [.medium])
    }
}
