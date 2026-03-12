package com.remodex.android.ui.screens

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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.remodex.android.R
import com.remodex.android.data.model.AppState
import com.remodex.android.data.model.ConnectionPhase
import com.remodex.android.ui.theme.CommandAccent
import com.remodex.android.ui.theme.Danger
import com.remodex.android.ui.theme.PlanAccent

@Composable
fun HomeEmptyScreen(
    state: AppState,
    onToggleConnection: () -> Unit,
    onOpenPairing: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Image(
            painter = painterResource(R.drawable.app_logo),
            contentDescription = null,
            modifier = Modifier
                .size(88.dp)
                .clip(RoundedCornerShape(22.dp)),
        )
        Spacer(Modifier.height(24.dp))
        
        ConnectionBadge(phase = state.connectionPhase)

        Spacer(Modifier.height(16.dp))
        state.secureMacFingerprint?.let { fingerprint ->
            Text(
                text = "Trusted Mac: $fingerprint",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(24.dp))
        }

        Button(
            onClick = onToggleConnection,
            enabled = state.connectionPhase != ConnectionPhase.CONNECTING,
            shape = RoundedCornerShape(18.dp),
            modifier = Modifier.fillMaxWidth(0.78f),
        ) {
            Text(
                when {
                    state.isConnected -> "Disconnect"
                    state.connectionPhase == ConnectionPhase.CONNECTING -> "Connecting..."
                    state.connectionPhase == ConnectionPhase.LOADING_CHATS -> "Loading chats..."
                    state.connectionPhase == ConnectionPhase.SYNCING -> "Syncing..."
                    else -> "Reconnect"
                },
            )
        }
        
        Spacer(Modifier.height(10.dp))
        
        TextButton(
            onClick = onOpenPairing,
            modifier = Modifier.fillMaxWidth(0.78f),
        ) {
            Icon(Icons.Outlined.QrCodeScanner, contentDescription = null)
            Spacer(Modifier.width(8.dp))
            Text("Scan New QR Code")
        }
        
        state.lastErrorMessage?.let { error ->
            Spacer(Modifier.height(16.dp))
            Text(
                text = error,
                style = MaterialTheme.typography.labelLarge,
                color = Danger,
                textAlign = TextAlign.Center,
            )
        }
    }
}

@Composable
private fun ConnectionBadge(phase: ConnectionPhase) {
    val (dotColor, text) = when (phase) {
        ConnectionPhase.CONNECTING -> PlanAccent to "Connecting"
        ConnectionPhase.LOADING_CHATS -> PlanAccent to "Loading chats"
        ConnectionPhase.SYNCING -> PlanAccent to "Syncing"
        ConnectionPhase.CONNECTED -> CommandAccent to "Connected"
        ConnectionPhase.OFFLINE -> MaterialTheme.colorScheme.tertiary to "Offline"
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
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
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
                text = text,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}
