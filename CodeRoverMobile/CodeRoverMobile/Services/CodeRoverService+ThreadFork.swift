// FILE: CodeRoverService+ThreadFork.swift
// Purpose: Owns native thread fork requests and keeps conversation branching separate from handoff/worktree routing.
// Layer: Service
// Exports: CodeRoverService thread fork APIs
// Depends on: Foundation, ConversationThread, JSONValue

import Foundation

extension CodeRoverService {
    func forkThreadIfReady(
        from sourceThreadId: String,
        target: CodeRoverThreadForkTarget
    ) async throws -> ConversationThread {
        guard isConnected else {
            throw CodeRoverServiceError.invalidInput("Connect to runtime first.")
        }
        guard isInitialized else {
            throw CodeRoverServiceError.invalidInput("Runtime is still initializing. Wait a moment and retry.")
        }

        return try await forkThread(from: sourceThreadId, target: target)
    }

    @discardableResult
    func forkThread(
        from sourceThreadId: String,
        target: CodeRoverThreadForkTarget
    ) async throws -> ConversationThread {
        let normalizedSourceThreadId = normalizedInterruptIdentifier(sourceThreadId) ?? sourceThreadId
        guard !normalizedSourceThreadId.isEmpty else {
            throw CodeRoverServiceError.invalidInput("A source thread id is required.")
        }

        guard let sourceThread = thread(for: normalizedSourceThreadId) else {
            throw CodeRoverServiceError.invalidInput("Thread not found.")
        }

        let resolvedProjectPath = resolvedForkProjectPath(for: target, sourceThread: sourceThread)
        do {
            let response = try await sendRequestWithApprovalPolicyFallback(
                method: "thread/fork",
                baseParams: ["threadId": .string(normalizedSourceThreadId)],
                context: "minimal"
            )

            guard let resultObject = response.result?.objectValue,
                  let threadValue = resultObject["thread"],
                  var decodedThread = decodeModel(ConversationThread.self, from: threadValue) else {
                throw CodeRoverServiceError.invalidResponse("thread/fork response missing thread")
            }

            let normalizedProjectPath = ConversationThreadStartProjectBinding.normalizedProjectPath(resolvedProjectPath)
            decodedThread.syncState = .live
            if let normalizedProjectPath {
                decodedThread.cwd = normalizedProjectPath
            } else if decodedThread.normalizedProjectPath == nil {
                decodedThread.cwd = ConversationThreadStartProjectBinding.normalizedProjectPath(
                    resultObject["cwd"]?.stringValue
                )
            }
            if decodedThread.model == nil {
                decodedThread.model = sourceThread.model
            }
            if decodedThread.modelProvider == nil {
                decodedThread.modelProvider = sourceThread.modelProvider
            }

            upsertThread(decodedThread, treatAsServerState: true)
            if let normalizedProjectPath {
                beginAuthoritativeProjectPathTransition(
                    threadId: decodedThread.id,
                    projectPath: normalizedProjectPath
                )
                if ConversationThread.projectIconSystemName(for: normalizedProjectPath) == "arrow.triangle.branch" {
                    rememberAssociatedManagedWorktreePath(normalizedProjectPath, for: decodedThread.id)
                }
            }

            let hydratedThread = try await ensureThreadResumed(
                threadId: decodedThread.id,
                force: true,
                preferredProjectPath: normalizedProjectPath,
                modelIdentifierOverride: sourceThread.model
            )

            let forkedThread = hydratedThread ?? thread(for: decodedThread.id) ?? decodedThread
            activeThreadId = forkedThread.id
            markThreadAsViewed(forkedThread.id)
            requestImmediateSync(threadId: forkedThread.id)
            return forkedThread
        } catch {
            if consumeUnsupportedThreadFork(error) {
                throw CodeRoverServiceError.invalidInput(
                    "This Mac bridge does not support native thread forks yet. Update CodeRover on your Mac and retry."
                )
            }
            throw error
        }
    }
}

private extension CodeRoverService {
    func resolvedForkProjectPath(
        for target: CodeRoverThreadForkTarget,
        sourceThread: ConversationThread
    ) -> String? {
        switch target {
        case .currentProject:
            return sourceThread.gitWorkingDirectory
        case .projectPath(let rawPath):
            return ConversationThreadStartProjectBinding.normalizedProjectPath(rawPath)
        }
    }

    func consumeUnsupportedThreadFork(_ error: Error) -> Bool {
        guard let serviceError = error as? CodeRoverServiceError,
              case .rpcError(let rpcError) = serviceError else {
            return false
        }

        let message = rpcError.message.lowercased()
        return rpcError.code == -32601
            || message.contains("unsupported request method")
            || message.contains("thread/fork")
            || message.contains("method not found")
    }
}
