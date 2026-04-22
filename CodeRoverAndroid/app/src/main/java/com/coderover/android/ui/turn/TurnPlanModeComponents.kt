package com.coderover.android.ui.turn

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Checklist
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
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
import com.coderover.android.data.model.ProposedPlan
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
    val proposedPlan = remember(message.id, message.text) { message.proposedPlan }
    TurnSystemCard(
        title = "Plan",
        showsProgress = message.isStreaming,
    ) {
        val hasInlinePlanResult = message.resolvedPlanPresentation?.isInlineResultVisible == true && proposedPlan != null
        if (hasInlinePlanResult) {
            ProposedPlanResultContent(requireNotNull(proposedPlan))
        }

        if (!hasInlinePlanResult) {
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
}

@Composable
internal fun PlanExecutionAccessory(
    message: ChatMessage,
    modifier: Modifier = Modifier,
    onTap: () -> Unit,
) {
    val steps = message.planState?.steps.orEmpty()
    val completedCount = steps.count { it.status == PlanStepStatus.COMPLETED }
    val highlightedStep = steps.firstOrNull { it.status == PlanStepStatus.IN_PROGRESS }
        ?: steps.firstOrNull { it.status == PlanStepStatus.PENDING }
        ?: steps.lastOrNull()
    val summaryText = highlightedStep?.step
        ?: message.proposedPlan?.summary?.trim()?.takeIf(String::isNotEmpty)
        ?: message.planState?.explanation?.trim()?.takeIf(String::isNotEmpty)
        ?: message.text.trim().ifEmpty { "Open plan details" }
    val statusLabel = when {
        steps.any { it.status == PlanStepStatus.IN_PROGRESS } -> "In progress"
        steps.isNotEmpty() && completedCount == steps.size -> "Completed"
        else -> "Pending"
    }
    val statusColor = when (statusLabel) {
        "In progress" -> PlanAccent
        "Completed" -> CommandAccent
        else -> MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.72f)
    }

    Surface(
        shape = RoundedCornerShape(24.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.78f),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.08f)),
        modifier = modifier
            .fillMaxWidth()
            .clickable(onClick = onTap),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 14.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .size(32.dp)
                    .background(PlanAccent.copy(alpha = 0.14f), CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = Icons.Outlined.Checklist,
                    contentDescription = null,
                    tint = PlanAccent,
                    modifier = Modifier.size(18.dp),
                )
            }

            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = "Plan",
                        style = MaterialTheme.typography.labelMedium.copy(fontFamily = monoFamily),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Surface(
                        shape = RoundedCornerShape(999.dp),
                        color = statusColor.copy(alpha = 0.12f),
                    ) {
                        Text(
                            text = statusLabel,
                            style = MaterialTheme.typography.labelSmall.copy(fontFamily = monoFamily),
                            color = statusColor,
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                        )
                    }
                    if (message.isStreaming) {
                        CircularProgressIndicator(modifier = Modifier.size(12.dp), strokeWidth = 1.5.dp)
                    }
                }
                Text(
                    text = summaryText,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 1,
                )
            }

            Text(
                text = if (steps.isEmpty()) "Plan" else "$completedCount/${steps.size}",
                style = MaterialTheme.typography.titleMedium.copy(fontFamily = monoFamily),
                color = MaterialTheme.colorScheme.onSurface,
            )
        }
    }
}

@Composable
internal fun ProposedPlanResultContent(proposedPlan: ProposedPlan) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        proposedPlan.summary?.trim()?.takeIf(String::isNotEmpty)?.let { summary ->
            Text(
                text = summary,
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.onSurface,
            )
        }
        RichMessageText(
            text = proposedPlan.body,
            textColor = MaterialTheme.colorScheme.onSurface,
            textStyle = MaterialTheme.typography.bodyMedium,
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun PlanExecutionSheet(
    message: ChatMessage,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        containerColor = Color.Transparent,
        dragHandle = null,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 18.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Surface(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(30.dp),
                color = MaterialTheme.colorScheme.surface.copy(alpha = 0.96f),
                tonalElevation = 8.dp,
                shadowElevation = 10.dp,
            ) {
                Column(
                    modifier = Modifier.padding(horizontal = 18.dp, vertical = 18.dp),
                    verticalArrangement = Arrangement.spacedBy(18.dp),
                ) {
                    Text("Active plan", style = MaterialTheme.typography.titleMedium)
                    PlanMessageContent(message)
                }
            }
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
