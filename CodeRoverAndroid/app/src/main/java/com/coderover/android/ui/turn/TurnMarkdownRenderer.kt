package com.coderover.android.ui.turn

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

@Composable
internal fun RichMessageText(
    text: String,
    textColor: Color,
    textStyle: androidx.compose.ui.text.TextStyle = MaterialTheme.typography.bodyLarge,
) {
    val segments = remember(text) { parseMarkdownSegments(text) }
    val linkColor = MaterialTheme.colorScheme.primary
    val pathColor = MaterialTheme.colorScheme.tertiary
    val inlineCodeBackground = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.8f)
    val pathBackground = MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.58f)
    SelectionContainer {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            segments.forEach { segment ->
                when (segment) {
                    is MarkdownSegmentUi.Prose -> {
                        parseMarkdownBlocks(segment.text).forEach { block ->
                            when (block) {
                                is MarkdownBlockUi.Paragraph -> {
                                    RichParagraphText(
                                        paragraph = block.text,
                                        textColor = textColor,
                                        style = textStyle,
                                        isHeading = false,
                                        linkColor = linkColor,
                                        pathColor = pathColor,
                                        inlineCodeBackground = inlineCodeBackground,
                                        pathBackground = pathBackground,
                                    )
                                }

                                is MarkdownBlockUi.Heading -> {
                                    val headingStyle = when (block.level) {
                                        1 -> textStyle.copy(fontWeight = FontWeight.Bold, color = textColor)
                                        else -> textStyle.copy(fontWeight = FontWeight.SemiBold, color = textColor)
                                    }
                                    RichParagraphText(
                                        paragraph = block.text,
                                        textColor = textColor,
                                        style = headingStyle,
                                        isHeading = true,
                                        linkColor = linkColor,
                                        pathColor = pathColor,
                                        inlineCodeBackground = inlineCodeBackground,
                                        pathBackground = pathBackground,
                                    )
                                }

                                is MarkdownBlockUi.ListBlock -> {
                                    Column(
                                        verticalArrangement = Arrangement.spacedBy(8.dp),
                                        modifier = Modifier.fillMaxWidth(),
                                    ) {
                                        block.items.forEachIndexed { index, item ->
                                            Row(
                                                horizontalArrangement = Arrangement.spacedBy(10.dp),
                                                verticalAlignment = Alignment.Top,
                                                modifier = Modifier.fillMaxWidth(),
                                            ) {
                                                Text(
                                                    text = if (block.ordered) "${block.startIndex + index}." else "•",
                                                    style = textStyle,
                                                    color = textColor.copy(alpha = 0.78f),
                                                    modifier = Modifier.padding(top = 1.dp),
                                                )
                                                RichParagraphText(
                                                    paragraph = item,
                                                    textColor = textColor,
                                                    style = textStyle,
                                                    isHeading = false,
                                                    linkColor = linkColor,
                                                    pathColor = pathColor,
                                                    inlineCodeBackground = inlineCodeBackground,
                                                    pathBackground = pathBackground,
                                                    modifier = Modifier.fillMaxWidth(),
                                                )
                                            }
                                        }
                                    }
                                }

                                is MarkdownBlockUi.Quote -> {
                                    Surface(
                                        shape = RoundedCornerShape(16.dp),
                                        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.46f),
                                    ) {
                                        Row(
                                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                                            verticalAlignment = Alignment.Top,
                                            modifier = Modifier
                                                .fillMaxWidth()
                                                .padding(horizontal = 12.dp, vertical = 12.dp),
                                        ) {
                                            Box(
                                                modifier = Modifier
                                                    .width(3.dp)
                                                    .height(24.dp)
                                                    .clip(RoundedCornerShape(999.dp))
                                                    .background(linkColor.copy(alpha = 0.7f)),
                                            )
                                            RichParagraphText(
                                                paragraph = block.text,
                                                textColor = textColor.copy(alpha = 0.92f),
                                                style = textStyle,
                                                isHeading = false,
                                                linkColor = linkColor,
                                                pathColor = pathColor,
                                                inlineCodeBackground = inlineCodeBackground,
                                                pathBackground = pathBackground,
                                                modifier = Modifier.fillMaxWidth(),
                                            )
                                        }
                                    }
                                }
                            }
                        }
                    }

                    is MarkdownSegmentUi.CodeBlock -> {
                        TurnMarkdownCodeBlock(
                            language = segment.language,
                            code = segment.code,
                            textColor = textColor,
                        )
                    }
                }
            }
        }
    }
}
