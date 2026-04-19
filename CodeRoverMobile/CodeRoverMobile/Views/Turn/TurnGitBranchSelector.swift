// FILE: TurnGitBranchSelector.swift
// Purpose: Hosts the branch switcher, branch creation flow, and PR target picker.
// Layer: View Component
// Exports: TurnGitBranchSelector
// Depends on: SwiftUI

import SwiftUI

private func normalizedCreatedBranchName(_ rawName: String) -> String {
    let trimmedName = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedName.isEmpty else { return "" }
    if trimmedName.hasPrefix("coderover/") {
        return trimmedName
    }
    return "coderover/\(trimmedName)"
}

private enum TurnGitBranchPickerMode: String, Identifiable {
    case currentBranch
    case pullRequestTarget

    var id: String { rawValue }

    var navigationTitle: String {
        switch self {
        case .currentBranch:
            return "Current Branch"
        case .pullRequestTarget:
            return "PR Target"
        }
    }
}

struct TurnGitBranchSelector: View {
    let isEnabled: Bool
    let availableGitBranchTargets: [String]
    let gitBranchesCheckedOutElsewhere: Set<String>
    let gitWorktreePathsByBranch: [String: String]
    let selectedGitBaseBranch: String
    let currentGitBranch: String
    let defaultBranch: String
    let isLoadingGitBranchTargets: Bool
    let isSwitchingGitBranch: Bool
    let onSelectGitBranch: (String) -> Void
    let onCreateGitBranch: (String) -> Void
    let onSelectGitBaseBranch: (String) -> Void
    let onRefreshGitBranches: () -> Void

    @State private var activePickerMode: TurnGitBranchPickerMode?

    private let branchLabelColor = Color(.secondaryLabel)
    private var branchSymbolSize: CGFloat { 12 }
    private var branchChevronFont: Font { AppFont.system(size: 9, weight: .regular) }
    private var branchControlsDisabled: Bool { !isEnabled || isLoadingGitBranchTargets || isSwitchingGitBranch }
    private var normalizedDefaultBranch: String? {
        let value = defaultBranch.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }
    private var normalizedCurrentBranch: String {
        currentGitBranch.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    private var effectiveGitBaseBranch: String {
        let selected = selectedGitBaseBranch.trimmingCharacters(in: .whitespacesAndNewlines)
        if !selected.isEmpty {
            return selected
        }
        return normalizedDefaultBranch ?? normalizedCurrentBranch
    }
    private var visibleBranchLabel: String {
        if !normalizedCurrentBranch.isEmpty {
            return normalizedCurrentBranch
        }
        return normalizedDefaultBranch ?? "Branch"
    }

    private func defaultBranch(for pickerMode: TurnGitBranchPickerMode) -> String? {
        switch pickerMode {
        case .currentBranch, .pullRequestTarget:
            return normalizedDefaultBranch
        }
    }

    private func visibleBranches(for pickerMode: TurnGitBranchPickerMode) -> [String] {
        let branchToExclude = defaultBranch(for: pickerMode)
        return availableGitBranchTargets.filter { branch in
            guard let branchToExclude else { return true }
            return branch != branchToExclude
        }
    }

    var body: some View {
        Button {
            HapticFeedback.shared.triggerImpactFeedback(style: .light)
            activePickerMode = .currentBranch
        } label: {
            HStack(spacing: 6) {
                Image("git-branch")
                    .renderingMode(.template)
                    .resizable()
                    .scaledToFit()
                    .frame(width: branchSymbolSize, height: branchSymbolSize)

                Text(visibleBranchLabel)
                    .font(AppFont.mono(.subheadline))
                    .fontWeight(.medium)
                    .lineLimit(1)
                    .layoutPriority(1)

                Image(systemName: "chevron.down")
                    .font(branchChevronFont)
            }
            .foregroundStyle(branchLabelColor)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(branchControlsDisabled)
        .sheet(item: $activePickerMode) { pickerMode in
            TurnGitBranchPickerSheet(
                branches: visibleBranches(for: pickerMode),
                gitBranchesCheckedOutElsewhere: gitBranchesCheckedOutElsewhere,
                gitWorktreePathsByBranch: gitWorktreePathsByBranch,
                selectedBranch: pickerMode == .currentBranch
                    ? normalizedCurrentBranch
                    : effectiveGitBaseBranch,
                defaultBranch: defaultBranch(for: pickerMode),
                currentBranch: normalizedCurrentBranch,
                allowsSelectingCurrentBranch: pickerMode == .currentBranch,
                navigationTitle: pickerMode.navigationTitle,
                isLoading: isLoadingGitBranchTargets,
                isSwitching: isSwitchingGitBranch,
                onSelect: { branch in
                    switch pickerMode {
                    case .currentBranch:
                        onSelectGitBranch(branch)
                    case .pullRequestTarget:
                        onSelectGitBaseBranch(branch)
                    }
                },
                onCreateBranch: onCreateGitBranch,
                onRefresh: onRefreshGitBranches
            )
            .presentationDetents([.medium, .large])
        }
        .contextMenu {
            Button("Current Branch") {
                activePickerMode = .currentBranch
            }
            Button("PR Target") {
                activePickerMode = .pullRequestTarget
            }
        }
    }
}

private struct TurnGitBranchPickerSheet: View {
    @Environment(\.dismiss) private var dismiss

    let branches: [String]
    let gitBranchesCheckedOutElsewhere: Set<String>
    let gitWorktreePathsByBranch: [String: String]
    let selectedBranch: String
    let defaultBranch: String?
    let currentBranch: String
    let allowsSelectingCurrentBranch: Bool
    let navigationTitle: String
    let isLoading: Bool
    let isSwitching: Bool
    let onSelect: (String) -> Void
    let onCreateBranch: (String) -> Void
    let onRefresh: () -> Void

    @State private var searchText = ""
    @State private var isShowingCreateBranchPrompt = false
    @State private var newBranchName = ""

    private var orderedBranches: [String] {
        guard searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return filteredBranches
        }

        var prioritizedBranches = branches
        if selectedBranch != defaultBranch,
           let selectedIndex = prioritizedBranches.firstIndex(of: selectedBranch) {
            let selected = prioritizedBranches.remove(at: selectedIndex)
            prioritizedBranches.insert(selected, at: 0)
        }
        return prioritizedBranches
    }

    private var filteredBranches: [String] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return branches }
        return branches.filter { $0.lowercased().contains(query) }
    }

    private var isNewBranchNameValid: Bool {
        let trimmed = newBranchName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != "coderover/" else { return false }
        return true
    }

    private var suggestedCreateBranchName: String? {
        guard allowsSelectingCurrentBranch else { return nil }
        let candidate = normalizedCreatedBranchName(searchText)
        guard !candidate.isEmpty else { return nil }

        let normalizedCandidate = candidate.lowercased()
        let allBranchNames = Set(branches + [defaultBranch].compactMap { $0 })
        let alreadyExists = allBranchNames.contains { $0.lowercased() == normalizedCandidate }
        return alreadyExists ? nil : candidate
    }

    var body: some View {
        NavigationStack {
            List {
                if let suggestedCreateBranchName {
                    Section("Create Branch") {
                        Button {
                            onCreateBranch(suggestedCreateBranchName)
                            dismiss()
                        } label: {
                            Label("Create \(suggestedCreateBranchName)", systemImage: "plus")
                        }
                        .disabled(isLoading || isSwitching)
                    }
                }

                Section("Branches") {
                    if let defaultBranch {
                        branchRow(defaultBranch)
                    }

                    ForEach(orderedBranches, id: \.self) { branch in
                        branchRow(branch)
                    }
                }

                Section {
                    if allowsSelectingCurrentBranch {
                        Button("New Branch...") {
                            newBranchName = normalizedCreatedBranchName(searchText)
                            isShowingCreateBranchPrompt = true
                        }
                        .disabled(isLoading || isSwitching)
                    }

                    Button(isLoading ? "Reloading..." : "Reload branch list") {
                        onRefresh()
                    }
                    .disabled(isLoading || isSwitching)
                }
            }
            .searchable(text: $searchText, prompt: "Search branches")
            .navigationTitle(navigationTitle)
            .navigationBarTitleDisplayMode(.inline)
        }
        .alert("New Branch", isPresented: $isShowingCreateBranchPrompt) {
            TextField("coderover/feature-name", text: $newBranchName)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("Cancel", role: .cancel) {}
            Button("Create") {
                onCreateBranch(normalizedCreatedBranchName(newBranchName))
                dismiss()
            }
            .disabled(!isNewBranchNameValid)
        } message: {
            Text("Create a new local branch and switch this thread to it.")
        }
    }

    @ViewBuilder
    private func branchRow(_ branch: String) -> some View {
        let disabled = isLoading
            || isSwitching
            || (!allowsSelectingCurrentBranch && branch == currentBranch)
            || (gitBranchesCheckedOutElsewhere.contains(branch) && gitWorktreePathsByBranch[branch] == nil)

        Button {
            onSelect(branch)
            dismiss()
        } label: {
            HStack(spacing: 10) {
                if selectedBranch == branch {
                    Label(branchLabel(branch), systemImage: "checkmark")
                } else {
                    Text(branchLabel(branch))
                }

                Spacer(minLength: 8)

                if gitBranchesCheckedOutElsewhere.contains(branch) {
                    Text(gitWorktreePathsByBranch[branch] == nil ? "Open elsewhere" : "Worktree")
                        .font(AppFont.caption(weight: .medium))
                        .foregroundStyle(.secondary)
                }
            }
        }
        .disabled(disabled)
    }

    private func branchLabel(_ branch: String) -> String {
        if branch == defaultBranch {
            return "\(branch) (default)"
        }
        return branch
    }
}
