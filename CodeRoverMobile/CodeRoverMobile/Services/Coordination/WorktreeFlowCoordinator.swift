// FILE: WorktreeFlowCoordinator.swift
// Purpose: Centralizes Local/Worktree chat start, handoff, and fork flows behind one domain coordinator.
// Layer: Service Coordination
// Exports: WorktreeFlowCoordinator, WorktreeFlowHandoffMove, WorktreeFlowHandoffOutcome
// Depends on: Foundation, CodeRoverService, GitActionsService

import Foundation

struct WorktreeFlowHandoffMove: Sendable {
    let thread: ConversationThread
    let projectPath: String
    let transferredChanges: Bool
    let createdManagedWorktree: Bool
}

enum WorktreeFlowHandoffOutcome: Sendable {
    case moved(WorktreeFlowHandoffMove)
    case missingAssociatedWorktree
}

enum WorktreeFlowCoordinator {
    static func startNewLocalChat(
        preferredProjectPath: String? = nil,
        coderover: CodeRoverService
    ) async throws -> ConversationThread {
        try await coderover.startThreadIfReady(preferredProjectPath: preferredProjectPath)
    }

    static func startNewWorktreeChat(
        preferredProjectPath: String,
        coderover: CodeRoverService
    ) async throws -> ConversationThread {
        let normalizedPreferredProjectPath = try requiredProjectPath(
            preferredProjectPath,
            message: "A valid local project path is required."
        )
        let gitService = GitActionsService(coderover: coderover, workingDirectory: normalizedPreferredProjectPath)
        let branches = try await gitService.branchesWithStatus()
        let baseBranch = branches.defaultBranch?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !baseBranch.isEmpty else {
            throw WorktreeFlowError("Could not determine a base branch for the new worktree chat.")
        }

        let result = try await gitService.createManagedWorktree(
            baseBranch: baseBranch,
            changeTransfer: .none
        )
        do {
            return try await coderover.startThreadIfReady(preferredProjectPath: result.worktreePath)
        } catch {
            if !result.alreadyExisted {
                let cleanupService = GitActionsService(coderover: coderover, workingDirectory: result.worktreePath)
                try? await cleanupService.removeManagedWorktree(branch: nil)
            }
            throw error
        }
    }

    static func handoffThreadToWorktree(
        threadID: String,
        sourceProjectPath: String?,
        associatedWorktreePath: String?,
        baseBranchForNewWorktree: String? = nil,
        coderover: CodeRoverService
    ) async throws -> WorktreeFlowHandoffOutcome {
        let normalizedSourceProjectPath = try requiredProjectPath(
            sourceProjectPath,
            message: "The current handoff source is not available on this Mac."
        )

        if let associatedWorktreePath,
           !associatedWorktreePath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let movedThread = try await coderover.moveThreadToProjectPath(
                threadId: threadID,
                projectPath: associatedWorktreePath
            )
            return .moved(
                WorktreeFlowHandoffMove(
                    thread: movedThread,
                    projectPath: associatedWorktreePath,
                    transferredChanges: false,
                    createdManagedWorktree: false
                )
            )
        }

        let baseBranch = baseBranchForNewWorktree?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !baseBranch.isEmpty else {
            throw WorktreeFlowError("A base branch is required to create the managed worktree.")
        }

        let gitService = GitActionsService(coderover: coderover, workingDirectory: normalizedSourceProjectPath)
        let result = try await gitService.createManagedWorktree(
            baseBranch: baseBranch,
            changeTransfer: .move
        )
        let movedThread = try await coderover.moveThreadToProjectPath(
            threadId: threadID,
            projectPath: result.worktreePath
        )
        return .moved(
            WorktreeFlowHandoffMove(
                thread: movedThread,
                projectPath: result.worktreePath,
                transferredChanges: result.transferredChanges,
                createdManagedWorktree: !result.alreadyExisted
            )
        )
    }

    static func handoffThreadToLocal(
        thread: ConversationThread,
        coderover: CodeRoverService
    ) async throws -> WorktreeFlowHandoffMove {
        let sourceProjectPath = try requiredProjectPath(
            thread.gitWorkingDirectory,
            message: "The current handoff source is not available on this Mac."
        )

        let gitService = GitActionsService(coderover: coderover, workingDirectory: sourceProjectPath)
        let branches = try await gitService.branchesWithStatus()
        guard let normalizedLocalCheckoutPath = ConversationThreadStartProjectBinding.normalizedProjectPath(
            branches.localCheckoutPath
        ) else {
            throw WorktreeFlowError("Could not resolve the paired Local checkout for this worktree.")
        }

        let transferResult = try await gitService.transferManagedHandoff(
            targetProjectPath: normalizedLocalCheckoutPath
        )
        let movedThread = try await coderover.moveThreadToProjectPath(
            threadId: thread.id,
            projectPath: normalizedLocalCheckoutPath
        )
        return WorktreeFlowHandoffMove(
            thread: movedThread,
            projectPath: normalizedLocalCheckoutPath,
            transferredChanges: transferResult.transferredChanges,
            createdManagedWorktree: false
        )
    }

    static func forkThreadToLocal(
        sourceThread: ConversationThread,
        localCheckoutPath: String?,
        coderover: CodeRoverService
    ) async throws -> ConversationThread {
        guard let targetProjectPath = localForkProjectPath(
            for: sourceThread,
            localCheckoutPath: localCheckoutPath
        ) else {
            throw WorktreeFlowError("Could not resolve the local project path for this thread.")
        }

        return try await coderover.forkThreadIfReady(
            from: sourceThread.id,
            target: .projectPath(targetProjectPath)
        )
    }

    static func forkThreadToWorktree(
        sourceThreadId: String,
        sourceProjectPath: String?,
        baseBranch: String,
        coderover: CodeRoverService
    ) async throws -> ConversationThread {
        let normalizedSourceProjectPath = try requiredProjectPath(
            sourceProjectPath,
            message: "A valid local project path is required."
        )
        let trimmedBaseBranch = baseBranch.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedBaseBranch.isEmpty else {
            throw WorktreeFlowError("A base branch is required to create the managed worktree.")
        }

        let gitService = GitActionsService(coderover: coderover, workingDirectory: normalizedSourceProjectPath)
        let result = try await gitService.createManagedWorktree(
            baseBranch: trimmedBaseBranch,
            changeTransfer: .none
        )

        do {
            return try await coderover.forkThreadIfReady(
                from: sourceThreadId,
                target: .projectPath(result.worktreePath)
            )
        } catch {
            if !result.alreadyExisted {
                let cleanupService = GitActionsService(coderover: coderover, workingDirectory: result.worktreePath)
                try? await cleanupService.removeManagedWorktree(branch: nil)
            }
            throw error
        }
    }

    static func liveThreadForCheckedOutElsewhereBranch(
        projectPath: String,
        coderover: CodeRoverService,
        currentThread: ConversationThread
    ) -> ConversationThread? {
        guard let normalizedProjectPath = ConversationThreadStartProjectBinding.normalizedProjectPath(projectPath) else {
            return nil
        }

        let resolvedProjectPath = canonicalProjectPath(normalizedProjectPath) ?? normalizedProjectPath
        let currentComparablePath = comparableProjectPath(currentThread.normalizedProjectPath)
        guard currentComparablePath != resolvedProjectPath else {
            return nil
        }

        return matchingLiveThread(
            in: coderover.threads,
            projectPath: resolvedProjectPath,
            sort: coderover.sortThreads
        )
    }

    static func localForkProjectPath(
        for thread: ConversationThread,
        localCheckoutPath: String?
    ) -> String? {
        if !thread.isManagedWorktreeProject {
            return normalizedForkProjectPath(thread.normalizedProjectPath)
        }

        return normalizedForkProjectPath(localCheckoutPath)
    }
}

private struct WorktreeFlowError: LocalizedError {
    let message: String

    init(_ message: String) {
        self.message = message
    }

    var errorDescription: String? {
        message
    }
}

private func requiredProjectPath(_ value: String?, message: String) throws -> String {
    guard let normalizedValue = ConversationThreadStartProjectBinding.normalizedProjectPath(value) else {
        throw WorktreeFlowError(message)
    }
    return normalizedValue
}

private extension WorktreeFlowCoordinator {
    static func canonicalProjectPath(_ rawPath: String) -> String? {
        guard let normalizedPath = ConversationThreadStartProjectBinding.normalizedProjectPath(rawPath) else {
            return nil
        }

        return URL(fileURLWithPath: normalizedPath)
            .resolvingSymlinksInPath()
            .standardizedFileURL
            .path
    }

    static func comparableProjectPath(_ rawPath: String?) -> String? {
        guard let rawPath else {
            return nil
        }

        return canonicalProjectPath(rawPath) ?? ConversationThreadStartProjectBinding.normalizedProjectPath(rawPath)
    }

    static func matchingLiveThread(
        in threads: [ConversationThread],
        projectPath: String,
        sort: ([ConversationThread]) -> [ConversationThread]
    ) -> ConversationThread? {
        let matchingLiveThreads = threads.filter { thread in
            thread.syncState == .live
                && comparableProjectPath(thread.normalizedProjectPath) == projectPath
        }

        return sort(matchingLiveThreads).first
    }

    static func normalizedForkProjectPath(_ rawPath: String?) -> String? {
        guard let rawPath else {
            return nil
        }

        let trimmedPath = rawPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedPath.isEmpty else {
            return nil
        }

        return trimmedPath
    }
}
