// FILE: CodeRoverService+Notifications.swift
// Purpose: Manages local notification permission, background run-completion alerts, and tap routing.
// Layer: Service
// Exports: CodeRoverService notification helpers
// Depends on: UserNotifications, CodeRoverService+Messages

import Foundation
import UserNotifications

private enum CodeRoverNotificationSource {
    static let runCompletion = "coderover.runCompletion"
}

protocol CodeRoverUserNotificationCentering: AnyObject {
    var delegate: UNUserNotificationCenterDelegate? { get set }
    func requestAuthorization(options: UNAuthorizationOptions) async throws -> Bool
    func add(_ request: UNNotificationRequest) async throws
    func authorizationStatus() async -> UNAuthorizationStatus
}

extension UNUserNotificationCenter: CodeRoverUserNotificationCentering {
    func authorizationStatus() async -> UNAuthorizationStatus {
        let settings = await notificationSettings()
        return settings.authorizationStatus
    }
}

final class CodeRoverNotificationCenterDelegateProxy: NSObject, UNUserNotificationCenterDelegate {
    weak var service: CodeRoverService?

    init(service: CodeRoverService) {
        self.service = service
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        // The in-app timeline and run badges already explain the new state.
        []
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        guard let service,
              let payload = CodeRoverRunCompletionNotificationPayload(from: response.notification.request.content.userInfo) else {
            return
        }

        await MainActor.run {
            service.handleNotificationOpen(threadId: payload.threadId, turnId: payload.turnId)
        }
    }
}

private struct CodeRoverRunCompletionNotificationPayload {
    let threadId: String
    let turnId: String?

    init?(from userInfo: [AnyHashable: Any]) {
        guard let source = userInfo[CodeRoverNotificationPayloadKeys.source] as? String,
              source == CodeRoverNotificationSource.runCompletion,
              let threadId = userInfo[CodeRoverNotificationPayloadKeys.threadId] as? String,
              !threadId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }

        self.threadId = threadId
        self.turnId = userInfo[CodeRoverNotificationPayloadKeys.turnId] as? String
    }
}

extension CodeRoverService {
    // Wires the UNUserNotificationCenter delegate once so taps can reopen the right thread.
    func configureNotifications() {
        guard !hasConfiguredNotifications else {
            return
        }

        let delegateProxy = CodeRoverNotificationCenterDelegateProxy(service: self)
        notificationCenterDelegateProxy = delegateProxy
        userNotificationCenter.delegate = delegateProxy
        hasConfiguredNotifications = true

        Task { @MainActor [weak self] in
            await self?.refreshNotificationAuthorizationStatus()
        }
    }

    // Requests notification permission once on first launch, while still allowing manual retry from Settings.
    func requestNotificationPermissionOnFirstLaunchIfNeeded() async {
        let promptedAlready = defaults.bool(forKey: Self.notificationsPromptedDefaultsKey)
        guard !promptedAlready else {
            await refreshNotificationAuthorizationStatus()
            return
        }

        await requestNotificationPermission(markPrompted: true)
    }

    // Used by: SettingsView, CodeRoverMobileApp
    func requestNotificationPermission(markPrompted: Bool = true) async {
        do {
            _ = try await userNotificationCenter.requestAuthorization(options: [.alert, .sound, .badge])
        } catch {
            debugRuntimeLog("notification permission request failed: \(error.localizedDescription)")
        }

        if markPrompted {
            defaults.set(true, forKey: Self.notificationsPromptedDefaultsKey)
        }

        await refreshNotificationAuthorizationStatus()
    }

    func refreshNotificationAuthorizationStatus() async {
        notificationAuthorizationStatus = await userNotificationCenter.authorizationStatus()
    }

    // Schedules a local alert only when a run finishes while the app is away from the foreground.
    func notifyRunCompletionIfNeeded(threadId: String, turnId: String?, result: CodeRoverRunCompletionResult) {
        guard !isAppInForeground else {
            return
        }

        Task { @MainActor [weak self] in
            await self?.scheduleRunCompletionNotificationIfNeeded(
                threadId: threadId,
                turnId: turnId,
                result: result
            )
        }
    }

    func handleNotificationOpen(threadId: String, turnId: String?) {
        let normalizedThreadId = threadId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedThreadId.isEmpty else {
            return
        }

        pendingNotificationOpenThreadID = normalizedThreadId
        Task { @MainActor [weak self] in
            guard let self else { return }

            defer {
                if pendingNotificationOpenThreadID == normalizedThreadId {
                    pendingNotificationOpenThreadID = nil
                }
            }

            if threads.contains(where: { $0.id == normalizedThreadId }) {
                await prepareThreadForDisplay(threadId: normalizedThreadId)
                return
            }

            await refreshThreadsForNotificationRouting()
            if threads.contains(where: { $0.id == normalizedThreadId }) {
                await prepareThreadForDisplay(threadId: normalizedThreadId)
                return
            }

            if activeThreadId == nil {
                activeThreadId = threads.first?.id
            }

            if turnId?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false {
                debugRuntimeLog("notification target turn not routable thread=\(normalizedThreadId) turn=\(turnId ?? "")")
            }
        }
    }
}

private extension CodeRoverService {
    // Keeps local alerts deduped because some runtimes emit both turn/completed and thread/status terminal signals.
    func scheduleRunCompletionNotificationIfNeeded(
        threadId: String,
        turnId: String?,
        result: CodeRoverRunCompletionResult
    ) async {
        await refreshNotificationAuthorizationStatus()
        guard canScheduleRunCompletionNotifications else {
            return
        }

        let now = Date()
        pruneRunCompletionNotificationDedupe(now: now)
        let dedupeKey = runCompletionNotificationDedupeKey(
            threadId: threadId,
            turnId: turnId,
            result: result,
            now: now
        )

        if let previousTimestamp = runCompletionNotificationDedupedAt[dedupeKey],
           now.timeIntervalSince(previousTimestamp) <= 60 {
            return
        }

        runCompletionNotificationDedupedAt[dedupeKey] = now

        let title = threads.first(where: { $0.id == threadId })?.displayTitle ?? "Conversation"
        let body: String = {
            switch result {
            case .completed:
                "Risposta pronta"
            case .failed:
                "Run non completata"
            }
        }()

        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.threadIdentifier = threadId
        content.userInfo = [
            CodeRoverNotificationPayloadKeys.source: CodeRoverNotificationSource.runCompletion,
            CodeRoverNotificationPayloadKeys.threadId: threadId,
            CodeRoverNotificationPayloadKeys.turnId: turnId ?? "",
            CodeRoverNotificationPayloadKeys.result: result.rawValue,
        ]

        let request = UNNotificationRequest(
            identifier: runCompletionNotificationIdentifier(for: dedupeKey),
            content: content,
            trigger: nil
        )

        do {
            try await userNotificationCenter.add(request)
        } catch {
            debugRuntimeLog("failed to schedule local notification: \(error.localizedDescription)")
        }
    }

    var canScheduleRunCompletionNotifications: Bool {
        switch notificationAuthorizationStatus {
        case .authorized, .provisional, .ephemeral:
            true
        case .denied, .notDetermined:
            false
        @unknown default:
            false
        }
    }

    func runCompletionNotificationDedupeKey(
        threadId: String,
        turnId: String?,
        result: CodeRoverRunCompletionResult,
        now: Date
    ) -> String {
        if let turnId, !turnId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "\(threadId)|\(turnId)|\(result.rawValue)"
        }

        let timeBucket = Int(now.timeIntervalSince1970 / 30)
        return "\(threadId)|\(result.rawValue)|\(timeBucket)"
    }

    func runCompletionNotificationIdentifier(for dedupeKey: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_."))
        let sanitized = String(dedupeKey.unicodeScalars.map { scalar in
            allowed.contains(scalar) ? Character(scalar) : "_"
        })
        return "coderover.runCompletion.\(sanitized)"
    }

    func pruneRunCompletionNotificationDedupe(now: Date) {
        runCompletionNotificationDedupedAt = runCompletionNotificationDedupedAt.filter { _, timestamp in
            now.timeIntervalSince(timestamp) <= 60
        }
    }

    // Refreshes the thread list before routing a notification tap to a thread created on another client.
    func refreshThreadsForNotificationRouting() async {
        guard isConnected else {
            return
        }

        do {
            try await listThreads()
        } catch {
            debugRuntimeLog("thread refresh for notification routing failed: \(error.localizedDescription)")
        }
    }
}
