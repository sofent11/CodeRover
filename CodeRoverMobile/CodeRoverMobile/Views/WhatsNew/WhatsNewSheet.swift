// FILE: WhatsNewSheet.swift
// Purpose: One-time per-version What's New presentation for local-first app updates.

import SwiftUI

struct WhatsNewSheet: View {
    let version: String
    let onDismiss: () -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("What’s New")
                            .font(AppFont.title2(weight: .bold))
                        Text("Version \(version)")
                            .font(AppFont.caption(weight: .semibold))
                            .foregroundStyle(.secondary)
                        Text("CodeRover stays local-first, but this release closes much more of the bridge and mobile parity gap.")
                            .font(AppFont.body())
                            .foregroundStyle(.secondary)
                    }

                    WhatsNewCard(
                        title: "Bridge-Aware Git Flows",
                        description: "Managed worktree actions now have richer bridge support, clearer handoff metadata, and better branch-status context for mobile preflight checks."
                    )

                    WhatsNewCard(
                        title: "Bridge Health In Settings",
                        description: "Settings can now show the installed bridge version, upgrade guidance, trusted-device count, and the synced keep-awake preference from your Mac."
                    )

                    WhatsNewCard(
                        title: "Smoother Local Setup",
                        description: "Onboarding now leans harder into the install, start, and scan flow so getting your Mac bridge online is easier to explain and repeat."
                    )

                    Button(action: onDismiss) {
                        Text("Continue")
                            .font(AppFont.body(weight: .semibold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .foregroundStyle(.white)
                            .background(.black, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .padding(.top, 4)
                }
                .padding(24)
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Later", action: onDismiss)
                }
            }
        }
    }
}

private struct WhatsNewCard: View {
    let title: String
    let description: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(AppFont.subheadline(weight: .semibold))
            Text(description)
                .font(AppFont.body())
                .foregroundStyle(.secondary)
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(Color(.tertiarySystemFill).opacity(0.55))
        )
    }
}

#Preview {
    WhatsNewSheet(version: "1.0") {}
}
