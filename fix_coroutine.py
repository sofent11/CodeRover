with open('RemodexAndroid/app/src/main/java/com/remodex/android/ui/components/ComposerCard.kt', 'r') as f:
    content = f.read()

content = content.replace("fun ComposerCard(", "fun ComposerCard(")
if "val scope = rememberCoroutineScope()" not in content:
    content = content.replace("var isPlanModeArmed by rememberSaveable(state.selectedThreadId) { mutableStateOf(false) }", "val scope = rememberCoroutineScope()\n    var isPlanModeArmed by rememberSaveable(state.selectedThreadId) { mutableStateOf(false) }")
    if "rememberCoroutineScope" not in content:
        content = "import androidx.compose.runtime.rememberCoroutineScope\nimport kotlinx.coroutines.launch\n" + content

with open('RemodexAndroid/app/src/main/java/com/remodex/android/ui/components/ComposerCard.kt', 'w') as f:
    f.write(content)
