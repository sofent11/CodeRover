import re

with open('RemodexAndroid/app/src/main/java/com/remodex/android/ui/screens/SidebarScreen.kt', 'r') as f:
    content = f.read()

# Fix the thread item badges and thin indicator
thread_item_old = r'Box\(\n\s+modifier = Modifier\n\s+\.padding\(top = 4\.dp\)\n\s+\.width\(3\.dp\)\n\s+\.height\(indicatorHeight\)\n\s+\.clip\(RoundedCornerShape\(999\.dp\)\)\n\s+\.background\(indicatorColor\),\n\s+\)'
thread_item_new = r'''Box(
                                    modifier = Modifier
                                        .padding(top = 4.dp)
                                        .width(2.dp)
                                        .height(indicatorHeight)
                                        .clip(RoundedCornerShape(999.dp))
                                        .background(indicatorColor),
                                )'''

content = re.sub(thread_item_old, thread_item_new, content)

# Inject badges next to the project tag
project_tag_old = r'Text\(\n\s+text = thread\.projectDisplayName,\n\s+style = MaterialTheme\.typography\.labelSmall,\n\s+color = if \(isSelected\) \{\n\s+MaterialTheme\.colorScheme\.primary\n\s+\} else \{\n\s+MaterialTheme\.colorScheme\.onSurfaceVariant\n\s+\},\n\s+modifier = Modifier\.padding\(horizontal = 8\.dp, vertical = 4\.dp\),\n\s+\)'

# I need to check if the thread is running or has diffs.
# I'll add a helper logic for that.
badge_logic = r'''Text(
                                                text = thread.projectDisplayName,
                                                style = MaterialTheme.typography.labelSmall,
                                                color = if (isSelected) {
                                                    MaterialTheme.colorScheme.primary
                                                } else {
                                                    MaterialTheme.colorScheme.onSurfaceVariant
                                                },
                                                modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                                            )
                                        }
                                        if (state.runningThreadIds.contains(thread.id)) {
                                            Surface(
                                                shape = RoundedCornerShape(4.dp),
                                                color = com.remodex.android.ui.theme.PlanAccent.copy(alpha = 0.15f),
                                            ) {
                                                Text(
                                                    text = "RUN",
                                                    style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Bold),
                                                    color = com.remodex.android.ui.theme.PlanAccent,
                                                    modifier = Modifier.padding(horizontal = 4.dp, vertical = 2.dp),
                                                )
                                            }
                                        }'''
content = re.sub(project_tag_old, badge_logic, content)

# Fix the Bottom Settings Button to be more subtle (Row style)
settings_button_old = r'FilledTonalButton\(\n\s+onClick = onOpenSettings,\n\s+modifier = Modifier\n\s+\.fillMaxWidth\(\)\n\s+\.padding\(16\.dp\),\n\s+shape = RoundedCornerShape\(18\.dp\),\n\s+\) \{\n\s+Icon\(Icons\.Outlined\.Settings, contentDescription = null\)\n\s+Spacer\(Modifier\.width\(8\.dp\)\)\n\s+Text\("Settings"\)\n\s+\}'
settings_button_new = r'''Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 12.dp)
                .clip(RoundedCornerShape(12.dp))
                .combinedClickable(onClick = onOpenSettings)
                .padding(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                Icons.Outlined.Settings,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(20.dp)
            )
            Spacer(Modifier.width(12.dp))
            Text(
                "Settings",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }'''
content = re.sub(settings_button_old, settings_button_new, content)

with open('RemodexAndroid/app/src/main/java/com/remodex/android/ui/screens/SidebarScreen.kt', 'w') as f:
    f.write(content)
