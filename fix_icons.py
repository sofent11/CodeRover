with open('RemodexAndroid/app/src/main/java/com/remodex/android/ui/RemodexApp.kt', 'r') as f:
    content = f.read()

content = content.replace("androidx.compose.material.icons.outlined.ExpandLess", "androidx.compose.material.icons.Icons.Default.KeyboardArrowUp")
content = content.replace("androidx.compose.material.icons.outlined.ExpandMore", "androidx.compose.material.icons.Icons.Default.KeyboardArrowDown")

with open('RemodexAndroid/app/src/main/java/com/remodex/android/ui/RemodexApp.kt', 'w') as f:
    f.write(content)
