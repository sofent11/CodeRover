with open('RemodexAndroid/app/src/main/java/com/remodex/android/ui/components/ComposerCard.kt', 'r') as f:
    content = f.read()

content = content.replace("import androidx.compose.runtime.rememberCoroutineScope\npackage", "package")
content = content.replace("import androidx.compose.animation.AnimatedVisibility", "import androidx.compose.runtime.rememberCoroutineScope\nimport kotlinx.coroutines.launch\nimport androidx.compose.animation.AnimatedVisibility")
content = content.replace("scope.launch {", "coroutineScope.launch {")
content = content.replace("val scope = rememberCoroutineScope()", "val coroutineScope = rememberCoroutineScope()")

with open('RemodexAndroid/app/src/main/java/com/remodex/android/ui/components/ComposerCard.kt', 'w') as f:
    f.write(content)
