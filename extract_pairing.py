import os
import re

with open('RemodexAndroid/app/src/main/java/com/remodex/android/ui/RemodexApp.kt', 'r') as f:
    content = f.read()

match = re.search(r'(@Composable\nprivate fun PairingEntryScreen.*?)\n@Composable\n@OptIn', content, re.DOTALL)
if match:
    component_code = match.group(1)
    # Remove from RemodexApp.kt
    new_content = content.replace(component_code, "")
    
    with open('RemodexAndroid/app/src/main/java/com/remodex/android/ui/RemodexApp.kt', 'w') as f:
        f.write(new_content)

    imports = """package com.remodex.android.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.remodex.android.ui.components.PairingScannerView
import com.remodex.android.ui.internal.GlassCard
import com.remodex.android.ui.theme.Danger

"""
    # Fix privacy: `private fun PairingEntryScreen` -> `fun PairingEntryScreen`
    component_code = component_code.replace('private fun PairingEntryScreen', 'fun PairingEntryScreen')
    
    with open('RemodexAndroid/app/src/main/java/com/remodex/android/ui/screens/PairingEntryScreen.kt', 'w') as f:
        f.write(imports + component_code)
