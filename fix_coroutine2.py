with open('RemodexAndroid/app/src/main/java/com/remodex/android/ui/components/ComposerCard.kt', 'r') as f:
    content = f.read()

content = content.replace("import androidx.compose.runtime.rememberCoroutineScope", "")
content = "import androidx.compose.runtime.rememberCoroutineScope\n" + content

with open('RemodexAndroid/app/src/main/java/com/remodex/android/ui/components/ComposerCard.kt', 'w') as f:
    f.write(content)
