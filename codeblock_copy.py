import re

with open('RemodexAndroid/app/src/main/java/com/remodex/android/ui/RemodexApp.kt', 'r') as f:
    content = f.read()

# I will find the CodeBlock logic and inject the copy button.
codeblock_old = """                    is MarkdownSegmentUi.CodeBlock -> {
                        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            segment.language?.takeIf(String::isNotEmpty)?.let { language ->
                                Text(
                                    text = language,
                                    style = MaterialTheme.typography.labelSmall.copy(fontFamily = monoFamily),
                                    color = textColor.copy(alpha = 0.72f),
                                )
                            }
                            Surface(
                                shape = RoundedCornerShape(12.dp),
                                color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.7f),
                            ) {
                                Text(
                                    text = segment.code.trimEnd(),
                                    style = MaterialTheme.typography.bodyMedium.copy(fontFamily = monoFamily),
                                    color = textColor,
                                    modifier = Modifier.padding(12.dp),
                                )
                            }
                        }
                    }"""

codeblock_new = """                    is MarkdownSegmentUi.CodeBlock -> {
                        Surface(
                            shape = RoundedCornerShape(12.dp),
                            color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.7f),
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Column {
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.85f))
                                        .padding(horizontal = 12.dp, vertical = 6.dp),
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    Text(
                                        text = segment.language?.takeIf(String::isNotEmpty) ?: "text",
                                        style = MaterialTheme.typography.labelSmall.copy(fontFamily = monoFamily),
                                        color = textColor.copy(alpha = 0.72f),
                                    )
                                    val context = androidx.compose.ui.platform.LocalContext.current
                                    val clipboardManager = context.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                                    var copied by androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf(false) }
                                    androidx.compose.runtime.LaunchedEffect(copied) {
                                        if (copied) {
                                            kotlinx.coroutines.delay(1500)
                                            copied = false
                                        }
                                    }
                                    androidx.compose.material3.IconButton(
                                        onClick = {
                                            clipboardManager.setPrimaryClip(android.content.ClipData.newPlainText("code", segment.code.trimEnd()))
                                            copied = true
                                        },
                                        modifier = Modifier.size(24.dp)
                                    ) {
                                        Icon(
                                            imageVector = if (copied) Icons.Outlined.Check else Icons.Outlined.ContentCopy,
                                            contentDescription = "Copy code",
                                            modifier = Modifier.size(14.dp),
                                            tint = if (copied) androidx.compose.ui.graphics.Color.Green else textColor.copy(alpha = 0.72f)
                                        )
                                    }
                                }
                                Box(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .horizontalScroll(rememberScrollState())
                                ) {
                                    Text(
                                        text = segment.code.trimEnd(),
                                        style = MaterialTheme.typography.bodyMedium.copy(fontFamily = monoFamily),
                                        color = textColor,
                                        modifier = Modifier.padding(12.dp),
                                    )
                                }
                            }
                        }
                    }"""

if codeblock_old in content:
    with open('RemodexAndroid/app/src/main/java/com/remodex/android/ui/RemodexApp.kt', 'w') as f:
        f.write(content.replace(codeblock_old, codeblock_new))
    print("Replaced!")
else:
    print("Not found")
