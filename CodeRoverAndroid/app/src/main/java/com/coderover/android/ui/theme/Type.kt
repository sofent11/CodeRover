package com.coderover.android.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.coderover.android.R
import com.coderover.android.data.model.AppFontStyle

private val geistFamily = FontFamily(
    Font(R.font.geist_regular, FontWeight.Normal),
    Font(R.font.geist_medium, FontWeight.Medium),
    Font(R.font.geist_semibold, FontWeight.SemiBold),
    Font(R.font.geist_bold, FontWeight.Bold),
)

val monoFamily = FontFamily(
    Font(R.font.jetbrains_mono_regular, FontWeight.Normal),
    Font(R.font.jetbrains_mono_medium, FontWeight.Medium),
    Font(R.font.jetbrains_mono_bold, FontWeight.Bold),
)

fun coderoverTypography(fontStyle: AppFontStyle): Typography {
    val prose = if (fontStyle == AppFontStyle.GEIST) geistFamily else FontFamily.Default
    return Typography(
        bodyLarge = TextStyle(fontFamily = prose, fontSize = 15.sp, lineHeight = 22.sp),
        bodyMedium = TextStyle(fontFamily = prose, fontSize = 14.sp, lineHeight = 20.sp),
        bodySmall = TextStyle(fontFamily = prose, fontSize = 12.sp, lineHeight = 18.sp),
        headlineSmall = TextStyle(fontFamily = prose, fontSize = 20.sp, fontWeight = FontWeight.Bold),
        titleLarge = TextStyle(fontFamily = prose, fontSize = 20.sp, fontWeight = FontWeight.Bold),
        titleMedium = TextStyle(fontFamily = prose, fontSize = 18.sp, fontWeight = FontWeight.Medium),
        titleSmall = TextStyle(fontFamily = prose, fontSize = 15.5.sp, fontWeight = FontWeight.SemiBold),
        labelLarge = TextStyle(fontFamily = prose, fontSize = 14.sp, fontWeight = FontWeight.Medium),
        labelMedium = TextStyle(fontFamily = prose, fontSize = 11.sp, fontWeight = FontWeight.Medium),
        labelSmall = TextStyle(fontFamily = prose, fontSize = 10.sp, fontWeight = FontWeight.Bold),
    )
}
