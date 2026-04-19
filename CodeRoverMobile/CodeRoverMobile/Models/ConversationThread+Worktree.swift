// FILE: ConversationThread+Worktree.swift
// Purpose: Shared worktree/path helpers used by thread routing flows.
// Layer: Model Extension
// Exports: ConversationThread worktree helpers
// Depends on: Foundation

import Foundation

extension ConversationThread {
    var isManagedWorktreeProject: Bool {
        Self.projectIconSystemName(for: normalizedProjectPath) == "arrow.triangle.branch"
    }

    static func projectIconSystemName(for normalizedProjectPath: String?) -> String {
        guard let normalizedProjectPath else {
            return "cloud"
        }

        return managedWorktreeToken(for: normalizedProjectPath) == nil ? "laptopcomputer" : "arrow.triangle.branch"
    }

    private static func managedWorktreeToken(for normalizedProjectPath: String) -> String? {
        let components = URL(fileURLWithPath: normalizedProjectPath).standardized.pathComponents
        guard let worktreesIndex = components.firstIndex(of: "worktrees"),
              worktreesIndex > 0,
              components[worktreesIndex - 1] == ".coderover" else {
            return nil
        }

        let tokenIndex = components.index(after: worktreesIndex)
        guard components.indices.contains(tokenIndex) else {
            return nil
        }

        let token = components[tokenIndex].trimmingCharacters(in: .whitespacesAndNewlines)
        return token.isEmpty ? nil : token
    }
}
