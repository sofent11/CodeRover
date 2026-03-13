package com.coderover.android.ui.turn

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import com.coderover.android.data.model.ContextWindowUsage
import com.coderover.android.ui.shared.HapticFeedback

@Composable
internal fun ContextWindowProgressRing(
    usage: ContextWindowUsage,
    isCompacting: Boolean = false,
    onCompact: (() -> Unit)? = null,
) {
    val haptic = HapticFeedback.rememberHapticFeedback()
    var showDialog by remember { mutableStateOf(false) }
    val ringSize = 24.dp
    val lineWidth = 2.5.dp
    val fractionUsed = usage.fractionUsed
    val animatedProgress by animateFloatAsState(targetValue = fractionUsed, label = "Context usage progress")

    val ringColor = when {
        fractionUsed >= 0.85f -> MaterialTheme.colorScheme.error
        fractionUsed >= 0.65f -> Color(0xFFFFA500) // Orange
        else -> MaterialTheme.colorScheme.primary
    }

    Box(
        modifier = Modifier
            .size(ringSize)
            .clickable {
                haptic.triggerImpactFeedback()
                showDialog = true
            },
        contentAlignment = Alignment.Center,
    ) {
        Canvas(modifier = Modifier.size(ringSize)) {
            drawCircle(
                color = ringColor.copy(alpha = 0.12f),
                style = Stroke(width = lineWidth.toPx())
            )
            drawArc(
                color = ringColor,
                startAngle = -90f,
                sweepAngle = 360f * animatedProgress,
                useCenter = false,
                style = Stroke(width = lineWidth.toPx(), cap = StrokeCap.Round)
            )
        }
        Text(
            text = "${usage.percentUsed}",
            style = MaterialTheme.typography.labelSmall.copy(
                fontSize = 8.sp,
                color = ringColor
            )
        )
    }

    if (showDialog) {
        Dialog(onDismissRequest = { showDialog = false }) {
            Surface(
                shape = MaterialTheme.shapes.medium,
                color = MaterialTheme.colorScheme.surface,
                tonalElevation = 8.dp
            ) {
                Column(
                    modifier = Modifier.padding(20.dp),
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Text(
                        text = "Context window:",
                        style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Spacer(Modifier.height(8.dp))
                    Text(
                        text = "${usage.percentUsed}% full",
                        style = MaterialTheme.typography.headlineMedium
                    )
                    Spacer(Modifier.height(8.dp))
                    Text(
                        text = "${usage.tokensUsedFormatted} / ${usage.tokenLimitFormatted} tokens used",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )

                    if (onCompact != null) {
                        Spacer(Modifier.height(16.dp))
                        HorizontalDivider()
                        Spacer(Modifier.height(16.dp))

                        if (isCompacting) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                                Spacer(Modifier.width(8.dp))
                                Text(
                                    text = "Compacting...",
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                        } else {
                            TextButton(onClick = {
                                onCompact()
                                showDialog = false
                            }) {
                                Icon(Icons.Outlined.Refresh, contentDescription = null, modifier = Modifier.size(18.dp))
                                Spacer(Modifier.width(8.dp))
                                Text("Compact context")
                            }
                        }
                    }
                }
            }
        }
    }
}
