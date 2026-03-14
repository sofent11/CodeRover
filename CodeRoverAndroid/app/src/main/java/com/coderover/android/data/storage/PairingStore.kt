package com.coderover.android.data.storage

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.coderover.android.data.model.AccessMode
import com.coderover.android.data.model.AppFontStyle
import com.coderover.android.data.model.ChatMessage
import com.coderover.android.data.model.PairingRecord
import com.coderover.android.data.model.PhoneIdentityState
import com.coderover.android.data.model.ThreadHistoryState
import com.coderover.android.data.model.ThreadSummary
import com.coderover.android.data.model.TrustedMacRegistry
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json

class PairingStore(context: Context) {
    private val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
    }

    private val prefs = EncryptedSharedPreferences.create(
        context,
        "coderover_android_secure_store",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    fun loadOnboardingSeen(): Boolean = prefs.getBoolean(KEY_ONBOARDING_SEEN, false)

    fun saveOnboardingSeen(seen: Boolean) {
        prefs.edit().putBoolean(KEY_ONBOARDING_SEEN, seen).apply()
    }

    fun loadFontStyle(): AppFontStyle {
        return runCatching {
            AppFontStyle.valueOf(prefs.getString(KEY_FONT_STYLE, AppFontStyle.SYSTEM.name).orEmpty())
        }.getOrDefault(AppFontStyle.SYSTEM)
    }

    fun saveFontStyle(fontStyle: AppFontStyle) {
        prefs.edit().putString(KEY_FONT_STYLE, fontStyle.name).apply()
    }

    fun loadSelectedProviderId(): String? = prefs.getString(KEY_SELECTED_PROVIDER_ID, null)

    fun saveSelectedProviderId(providerId: String?) {
        prefs.edit().putString(KEY_SELECTED_PROVIDER_ID, providerId).apply()
    }

    fun loadAccessMode(providerId: String? = null): AccessMode {
        val scopedKey = providerKey(KEY_ACCESS_MODE, providerId)
        val storedValue = prefs.getString(scopedKey, null)
            ?: prefs.getString(KEY_ACCESS_MODE, AccessMode.ON_REQUEST.rawValue)
        return AccessMode.fromRawValue(storedValue)
    }

    fun saveAccessMode(accessMode: AccessMode, providerId: String? = null) {
        prefs.edit().putString(providerKey(KEY_ACCESS_MODE, providerId), accessMode.rawValue).apply()
    }

    fun loadPairings(): List<PairingRecord> {
        val encoded = prefs.getString(KEY_PAIRINGS, null) ?: return emptyList()
        return runCatching {
            json.decodeFromString(ListSerializer(PairingRecord.serializer()), encoded)
        }.getOrDefault(emptyList())
    }

    fun savePairings(pairings: List<PairingRecord>) {
        prefs.edit()
            .putString(KEY_PAIRINGS, json.encodeToString(ListSerializer(PairingRecord.serializer()), pairings))
            .apply()
    }

    fun loadActivePairingMacDeviceId(): String? = prefs.getString(KEY_ACTIVE_PAIRING, null)

    fun saveActivePairingMacDeviceId(macDeviceId: String?) {
        prefs.edit().putString(KEY_ACTIVE_PAIRING, macDeviceId).apply()
    }

    fun loadPhoneIdentityState(): PhoneIdentityState? {
        val encoded = prefs.getString(KEY_PHONE_IDENTITY, null) ?: return null
        return runCatching {
            json.decodeFromString(PhoneIdentityState.serializer(), encoded)
        }.getOrNull()
    }

    fun savePhoneIdentityState(identityState: PhoneIdentityState) {
        prefs.edit()
            .putString(KEY_PHONE_IDENTITY, json.encodeToString(PhoneIdentityState.serializer(), identityState))
            .apply()
    }

    fun loadTrustedMacRegistry(): TrustedMacRegistry {
        val encoded = prefs.getString(KEY_TRUSTED_MACS, null) ?: return TrustedMacRegistry()
        return runCatching {
            json.decodeFromString(TrustedMacRegistry.serializer(), encoded)
        }.getOrDefault(TrustedMacRegistry())
    }

    fun saveTrustedMacRegistry(registry: TrustedMacRegistry) {
        prefs.edit()
            .putString(KEY_TRUSTED_MACS, json.encodeToString(TrustedMacRegistry.serializer(), registry))
            .apply()
    }

    fun loadSelectedModelId(providerId: String? = null): String? {
        return prefs.getString(providerKey(KEY_SELECTED_MODEL_ID, providerId), null)
            ?: prefs.getString(KEY_SELECTED_MODEL_ID, null)
    }

    fun saveSelectedModelId(modelId: String?, providerId: String? = null) {
        prefs.edit().putString(providerKey(KEY_SELECTED_MODEL_ID, providerId), modelId).apply()
    }

    fun loadSelectedReasoningEffort(providerId: String? = null): String? {
        return prefs.getString(providerKey(KEY_SELECTED_REASONING, providerId), null)
            ?: prefs.getString(KEY_SELECTED_REASONING, null)
    }

    fun saveSelectedReasoningEffort(reasoningEffort: String?, providerId: String? = null) {
        prefs.edit().putString(providerKey(KEY_SELECTED_REASONING, providerId), reasoningEffort).apply()
    }

    fun loadCachedThreads(): List<ThreadSummary> {
        val encoded = prefs.getString(KEY_CACHED_THREADS, null) ?: return emptyList()
        return runCatching {
            json.decodeFromString(ListSerializer(ThreadSummary.serializer()), encoded)
        }.getOrDefault(emptyList())
    }

    fun saveCachedThreads(threads: List<ThreadSummary>) {
        prefs.edit()
            .putString(KEY_CACHED_THREADS, json.encodeToString(ListSerializer(ThreadSummary.serializer()), threads))
            .apply()
    }

    fun loadCachedSelectedThreadId(): String? = prefs.getString(KEY_CACHED_SELECTED_THREAD_ID, null)

    fun saveCachedSelectedThreadId(threadId: String?) {
        prefs.edit().putString(KEY_CACHED_SELECTED_THREAD_ID, threadId).apply()
    }

    fun loadCachedMessagesByThread(): Map<String, List<ChatMessage>> {
        val encoded = prefs.getString(KEY_CACHED_MESSAGES_BY_THREAD, null) ?: return emptyMap()
        return runCatching {
            json.decodeFromString(
                MapSerializer(String.serializer(), ListSerializer(ChatMessage.serializer())),
                encoded,
            )
        }.getOrDefault(emptyMap())
    }

    fun saveCachedMessagesByThread(messagesByThread: Map<String, List<ChatMessage>>) {
        prefs.edit()
            .putString(
                KEY_CACHED_MESSAGES_BY_THREAD,
                json.encodeToString(
                    MapSerializer(String.serializer(), ListSerializer(ChatMessage.serializer())),
                    messagesByThread,
                ),
            )
            .apply()
    }

    fun loadCachedHistoryStateByThread(): Map<String, ThreadHistoryState> {
        val encoded = prefs.getString(KEY_CACHED_HISTORY_STATE_BY_THREAD, null) ?: return emptyMap()
        return runCatching {
            json.decodeFromString(
                MapSerializer(String.serializer(), ThreadHistoryState.serializer()),
                encoded,
            )
        }.getOrDefault(emptyMap())
    }

    fun saveCachedHistoryStateByThread(historyStateByThread: Map<String, ThreadHistoryState>) {
        prefs.edit()
            .putString(
                KEY_CACHED_HISTORY_STATE_BY_THREAD,
                json.encodeToString(
                    MapSerializer(String.serializer(), ThreadHistoryState.serializer()),
                    historyStateByThread.mapValues { (_, state) ->
                        state.copy(
                            isLoadingOlder = false,
                            isTailRefreshing = false,
                        )
                    },
                ),
            )
            .apply()
    }

    private companion object {
        const val KEY_ONBOARDING_SEEN = "onboarding_seen"
        const val KEY_FONT_STYLE = "font_style"
        const val KEY_ACCESS_MODE = "access_mode"
        const val KEY_SELECTED_PROVIDER_ID = "runtime.selected_provider_id"
        const val KEY_PAIRINGS = "pairings"
        const val KEY_ACTIVE_PAIRING = "active_pairing_mac_device_id"
        const val KEY_PHONE_IDENTITY = "phone_identity"
        const val KEY_TRUSTED_MACS = "trusted_macs"
        const val KEY_SELECTED_MODEL_ID = "selected_model_id"
        const val KEY_SELECTED_REASONING = "selected_reasoning_effort"
        const val KEY_CACHED_THREADS = "cached_threads"
        const val KEY_CACHED_SELECTED_THREAD_ID = "cached_selected_thread_id"
        const val KEY_CACHED_MESSAGES_BY_THREAD = "cached_messages_by_thread"
        const val KEY_CACHED_HISTORY_STATE_BY_THREAD = "cached_history_state_by_thread"
    }

    private fun providerKey(baseKey: String, providerId: String?): String {
        val normalizedProviderId = providerId?.trim()?.lowercase().orEmpty()
        if (normalizedProviderId.isEmpty()) {
            return baseKey
        }
        return "runtime.$normalizedProviderId.$baseKey"
    }
}
