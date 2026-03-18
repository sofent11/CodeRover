// FILE: TurnPlanModeComponents.swift
// Purpose: Renders inline plan cards, composer plan affordances, and structured question cards.
// Layer: View Component
// Exports: PlanSystemCard, PlanExecutionAccessory, PlanExecutionSheet, StructuredUserInputCard
// Depends on: SwiftUI, CodeRoverService, ChatMessage, StructuredUserInputCardView

import SwiftUI

struct PlanSystemCard: View {
    let message: ChatMessage

    private var bodyText: String {
        let trimmed = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let placeholders: Set<String> = ["Planning..."]
        guard !trimmed.isEmpty, !placeholders.contains(trimmed) else {
            return ""
        }
        return trimmed
    }

    private var explanationText: String? {
        let trimmed = message.planState?.explanation?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let trimmed, !trimmed.isEmpty else {
            return nil
        }
        guard trimmed != bodyText else {
            return nil
        }
        return trimmed
    }

    var body: some View {
        PlanModeCardContainer(title: "Plan", showsProgress: message.isStreaming) {
            if !bodyText.isEmpty {
                MarkdownTextView(text: bodyText, profile: .assistantProse)
                    .fixedSize(horizontal: false, vertical: true)
            } else if let explanationText {
                MarkdownTextView(text: explanationText, profile: .assistantProse)
            }

            if let explanationText, !bodyText.isEmpty {
                Text(explanationText)
                    .font(AppFont.footnote())
                    .foregroundStyle(.secondary)
            }

            if let steps = message.planState?.steps, !steps.isEmpty {
                PlanStepList(steps: steps)
            }
        }
    }
}

struct PlanExecutionAccessory: View {
    let message: ChatMessage
    let onTap: () -> Void

    private var steps: [CodeRoverPlanStep] {
        message.planState?.steps ?? []
    }

    private var completedStepCount: Int {
        steps.filter { $0.status == .completed }.count
    }

    private var totalStepCount: Int {
        steps.count
    }

    private var highlightedStep: CodeRoverPlanStep? {
        steps.first(where: { $0.status == .inProgress })
            ?? steps.first(where: { $0.status == .pending })
            ?? steps.last
    }

    private var summaryText: String {
        if let highlightedStep {
            return highlightedStep.step
        }

        let explanation = message.planState?.explanation?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !explanation.isEmpty {
            return explanation
        }

        let body = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
        return body.isEmpty ? "Open plan details" : body
    }

    private var progressText: String {
        guard totalStepCount > 0 else { return "Plan" }
        return "\(completedStepCount)/\(totalStepCount)"
    }

    private var statusLabel: String {
        if steps.contains(where: { $0.status == .inProgress }) {
            return "In progress"
        }
        if totalStepCount > 0, completedStepCount == totalStepCount {
            return "Completed"
        }
        return "Pending"
    }

    private var statusColor: Color {
        if steps.contains(where: { $0.status == .inProgress }) {
            return .orange
        }
        if totalStepCount > 0, completedStepCount == totalStepCount {
            return .green
        }
        return Color(.plan)
    }

    var body: some View {
        Button {
            HapticFeedback.shared.triggerImpactFeedback(style: .light)
            onTap()
        } label: {
            HStack(alignment: .center, spacing: 12) {
                Image(systemName: "checklist")
                    .font(AppFont.system(size: 14, weight: .semibold))
                    .foregroundStyle(Color(.plan))
                    .frame(width: 32, height: 32)
                    .background(Color(.plan).opacity(0.14), in: Circle())

                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        Text("Plan")
                            .font(AppFont.caption(weight: .medium))
                            .foregroundStyle(.secondary)

                        Text(statusLabel)
                            .font(AppFont.caption2(weight: .medium))
                            .foregroundStyle(statusColor)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .background(statusColor.opacity(0.12), in: Capsule())

                        if message.isStreaming {
                            ProgressView()
                                .controlSize(.mini)
                        }
                    }

                    Text(summaryText)
                        .font(AppFont.subheadline(weight: .medium))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }

                Spacer(minLength: 0)

                Text(progressText)
                    .font(AppFont.headline(weight: .semibold))
                    .foregroundStyle(.primary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
        }
        .buttonStyle(.plain)
        .adaptiveGlass(.regular, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
    }
}

struct PlanExecutionSheet: View {
    @Environment(\.dismiss) private var dismiss

    let message: ChatMessage

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    PlanSystemCard(message: message)
                }
                .padding(16)
            }
            .background(Color(.systemBackground))
            .navigationTitle("Active plan")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") {
                        dismiss()
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}

struct StructuredUserInputCard: View {
    @Environment(CodeRoverService.self) private var coderover

    let request: CodeRoverStructuredUserInputRequest

    @State private var isSubmitting = false
    @State private var hasSubmittedResponse = false

    var body: some View {
        StructuredUserInputCardView(
            questions: request.questions,
            isSubmitting: isSubmitting,
            hasSubmittedResponse: hasSubmittedResponse,
            onSelectOption: { _, _ in },
            onSubmit: { answers in
                submitAnswers(answers)
            }
        )
    }

    private func submitAnswers(_ answersByQuestionID: [String: [String]]) {
        guard answersByQuestionID.count == request.questions.count else {
            return
        }

        isSubmitting = true
        hasSubmittedResponse = true
        Task { @MainActor in
            do {
                try await coderover.respondToStructuredUserInput(
                    requestID: request.requestID,
                    answersByQuestionID: answersByQuestionID
                )
                isSubmitting = false
            } catch {
                isSubmitting = false
                hasSubmittedResponse = false
                coderover.lastErrorMessage = coderover.userFacingTurnErrorMessage(from: error)
            }
        }
    }
}

private struct PlanStepList: View {
    let steps: [CodeRoverPlanStep]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(steps) { step in
                PlanStepRow(step: step)
            }
        }
    }
}

private struct PlanStepRow: View {
    let step: CodeRoverPlanStep

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: statusSymbol)
                .font(AppFont.system(size: 12, weight: .semibold))
                .foregroundStyle(statusColor)
                .padding(.top, 2)

            VStack(alignment: .leading, spacing: 4) {
                Text(step.step)
                    .font(AppFont.body())
                    .foregroundStyle(.primary)

                Text(statusLabel)
                    .font(AppFont.caption2(weight: .medium))
                    .foregroundStyle(statusColor)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(statusColor.opacity(0.12), in: Capsule())
            }
        }
    }

    private var statusLabel: String {
        switch step.status {
        case .pending:
            return "Pending"
        case .inProgress:
            return "In progress"
        case .completed:
            return "Completed"
        }
    }

    private var statusSymbol: String {
        switch step.status {
        case .pending:
            return "circle"
        case .inProgress:
            return "clock"
        case .completed:
            return "checkmark.circle.fill"
        }
    }

    private var statusColor: Color {
        switch step.status {
        case .pending:
            return .secondary
        case .inProgress:
            return .orange
        case .completed:
            return .green
        }
    }
}
