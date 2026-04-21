package com.coderover.android.ui.settings

import android.content.Intent
import android.provider.Settings
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.foundation.clickable
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material.icons.outlined.PowerSettingsNew
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.app.NotificationManagerCompat
import com.coderover.android.data.model.AccessMode
import com.coderover.android.data.model.AppFontStyle
import com.coderover.android.data.model.AppState
import com.coderover.android.data.model.ModelOption
import com.coderover.android.data.model.PairingRecord
import com.coderover.android.data.model.RuntimeProvider
import com.coderover.android.data.model.ThreadSummary
import com.coderover.android.ui.shared.StatusTag
import com.coderover.android.ui.shared.connectionStatusLabel
import com.coderover.android.ui.shared.relativeTimeLabel
import com.coderover.android.ui.theme.CommandAccent
import com.coderover.android.ui.theme.Danger
import com.coderover.android.ui.theme.monoFamily
import kotlinx.coroutines.delay

@Composable
fun SettingsOverviewCard(
    state: AppState,
) {
    Surface(
        shape = RoundedCornerShape(28.dp),
        color = MaterialTheme.colorScheme.surface.copy(alpha = 0.96f),
        border = androidx.compose.foundation.BorderStroke(1.dp, com.coderover.android.ui.theme.Border),
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                text = "Settings",
                style = MaterialTheme.typography.titleLarge,
            )
            Text(
                text = "Keep Android aligned with the iOS client while staying local-first: bridge, threads, git and CodeRover runtime all stay on your Mac.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Row(
                modifier = Modifier.horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                SettingsInfoPill(
                    label = "Connection",
                    value = connectionStatusLabel(state.connectionPhase),
                    accent = if (state.isConnected) CommandAccent else MaterialTheme.colorScheme.outline,
                )
                SettingsInfoPill(
                    label = "Security",
                    value = state.secureConnectionState.statusLabel,
                    accent = if (state.secureConnectionState.statusLabel.contains("encrypted", ignoreCase = true)) {
                        CommandAccent
                    } else {
                        MaterialTheme.colorScheme.tertiary
                    },
                )
                SettingsInfoPill(
                    label = "Chats",
                    value = state.threads.size.toString(),
                    accent = MaterialTheme.colorScheme.primary,
                )
            }
        }
    }
}

@Composable
fun SettingsAppearanceCard(
    fontStyle: AppFontStyle,
    onFontStyleSelected: (AppFontStyle) -> Unit,
) {
    SettingsCard(title = "Appearance") {
        SettingsPickerRow(
            label = "Font",
            selectedValue = fontStyle,
            options = AppFontStyle.entries,
            displayValue = { if (it == AppFontStyle.SYSTEM) "System" else "Geist" },
            onValueSelected = onFontStyleSelected,
        )
        Text(
            text = if (fontStyle == AppFontStyle.SYSTEM) "Use the native Android font for regular text. Code stays monospaced." else "Use Geist for regular text. Code stays monospaced.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
fun SettingsRuntimeDefaultsCard(
    state: AppState,
    onProviderSelected: (String) -> Unit,
    onAccessModeSelected: (AccessMode) -> Unit,
    onModelSelected: (String?) -> Unit,
    onReasoningSelected: (String?) -> Unit,
) {
    SettingsCard(title = "Runtime defaults") {
        SettingsPickerRow(
            label = "Provider",
            selectedValue = state.selectedProvider,
            options = state.availableProviders,
            displayValue = RuntimeProvider::title,
            onValueSelected = { onProviderSelected(it.id) },
        )

        if (state.availableModels.isNotEmpty()) {
            val selectedModel = state.availableModels.find { it.id == state.selectedModelId }

            SettingsPickerRow(
                label = "Model",
                selectedValue = selectedModel,
                options = listOf(null) + state.availableModels,
                displayValue = { it?.title ?: "Auto" },
                onValueSelected = { onModelSelected(it?.id) },
            )

            val modelForReasoning = selectedModel ?: state.availableModels.firstOrNull()
            if (modelForReasoning != null && modelForReasoning.supportedReasoningEfforts.isNotEmpty()) {
                val currentReasoning = state.selectedReasoningEffort

                SettingsPickerRow(
                    label = "Reasoning",
                    selectedValue = currentReasoning,
                    options = listOf(null) + modelForReasoning.supportedReasoningEfforts,
                    displayValue = { it?.replaceFirstChar(Char::uppercase) ?: "Auto" },
                    onValueSelected = onReasoningSelected,
                )
            }
        }

        SettingsPickerRow(
            label = "Access",
            selectedValue = state.accessMode,
            options = AccessMode.entries.filter { mode ->
                state.selectedProvider.accessModes.any { it.id == mode.rawValue }
            }.ifEmpty { AccessMode.entries },
            displayValue = { it.displayName },
            onValueSelected = onAccessModeSelected,
        )
    }
}

@Composable
fun SettingsConnectionCard(
    state: AppState,
    onReconnect: () -> Unit,
    onDisconnect: () -> Unit,
    onSelectPairing: (String) -> Unit,
    onRemovePairing: (String) -> Unit,
    onPreferredTransportSelected: (String, String) -> Unit,
) {
    val haptic = com.coderover.android.ui.shared.HapticFeedback.rememberHapticFeedback()
    val connectionActionInFlight = when (state.connectionPhase) {
        com.coderover.android.data.model.ConnectionPhase.CONNECTING,
        com.coderover.android.data.model.ConnectionPhase.LOADING_CHATS,
        com.coderover.android.data.model.ConnectionPhase.SYNCING -> true
        com.coderover.android.data.model.ConnectionPhase.CONNECTED,
        com.coderover.android.data.model.ConnectionPhase.OFFLINE -> false
    }

    val activePairing = state.activePairing
    val availableTransportCandidates = activePairing?.transportCandidates?.filter { it.isUsableCandidate() } ?: emptyList()
    val transportAutoValue = "__AUTO_TRANSPORT__"

    SettingsCard(title = "Connection") {
        Text(
            text = "Status: ${connectionStatusLabel(state.connectionPhase)}",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Text(
            text = "Security: ${state.secureConnectionState.statusLabel}",
            style = MaterialTheme.typography.bodySmall,
            color = if (state.secureConnectionState == com.coderover.android.data.model.SecureConnectionState.ENCRYPTED) {
                CommandAccent
            } else {
                MaterialTheme.colorScheme.onSurfaceVariant
            },
        )

        state.secureMacFingerprint?.let { fingerprint ->
            Text(
                text = "Trusted Mac: $fingerprint",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        if (state.pairings.isNotEmpty()) {
            Text(
                text = "Paired Macs: ${state.pairings.size}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                state.pairings.forEach { pairing ->
                    SettingsPairingCard(
                        pairing = pairing,
                        isActive = pairing.macDeviceId == state.activePairingMacDeviceId,
                        isConnected = state.isConnected && pairing.macDeviceId == state.activePairingMacDeviceId,
                        isBusy = connectionActionInFlight,
                        onSelectPairing = { onSelectPairing(pairing.macDeviceId) },
                        onRemovePairing = { onRemovePairing(pairing.macDeviceId) },
                    )
                }
            }
        }

        if (activePairing != null && availableTransportCandidates.size > 1) {
            val selectedPreferredTransportCandidate = activePairing.transportCandidates.firstOrNull {
                it.url == activePairing.preferredTransportUrl
            }

            SettingsPickerRow(
                label = "Transport",
                selectedValue = selectedPreferredTransportCandidate,
                options = listOf(null) + availableTransportCandidates,
                displayValue = { candidate ->
                    candidate?.label ?: candidate?.url ?: "Auto"
                },
                onValueSelected = { candidate ->
                    if (!connectionActionInFlight) {
                        onPreferredTransportSelected(activePairing.macDeviceId, candidate?.url ?: "")
                    }
                },
            )

            Text(
                text = if (selectedPreferredTransportCandidate == null) {
                    "Current preference: Auto"
                } else {
                    "Current preference: ${selectedPreferredTransportCandidate.label ?: selectedPreferredTransportCandidate.url}"
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        val connectionPhaseShowsProgress = when (state.connectionPhase) {
            com.coderover.android.data.model.ConnectionPhase.CONNECTING,
            com.coderover.android.data.model.ConnectionPhase.LOADING_CHATS,
            com.coderover.android.data.model.ConnectionPhase.SYNCING -> true
            com.coderover.android.data.model.ConnectionPhase.CONNECTED,
            com.coderover.android.data.model.ConnectionPhase.OFFLINE -> false
        }

        if (connectionPhaseShowsProgress) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                androidx.compose.material3.CircularProgressIndicator(
                    modifier = Modifier.size(16.dp),
                    strokeWidth = 2.dp,
                )
                val progressLabel = when (state.connectionPhase) {
                    com.coderover.android.data.model.ConnectionPhase.CONNECTING -> "Connecting to bridge..."
                    com.coderover.android.data.model.ConnectionPhase.LOADING_CHATS -> "Loading chats..."
                    com.coderover.android.data.model.ConnectionPhase.SYNCING -> "Syncing workspace..."
                    else -> ""
                }
                Text(
                    text = progressLabel,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        state.lastErrorMessage?.takeIf { it.isNotBlank() }?.let { errorMessage ->
            Text(
                text = errorMessage,
                style = MaterialTheme.typography.bodySmall,
                color = Danger,
            )
        }

        if (state.isConnected) {
            SettingsButton(
                title = "Disconnect",
                isDestructive = true,
                enabled = !connectionActionInFlight,
                onClick = {
                    haptic.triggerImpactFeedback(com.coderover.android.ui.shared.HapticFeedback.Style.MEDIUM)
                    onDisconnect()
                },
            )
        }
    }
}

@Composable
fun SettingsBridgeCard(
    state: AppState,
    onKeepAwakeChanged: (Boolean) -> Unit,
) {
    val clipboardManager = LocalClipboardManager.current
    val haptic = com.coderover.android.ui.shared.HapticFeedback.rememberHapticFeedback()
    var copiedUpgradeCommand by remember { mutableStateOf(false) }

    if (copiedUpgradeCommand) {
        LaunchedEffect(Unit) {
            delay(1500)
            copiedUpgradeCommand = false
        }
    }

    SettingsCard(title = "Bridge") {
        val status = state.bridgeStatus
        if (status != null) {
            Text(
                text = "Installed: ${status.bridgeVersionLabel}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                text = "Latest: ${status.latestVersionLabel}",
                style = MaterialTheme.typography.bodySmall,
                color = if (status.updateAvailable) MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                text = "Trusted devices: ${status.trustedDeviceCount}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            status.supportedMobileVersions?.android?.let { support ->
                Text(
                    text = "Supported Android: ${support.displayLabel}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Text("Keep Mac awake", style = MaterialTheme.typography.bodyLarge)
                    Text(
                        text = if (status.keepAwakeEnabled) {
                            if (status.keepAwakeActive) {
                                "The bridge is actively preventing your Mac from sleeping."
                            } else {
                                "Keep-awake is enabled and will apply to the bridge session."
                            }
                        } else {
                            "Allow the Mac to sleep normally when the bridge does not need to keep the machine awake."
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Spacer(Modifier.width(12.dp))
                Switch(
                    checked = status.keepAwakeEnabled,
                    onCheckedChange = onKeepAwakeChanged,
                    enabled = !state.isLoadingBridgeStatus,
                )
            }

            state.bridgeUpdatePrompt?.takeIf { it.shouldPrompt }?.let { prompt ->
                Text(
                    text = prompt.title ?: "Bridge update available",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                )
                prompt.message?.takeIf { it.isNotBlank() }?.let { message ->
                    Text(
                        text = message,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                prompt.upgradeCommand?.takeIf { it.isNotBlank() }?.let { command ->
                    Text(
                        text = command,
                        style = MaterialTheme.typography.bodyMedium.copy(fontFamily = monoFamily),
                    )
                    SettingsButton(
                        title = if (copiedUpgradeCommand) "Copied upgrade command" else "Copy upgrade command",
                        onClick = {
                            clipboardManager.setText(androidx.compose.ui.text.AnnotatedString(command))
                            haptic.triggerImpactFeedback(com.coderover.android.ui.shared.HapticFeedback.Style.LIGHT)
                            copiedUpgradeCommand = true
                        },
                    )
                }
            }
        } else if (state.isConnected) {
            if (state.isLoadingBridgeStatus) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    androidx.compose.material3.CircularProgressIndicator(
                        modifier = Modifier.size(16.dp),
                        strokeWidth = 2.dp,
                    )
                    Text(
                        text = "Reading bridge status from your Mac...",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            } else {
                Text(
                    text = "Bridge status is unavailable for this connection.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        } else {
            Text(
                text = "Connect to a paired Mac to read bridge version, update guidance, and keep-awake state.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun SettingsPairingCard(
    pairing: PairingRecord,
    isActive: Boolean,
    isConnected: Boolean,
    isBusy: Boolean,
    onSelectPairing: () -> Unit,
    onRemovePairing: () -> Unit,
) {
    Column(
        modifier = Modifier.padding(vertical = 2.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = pairing.transportCandidates.firstOrNull()?.label ?: pairing.macDeviceId,
                fontWeight = FontWeight.SemiBold,
                style = MaterialTheme.typography.titleSmall,
                modifier = Modifier.weight(1f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = when {
                    isConnected -> "Connected"
                    isActive -> "Selected"
                    else -> "Saved"
                },
                fontWeight = FontWeight.SemiBold,
                style = MaterialTheme.typography.labelSmall,
                color = if (isConnected) CommandAccent else MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        Text(
            text = "${pairing.transportCandidates.size} saved transport${if (pairing.transportCandidates.size == 1) "" else "s"}",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        if (!isActive) {
            SettingsButton(
                title = if (isConnected) "Switch to This Mac" else "Use This Mac",
                enabled = !isBusy,
                onClick = onSelectPairing,
            )
        }

        SettingsButton(
            title = if (isActive) "Remove This Mac" else "Remove",
            isDestructive = true,
            enabled = !isBusy,
            onClick = onRemovePairing,
        )
    }
}

@Composable
private fun SettingsButton(
    title: String,
    isDestructive: Boolean = false,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    Surface(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(10.dp),
        color = if (isDestructive) {
            Danger.copy(alpha = 0.06f)
        } else {
            MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.42f)
        },
        border = androidx.compose.foundation.BorderStroke(
            1.dp,
            if (isDestructive) {
                Danger.copy(alpha = 0.12f)
            } else {
                MaterialTheme.colorScheme.outline.copy(alpha = 0.12f)
            },
        ),
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 10.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                title,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                fontWeight = FontWeight.Medium,
                color = if (isDestructive) Danger else MaterialTheme.colorScheme.onSurface,
            )
        }
    }
}

@Composable
fun SettingsNotificationsCard() {
    val context = LocalContext.current
    val notificationsEnabled = remember {
        NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    SettingsCard(title = "Notifications") {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                androidx.compose.material3.Icon(Icons.Outlined.Notifications, contentDescription = null)
                Text("Status", style = MaterialTheme.typography.bodyLarge)
            }
            Text(
                text = if (notificationsEnabled) "Authorized" else "Denied",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Text(
            text = "Used for local alerts when a run finishes while Android is in the background.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        val haptic = com.coderover.android.ui.shared.HapticFeedback.rememberHapticFeedback()
        if (!notificationsEnabled) {
            SettingsButton(
                title = "Open Android Settings",
                onClick = {
                    haptic.triggerImpactFeedback(com.coderover.android.ui.shared.HapticFeedback.Style.LIGHT)
                    val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
                        putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                    }
                    context.startActivity(intent)
                },
            )
        }
    }
}

@Composable
fun SettingsArchivedChatsCard(
    threads: List<ThreadSummary>,
    onOpenArchivedChats: () -> Unit,
) {
    val archivedCount = remember(threads) {
        threads.count { it.syncState == com.coderover.android.data.model.ThreadSyncState.ARCHIVED_LOCAL }
    }

    SettingsCard(title = "Archived Chats") {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable { onOpenArchivedChats() }
                .padding(vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                androidx.compose.material3.Icon(Icons.Outlined.Archive, contentDescription = null)
                Text("Archived Chats", style = MaterialTheme.typography.bodyLarge)
            }
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                if (archivedCount > 0) {
                    Text(
                        text = archivedCount.toString(),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                androidx.compose.material3.Icon(
                    imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
                    contentDescription = null,
                    modifier = Modifier.size(20.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                )
            }
        }
    }
}

@Composable
fun SettingsPairAnotherMacCard(
    importText: String,
    onImportTextChanged: (String) -> Unit,
    onImport: () -> Unit,
) {
    val clipboardManager = LocalClipboardManager.current
    SettingsCard(title = "Pair another Mac") {
        Text(
            text = "Import another local bridge pairing payload to switch between Macs without leaving Android.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        OutlinedTextField(
            value = importText,
            onValueChange = onImportTextChanged,
            modifier = Modifier.fillMaxWidth(),
            minLines = 5,
            label = { Text("Paste pairing payload") },
            shape = RoundedCornerShape(18.dp),
        )
        TextButton(
            onClick = {
                val clipboardText = clipboardManager.getText()?.text
                    ?.takeIf { it.isNotBlank() }
                    ?: return@TextButton
                onImportTextChanged(clipboardText)
            },
        ) {
            Text("Paste from Clipboard")
        }
        SettingsButton(title = "Import Pairing", onClick = onImport)
    }
}

@Composable
fun SettingsAboutCard() {
    SettingsCard(title = "About") {
        Text(
            text = "Chats are end-to-end encrypted between your Android phone and Mac. Local and tailnet transports only carry the encrypted wire stream and connection metadata.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
