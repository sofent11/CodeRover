package com.coderover.android.ui.turn

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.coderover.android.data.model.ChatMessage
import com.coderover.android.data.model.PlanStepStatus
import com.coderover.android.ui.theme.CommandAccent
import com.coderover.android.ui.theme.PlanAccent

@Composable
internal fun PlanMessageContent(message: ChatMessage) {
    val plan = remember(message.id, message.text, message.planState) {
        message.planState?.let { state ->
            PlanSummaryUi(
                explanation = state.explanation,
                steps = state.steps.map { step ->
                    PlanStepUi(
                        text = step.step,
                        statusLabel = when (step.status) {
                            PlanStepStatus.PENDING -> "Pending"
                            PlanStepStatus.IN_PROGRESS -> "In progress"
                            PlanStepStatus.COMPLETED -> "Completed"
                        },
                    )
                },
            )
        } ?: parsePlanSummary(message.text)
    }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        plan.explanation?.let {
            Text(
                text = it,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
        if (plan.steps.isNotEmpty()) {
            plan.steps.forEach { step ->
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.Top,
                ) {
                    Box(
                        modifier = Modifier
                            .padding(top = 6.dp)
                            .size(8.dp)
                            .background(planStatusAccentColor(step.statusLabel), CircleShape),
                    )
                    Spacer(Modifier.size(10.dp))
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = step.text,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Spacer(Modifier.height(2.dp))
                        Text(
                            text = step.statusLabel,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        } else if (message.text.isNotBlank()) {
            Text(
                text = message.text.trim(),
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}

private data class PlanStepUi(
    val text: String,
    val statusLabel: String,
)

private data class PlanSummaryUi(
    val explanation: String?,
    val steps: List<PlanStepUi>,
)

private fun parsePlanSummary(text: String): PlanSummaryUi {
    val lines = text.lines().map(String::trim).filter(String::isNotEmpty)
    val steps = mutableListOf<PlanStepUi>()
    val explanationLines = mutableListOf<String>()
    val bracketRegex = Regex("""^[-*]?\s*\[(x| |>)\]\s*(.+)$""", RegexOption.IGNORE_CASE)
    val numberedRegex = Regex("""^\d+\.\s+(.+)$""")
    val statusRegex = Regex("""^(completed|in_progress|in progress|pending)\s*[:-]\s*(.+)$""", RegexOption.IGNORE_CASE)

    lines.forEach { line ->
        val bracketMatch = bracketRegex.matchEntire(line)
        val statusMatch = statusRegex.matchEntire(line)
        val numberedMatch = numberedRegex.matchEntire(line)
        when {
            bracketMatch != null -> {
                val rawStatus = bracketMatch.groupValues[1].lowercase()
                val statusLabel = when (rawStatus) {
                    "x" -> "Completed"
                    ">" -> "In progress"
                    else -> "Pending"
                }
                steps += PlanStepUi(
                    text = bracketMatch.groupValues[2],
                    statusLabel = statusLabel,
                )
            }

            statusMatch != null -> {
                val normalizedStatus = when (statusMatch.groupValues[1].lowercase()) {
                    "completed" -> "Completed"
                    "in_progress", "in progress" -> "In progress"
                    else -> "Pending"
                }
                steps += PlanStepUi(
                    text = statusMatch.groupValues[2],
                    statusLabel = normalizedStatus,
                )
            }

            line.startsWith("- ") || line.startsWith("* ") || numberedMatch != null -> {
                steps += PlanStepUi(
                    text = numberedMatch?.groupValues?.getOrNull(1) ?: line.drop(2),
                    statusLabel = "Pending",
                )
            }

            else -> explanationLines += line
        }
    }

    return PlanSummaryUi(
        explanation = explanationLines.takeIf { it.isNotEmpty() }?.joinToString(" "),
        steps = steps,
    )
}

@Composable
private fun planStatusAccentColor(statusLabel: String): Color {
    return when (statusLabel) {
        "Completed" -> CommandAccent
        "In progress" -> PlanAccent
        else -> MaterialTheme.colorScheme.outline
    }
}
