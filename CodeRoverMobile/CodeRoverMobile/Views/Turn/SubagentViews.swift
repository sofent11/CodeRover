// FILE: SubagentViews.swift
// Purpose: UI components for subagent orchestration cards in the timeline.
// Layer: View Components
// Exports: SubagentActionCard
// Depends on: SwiftUI, CodeRoverService, CollaborationMode, AppFont

import SwiftUI

struct SubagentActionCard: View {
    let parentThreadId: String
    let action: CodeRoverSubagentAction
    let isStreaming: Bool
    let onOpenSubagent: ((CodeRoverSubagentThreadPresentation) -> Void)?

    @Environment(CodeRoverService.self) private var coderover
    @State private var isExpanded = true

    var body: some View {
        let _ = coderover.subagentIdentityVersion
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(action.summaryText)
                    .font(AppFont.caption())
                    .foregroundStyle(.secondary)

                Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                    .font(AppFont.system(size: 10, weight: .medium))
                    .foregroundStyle(.tertiary)

                Spacer()
            }
            .contentShape(Rectangle())
            .onTapGesture {
                withAnimation(.easeInOut(duration: 0.2)) {
                    isExpanded.toggle()
                }
            }

            if isExpanded {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(action.agentRows) { agent in
                        let resolved = coderover.resolvedSubagentPresentation(agent, parentThreadId: parentThreadId)
                        Button {
                            HapticFeedback.shared.triggerImpactFeedback(style: .light)
                            onOpenSubagent?(resolved)
                        } label: {
                            HStack(spacing: 10) {
                                Circle()
                                    .fill(statusColor(for: resolved))
                                    .frame(width: 8, height: 8)

                                VStack(alignment: .leading, spacing: 3) {
                                    Text(
                                        coderover.resolvedSubagentDisplayLabel(
                                            threadId: resolved.threadId,
                                            agentId: resolved.agentId
                                        ) ?? resolved.displayLabel
                                    )
                                    .font(AppFont.body(weight: .medium))
                                    .foregroundStyle(.primary)

                                    if let statusText = normalizedValue(resolved.fallbackStatus) {
                                        Text(statusText.replacingOccurrences(of: "_", with: " "))
                                            .font(AppFont.caption2())
                                            .foregroundStyle(.secondary)
                                    }
                                }

                                Spacer(minLength: 8)

                                if let model = normalizedValue(resolved.model) {
                                    Text(model)
                                        .font(AppFont.mono(.caption2))
                                        .foregroundStyle(.secondary)
                                }

                                if onOpenSubagent != nil {
                                    Image(systemName: "chevron.right")
                                        .font(AppFont.system(size: 12, weight: .regular))
                                        .foregroundStyle(.tertiary)
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }

            if isStreaming {
                SubagentTypingIndicator()
                    .padding(.top, 2)
            }
        }
        .task(id: action.agentRows.map(\.threadId)) {
            await coderover.loadSubagentThreadMetadataIfNeeded(threadIds: action.agentRows.map(\.threadId))
        }
    }

    private func statusColor(for presentation: CodeRoverSubagentThreadPresentation) -> Color {
        let rawStatus = presentation.fallbackStatus?.lowercased() ?? action.status.lowercased()
        if rawStatus.contains("fail") || rawStatus.contains("error") {
            return .red
        }
        if rawStatus.contains("stop") || rawStatus.contains("cancel") {
            return .orange
        }
        if rawStatus.contains("complete") || rawStatus.contains("done") {
            return .green
        }
        return Color(.plan)
    }

    private func normalizedValue(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

private struct SubagentTypingIndicator: View {
    private let dotCount = 3
    private let dotSize: CGFloat = 6
    private let spacing: CGFloat = 4
    private let amplitude: CGFloat = 3
    private let period: TimeInterval = 0.9

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 8.0, paused: false)) { context in
            let time = context.date.timeIntervalSinceReferenceDate
            HStack(spacing: spacing) {
                ForEach(0..<dotCount, id: \.self) { index in
                    let phase = (time / period) * (.pi * 2) + Double(index) * 0.6
                    Circle()
                        .fill(Color.secondary.opacity(0.5))
                        .frame(width: dotSize, height: dotSize)
                        .offset(y: CGFloat(sin(phase)) * amplitude)
                }
            }
        }
        .accessibilityHidden(true)
    }
}

enum SubagentLabelParser {
    static func parse(_ title: String) -> (nickname: String, roleSuffix: String) {
        guard title.hasSuffix("]"),
              let openBracket = title.lastIndex(of: "[") else {
            return (title, "")
        }
        let nickname = String(title[..<openBracket]).trimmingCharacters(in: .whitespacesAndNewlines)
        let roleStart = title.index(after: openBracket)
        let roleEnd = title.index(before: title.endIndex)
        let role = String(title[roleStart..<roleEnd]).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !role.isEmpty else {
            return (nickname.isEmpty ? title : nickname, "")
        }
        let resolvedName = nickname.isEmpty ? role.capitalized : nickname
        return (resolvedName, " (\(role))")
    }

    static func nicknameColor(for title: String) -> Color {
        SubagentColorPalette.color(for: parse(title).nickname)
    }

    static func styledText(
        nickname: String,
        roleSuffix: String,
        roleSuffixColor: Color = .secondary
    ) -> Text {
        Text(nickname)
            .foregroundColor(SubagentColorPalette.color(for: nickname))
            .fontWeight(.semibold)
        + Text(roleSuffix)
            .foregroundColor(roleSuffixColor)
    }

    static func styledText(
        for title: String,
        roleSuffixColor: Color = .secondary
    ) -> Text {
        let parts = parse(title)
        return styledText(
            nickname: parts.nickname,
            roleSuffix: parts.roleSuffix,
            roleSuffixColor: roleSuffixColor
        )
    }
}

private enum SubagentColorPalette {
    static let colors: [Color] = [
        Color(red: 0.90, green: 0.30, blue: 0.30),
        Color(red: 0.30, green: 0.75, blue: 0.55),
        Color(red: 0.40, green: 0.55, blue: 0.95),
        Color(red: 0.85, green: 0.60, blue: 0.25),
        Color(red: 0.70, green: 0.45, blue: 0.85),
        Color(red: 0.25, green: 0.78, blue: 0.82),
        Color(red: 0.90, green: 0.50, blue: 0.60),
        Color(red: 0.65, green: 0.75, blue: 0.30),
    ]

    static func color(for name: String) -> Color {
        var hash: UInt64 = 5381
        for byte in name.utf8 {
            hash = ((hash &<< 5) &+ hash) &+ UInt64(byte)
        }
        return colors[Int(hash % UInt64(colors.count))]
    }
}
