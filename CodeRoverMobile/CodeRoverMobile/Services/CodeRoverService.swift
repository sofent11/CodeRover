// FILE: CodeRoverService.swift
// Purpose: Central state container for Codex app-server communication.
// Layer: Service
// Exports: CodeRoverService, CodeRoverApprovalRequest
// Depends on: Foundation, Observation, RPCMessage, ConversationThread, ChatMessage, UserNotifications

import Foundation
import Network
import Observation
import UIKit
import UserNotifications
import Darwin

struct CodeRoverApprovalRequest: Identifiable, Sendable {
    let id: String
    let requestID: JSONValue
    let method: String
    let command: String?
    let reason: String?
    let threadId: String?
    let turnId: String?
    let params: JSONValue?
}

struct CodeRoverRecentActivityLine {
    let line: String
    let timestamp: Date
}

struct CodeRoverRunningThreadWatch: Equatable, Sendable {
    let threadId: String
    let expiresAt: Date
}

struct CodeRoverSecureControlWaiter {
    let id: UUID
    let continuation: CheckedContinuation<String, Error>
}

struct CodeRoverPendingRequestContext {
    let method: String
    let threadId: String?
    let createdAt: Date
}


enum ConversationThreadRunBadgeState: Equatable, Sendable {
    case running
    case ready
    case failed
}

enum CodeRoverRunCompletionResult: String, Equatable, Sendable {
    case completed
    case failed
}

enum CodeRoverNotificationPayloadKeys {
    static let source = "source"
    static let threadId = "threadId"
    static let turnId = "turnId"
    static let result = "result"
}

// Tracks the real terminal outcome of a run, including user interruption.
enum CodeRoverTurnTerminalState: String, Equatable, Sendable {
    case completed
    case failed
    case stopped
}

enum CodeRoverConnectionRecoveryState: Equatable, Sendable {
    case idle
    case retrying(attempt: Int, message: String)
}

enum CodeRoverConnectionPhase: Equatable, Sendable {
    case offline
    case connecting
    case loadingChats
    case syncing
    case connected
}

enum CodeRoverReviewTarget {
    case uncommittedChanges
    case baseBranch
}

struct CodeRoverRateLimitWindow: Equatable, Sendable {
    let usedPercent: Int
    let windowDurationMins: Int?
    let resetsAt: Date?

    var clampedUsedPercent: Int {
        min(max(usedPercent, 0), 100)
    }

    var remainingPercent: Int {
        max(0, 100 - clampedUsedPercent)
    }
}

struct CodeRoverRateLimitDisplayRow: Identifiable, Equatable, Sendable {
    let id: String
    let label: String
    let window: CodeRoverRateLimitWindow
}

struct CodeRoverRateLimitBucket: Identifiable, Equatable, Sendable {
    let limitId: String
    let limitName: String?
    let primary: CodeRoverRateLimitWindow?
    let secondary: CodeRoverRateLimitWindow?

    var id: String { limitId }

    var primaryOrSecondary: CodeRoverRateLimitWindow? {
        primary ?? secondary
    }

    var displayRows: [CodeRoverRateLimitDisplayRow] {
        var rows: [CodeRoverRateLimitDisplayRow] = []

        if let primary {
            rows.append(
                CodeRoverRateLimitDisplayRow(
                    id: "\(limitId)-primary",
                    label: Self.label(for: primary, fallback: limitName ?? limitId),
                    window: primary
                )
            )
        }

        if let secondary {
            rows.append(
                CodeRoverRateLimitDisplayRow(
                    id: "\(limitId)-secondary",
                    label: Self.label(for: secondary, fallback: limitName ?? limitId),
                    window: secondary
                )
            )
        }

        return rows
    }

    var sortDurationMins: Int {
        primaryOrSecondary?.windowDurationMins ?? Int.max
    }

    var displayLabel: String {
        if let durationLabel = Self.durationLabel(minutes: primaryOrSecondary?.windowDurationMins) {
            return durationLabel
        }

        let trimmedName = limitName?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let trimmedName, !trimmedName.isEmpty {
            return trimmedName
        }

        return limitId
    }

    private static func label(for window: CodeRoverRateLimitWindow, fallback: String) -> String {
        durationLabel(minutes: window.windowDurationMins) ?? fallback
    }

    private static func durationLabel(minutes: Int?) -> String? {
        guard let minutes, minutes > 0 else { return nil }

        let weekMinutes = 7 * 24 * 60
        let dayMinutes = 24 * 60

        if minutes % weekMinutes == 0 {
            return minutes == weekMinutes ? "Weekly" : "\(minutes / weekMinutes)w"
        }

        if minutes % dayMinutes == 0 {
            return "\(minutes / dayMinutes)d"
        }

        if minutes % 60 == 0 {
            return "\(minutes / 60)h"
        }

        return "\(minutes)m"
    }
}

@MainActor
@Observable
final class CodeRoverService {
    // --- Public state ---------------------------------------------------------

    var threads: [ConversationThread] = []
    var isConnected = false
    var isConnecting = false
    var isInitialized = false
    var isLoadingThreads = false
    // Tracks the non-blocking bootstrap that hydrates chats/models after the socket is ready.
    var isBootstrappingConnectionSync = false
    var currentOutput = ""
    var activeThreadId: String? {
        didSet {
            guard oldValue != activeThreadId else { return }
            let previousProviderID = runtimeProviderID(
                for: threads.first(where: { $0.id == oldValue })?.provider
            )
            let nextProviderID = runtimeProviderID(
                for: threads.first(where: { $0.id == activeThreadId })?.provider
            )
            let shouldRefreshModels = isConnected
                && previousProviderID != nextProviderID
                && loadedModelsProviderID != nextProviderID
            syncRuntimeSelectionContext(for: nextProviderID, refreshModels: shouldRefreshModels)
        }
    }
    var activeTurnId: String?
    var activeTurnIdByThread: [String: String] = [:]

    var compactingThreadIDs: Set<String> = []
    var runningThreadIDs: Set<String> = []
    // Protects active runs that are real but have not yielded a stable turnId yet.
    var protectedRunningFallbackThreadIDs: Set<String> = []
    var readyThreadIDs: Set<String> = []
    var failedThreadIDs: Set<String> = []
    // Keeps the latest terminal outcome per thread so UI can react to real run completion.
    var latestTurnTerminalStateByThread: [String: CodeRoverTurnTerminalState] = [:]
    // Preserves terminal outcome per turn so completed/stopped blocks stay distinguishable.
    var terminalStateByTurnID: [String: CodeRoverTurnTerminalState] = [:]
    var pendingApproval: CodeRoverApprovalRequest?
    var lastRawMessage: String?
    var lastErrorMessage: String?
    var connectionRecoveryState: CodeRoverConnectionRecoveryState = .idle
    // Per-thread queued drafts for client-side turn queueing while a run is active.
    var queuedTurnDraftsByThread: [String: [QueuedTurnDraft]] = [:]
    // Per-thread queue pause state (active by default when absent).
    var queuePauseStateByThread: [String: QueuePauseState] = [:]
    var messagesByThread: [String: [ChatMessage]] = [:]
    // Monotonic per-thread revision so views can react to message mutations without hashing full transcripts.
    var messageRevisionByThread: [String: Int] = [:]
    var syncRealtimeEnabled = true
    var availableProviders: [RuntimeProvider] = [.codexDefault]
    var selectedProviderID: String = "codex" {
        didSet {
            guard oldValue != selectedProviderID else { return }
            defaults.set(selectedProviderID, forKey: Self.selectedProviderDefaultsKey)
        }
    }
    var availableModels: [ModelOption] = []
    var selectedModelId: String? {
        didSet {
            guard oldValue != selectedModelId else { return }
            persistRuntimeSelections()
        }
    }
    var selectedReasoningEffort: String? {
        didSet {
            guard oldValue != selectedReasoningEffort else { return }
            persistRuntimeSelections()
        }
    }
    var selectedAccessMode: AccessMode = .onRequest {
        didSet {
            guard oldValue != selectedAccessMode else { return }
            persistRuntimeSelections()
        }
    }
    var isLoadingModels = false
    var loadingModelsProviderID: String?
    var loadedModelsProviderID: String?
    var modelsErrorMessage: String?
    var notificationAuthorizationStatus: UNAuthorizationStatus = .notDetermined
    var pendingNotificationOpenThreadID: String?
    var supportsStructuredSkillInput = true
    // Runtime compatibility flag for `turn/start.collaborationMode` plan turns.
    var supportsTurnCollaborationMode = false
    var rateLimitBuckets: [CodeRoverRateLimitBucket] = []
    var isLoadingRateLimits = false
    var rateLimitsErrorMessage: String?
    // User-initiated disconnects can request that the shell returns to the home screen.
    var shouldReturnHomeAfterDisconnect = false

    func persistRuntimeSelections(providerID: String? = nil) {
        let normalizedProvider: String = {
            let explicitProvider = providerID?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if let explicitProvider, ["codex", "claude", "gemini"].contains(explicitProvider) {
                return explicitProvider
            }
            if let activeThreadId,
               let threadProvider = threads.first(where: { $0.id == activeThreadId })?.provider
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                    .lowercased(),
               ["codex", "claude", "gemini"].contains(threadProvider) {
                return threadProvider
            }
            let selectedProvider = selectedProviderID.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            return ["codex", "claude", "gemini"].contains(selectedProvider) ? selectedProvider : "codex"
        }()

        defaults.set(selectedProviderID, forKey: Self.selectedProviderDefaultsKey)

        let modelDefaultsKey = "runtime.\(normalizedProvider).selectedModelId"
        if let selectedModelId, !selectedModelId.isEmpty {
            runtimeModelIdByProvider[normalizedProvider] = selectedModelId
            defaults.set(selectedModelId, forKey: modelDefaultsKey)
        } else {
            runtimeModelIdByProvider.removeValue(forKey: normalizedProvider)
            defaults.removeObject(forKey: modelDefaultsKey)
        }

        let reasoningDefaultsKey = "runtime.\(normalizedProvider).selectedReasoningEffort"
        if let selectedReasoningEffort, !selectedReasoningEffort.isEmpty {
            runtimeReasoningEffortByProvider[normalizedProvider] = selectedReasoningEffort
            defaults.set(selectedReasoningEffort, forKey: reasoningDefaultsKey)
        } else {
            runtimeReasoningEffortByProvider.removeValue(forKey: normalizedProvider)
            defaults.removeObject(forKey: reasoningDefaultsKey)
        }

        runtimeAccessModeByProvider[normalizedProvider] = selectedAccessMode
        defaults.set(selectedAccessMode.rawValue, forKey: "runtime.\(normalizedProvider).selectedAccessMode")
    }

    // Pairing persistence
    var savedBridgePairings: [CodeRoverBridgePairingRecord] = []
    var activePairingMacDeviceId: String?
    var pairedBridgeId: String?
    var pairedTransportCandidates: [CodeRoverTransportCandidate] = []
    var preferredTransportURL: String?
    var lastSuccessfulTransportURL: String?
    var pairedMacDeviceId: String?
    var pairedMacIdentityPublicKey: String?
    var secureProtocolVersion: Int = coderoverSecureProtocolVersion
    var lastAppliedBridgeOutboundSeq = 0
    var secureConnectionState: CodeRoverSecureConnectionState = .notPaired
    var secureMacFingerprint: String?

    // --- Internal wiring ------------------------------------------------------

    var webSocketConnection: NWConnection?
    let webSocketQueue = DispatchQueue(label: "CodeRoverMobile.WebSocket", qos: .userInitiated)
    var pendingRequests: [String: CheckedContinuation<RPCMessage, Error>] = [:]
    var pendingRequestTimeoutTasks: [String: Task<Void, Never>] = [:]
    var pendingRequestContexts: [String: CodeRoverPendingRequestContext] = [:]
    // Test hook: intercepts outbound RPC requests without requiring a live socket.
    @ObservationIgnored var requestTransportOverride: ((String, JSONValue?) async throws -> RPCMessage)?
    var streamingAssistantMessageByTurnID: [String: String] = [:]
    var streamingSystemMessageByItemID: [String: String] = [:]
    /// Rich metadata for command execution tool calls, keyed by itemId.
    var commandExecutionDetailsByItemID: [String: CommandExecutionDetails] = [:]
    // Debounces disk writes while streaming to keep UI responsive.
    var messagePersistenceDebounceTask: Task<Void, Never>?
    // Dedupes completion payloads when servers omit turn/item identifiers.
    var assistantCompletionFingerprintByThread: [String: (text: String, timestamp: Date)] = [:]
    // Dedupes concise activity feed lines per thread/turn to avoid visual spam.
    var recentActivityLineByThread: [String: CodeRoverRecentActivityLine] = [:]
    var contextWindowUsageByThread: [String: ContextWindowUsage] = [:]
    var threadIdByTurnID: [String: String] = [:]
    var hydratedThreadIDs: Set<String> = []
    var loadingThreadIDs: Set<String> = []
    var resumedThreadIDs: Set<String> = []
    var isAppInForeground = true
    var threadListSyncTask: Task<Void, Never>?
    var activeThreadSyncTask: Task<Void, Never>?
    var runningThreadWatchSyncTask: Task<Void, Never>?
    var postConnectSyncTask: Task<Void, Never>?
    var postConnectSyncToken: UUID?
    var connectedServerIdentity: String?
    var runningThreadWatchByID: [String: CodeRoverRunningThreadWatch] = [:]
    var backgroundTurnGraceTaskID: UIBackgroundTaskIdentifier = .invalid
    var hasConfiguredNotifications = false
    var runCompletionNotificationDedupedAt: [String: Date] = [:]
    var notificationCenterDelegateProxy: CodeRoverNotificationCenterDelegateProxy?
    var shouldAutoReconnectOnForeground = false
    var secureSession: CodeRoverSecureSession?
    var pendingHandshake: CodeRoverPendingHandshake?
    var phoneIdentityState: CodeRoverPhoneIdentityState
    var trustedMacRegistry: CodeRoverTrustedMacRegistry
    var pendingSecureControlContinuations: [String: [CodeRoverSecureControlWaiter]] = [:]
    var bufferedSecureControlMessages: [String: [String]] = [:]
    // Assistant-scoped patch ledger used by the revert-changes flow.
    var aiChangeSetsByID: [String: AIChangeSet] = [:]
    var aiChangeSetIDByTurnID: [String: String] = [:]
    var aiChangeSetIDByAssistantMessageID: [String: String] = [:]
    // Canonical repo roots keyed by observed working directories from bridge git/status responses.
    var repoRootByWorkingDirectory: [String: String] = [:]
    var knownRepoRoots: Set<String> = []

    let encoder: JSONEncoder
    let decoder: JSONDecoder
    let messagePersistence = MessagePersistence()
    let aiChangeSetPersistence = AIChangeSetPersistence()
    let defaults: UserDefaults
    let userNotificationCenter: CodeRoverUserNotificationCentering

    @ObservationIgnored var runtimeModelIdByProvider: [String: String] = [:]
    @ObservationIgnored var runtimeReasoningEffortByProvider: [String: String] = [:]
    @ObservationIgnored var runtimeAccessModeByProvider: [String: AccessMode] = [:]

    static let selectedProviderDefaultsKey = "runtime.selectedProviderId"
    static let locallyArchivedThreadIDsKey = "coderover.locallyArchivedThreadIDs"
    static let notificationsPromptedDefaultsKey = "coderover.notifications.prompted"

    init(
        encoder: JSONEncoder = JSONEncoder(),
        decoder: JSONDecoder = JSONDecoder(),
        defaults: UserDefaults = .standard,
        userNotificationCenter: CodeRoverUserNotificationCentering = UNUserNotificationCenter.current()
    ) {
        self.encoder = encoder
        self.decoder = decoder
        self.defaults = defaults
        self.userNotificationCenter = userNotificationCenter
        self.phoneIdentityState = coderoverPhoneIdentityStateFromSecureStore()
        self.trustedMacRegistry = coderoverTrustedMacRegistryFromSecureStore()
        let loadedMessages = messagePersistence.load().mapValues { messages in
            messages.map { message in
                var value = message
                // Streaming cannot survive app relaunch; clear stale flags loaded from disk.
                value.isStreaming = false
                return value
            }
        }
        MessageOrderCounter.seed(from: loadedMessages)
        self.messagesByThread = loadedMessages

        let loadedChangeSets = aiChangeSetPersistence.load()
        self.aiChangeSetsByID = loadedChangeSets.reduce(into: [:]) { partialResult, changeSet in
            partialResult[changeSet.id] = changeSet
        }
        self.aiChangeSetIDByTurnID = loadedChangeSets.reduce(into: [:]) { partialResult, changeSet in
            partialResult[changeSet.turnId] = changeSet.id
        }
        self.aiChangeSetIDByAssistantMessageID = loadedChangeSets.reduce(into: [:]) { partialResult, changeSet in
            if let assistantMessageId = changeSet.assistantMessageId {
                partialResult[assistantMessageId] = changeSet.id
            }
        }

        let savedProvider = defaults.string(forKey: Self.selectedProviderDefaultsKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        self.selectedProviderID = (savedProvider?.isEmpty == false) ? (savedProvider ?? "codex") : "codex"
        self.selectedModelId = nil
        self.selectedReasoningEffort = nil
        self.selectedAccessMode = .onRequest
        self.syncRuntimeSelectionContext()

        // Restore saved Mac pairings. Legacy single-pairing keys are migrated into the
        // new multi-pairing store the first time a newer client launches.
        let storedPairings = SecureStore.readCodable(
            [CodeRoverBridgePairingRecord].self,
            for: CodeRoverSecureKeys.pairingRecords
        ) ?? []
        let normalizedStoredPairings = Self.normalizedSavedBridgePairings(storedPairings)
        let storedActivePairingMacDeviceId = SecureStore.readString(
            for: CodeRoverSecureKeys.pairingActiveMacDeviceId
        )?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        var shouldPersistNormalizedPairings = normalizedStoredPairings.count != storedPairings.count

        if normalizedStoredPairings.isEmpty,
           let legacyPairing = Self.loadLegacySavedBridgePairingFromSecureStore() {
            self.savedBridgePairings = [legacyPairing]
            self.activePairingMacDeviceId = legacyPairing.macDeviceId
            shouldPersistNormalizedPairings = true
        } else {
            self.savedBridgePairings = normalizedStoredPairings
            self.activePairingMacDeviceId = storedActivePairingMacDeviceId
        }

        applyResolvedActiveSavedBridgePairing()

        if shouldPersistNormalizedPairings || activePairingMacDeviceId != storedActivePairingMacDeviceId {
            persistSavedBridgePairings()
        }
    }

    // Remembers whether we can offer reconnect without forcing a fresh QR scan.
    var hasSavedBridgePairing: Bool {
        normalizedBridgeId != nil && !normalizedTransportCandidates.isEmpty
    }

    var activeSavedBridgePairing: CodeRoverBridgePairingRecord? {
        guard let activePairingMacDeviceId else {
            return savedBridgePairings.first
        }
        return savedBridgePairings.first { $0.macDeviceId == activePairingMacDeviceId }
            ?? savedBridgePairings.first
    }

    var orderedSavedBridgePairings: [CodeRoverBridgePairingRecord] {
        savedBridgePairings.sorted { lhs, rhs in
            if lhs.macDeviceId == activePairingMacDeviceId {
                return true
            }
            if rhs.macDeviceId == activePairingMacDeviceId {
                return false
            }
            return lhs.lastPairedAt > rhs.lastPairedAt
        }
    }

    // Normalizes the persisted bridge id before reuse in reconnect flows.
    var normalizedBridgeId: String? {
        pairedBridgeId?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nilIfEmpty
    }

    var normalizedTransportCandidates: [CodeRoverTransportCandidate] {
        Self.normalizeTransportCandidates(pairedTransportCandidates)
    }

    var localIPv4AddressesProvider: () -> [String] = {
        CodeRoverService.currentLocalIPv4Addresses()
    }

    var orderedTransportCandidateURLs: [String] {
        orderedTransportCandidates.map(\.url)
    }

    var orderedTransportCandidates: [CodeRoverTransportCandidate] {
        orderedTransportCandidates(
            from: normalizedTransportCandidates,
            preferredTransportURL: preferredTransportURL,
            lastSuccessfulTransportURL: lastSuccessfulTransportURL
        )
    }

    func orderedTransportCandidates(
        from candidates: [CodeRoverTransportCandidate],
        preferredTransportURL: String? = nil,
        lastSuccessfulTransportURL: String? = nil
    ) -> [CodeRoverTransportCandidate] {
        let localIPv4Addresses = localIPv4AddressesProvider()
        let preferredTransportURL = preferredTransportURL?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nilIfEmpty
        let lastSuccessfulTransportURL = lastSuccessfulTransportURL?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nilIfEmpty

        let candidates = candidates
            .enumerated()
            .compactMap { index, candidate -> (index: Int, candidate: CodeRoverTransportCandidate)? in
                candidate.isUsableReconnectCandidate ? (index, candidate) : nil
            }
            .sorted { lhs, rhs in
                let lhsScore = lhs.candidate.reconnectScore(
                    localIPv4Addresses: localIPv4Addresses,
                    preferredTransportURL: preferredTransportURL,
                    lastSuccessfulTransportURL: lastSuccessfulTransportURL
                )
                let rhsScore = rhs.candidate.reconnectScore(
                    localIPv4Addresses: localIPv4Addresses,
                    preferredTransportURL: preferredTransportURL,
                    lastSuccessfulTransportURL: lastSuccessfulTransportURL
                )
                if lhsScore != rhsScore {
                    return lhsScore < rhsScore
                }
                return lhs.index < rhs.index
            }
            .map(\.candidate)
        guard !candidates.isEmpty else {
            return []
        }
        return candidates
    }

    var normalizedPairedMacDeviceId: String? {
        pairedMacDeviceId?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nilIfEmpty
    }

    var normalizedPairedMacIdentityPublicKey: String? {
        pairedMacIdentityPublicKey?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nilIfEmpty
    }

    // Separates transport readiness from post-connect hydration so the UI can explain delays honestly.
    var connectionPhase: CodeRoverConnectionPhase {
        if isConnecting {
            return .connecting
        }

        guard isConnected else {
            return .offline
        }

        if threads.isEmpty && (isBootstrappingConnectionSync || isLoadingThreads) {
            return .loadingChats
        }

        if isBootstrappingConnectionSync || isLoadingModels || isLoadingThreads {
            return .syncing
        }

        return .connected
    }
}

private extension String {
    var nilIfEmpty: String? {
        isEmpty ? nil : self
    }
}

private extension CodeRoverTransportCandidate {
    var isUsableReconnectCandidate: Bool {
        guard let url = URL(string: url),
              let host = url.host?.trimmingCharacters(in: .whitespacesAndNewlines),
              !host.isEmpty else {
            return false
        }

        if kind == "local_ipv4" {
            return !host.hasPrefix("169.254.")
        }

        return true
    }

    func reconnectScore(
        localIPv4Addresses: [String],
        preferredTransportURL: String?,
        lastSuccessfulTransportURL: String?
    ) -> (Int, Int, Int) {
        let host = URL(string: url)?.host?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let networkPriority = reconnectNetworkPriority(host: host, localIPv4Addresses: localIPv4Addresses)
        let rememberedPriority: Int
        if url == preferredTransportURL {
            rememberedPriority = 0
        } else if url == lastSuccessfulTransportURL {
            rememberedPriority = 1
        } else {
            rememberedPriority = 2
        }
        let kindPriority = reconnectKindPriority
        return (networkPriority, rememberedPriority, kindPriority)
    }

    private func reconnectNetworkPriority(host: String, localIPv4Addresses: [String]) -> Int {
        if let ipv4 = host.normalizedIPv4Address {
            if localIPv4Addresses.contains(where: { $0.isSameIPv4Subnet(as: ipv4) }) {
                return 0
            }
            if ipv4.isPublicIPv4Address {
                return 1
            }
            return 4
        }

        if kind == "tailnet_ipv4" || kind == "tailnet" || host.hasSuffix(".ts.net") {
            return 2
        }

        if kind == "local_hostname" || host.hasSuffix(".local") {
            return 3
        }

        return 1
    }

    private var reconnectKindPriority: Int {
        switch kind {
        case "local_ipv4":
            return 0
        case "tailnet_ipv4", "tailnet":
            return 1
        case "local_hostname":
            return 2
        default:
            return 3
        }
    }
}

private extension CodeRoverService {
    static func currentLocalIPv4Addresses() -> [String] {
        var addresses: [String] = []
        var interfacePointer: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&interfacePointer) == 0, let first = interfacePointer else {
            return []
        }
        defer { freeifaddrs(first) }

        for pointer in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let interface = pointer.pointee
            guard let addressPointer = interface.ifa_addr,
                  addressPointer.pointee.sa_family == UInt8(AF_INET) else {
                continue
            }

            let flags = Int32(interface.ifa_flags)
            if (flags & IFF_UP) == 0 || (flags & IFF_LOOPBACK) != 0 {
                continue
            }

            var hostBuffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            let result = getnameinfo(
                addressPointer,
                socklen_t(addressPointer.pointee.sa_len),
                &hostBuffer,
                socklen_t(hostBuffer.count),
                nil,
                0,
                NI_NUMERICHOST
            )
            guard result == 0 else {
                continue
            }

            let address = String(cString: hostBuffer)
            guard let normalized = address.normalizedIPv4Address,
                  !normalized.hasPrefix("127."),
                  !normalized.hasPrefix("169.254.") else {
                continue
            }
            addresses.append(normalized)
        }

        return Array(Set(addresses)).sorted()
    }
}

private extension String {
    var normalizedIPv4Address: String? {
        let components = split(separator: ".", omittingEmptySubsequences: false)
        guard components.count == 4 else { return nil }
        let octets = components.compactMap { Int($0) }
        guard octets.count == 4, octets.allSatisfy({ 0...255 ~= $0 }) else {
            return nil
        }
        return octets.map(String.init).joined(separator: ".")
    }

    func isSameIPv4Subnet(as other: String) -> Bool {
        guard let lhs = normalizedIPv4Address?.split(separator: "."),
              let rhs = other.normalizedIPv4Address?.split(separator: "."),
              lhs.count == 4,
              rhs.count == 4 else {
            return false
        }
        return lhs[0] == rhs[0] && lhs[1] == rhs[1] && lhs[2] == rhs[2]
    }

    var isPublicIPv4Address: Bool {
        guard let octets = normalizedIPv4Address?.split(separator: ".").compactMap({ Int($0) }),
              octets.count == 4 else {
            return false
        }
        let first = octets[0]
        let second = octets[1]
        if first == 10 || first == 127 || first == 0 {
            return false
        }
        if first == 169 && second == 254 {
            return false
        }
        if first == 172 && (16...31).contains(second) {
            return false
        }
        if first == 192 && second == 168 {
            return false
        }
        if first >= 224 {
            return false
        }
        return true
    }
}
