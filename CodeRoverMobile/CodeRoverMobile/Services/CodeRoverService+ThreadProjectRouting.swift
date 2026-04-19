// FILE: CodeRoverService+ThreadProjectRouting.swift
// Purpose: Keeps thread-to-project routing helpers separate from broader turn lifecycle code.
// Layer: Service Extension
// Exports: CodeRoverService thread project routing helpers

import Foundation

extension CodeRoverService {
    func startThreadIfReady(preferredProjectPath: String? = nil) async throws -> ConversationThread {
        guard isConnected else {
            throw CodeRoverServiceError.invalidInput("Connect to runtime first.")
        }
        guard isInitialized else {
            throw CodeRoverServiceError.invalidInput("Runtime is still initializing. Wait a moment and retry.")
        }

        return try await startThread(preferredProjectPath: preferredProjectPath)
    }

    @discardableResult
    func moveThreadToProjectPath(threadId: String, projectPath: String) async throws -> ConversationThread {
        let normalizedThreadId = normalizedInterruptIdentifier(threadId) ?? threadId
        guard let normalizedProjectPath = ConversationThreadStartProjectBinding.normalizedProjectPath(projectPath) else {
            throw CodeRoverServiceError.invalidInput("A valid project path is required.")
        }
        guard var currentThread = thread(for: normalizedThreadId) else {
            throw CodeRoverServiceError.invalidInput("Thread not found.")
        }

        let previousThread = currentThread
        let previousAuthoritativePath = authoritativeProjectPathByThreadID[normalizedThreadId]
        let previousAssociatedManagedWorktreePath = associatedManagedWorktreePath(for: normalizedThreadId)
        let wasResumed = resumedThreadIDs.contains(normalizedThreadId)

        beginAuthoritativeProjectPathTransition(threadId: normalizedThreadId, projectPath: normalizedProjectPath)
        if ConversationThread.projectIconSystemName(for: normalizedProjectPath) == "arrow.triangle.branch" {
            rememberAssociatedManagedWorktreePath(normalizedProjectPath, for: normalizedThreadId)
        }

        currentThread.cwd = normalizedProjectPath
        currentThread.updatedAt = Date()
        upsertThread(currentThread)
        activeThreadId = normalizedThreadId
        markThreadAsViewed(normalizedThreadId)
        rememberRepoRoot(normalizedProjectPath, forWorkingDirectory: normalizedProjectPath)

        resumedThreadIDs.remove(normalizedThreadId)
        do {
            let resumedThread = try await ensureThreadResumed(
                threadId: normalizedThreadId,
                force: true,
                preferredProjectPath: normalizedProjectPath
            )
            confirmAuthoritativeProjectPathIfNeeded(
                threadId: normalizedThreadId,
                projectPath: resumedThread?.normalizedProjectPath
            )
        } catch {
            if shouldAllowProjectRebindWithoutResume(error) {
                requestImmediateActiveThreadSync(threadId: normalizedThreadId)
                return thread(for: normalizedThreadId) ?? currentThread
            }

            upsertThread(previousThread)
            if let previousAuthoritativePath {
                authoritativeProjectPathByThreadID[normalizedThreadId] = previousAuthoritativePath
            } else {
                authoritativeProjectPathByThreadID.removeValue(forKey: normalizedThreadId)
            }
            rememberAssociatedManagedWorktreePath(previousAssociatedManagedWorktreePath, for: normalizedThreadId)
            if wasResumed {
                resumedThreadIDs.insert(normalizedThreadId)
            } else {
                resumedThreadIDs.remove(normalizedThreadId)
            }
            requestImmediateActiveThreadSync(threadId: normalizedThreadId)
            throw error
        }

        requestImmediateActiveThreadSync(threadId: normalizedThreadId)
        return thread(for: normalizedThreadId) ?? currentThread
    }

    func associatedManagedWorktreePath(for threadId: String?) -> String? {
        guard let normalizedThreadId = normalizedInterruptIdentifier(threadId) ?? normalizedThreadIdValue(threadId) else {
            return nil
        }

        return normalizedStoredProjectPath(associatedManagedWorktreePathByThreadID[normalizedThreadId])
    }

    func rememberAssociatedManagedWorktreePath(_ projectPath: String?, for threadId: String) {
        guard let normalizedThreadId = normalizedInterruptIdentifier(threadId) ?? normalizedThreadIdValue(threadId) else {
            return
        }

        let normalizedProjectPath = normalizedStoredProjectPath(projectPath)
        if associatedManagedWorktreePathByThreadID[normalizedThreadId] == normalizedProjectPath {
            return
        }

        if let normalizedProjectPath {
            associatedManagedWorktreePathByThreadID[normalizedThreadId] = normalizedProjectPath
        } else {
            associatedManagedWorktreePathByThreadID.removeValue(forKey: normalizedThreadId)
        }
        persistAssociatedManagedWorktreePaths()
    }

    func currentAuthoritativeProjectPath(for threadId: String?) -> String? {
        guard let normalizedThreadId = normalizedInterruptIdentifier(threadId) ?? normalizedThreadIdValue(threadId) else {
            return nil
        }

        return normalizedStoredProjectPath(authoritativeProjectPathByThreadID[normalizedThreadId])
    }

    func beginAuthoritativeProjectPathTransition(threadId: String, projectPath: String) {
        guard let normalizedThreadId = normalizedInterruptIdentifier(threadId) ?? normalizedThreadIdValue(threadId),
              let normalizedProjectPath = normalizedStoredProjectPath(projectPath) else {
            return
        }

        authoritativeProjectPathByThreadID[normalizedThreadId] = normalizedProjectPath
    }

    func clearAuthoritativeProjectPathTransition(threadId: String) {
        guard let normalizedThreadId = normalizedInterruptIdentifier(threadId) ?? normalizedThreadIdValue(threadId) else {
            return
        }

        authoritativeProjectPathByThreadID.removeValue(forKey: normalizedThreadId)
    }

    func applyingAuthoritativeProjectPath(
        to thread: ConversationThread,
        treatAsServerState: Bool
    ) -> ConversationThread {
        guard let authoritativePath = currentAuthoritativeProjectPath(for: thread.id) else {
            return thread
        }

        if thread.normalizedProjectPath == authoritativePath {
            if treatAsServerState, let normalizedThreadId = normalizedThreadIdValue(thread.id) {
                authoritativeProjectPathByThreadID.removeValue(forKey: normalizedThreadId)
            }
            return thread
        }

        var protectedThread = thread
        protectedThread.cwd = authoritativePath
        return protectedThread
    }

    func requestImmediateActiveThreadSync(threadId: String? = nil) {
        requestImmediateSync(threadId: threadId)
    }

    func shouldAllowProjectRebindWithoutResume(_ error: Error) -> Bool {
        let message: String
        if let serviceError = error as? CodeRoverServiceError,
           case .rpcError(let rpcError) = serviceError {
            message = rpcError.message.lowercased()
        } else {
            message = error.localizedDescription.lowercased()
        }

        return message.contains("no rollout found")
            || message.contains("no rollout file found")
    }
}

private extension CodeRoverService {
    func confirmAuthoritativeProjectPathIfNeeded(threadId: String, projectPath: String?) {
        guard let normalizedThreadId = normalizedInterruptIdentifier(threadId) ?? normalizedThreadIdValue(threadId),
              let authoritativeProjectPath = currentAuthoritativeProjectPath(for: normalizedThreadId),
              let normalizedProjectPath = normalizedStoredProjectPath(projectPath),
              normalizedProjectPath == authoritativeProjectPath else {
            return
        }

        authoritativeProjectPathByThreadID.removeValue(forKey: normalizedThreadId)
    }

    func persistAssociatedManagedWorktreePaths() {
        guard let encoded = try? encoder.encode(associatedManagedWorktreePathByThreadID) else {
            return
        }

        defaults.set(encoded, forKey: Self.associatedManagedWorktreePathsDefaultsKey)
    }

    func normalizedThreadIdValue(_ value: String?) -> String? {
        guard let value else {
            return nil
        }

        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    func normalizedStoredProjectPath(_ value: String?) -> String? {
        ConversationThreadStartProjectBinding.normalizedProjectPath(value)
    }
}
