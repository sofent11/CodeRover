import re

with open("RemodexAndroid/app/src/main/java/com/remodex/android/ui/RemodexApp.kt", "r") as f:
    content = f.read()

# Make GlassCard and relativeTimeLabel internal
content = re.sub(r'private fun GlassCard', 'internal fun GlassCard', content)
content = re.sub(r'private fun relativeTimeLabel', 'internal fun relativeTimeLabel', content)
content = re.sub(r'private fun StatusTag', 'internal fun StatusTag', content)
content = re.sub(r'private fun statusLabel', 'internal fun statusLabel', content)

# Also CommandAccent and Border are in com.remodex.android.ui.theme

# Extract SidebarContent
sidebar_match = re.search(r'@Composable\nprivate fun SidebarContent\((.*?)\n\}', content, re.DOTALL)
if sidebar_match:
    sidebar_code = sidebar_match.group(0)
    # Remove it from RemodexApp.kt
    # Note: we should replace it safely. But wait, it ends with a closing brace. 
    # Let's do a more robust extraction.
    
    start_idx = content.find('@Composable\nprivate fun SidebarContent')
    if start_idx != -1:
        # find matching closing brace
        brace_count = 0
        end_idx = -1
        in_string = False
        escape = False
        started = False
        
        # skip over @Composable and signature to the first '{'
        first_brace = content.find('{', start_idx)
        for i in range(first_brace, len(content)):
            char = content[i]
            if char == '"' and not escape:
                in_string = not in_string
            elif char == '\\':
                escape = not escape
            else:
                escape = False
                
            if not in_string:
                if char == '{':
                    brace_count += 1
                    started = True
                elif char == '}':
                    brace_count -= 1
                    
            if started and brace_count == 0:
                end_idx = i + 1
                break
                
        if end_idx != -1:
            sidebar_code = content[start_idx:end_idx]
            content = content[:start_idx] + content[end_idx:]

# Ensure SidebarScreen is imported in RemodexApp.kt
import_stmt = "import com.remodex.android.ui.screens.SidebarScreen\n"
if "import com.remodex.android.ui.screens.SidebarScreen" not in content:
    content = content.replace("import com.remodex.android.ui.components.PairingScannerView", 
                              "import com.remodex.android.ui.components.PairingScannerView\n" + import_stmt)

# Update RemodexApp.kt usages
content = content.replace("SidebarContent(", "SidebarScreen(")
content = content.replace("onCreateThread = {\n                        showSettings = false\n                        showPairingEntry = false\n                        viewModel.createThread()\n                        scope.launch { drawerState.close() }\n                    },",
"""onCreateThread = { project ->
                        showSettings = false
                        showPairingEntry = false
                        viewModel.createThread(project)
                        scope.launch { drawerState.close() }
                    },
                    onDeleteThread = viewModel::deleteThread,
                    onArchiveThread = viewModel::archiveThread,
                    onUnarchiveThread = viewModel::unarchiveThread,
                    onRenameThread = viewModel::renameThread,""")

with open("RemodexAndroid/app/src/main/java/com/remodex/android/ui/RemodexApp.kt", "w") as f:
    f.write(content)

