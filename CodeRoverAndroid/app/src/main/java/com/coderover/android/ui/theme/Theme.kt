package com.coderover.android.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import com.coderover.android.data.model.AppFontStyle

private val lightScheme = lightColorScheme(
    background = Background,
    surface = Surface,
    surfaceVariant = SurfaceMuted,
    onBackground = Ink,
    onSurface = Ink,
    onSurfaceVariant = InkMuted,
    primary = Ink,
    onPrimary = Surface,
    secondary = InkMuted,
    outline = Border,
    outlineVariant = BorderStrong,
    tertiary = SurfaceMuted,
    onTertiary = Ink,
    scrim = Ink.copy(alpha = 0.68f),
    error = Danger,
)

private val darkScheme = darkColorScheme(
    background = DarkBackground,
    surface = DarkSurface,
    surfaceVariant = DarkSurfaceMuted,
    onBackground = DarkInk,
    onSurface = DarkInk,
    onSurfaceVariant = DarkInkMuted,
    primary = DarkInk,
    onPrimary = DarkSurface,
    secondary = DarkInkMuted,
    outline = DarkBorder,
    outlineVariant = DarkBorderStrong,
    tertiary = DarkSurfaceMuted,
    onTertiary = DarkInk,
    scrim = Color.Black.copy(alpha = 0.76f),
    error = Danger,
)

@Composable
fun CodeRoverTheme(
    fontStyle: AppFontStyle,
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) darkScheme else lightScheme,
        typography = coderoverTypography(fontStyle),
        content = content,
    )
}
