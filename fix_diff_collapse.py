import re

with open('RemodexAndroid/app/src/main/java/com/remodex/android/ui/RemodexApp.kt', 'r') as f:
    content = f.read()

diff_dialog_old = """private fun DiffDetailDialog(
    title: String,
    files: List<DiffFileDetailUi>,
    fallbackBody: String,
    onDismiss: () -> Unit,
) {"""

diff_dialog_new = """private fun DiffDetailDialog(
    title: String,
    files: List<DiffFileDetailUi>,
    fallbackBody: String,
    onDismiss: () -> Unit,
) {
    var expandedFileIds by androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf(emptySet<String>()) }
    val allExpanded = files.isNotEmpty() && files.all { expandedFileIds.contains(it.path) }
"""

content = content.replace(diff_dialog_old, diff_dialog_new)

diff_dialog_body_old = """                    Text(
                        text = title,
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.weight(1f),
                    )
                    TextButton(onClick = onDismiss) {
                        Text("Close")
                    }"""
diff_dialog_body_new = """                    Text(
                        text = title,
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.weight(1f),
                    )
                    if (files.isNotEmpty()) {
                        TextButton(onClick = {
                            expandedFileIds = if (allExpanded) emptySet() else files.map { it.path }.toSet()
                        }) {
                            Text(if (allExpanded) "Collapse All" else "Expand All")
                        }
                    }
                    TextButton(onClick = onDismiss) {
                        Text("Close")
                    }"""
content = content.replace(diff_dialog_body_old, diff_dialog_body_new)

diff_item_old = """                            DiffFileDetailCard(file)"""
diff_item_new = """                            DiffFileDetailCard(
                                file = file,
                                isExpanded = expandedFileIds.contains(file.path),
                                onToggleExpand = {
                                    expandedFileIds = if (expandedFileIds.contains(file.path)) {
                                        expandedFileIds - file.path
                                    } else {
                                        expandedFileIds + file.path
                                    }
                                }
                            )"""
content = content.replace(diff_item_old, diff_item_new)

card_old = """private fun DiffFileDetailCard(file: DiffFileDetailUi) {
    val accent = fileChangeAccentColor(file.actionLabel)
    Surface(
        shape = RoundedCornerShape(20.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.45f),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {"""

card_new = """private fun DiffFileDetailCard(
    file: DiffFileDetailUi,
    isExpanded: Boolean,
    onToggleExpand: () -> Unit,
) {
    val accent = fileChangeAccentColor(file.actionLabel)
    Surface(
        shape = RoundedCornerShape(20.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.45f),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clickable { onToggleExpand() }
                .padding(horizontal = 14.dp, vertical = 14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {"""
content = content.replace(card_old, card_new)

card_body_old = """            if (file.additions > 0 || file.deletions > 0) {
                Text(
                    text = buildString {
                        if (file.additions > 0) append("+${file.additions}")
                        if (file.deletions > 0) {
                            if (isNotEmpty()) append(" ")
                            append("-${file.deletions}")
                        }
                    },
                    style = MaterialTheme.typography.labelMedium.copy(fontFamily = monoFamily),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (file.hunks.isNotEmpty()) {"""

card_body_new = """            if (file.additions > 0 || file.deletions > 0) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = buildString {
                            if (file.additions > 0) append("+${file.additions}")
                            if (file.deletions > 0) {
                                if (isNotEmpty()) append(" ")
                                append("-${file.deletions}")
                            }
                        },
                        style = MaterialTheme.typography.labelMedium.copy(fontFamily = monoFamily),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Icon(
                        imageVector = if (isExpanded) androidx.compose.material.icons.Icons.Outlined.ExpandLess else androidx.compose.material.icons.Icons.Outlined.ExpandMore,
                        contentDescription = null,
                        modifier = Modifier.size(16.dp),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            } else {
                Icon(
                    imageVector = if (isExpanded) androidx.compose.material.icons.Icons.Outlined.ExpandLess else androidx.compose.material.icons.Icons.Outlined.ExpandMore,
                    contentDescription = null,
                    modifier = Modifier.size(16.dp).align(Alignment.End),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            if (isExpanded && file.hunks.isNotEmpty()) {"""
content = content.replace(card_body_old, card_body_new)

card_body2_old = """            } else if (file.rawBody.isNotBlank()) {"""
card_body2_new = """            } else if (isExpanded && file.rawBody.isNotBlank()) {"""
content = content.replace(card_body2_old, card_body2_new)

with open('RemodexAndroid/app/src/main/java/com/remodex/android/ui/RemodexApp.kt', 'w') as f:
    f.write(content)
