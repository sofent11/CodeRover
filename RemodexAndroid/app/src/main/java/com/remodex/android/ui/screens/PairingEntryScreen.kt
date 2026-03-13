package com.remodex.android.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ListItem
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
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
import com.remodex.android.data.model.PairingRecord
import com.remodex.android.data.model.TransportCandidate
import com.remodex.android.ui.components.PairingScannerView
import com.remodex.android.ui.shared.GlassCard
import com.remodex.android.ui.theme.Danger

@Composable
@OptIn(ExperimentalMaterial3Api::class)
fun PairingEntryScreen(
    importText: String,
    errorMessage: String?,
    pendingTransportSelectionPairing: PairingRecord?,
    onImportTextChanged: (String) -> Unit,
    onImport: () -> Unit,
    onScannedPayload: (String) -> Unit,
    onSelectTransport: (String, String) -> Unit,
) {
    var scannerMode by rememberSaveable { mutableStateOf(true) }
    val transportSheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val clipboardManager = LocalClipboardManager.current

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black),
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .statusBarsPadding()
                .navigationBarsPadding()
                .padding(24.dp),
            verticalArrangement = Arrangement.SpaceBetween,
        ) {
            Spacer(Modifier.height(12.dp))

            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Surface(
                    shape = RoundedCornerShape(28.dp),
                    color = Color.White.copy(alpha = 0.07f),
                    border = androidx.compose.foundation.BorderStroke(1.dp, Color.White.copy(alpha = 0.16f)),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Column(
                        modifier = Modifier.padding(horizontal = 20.dp, vertical = 20.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        if (scannerMode) {
                            PairingScannerView(
                                modifier = Modifier.size(280.dp),
                                onCodeScanned = onScannedPayload,
                                permissionDeniedContent = {
                                    Box(
                                        modifier = Modifier
                                            .size(250.dp)
                                            .border(2.dp, Color.White.copy(alpha = 0.65f), RoundedCornerShape(20.dp)),
                                        contentAlignment = Alignment.Center,
                                    ) {
                                        Text(
                                            "Camera access needed",
                                            color = Color.White,
                                            style = MaterialTheme.typography.labelLarge,
                                        )
                                    }
                                },
                            )
                        } else {
                            Box(
                                modifier = Modifier
                                    .size(250.dp)
                                    .border(2.dp, Color.White.copy(alpha = 0.65f), RoundedCornerShape(20.dp)),
                                contentAlignment = Alignment.Center,
                            ) {
                                androidx.compose.material3.Icon(
                                    Icons.Outlined.QrCodeScanner,
                                    contentDescription = null,
                                    tint = Color.White.copy(alpha = 0.8f),
                                    modifier = Modifier.size(44.dp),
                                )
                            }
                        }

                        Spacer(Modifier.height(24.dp))

                        Text(
                            text = if (scannerMode) {
                                "Scan QR code from Remodex CLI"
                            } else {
                                "Paste pairing payload from Remodex CLI"
                            },
                            color = Color.White,
                            style = MaterialTheme.typography.titleMedium,
                            textAlign = TextAlign.Center,
                        )

                        Spacer(Modifier.height(10.dp))

                        Text(
                            text = if (scannerMode) {
                                "Use the QR code generated by your local bridge."
                            } else {
                                "Paste the secure pairing JSON if scanning is not convenient."
                            },
                            color = Color.White.copy(alpha = 0.74f),
                            style = MaterialTheme.typography.bodyMedium,
                            textAlign = TextAlign.Center,
                        )

                        Spacer(Modifier.height(16.dp))

                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            FilterChip(
                                selected = scannerMode,
                                onClick = { scannerMode = true },
                                label = { Text("Scan") },
                            )
                            FilterChip(
                                selected = !scannerMode,
                                onClick = { scannerMode = false },
                                label = { Text("Paste") },
                            )
                        }
                    }
                }
            }

            GlassCard(cornerRadius = 24.dp) {
                Text(
                    text = if (scannerMode) {
                        "Point your camera at the pairing QR from your Mac bridge."
                    } else {
                        "Paste the secure pairing payload."
                    },
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                if (!scannerMode) {
                    Spacer(Modifier.height(14.dp))
                    OutlinedTextField(
                        value = importText,
                        onValueChange = onImportTextChanged,
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(180.dp),
                        label = { Text("Pairing payload") },
                        shape = RoundedCornerShape(20.dp),
                    )
                    Spacer(Modifier.height(16.dp))
                    TextButton(
                        onClick = {
                            val clipboardText = clipboardManager.getText()?.text
                                ?.takeIf { it.isNotBlank() }
                                ?: return@TextButton
                            onImportTextChanged(clipboardText)
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text("Paste from Clipboard")
                    }
                    Spacer(Modifier.height(8.dp))
                    Button(
                        onClick = onImport,
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(18.dp),
                    ) {
                        Text("Connect to Mac Bridge")
                    }
                }

                if (!errorMessage.isNullOrBlank()) {
                    if (!scannerMode) {
                        Spacer(Modifier.height(12.dp))
                    }
                    Text(
                        text = errorMessage,
                        color = Danger,
                        style = MaterialTheme.typography.labelLarge,
                    )
                }
            }
        }
    }

    pendingTransportSelectionPairing?.takeIf { it.transportCandidates.size > 1 }?.let { pairing ->
        ModalBottomSheet(
            onDismissRequest = {},
            sheetState = transportSheetState,
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 8.dp)
                    .padding(bottom = 24.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
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

@Composable
private fun TransportCandidateRow(
    candidate: TransportCandidate,
    onClick: () -> Unit,
) {
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(18.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.42f),
        modifier = Modifier.fillMaxWidth(),
    ) {
        ListItem(
            headlineContent = {
                Text(candidate.label ?: candidate.kind.replace('_', ' ').replaceFirstChar(Char::uppercase))
            },
            supportingContent = {
                Text(candidate.url)
            },
        )
    }
}
