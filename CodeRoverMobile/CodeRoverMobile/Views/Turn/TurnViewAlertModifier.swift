// FILE: TurnViewAlertModifier.swift
// Purpose: Centralizes TurnView approval + git alerts so TurnView stays focused on orchestration.
// Layer: View Modifier
// Exports: turnViewAlerts
// Depends on: SwiftUI, CodeRoverApprovalRequest, GitActionModels

import SwiftUI

private struct TurnViewAlertModifier: ViewModifier {
    @Binding var alertApprovalRequest: CodeRoverApprovalRequest?
    @Binding var isShowingNothingToCommitAlert: Bool
    @Binding var gitSyncAlert: TurnGitSyncAlert?
    @Binding var isShowingDesktopRestartConfirmation: Bool
    @Binding var desktopRestartErrorMessage: String?

    let onDeclineApproval: () -> Void
    let onApproveApproval: () -> Void
    let onConfirmGitSyncAction: (TurnGitSyncAlertAction) -> Void
    let onConfirmDesktopRestart: () -> Void

    func body(content: Content) -> some View {
        content
            .alert(
                "Approval request",
                isPresented: approvalAlertIsPresented,
                presenting: alertApprovalRequest
            ) { _ in
                Button("Decline", role: .destructive) {
                    alertApprovalRequest = nil
                    onDeclineApproval()
                }
                Button("Approve") {
                    alertApprovalRequest = nil
                    onApproveApproval()
                }
            } message: { request in
                Text(approvalAlertMessage(for: request))
            }
            .alert("Nothing to Commit", isPresented: $isShowingNothingToCommitAlert) {
                Button("OK", role: .cancel) {}
            } message: {
                Text("There are no changes to commit.")
            }
            .alert(
                gitSyncAlert?.title ?? "Git",
                isPresented: gitSyncAlertIsPresented,
                presenting: gitSyncAlert
            ) { alert in
                switch alert.action {
                case .dismissOnly:
                    Button("OK", role: .cancel) {
                        gitSyncAlert = nil
                    }
                case .pullRebase:
                    Button("Cancel", role: .cancel) {
                        gitSyncAlert = nil
                    }
                    Button("Pull & Rebase") {
                        let action = alert.action
                        gitSyncAlert = nil
                        onConfirmGitSyncAction(action)
                    }
                }
            } message: { alert in
                Text(alert.message)
            }
            .alert("Restart Codex Desktop App", isPresented: $isShowingDesktopRestartConfirmation) {
                Button("Cancel", role: .cancel) {}
                Button("Restart") {
                    onConfirmDesktopRestart()
                }
            } message: {
                Text("Force close and reopen the Codex desktop app on your Mac, then reopen this conversation there.")
            }
            .alert(
                "Desktop Restart Failed",
                isPresented: desktopRestartErrorIsPresented,
                presenting: desktopRestartErrorMessage
            ) { _ in
                Button("OK", role: .cancel) {
                    desktopRestartErrorMessage = nil
                }
            } message: { message in
                Text(message)
            }
    }

    private var approvalAlertIsPresented: Binding<Bool> {
        Binding(
            get: { alertApprovalRequest != nil },
            set: { isPresented in
                if !isPresented {
                    alertApprovalRequest = nil
                }
            }
        )
    }

    private var gitSyncAlertIsPresented: Binding<Bool> {
        Binding(
            get: { gitSyncAlert != nil },
            set: { isPresented in
                if !isPresented {
                    gitSyncAlert = nil
                }
            }
        )
    }

    private var desktopRestartErrorIsPresented: Binding<Bool> {
        Binding(
            get: { desktopRestartErrorMessage != nil },
            set: { isPresented in
                if !isPresented {
                    desktopRestartErrorMessage = nil
                }
            }
        )
    }

    private func approvalAlertMessage(for request: CodeRoverApprovalRequest) -> String {
        var lines: [String] = []

        if let reason = request.reason?.trimmingCharacters(in: .whitespacesAndNewlines),
           !reason.isEmpty {
            lines.append(reason)
        }

        if let command = request.command?.trimmingCharacters(in: .whitespacesAndNewlines),
           !command.isEmpty {
            lines.append("Command: \(command)")
        }

        if lines.isEmpty {
            return "CodeRover is requesting permission to continue."
        }

        return lines.joined(separator: "\n\n")
    }
}

extension View {
    func turnViewAlerts(
        alertApprovalRequest: Binding<CodeRoverApprovalRequest?>,
        isShowingNothingToCommitAlert: Binding<Bool>,
        gitSyncAlert: Binding<TurnGitSyncAlert?>,
        isShowingDesktopRestartConfirmation: Binding<Bool>,
        desktopRestartErrorMessage: Binding<String?>,
        onDeclineApproval: @escaping () -> Void,
        onApproveApproval: @escaping () -> Void,
        onConfirmGitSyncAction: @escaping (TurnGitSyncAlertAction) -> Void,
        onConfirmDesktopRestart: @escaping () -> Void
    ) -> some View {
        modifier(
            TurnViewAlertModifier(
                alertApprovalRequest: alertApprovalRequest,
                isShowingNothingToCommitAlert: isShowingNothingToCommitAlert,
                gitSyncAlert: gitSyncAlert,
                isShowingDesktopRestartConfirmation: isShowingDesktopRestartConfirmation,
                desktopRestartErrorMessage: desktopRestartErrorMessage,
                onDeclineApproval: onDeclineApproval,
                onApproveApproval: onApproveApproval,
                onConfirmGitSyncAction: onConfirmGitSyncAction,
                onConfirmDesktopRestart: onConfirmDesktopRestart
            )
        )
    }
}
