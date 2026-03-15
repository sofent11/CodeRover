package com.coderover.android.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.coderover.android.app.AppViewModel
import com.coderover.android.data.model.AppState
import com.coderover.android.ui.settings.SettingsAboutCard
import com.coderover.android.ui.settings.SettingsAppearanceCard
import com.coderover.android.ui.settings.SettingsArchivedChatsCard
import com.coderover.android.ui.settings.SettingsConnectionCard
import com.coderover.android.ui.settings.SettingsNotificationsCard
import com.coderover.android.ui.settings.SettingsRuntimeDefaultsCard

@Composable
fun SettingsScreen(
    state: AppState,
    viewModel: AppViewModel,
    onDisconnect: () -> Unit = viewModel::disconnect,
    onOpenArchivedChats: () -> Unit = {},
) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(24.dp),
    ) {
        item {
            SettingsArchivedChatsCard(
                threads = state.threads,
                onOpenArchivedChats = onOpenArchivedChats,
            )
        }

        item {
            SettingsAppearanceCard(
                fontStyle = state.fontStyle,
                onFontStyleSelected = viewModel::setFontStyle,
            )
        }

        item {
            SettingsNotificationsCard()
        }

        item {
            SettingsRuntimeDefaultsCard(
                state = state,
                onProviderSelected = viewModel::setSelectedProviderId,
                onAccessModeSelected = viewModel::setAccessMode,
                onModelSelected = viewModel::setSelectedModelId,
                onReasoningSelected = viewModel::setSelectedReasoningEffort,
            )
        }

        item {
            SettingsConnectionCard(
                state = state,
                onReconnect = viewModel::connectActivePairing,
                onDisconnect = onDisconnect,
                onSelectPairing = viewModel::selectPairing,
                onRemovePairing = viewModel::removePairing,
                onPreferredTransportSelected = viewModel::setPreferredTransport,
            )
        }

        item {
            SettingsAboutCard()
        }
    }
}
