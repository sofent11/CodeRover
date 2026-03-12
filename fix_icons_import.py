with open('RemodexAndroid/app/src/main/java/com/remodex/android/ui/RemodexApp.kt', 'r') as f:
    content = f.read()

import_str = "import androidx.compose.material.icons.outlined.Settings\nimport androidx.compose.material.icons.filled.KeyboardArrowDown\nimport androidx.compose.material.icons.filled.KeyboardArrowUp\n"
content = content.replace("import androidx.compose.material.icons.outlined.Settings\n", import_str)

with open('RemodexAndroid/app/src/main/java/com/remodex/android/ui/RemodexApp.kt', 'w') as f:
    f.write(content)
