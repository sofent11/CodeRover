package com.remodex.android.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import com.remodex.android.data.model.AppFontStyle

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
    error = Danger,
)

private val darkScheme = darkColorScheme(
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
    error = Danger,
)

@Composable
fun RemodexTheme(
    fontStyle: AppFontStyle,
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) darkScheme else lightScheme,
        typography = remodexTypography(fontStyle),
        content = content,
    )
}
