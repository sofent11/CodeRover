package com.coderover.android.ui.settings

import android.content.Intent
import android.provider.Settings
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material.icons.outlined.PowerSettingsNew
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
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

        SettingsPickerRow(
            label = "Access",
            selectedValue = state.accessMode,
            options = AccessMode.entries.filter { mode ->
                state.selectedProvider.accessModes.any { it.id == mode.rawValue }
            }.ifEmpty { AccessMode.entries },
            displayValue = { it.displayName },
            onValueSelected = onAccessModeSelected,
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
    SettingsCard(title = "Connection") {
        Row(
            modifier = Modifier.horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            SettingsInfoPill(
                label = "Bridge",
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
        }

        state.secureMacFingerprint?.let { fingerprint ->
            Text(
                text = "Trusted Mac: $fingerprint",
                style = MaterialTheme.typography.bodyMedium.copy(fontFamily = monoFamily),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        when (state.connectionPhase) {
            com.coderover.android.data.model.ConnectionPhase.CONNECTING -> {
                Text(
                    text = "Connecting to bridge...",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            com.coderover.android.data.model.ConnectionPhase.LOADING_CHATS -> {
                Text(
                    text = "Loading chats...",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            com.coderover.android.data.model.ConnectionPhase.SYNCING -> {
                Text(
                    text = "Syncing workspace...",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            com.coderover.android.data.model.ConnectionPhase.CONNECTED,
            com.coderover.android.data.model.ConnectionPhase.OFFLINE -> Unit
        }

        state.pairings.forEach { pairing ->
            SettingsPairingCard(
                pairing = pairing,
                isActive = pairing.macDeviceId == state.activePairingMacDeviceId,
                isConnected = state.isConnected && pairing.macDeviceId == state.activePairingMacDeviceId,
                isBusy = connectionActionInFlight,
                onSelectPairing = { onSelectPairing(pairing.macDeviceId) },
                onRemovePairing = { onRemovePairing(pairing.macDeviceId) },
                onPreferredTransportSelected = { url ->
                    onPreferredTransportSelected(pairing.macDeviceId, url)
                },
            )
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Button(
                onClick = {
                    haptic.triggerImpactFeedback()
                    onReconnect()
                },
                enabled = !connectionActionInFlight,
                modifier = Modifier.weight(1f),
                contentPadding = PaddingValues(horizontal = 8.dp)
            ) {
                androidx.compose.material3.Icon(Icons.Outlined.Refresh, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(4.dp))
                Text("Reconnect", maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            OutlinedButton(
                onClick = {
                    haptic.triggerImpactFeedback(com.coderover.android.ui.shared.HapticFeedback.Style.MEDIUM)
                    onDisconnect()
                },
                enabled = !connectionActionInFlight,
                modifier = Modifier.weight(1f),
                contentPadding = PaddingValues(horizontal = 8.dp)
            ) {
                androidx.compose.material3.Icon(Icons.Outlined.PowerSettingsNew, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(4.dp))
                Text("Disconnect", maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
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
    onPreferredTransportSelected: (String) -> Unit,
) {
    Surface(
        shape = RoundedCornerShape(20.dp),
        color = MaterialTheme.colorScheme.surface.copy(alpha = 0.7f),
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    text = pairing.transportCandidates.firstOrNull()?.label ?: pairing.macDeviceId,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier
                        .fillMaxWidth(0.72f)
                        .padding(end = 8.dp),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                StatusTag(
                    text = when {
                        isConnected -> "Connected"
                        isActive -> "Selected"
                        else -> "Saved"
                    },
                    containerColor = if (isActive) CommandAccent.copy(alpha = 0.12f) else MaterialTheme.colorScheme.surfaceVariant,
                    contentColor = if (isActive) CommandAccent else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            if (pairing.transportCandidates.size > 1) {
                val selectedTransport = pairing.transportCandidates.firstOrNull {
                    it.url == (pairing.preferredTransportUrl ?: pairing.lastSuccessfulTransportUrl)
                } ?: pairing.transportCandidates.first()
                SettingsPickerRow(
                    label = "Transport",
                    selectedValue = selectedTransport,
                    options = pairing.transportCandidates,
                    displayValue = { it.label ?: it.url },
                    onValueSelected = {
                        if (!isBusy) {
                            onPreferredTransportSelected(it.url)
                        }
                    },
                )
                Text(
                    text = if (pairing.preferredTransportUrl.isNullOrBlank()) {
                        "Current preference: Auto"
                    } else {
                        "Current preference: ${selectedTransport.label ?: selectedTransport.url}"
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            Text(
                text = "${pairing.transportCandidates.size} saved transport(s)",
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (!isActive) {
                    OutlinedButton(
                        onClick = onSelectPairing,
                        enabled = !isBusy,
                    ) {
                        Text(if (isConnected) "Switch to This Mac" else "Use This Mac")
                    }
                }
                TextButton(
                    onClick = onRemovePairing,
                    enabled = !isBusy,
                ) {
                    Text("Remove", color = Danger)
                }
            }
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
                text = if (notificationsEnabled) "Enabled" else "Disabled",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Text(
            text = "Used for local alerts when a run finishes while Android is in the background.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        OutlinedButton(
            onClick = {
                val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
                    putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                }
                context.startActivity(intent)
            },
        ) {
            Text("Open Android notification settings")
        }
    }
}

@Composable
fun SettingsArchivedChatsCard(
    threads: List<ThreadSummary>,
    onUnarchiveThread: (String) -> Unit,
) {
    val archivedThreads = remember(threads) {
        threads.filter { it.syncState == com.coderover.android.data.model.ThreadSyncState.ARCHIVED_LOCAL }
            .sortedByDescending { it.updatedAt ?: it.createdAt ?: 0L }
    }
    var expanded by rememberSaveable { mutableStateOf(false) }

    SettingsCard(title = "Archived chats") {
        Row(
            modifier = Modifier.fillMaxWidth(),
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
            Text(
                text = archivedThreads.size.toString(),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        if (archivedThreads.isEmpty()) {
            Text(
                text = "No archived conversations yet.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            TextButton(onClick = { expanded = !expanded }) {
                Text(if (expanded) "Hide archived chats" else "Show archived chats")
            }
            if (expanded) {
                archivedThreads.forEach { thread ->
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(
                            modifier = Modifier
                                .fillMaxWidth(0.72f)
                                .padding(end = 8.dp),
                        ) {
                            Text(
                                text = thread.displayTitle,
                                style = MaterialTheme.typography.bodyLarge,
                            )
                            val subtitle = listOfNotNull(
                                thread.projectDisplayName.takeIf { it.isNotBlank() },
                                relativeTimeLabel(thread.updatedAt ?: thread.createdAt),
                            ).joinToString(" • ")
                            if (subtitle.isNotBlank()) {
                                Text(
                                    text = subtitle,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                        TextButton(onClick = { onUnarchiveThread(thread.id) }) {
                            Text("Unarchive")
                        }
                    }
                }
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
        Button(onClick = onImport, shape = RoundedCornerShape(16.dp)) {
            Text("Import Pairing")
        }
    }
}

@Composable
fun SettingsAboutCard() {
    SettingsCard(title = "About") {
        Text(
            text = "Chats are end-to-end encrypted between your Android phone and Mac. Local or tailnet transports only see encrypted traffic and connection metadata.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Row(
            modifier = Modifier.horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            SettingsInfoPill(
                label = "Runtime",
                value = "Mac-hosted",
                accent = MaterialTheme.colorScheme.primary,
            )
            SettingsInfoPill(
                label = "Bridge",
                value = "Local",
                accent = CommandAccent,
            )
            SettingsInfoPill(
                label = "Transport",
                value = "QR pairing",
                accent = MaterialTheme.colorScheme.tertiary,
            )
        }
    }
}
