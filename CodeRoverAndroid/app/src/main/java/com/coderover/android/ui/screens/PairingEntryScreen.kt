package com.coderover.android.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.PhotoCamera
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.coderover.android.data.model.PairingRecord
import com.coderover.android.data.model.TransportCandidate
import com.coderover.android.ui.components.PairingScannerView
import com.coderover.android.ui.shared.GlassCard
import androidx.compose.material3.AlertDialog
import com.coderover.android.ui.shared.HapticFeedback
import android.content.Intent
import android.provider.Settings
import androidx.compose.ui.platform.LocalContext
import com.coderover.android.ui.shared.ParityToolbarItemSurface

@Composable
@OptIn(ExperimentalMaterial3Api::class)
fun PairingEntryScreen(
    errorMessage: String?,
    pendingTransportSelectionPairing: PairingRecord?,
    onBack: (() -> Unit)? = null,
    onScannedPayload: (String, resetScanLock: () -> Unit) -> Unit,
    onSelectTransport: (String, String) -> Unit,
    onErrorDismissed: () -> Unit,
) {
    val transportSheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val haptic = HapticFeedback.rememberHapticFeedback()
    val context = LocalContext.current

    PairingScannerView(
        modifier = Modifier.fillMaxSize(),
        onCodeScanned = { code, resetScanLock ->
            haptic.triggerImpactFeedback()
            onScannedPayload(code, resetScanLock)
        },
        permissionDeniedContent = {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
                modifier = Modifier
                    .fillMaxSize()
                    .padding(horizontal = 24.dp)
            ) {
                androidx.compose.material3.Icon(
                    imageVector = Icons.Outlined.PhotoCamera,
                    contentDescription = null,
                    tint = Color.White.copy(alpha = 0.6f),
                    modifier = Modifier.size(48.dp)
                )
                Spacer(Modifier.height(20.dp))
                Text(
                    "Camera access needed",
                    color = Color.White,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold,
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    "Open Settings and allow camera access to scan the pairing QR code.",
                    color = Color.White.copy(alpha = 0.6f),
                    style = MaterialTheme.typography.bodyMedium,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.widthIn(max = 320.dp)
                )
                Spacer(Modifier.height(20.dp))
                Button(
                    onClick = {
                        val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                            data = android.net.Uri.fromParts("package", context.packageName, null)
                        }
                        context.startActivity(intent)
                    }
                ) {
                    Text("Open Settings")
                }
            }
        },
        overlayContent = {
            Column(
                modifier = Modifier.fillMaxSize(),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(24.dp),
            ) {
                Spacer(modifier = Modifier.weight(1f))

                Box(
                    modifier = Modifier
                        .size(250.dp)
                        .border(2.dp, Color.White.copy(alpha = 0.6f), RoundedCornerShape(20.dp)),
                )

                Text(
                    text = "Scan QR code from CodeRover CLI",
                    color = Color.White,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = androidx.compose.ui.text.font.FontWeight.Medium,
                )

                Spacer(modifier = Modifier.weight(1f))
            }
        }
    )

    onBack?.let { dismiss ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .statusBarsPadding()
                .padding(horizontal = 16.dp, vertical = 12.dp),
        ) {
            ParityToolbarItemSurface(
                modifier = Modifier.align(Alignment.TopStart),
                onClick = dismiss,
            ) {
                androidx.compose.material3.Icon(
                    imageVector = Icons.AutoMirrored.Outlined.ArrowBack,
                    contentDescription = "Back",
                )
            }
        }
    }

    if (!errorMessage.isNullOrBlank()) {
        AlertDialog(
            onDismissRequest = onErrorDismissed,
            title = { Text("Scan Error") },
            text = { Text(errorMessage) },
            confirmButton = {},
            dismissButton = {
                TextButton(onClick = onErrorDismissed) {
                    Text("OK")
                }
            }
        )
    }

    pendingTransportSelectionPairing?.takeIf { it.transportCandidates.size > 1 }?.let { pairing ->
        ModalBottomSheet(
            onDismissRequest = {},
            sheetState = transportSheetState,
            containerColor = Color.Transparent,
        ) {
            GlassCard(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 8.dp)
                    .padding(bottom = 24.dp),
                cornerRadius = 30.dp,
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        text = "Choose a transport",
                        style = MaterialTheme.typography.titleMedium,
                    )
                    Text(
                        text = "This Mac advertised multiple bridge routes. Pick the local or relay address Android should use for this pairing.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    pairing.transportCandidates.forEach { candidate ->
                        TransportCandidateRow(
                            candidate = candidate,
                            onClick = {
                                onSelectTransport(pairing.macDeviceId, candidate.url)
                            },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun TransportCandidateRow(
    candidate: TransportCandidate,
    onClick: () -> Unit,
) {
    GlassCard(
        modifier = Modifier.fillMaxWidth(),
        cornerRadius = 18.dp,
        padding = 0.dp,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clickable(onClick = onClick)
                .padding(horizontal = 16.dp, vertical = 14.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(
                text = candidate.label ?: candidate.kind.replace('_', ' ').replaceFirstChar(Char::uppercase),
                style = MaterialTheme.typography.bodyLarge,
            )
            Text(
                text = candidate.url,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
