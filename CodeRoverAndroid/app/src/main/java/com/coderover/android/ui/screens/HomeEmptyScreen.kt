package com.coderover.android.ui.screens

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.coderover.android.R
import com.coderover.android.data.model.AppState
import com.coderover.android.data.model.ConnectionPhase
import com.coderover.android.ui.shared.GlassCard
import com.coderover.android.ui.theme.CommandAccent
import com.coderover.android.ui.theme.Danger
import com.coderover.android.ui.theme.PlanAccent
import kotlinx.coroutines.delay

@Composable
fun HomeEmptyScreen(
    state: AppState,
    onToggleConnection: () -> Unit,
    onOpenPairing: () -> Unit,
) {
    var showStillConnecting by remember(state.connectionPhase) { mutableStateOf(false) }

    LaunchedEffect(state.connectionPhase) {
        showStillConnecting = false
        if (state.connectionPhase == ConnectionPhase.CONNECTING) {
            delay(12_000L)
            showStillConnecting = true
        } else {
            showStillConnecting = false
        }
    }

    val statusLabel = when {
        state.connectionPhase == ConnectionPhase.CONNECTING && showStillConnecting -> "Still connecting..."
        else -> connectionStatusText(state.connectionPhase)
    }
    val securityLabel = state.secureConnectionState.statusLabel
    val buttonLabel = when (state.connectionPhase) {
        ConnectionPhase.CONNECTING -> "Reconnecting..."
        ConnectionPhase.LOADING_CHATS -> "Loading chats..."
        ConnectionPhase.SYNCING -> "Syncing..."
        ConnectionPhase.CONNECTED -> "Disconnect"
        ConnectionPhase.OFFLINE -> "Reconnect"
    }
    val showsScanAction = state.connectionPhase == ConnectionPhase.CONNECTING ||
        (state.pairings.isNotEmpty() && !state.isConnected)
    val isConnectionActionInFlight = when (state.connectionPhase) {
        ConnectionPhase.CONNECTING, ConnectionPhase.LOADING_CHATS, ConnectionPhase.SYNCING -> true
        ConnectionPhase.CONNECTED, ConnectionPhase.OFFLINE -> false
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Column(
            modifier = Modifier.widthIn(max = 280.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            GlassCard(cornerRadius = 22.dp, padding = 0.dp) {
                Image(
                    painter = painterResource(R.drawable.app_logo),
                    contentDescription = null,
                    modifier = Modifier
                        .size(88.dp)
                        .clip(RoundedCornerShape(22.dp)),
                )
            }
            Spacer(Modifier.height(20.dp))

            ConnectionBadge(
                phase = state.connectionPhase,
                label = statusLabel,
            )

            if (securityLabel.isNotBlank()) {
                Spacer(Modifier.height(14.dp))
                Text(
                    text = securityLabel,
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )
            }

            state.lastErrorMessage?.let { error ->
                Spacer(Modifier.height(10.dp))
                Text(
                    text = error,
                    style = MaterialTheme.typography.labelLarge,
                    color = Danger,
                    textAlign = TextAlign.Center,
                )
            }

            Spacer(Modifier.height(18.dp))

            Button(
                onClick = onToggleConnection,
                enabled = !isConnectionActionInFlight,
                shape = RoundedCornerShape(18.dp),
                modifier = Modifier.fillMaxWidth(),
                colors = ButtonDefaults.buttonColors(
                    containerColor = if (state.connectionPhase == ConnectionPhase.LOADING_CHATS ||
                        state.connectionPhase == ConnectionPhase.SYNCING ||
                        state.connectionPhase == ConnectionPhase.CONNECTED
                    ) {
                        MaterialTheme.colorScheme.surfaceVariant
                    } else {
                        Color.Black
                    },
                    contentColor = if (state.connectionPhase == ConnectionPhase.LOADING_CHATS ||
                        state.connectionPhase == ConnectionPhase.SYNCING ||
                        state.connectionPhase == ConnectionPhase.CONNECTED
                    ) {
                        MaterialTheme.colorScheme.onSurface
                    } else {
                        Color.White
                    },
                ),
            ) {
                Text(buttonLabel)
            }

            Spacer(Modifier.height(8.dp))

            if (showsScanAction) {
                TextButton(
                    onClick = onOpenPairing,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Icon(Icons.Outlined.QrCodeScanner, contentDescription = null)
                    Spacer(Modifier.width(8.dp))
                    Text("Scan New QR Code")
                }
            }
        }
    }
}

@Composable
private fun ConnectionBadge(phase: ConnectionPhase) {
    ConnectionBadge(phase = phase, label = connectionStatusText(phase))
}

@Composable
private fun ConnectionBadge(
    phase: ConnectionPhase,
    label: String,
) {
    val dotColor = when (phase) {
        ConnectionPhase.CONNECTING, ConnectionPhase.LOADING_CHATS, ConnectionPhase.SYNCING -> PlanAccent
        ConnectionPhase.CONNECTED -> CommandAccent
        ConnectionPhase.OFFLINE -> MaterialTheme.colorScheme.tertiary
    }

    val infiniteTransition = rememberInfiniteTransition(label = "pulse")
    val alpha by infiniteTransition.animateFloat(
        initialValue = 0.4f,
        targetValue = 1.0f,
        animationSpec = infiniteRepeatable(
            animation = tween(1000),
            repeatMode = RepeatMode.Reverse
        ),
        label = "pulseAlpha"
    )

    val isPulsing = phase == ConnectionPhase.CONNECTING || 
                    phase == ConnectionPhase.LOADING_CHATS || 
                    phase == ConnectionPhase.SYNCING

    Surface(
        shape = RoundedCornerShape(999.dp),
        color = MaterialTheme.colorScheme.surface.copy(alpha = 0.9f),
        border = androidx.compose.foundation.BorderStroke(
            1.dp,
            MaterialTheme.colorScheme.outline.copy(alpha = 0.14f),
        ),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Box(
                modifier = Modifier
                    .size(8.dp)
                    .alpha(if (isPulsing) alpha else 1f)
                    .background(dotColor, CircleShape)
            )
            Text(
                text = label,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

private fun connectionStatusText(phase: ConnectionPhase): String {
    return when (phase) {
        ConnectionPhase.CONNECTING -> "Connecting"
        ConnectionPhase.LOADING_CHATS -> "Loading chats"
        ConnectionPhase.SYNCING -> "Syncing"
        ConnectionPhase.CONNECTED -> "Connected"
        ConnectionPhase.OFFLINE -> "Offline"
    }
}
