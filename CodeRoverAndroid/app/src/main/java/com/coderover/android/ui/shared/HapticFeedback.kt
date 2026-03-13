package com.coderover.android.ui.shared

import android.content.Context
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext

/**
 * Android implementation of the light impact feedback used in CodeRoverMobile (iOS).
 */
class HapticFeedback(private val context: Context) {
    private val vibrator: Vibrator? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        val vibratorManager = context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager
        vibratorManager?.defaultVibrator
    } else {
        @Suppress("DEPRECATION")
        context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
    }

    enum class Style {
        LIGHT, MEDIUM, HEAVY
    }

    fun triggerImpactFeedback(style: Style = Style.LIGHT) {
        val effect = when (style) {
            Style.LIGHT -> VibrationEffect.createOneShot(10, VibrationEffect.DEFAULT_AMPLITUDE)
            Style.MEDIUM -> VibrationEffect.createOneShot(20, VibrationEffect.DEFAULT_AMPLITUDE)
            Style.HEAVY -> VibrationEffect.createOneShot(40, VibrationEffect.DEFAULT_AMPLITUDE)
        }
        vibrator?.vibrate(effect)
    }

    companion object {
        @Composable
        fun rememberHapticFeedback(): HapticFeedback {
            val context = LocalContext.current
            return remember(context) { HapticFeedback(context) }
        }
    }
}
