package com.coderover.android.ui.turn

import androidx.compose.foundation.BorderStroke
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
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
import com.coderover.android.ui.theme.monoFamily

@Composable
internal fun TurnSystemCard(
    title: String,
    showsProgress: Boolean,
    content: @Composable () -> Unit,
) {
    Surface(
        shape = RoundedCornerShape(24.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.78f),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.08f)),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 14.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = title,
                    style = MaterialTheme.typography.labelMedium.copy(fontFamily = monoFamily),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (showsProgress) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(12.dp),
                        strokeWidth = 1.5.dp,
                    )
                }
            }

            content()
        }
    }
}

@Composable
internal fun PlanMessageContent(message: ChatMessage) {
    val plan = remember(message.id, message.text, message.planState) {
        message.planState?.let { state ->
            PlanSummaryUi(
                explanation = state.explanation?.trim()?.takeIf(String::isNotEmpty),
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
    TurnSystemCard(
        title = "Plan",
        showsProgress = message.isStreaming,
    ) {
        plan.explanation?.let {
            RichMessageText(
                text = it,
                textColor = MaterialTheme.colorScheme.onSurface,
                textStyle = MaterialTheme.typography.bodyMedium,
            )
        }

        if (plan.steps.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                plan.steps.forEach { step ->
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                        verticalAlignment = Alignment.Top,
                    ) {
                        Box(
                            modifier = Modifier
                                .padding(top = 4.dp)
                                .size(8.dp)
                                .background(planStatusAccentColor(step.statusLabel), CircleShape),
                        )
                        Column(
                            modifier = Modifier.weight(1f),
                            verticalArrangement = Arrangement.spacedBy(4.dp),
                        ) {
                            Text(
                                text = step.text,
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurface,
                            )
                            Surface(
                                shape = RoundedCornerShape(999.dp),
                                color = planStatusAccentColor(step.statusLabel).copy(alpha = 0.12f),
                            ) {
                                Text(
                                    text = step.statusLabel,
                                    style = MaterialTheme.typography.labelSmall.copy(fontFamily = monoFamily),
                                    color = planStatusAccentColor(step.statusLabel),
                                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                                )
                            }
                        }
                    }
                }
            }
        } else if (message.text.isNotBlank()) {
            RichMessageText(
                text = message.text.trim(),
                textColor = MaterialTheme.colorScheme.onSurface,
                textStyle = MaterialTheme.typography.bodyMedium,
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
        else -> MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.72f)
    }
}
