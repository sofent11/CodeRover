package com.remodex.android.ui.turn

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.remodex.android.ui.theme.monoFamily

enum class TurnDiffLineKind {
    ADDITION, DELETION, HUNK, META, NEUTRAL;

    companion object {
        fun detectVerifiedPatch(code: String): Boolean {
            val lines = code.lines()
            if (lines.isEmpty()) return false

            var hasHunk = false
            var hasGitHeader = false
            var hasBodyChange = false
            var metadataEvidenceCount = 0

            for (line in lines) {
                if (line.startsWith("@@")) {
                    hasHunk = true
                    continue
                }

                if (line.startsWith("diff --git ") ||
                    line.startsWith("--- ") ||
                    line.startsWith("+++ ") ||
                    line.startsWith("index ") ||
                    line.startsWith("new file mode") ||
                    line.startsWith("deleted file mode") ||
                    line.startsWith("old mode ") ||
                    line.startsWith("new mode ") ||
                    line.startsWith("rename from ") ||
                    line.startsWith("rename to ") ||
                    line.startsWith("similarity index ") ||
                    line.startsWith("dissimilarity index ")
                ) {
                    hasGitHeader = true
                    metadataEvidenceCount++
                    continue
                }

                if (line.startsWith("+") && !line.startsWith("+++")) {
                    hasBodyChange = true
                    continue
                }

                if (line.startsWith("-") && !line.startsWith("---")) {
                    hasBodyChange = true
                    continue
                }
            }

            if (hasBodyChange) {
                return hasHunk || hasGitHeader
            }

            if (hasHunk) return true

            return hasGitHeader && metadataEvidenceCount >= 2
        }

        fun classify(line: String): TurnDiffLineKind {
            return when {
                line.startsWith("@@") -> HUNK
                line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++") -> META
                line.startsWith("+") && !line.startsWith("+++") -> ADDITION
                line.startsWith("-") && !line.startsWith("---") -> DELETION
                else -> NEUTRAL
            }
        }
    }

    val indicatorColor: Color
        get() = when (this) {
            ADDITION -> Color(0xFF21C45E)
            DELETION -> Color(0xFFF04444)
            else -> Color.Transparent
        }

    val hasIndicator: Boolean
        get() = this == ADDITION || this == DELETION

    val textColor: Color
        @Composable
        get() = when (this) {
            ADDITION -> Color(0xFF21C45E)
            DELETION -> Color(0xFFF04444)
            HUNK -> Color(0xFFB2BDD9)
            META -> MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f)
            NEUTRAL -> MaterialTheme.colorScheme.onSurface
        }

    val backgroundColor: Color
        get() = when (this) {
            ADDITION -> Color(0xFF1A7342).copy(alpha = 0.12f)
            DELETION -> Color(0xFF8C2E2E).copy(alpha = 0.12f)
            else -> Color.Transparent
        }
}

@Composable
internal fun TurnDiffCodeBlockView(
    code: String,
    showsLineIndicator: Boolean = true,
) {
    val lines = code.lines()

    SelectionContainer {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.3f)),
        ) {
            lines.forEach { line ->
                val kind = TurnDiffLineKind.classify(line)
                if (kind != TurnDiffLineKind.META) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(kind.backgroundColor),
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            if (showsLineIndicator && kind.hasIndicator) {
                                Box(
                                    modifier = Modifier
                                        .width(2.dp)
                                        .height(20.dp)
                                        .background(kind.indicatorColor),
                                )
                            }
                            Text(
                                text = line,
                                style = MaterialTheme.typography.bodySmall.copy(fontFamily = monoFamily),
                                color = kind.textColor,
                                modifier = Modifier
                                    .padding(horizontal = 10.dp, vertical = 1.dp)
                                    .fillMaxWidth(),
                            )
                        }
                    }
                }
            }
        }
    }
}
