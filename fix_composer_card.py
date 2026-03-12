import re

with open('RemodexAndroid/app/src/main/java/com/remodex/android/ui/components/ComposerCard.kt', 'r') as f:
    content = f.read()

# Fix the import issue
import_block = """
import androidx.compose.foundation.Canvas
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
"""

content = re.sub(r'import androidx\.compose\.foundation\.Canvas.*StrokeCap\nimport androidx\.compose\.ui\.graphics\.drawscope\.Stroke', '', content, flags=re.DOTALL)
lines = content.split('\n')
for i, line in enumerate(lines):
    if line.startswith('import '):
        lines.insert(i, import_block.strip())
        break
content = '\n'.join(lines)

# Fix the coroutine scope issue
content = content.replace("coroutineScope.launch {", "scope.launch {")
content = content.replace("val coroutineScope = rememberCoroutineScope()", "val scope = rememberCoroutineScope()")

with open('RemodexAndroid/app/src/main/java/com/remodex/android/ui/components/ComposerCard.kt', 'w') as f:
    f.write(content)
