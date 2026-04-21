package com.coderover.android.ui.shared

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.coderover.android.data.model.AppState
import com.coderover.android.data.model.ConnectionPhase
import com.coderover.android.ui.theme.Border
import com.coderover.android.ui.theme.CommandAccent
import com.coderover.android.ui.theme.PlanAccent

object ParityUi {
    val sectionSpacing = 24.dp
    val compactSpacing = 8.dp
    val rowCornerRadius = 14.dp
    val cardCornerRadius = 20.dp
    val composerCornerRadius = 28.dp
    val toolbarItemSize = 38.dp
    val floatingButtonSize = 44.dp
    val sectionLabelPadding = 4.dp
}

@Composable
fun StatusTag(
    text: String,
    containerColor: Color,
    contentColor: Color,
) {
    Surface(
        shape = RoundedCornerShape(999.dp),
        color = containerColor,
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.labelSmall,
            color = contentColor,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
        )
    }
}

@Composable
fun ParitySectionLabel(
    title: String,
    modifier: Modifier = Modifier,
) {
    Text(
        text = title.uppercase(),
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = modifier.padding(horizontal = ParityUi.sectionLabelPadding),
    )
}

@Composable
fun ParityCard(
    modifier: Modifier = Modifier,
    cornerRadius: Dp = ParityUi.cardCornerRadius,
    padding: Dp = 16.dp,
    content: @Composable ColumnScope.() -> Unit,
) {
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(cornerRadius),
        color = MaterialTheme.colorScheme.surface.copy(alpha = 0.82f),
        border = BorderStroke(1.dp, Border),
        tonalElevation = 1.dp,
        shadowElevation = 2.dp,
    ) {
        Column(
            modifier = Modifier
                .background(
                    brush = Brush.verticalGradient(
                        colors = listOf(
                            MaterialTheme.colorScheme.surface.copy(alpha = 0.98f),
                            MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.35f),
                        ),
                    ),
                )
                .padding(padding),
            content = content,
        )
    }
}

@Composable
fun GlassCard(
    modifier: Modifier = Modifier,
    cornerRadius: Dp = ParityUi.cardCornerRadius,
    content: @Composable ColumnScope.() -> Unit,
) {
    ParityCard(
        modifier = modifier,
        cornerRadius = cornerRadius,
        content = content,
    )
}

@Composable
fun GlassCard(
    modifier: Modifier = Modifier,
    cornerRadiusTopStart: Dp = 20.dp,
    cornerRadiusTopEnd: Dp = 20.dp,
    cornerRadiusBottomStart: Dp = 20.dp,
    cornerRadiusBottomEnd: Dp = 20.dp,
    padding: Dp = 16.dp,
    content: @Composable ColumnScope.() -> Unit,
) {
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(
            topStart = cornerRadiusTopStart,
            topEnd = cornerRadiusTopEnd,
            bottomStart = cornerRadiusBottomStart,
            bottomEnd = cornerRadiusBottomEnd,
        ),
        color = MaterialTheme.colorScheme.surface.copy(alpha = 0.82f),
        border = BorderStroke(1.dp, Border),
        tonalElevation = 1.dp,
        shadowElevation = 2.dp,
    ) {
        Column(
            modifier = Modifier
                .background(
                    brush = Brush.verticalGradient(
                        colors = listOf(
                            MaterialTheme.colorScheme.surface.copy(alpha = 0.98f),
                            MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.35f),
                        ),
                    ),
                )
                .padding(padding),
            content = content,
        )
    }
}

@Composable
fun ParityListRow(
    modifier: Modifier = Modifier,
    isSelected: Boolean = false,
    content: @Composable RowScope.() -> Unit,
) {
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(ParityUi.rowCornerRadius),
        color = if (isSelected) {
            MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.82f)
        } else {
            Color.Transparent
        },
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            content = content,
        )
    }
}

@Composable
fun ParityToolbarItemSurface(
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    size: Dp = ParityUi.toolbarItemSize,
    onClick: (() -> Unit)? = null,
    content: @Composable BoxScope.() -> Unit,
) {
    Surface(
        modifier = modifier.size(size),
        shape = CircleShape,
        color = MaterialTheme.colorScheme.surface.copy(alpha = 0.88f),
        border = BorderStroke(1.dp, Border),
        tonalElevation = 1.dp,
        shadowElevation = 2.dp,
        onClick = onClick ?: {},
        enabled = enabled && onClick != null,
    ) {
        Box(
            modifier = Modifier.fillMaxWidth(),
            contentAlignment = Alignment.Center,
            content = content,
        )
    }
}

@Composable
fun ParityToolbarIconButton(
    icon: ImageVector,
    contentDescription: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    ParityToolbarItemSurface(
        modifier = modifier,
        enabled = enabled,
        onClick = onClick,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = contentDescription,
            tint = if (enabled) {
                MaterialTheme.colorScheme.onSurface
            } else {
                MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.55f)
            },
        )
    }
}

@Composable
fun ParityIconButton(
    icon: ImageVector,
    contentDescription: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    ParityToolbarItemSurface(
        modifier = modifier,
        enabled = enabled,
        onClick = onClick,
    ) {
        IconButton(onClick = onClick, enabled = enabled) {
            Icon(
                imageVector = icon,
                contentDescription = contentDescription,
                tint = if (enabled) {
                    MaterialTheme.colorScheme.onSurface
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.55f)
                },
            )
        }
    }
}

@Composable
fun ParityInputSurface(
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    ParityCard(
        modifier = modifier,
        cornerRadius = ParityUi.composerCornerRadius,
        padding = 0.dp,
    ) {
        content()
    }
}

fun connectionStatusLabel(phase: ConnectionPhase): String {
    return when (phase) {
        ConnectionPhase.CONNECTING -> "Connecting"
        ConnectionPhase.LOADING_CHATS -> "Loading chats"
        ConnectionPhase.SYNCING -> "Syncing"
        ConnectionPhase.CONNECTED -> "Connected"
        ConnectionPhase.OFFLINE -> "Offline"
    }
}

fun relativeTimeLabel(timestamp: Long?): String? {
    val value = timestamp ?: return null
    if (value <= 0L) {
        return null
    }
    val deltaSeconds = ((System.currentTimeMillis() - value) / 1_000L).coerceAtLeast(0L)
    return when {
        deltaSeconds < 60L -> "now"
        deltaSeconds < 3_600L -> "${deltaSeconds / 60L}m"
        deltaSeconds < 86_400L -> "${deltaSeconds / 3_600L}h"
        deltaSeconds < 604_800L -> "${deltaSeconds / 86_400L}d"
        else -> "${deltaSeconds / 604_800L}w"
    }
}

@Composable
fun AppBackdrop(
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier
            .background(
                brush = Brush.verticalGradient(
                    colors = listOf(
                        MaterialTheme.colorScheme.background,
                        MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f),
                        MaterialTheme.colorScheme.background,
                    ),
                ),
            ),
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .fillMaxHeight(0.34f)
                .background(
                    brush = Brush.radialGradient(
                        colors = listOf(
                            MaterialTheme.colorScheme.primary.copy(alpha = 0.10f),
                            Color.Transparent,
                        ),
                    ),
                ),
        )
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .fillMaxHeight()
                .padding(top = 220.dp)
                .background(
                    brush = Brush.radialGradient(
                        colors = listOf(
                            MaterialTheme.colorScheme.tertiary.copy(alpha = 0.08f),
                            Color.Transparent,
                        ),
                    ),
                ),
        )
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(180.dp)
                .background(
                    brush = Brush.verticalGradient(
                        colors = listOf(
                            Color.White.copy(alpha = 0.28f),
                            Color.Transparent,
                        ),
                    ),
                ),
        )
    }
}

@Composable
fun StatusPill(state: AppState) {
    Surface(
        shape = RoundedCornerShape(999.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.88f),
        modifier = Modifier.padding(end = 8.dp),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Box(
                modifier = Modifier
                    .size(7.dp)
                    .background(
                        when (state.connectionPhase) {
                            ConnectionPhase.CONNECTED -> CommandAccent
                            ConnectionPhase.CONNECTING, ConnectionPhase.LOADING_CHATS, ConnectionPhase.SYNCING -> PlanAccent
                            ConnectionPhase.OFFLINE -> MaterialTheme.colorScheme.outline
                        },
                        CircleShape,
                    ),
            )
            Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Text(
                    text = connectionStatusLabel(state.connectionPhase),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                Text(
                    text = state.secureConnectionState.statusLabel,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}
