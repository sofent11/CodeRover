package com.coderover.android.ui.turn

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.coderover.android.data.model.AppState
import com.coderover.android.data.model.ConnectionPhase
import com.coderover.android.data.model.ModelOption
import com.coderover.android.data.model.ThreadHistoryState

@Composable
internal fun ComposerMetaButton(
    title: String,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    Surface(
        onClick = onClick,
        enabled = enabled,
        shape = RoundedCornerShape(8.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(
                text = title,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Icon(
                Icons.Default.KeyboardArrowDown,
                contentDescription = null,
                modifier = Modifier.size(14.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
internal fun ComposerSecondaryChip(
    label: String,
    value: String,
    onClick: () -> Unit,
) {
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(999.dp),
        color = Color.Transparent,
    ) {
        Text(
            text = "$label: $value",
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(horizontal = 4.dp, vertical = 4.dp),
        )
    }
}

@Composable
internal fun ComposerStaticChip(
    label: String,
    value: String,
) {
    Surface(
        shape = RoundedCornerShape(999.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.46f),
    ) {
        Text(
            text = "$label: $value",
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
        )
    }
}

internal fun resolveSelectedModelOption(state: AppState): ModelOption? {
    return state.availableModels.firstOrNull {
        it.id == state.selectedModelId || it.model == state.selectedModelId
    } ?: state.availableModels.firstOrNull { it.isDefault }
        ?: state.availableModels.firstOrNull()
}

internal fun orderedComposerModels(models: List<ModelOption>): List<ModelOption> {
    val preferredOrder = listOf(
        "gpt-5.1-codex-mini",
        "gpt-5.2",
        "gpt-5.1-codex-max",
        "gpt-5.2-codex",
        "gpt-5.3-codex",
    )
    val ranks = preferredOrder.withIndex().associate { (index, model) -> model to index }
    return models.sortedWith(
        compareBy<ModelOption> { ranks[it.model.lowercase()] ?: Int.MAX_VALUE }
            .thenByDescending { composerModelTitle(it) },
    )
}

internal fun composerModelTitle(model: ModelOption): String {
    return when (model.model.lowercase()) {
        "gpt-5.3-codex" -> "GPT-5.3-Codex"
        "gpt-5.2-codex" -> "GPT-5.2-Codex"
        "gpt-5.1-codex-max" -> "GPT-5.1-Codex-Max"
        "gpt-5.4" -> "GPT-5.4"
        "gpt-5.2" -> "GPT-5.2"
        "gpt-5.1-codex-mini" -> "GPT-5.1-Codex-Mini"
        else -> model.title
    }
}

internal fun composerReasoningTitle(effort: String): String {
    return when (effort.trim().lowercase()) {
        "minimal", "low" -> "Low"
        "medium" -> "Medium"
        "high" -> "High"
        "xhigh", "extra_high", "extra-high", "very_high", "very-high" -> "Extra High"
        else -> effort.split('_', '-').joinToString(" ") { token ->
            token.replaceFirstChar { character -> character.titlecase() }
        }
    }
}

internal fun composerConnectionMessage(state: AppState, threadId: String? = state.selectedThreadId): String {
    val currentThreadId = threadId ?: state.selectedThreadId
    val historyState = currentThreadId?.let(state.historyStateByThread::get)
    val hasLocalHistory = currentThreadId?.let { state.messagesByThread[it].orEmpty().isNotEmpty() } == true
    return when {
        historyState.shouldDescribeThreadRefresh() -> {
            if (hasLocalHistory) {
                "Connected securely. Refreshing this conversation."
            } else {
                "Connected securely. Loading this conversation."
            }
        }
        state.connectionPhase == ConnectionPhase.CONNECTING -> {
            if (hasLocalHistory) {
                "Reconnecting to your Mac bridge. Local conversation history is still available."
            } else {
                "Reconnecting to your Mac bridge..."
            }
        }
        state.connectionPhase == ConnectionPhase.LOADING_CHATS -> {
            if (hasLocalHistory) {
                "Connected securely. Refreshing this conversation in the background."
            } else {
                "Connected securely. Loading this conversation."
            }
        }
        state.connectionPhase == ConnectionPhase.SYNCING -> {
            if (hasLocalHistory) {
                "Connected securely. Restoring this conversation."
            } else {
                "Connected securely. Syncing recent thread state from your Mac."
            }
        }
        state.connectionPhase == ConnectionPhase.CONNECTED -> "Connected to your paired Mac."
        state.connectionPhase == ConnectionPhase.OFFLINE -> "History is available offline. Reconnect before sending new messages."
        else -> "Connected to your paired Mac."
    }
}

internal fun isComposerReconnectInFlight(state: AppState): Boolean {
    return when (state.connectionPhase) {
        ConnectionPhase.CONNECTING,
        ConnectionPhase.LOADING_CHATS,
        ConnectionPhase.SYNCING -> true
        ConnectionPhase.CONNECTED,
        ConnectionPhase.OFFLINE -> false
    }
}

private fun ThreadHistoryState?.shouldDescribeThreadRefresh(): Boolean {
    return this?.isTailRefreshing == true
}

@Composable
internal fun ContextWindowProgressRing(
    percentage: Float,
    modifier: Modifier = Modifier,
    size: androidx.compose.ui.unit.Dp = 20.dp,
    strokeWidth: androidx.compose.ui.unit.Dp = 3.dp,
) {
    val trackColor = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.1f)
    val progressColor = if (percentage > 0.9f) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary

    Canvas(modifier = modifier.size(size)) {
        drawArc(
            color = trackColor,
            startAngle = 0f,
            sweepAngle = 360f,
            useCenter = false,
            style = Stroke(width = strokeWidth.toPx(), cap = StrokeCap.Round),
            size = Size(size.toPx(), size.toPx()),
        )

        drawArc(
            color = progressColor,
            startAngle = -90f,
            sweepAngle = 360f * percentage,
            useCenter = false,
            style = Stroke(width = strokeWidth.toPx(), cap = StrokeCap.Round),
            size = Size(size.toPx(), size.toPx()),
        )
    }
}
