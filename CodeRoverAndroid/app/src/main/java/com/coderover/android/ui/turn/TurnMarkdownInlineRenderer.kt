package com.coderover.android.ui.turn

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import com.coderover.android.ui.theme.monoFamily

@Composable
internal fun RichParagraphText(
    paragraph: String,
    textColor: Color,
    style: androidx.compose.ui.text.TextStyle,
    isHeading: Boolean,
    linkColor: Color,
    pathColor: Color,
    inlineCodeBackground: Color,
    pathBackground: Color,
    modifier: Modifier = Modifier,
) {
    val annotatedText = remember(
        paragraph,
        textColor,
        isHeading,
        linkColor,
        pathColor,
        inlineCodeBackground,
        pathBackground,
    ) {
        buildRichParagraph(
            paragraph = paragraph,
            textColor = textColor,
            isHeading = isHeading,
            linkColor = linkColor,
            pathColor = pathColor,
            inlineCodeBackground = inlineCodeBackground,
            pathBackground = pathBackground,
        )
    }
    Text(
        text = annotatedText,
        style = style.copy(color = textColor),
        modifier = modifier,
    )
}

private fun buildRichParagraph(
    paragraph: String,
    textColor: Color,
    isHeading: Boolean,
    linkColor: Color,
    pathColor: Color,
    inlineCodeBackground: Color,
    pathBackground: Color,
): AnnotatedString {
    val source = paragraph.trim()
    return buildAnnotatedString {
        val tokenRegex = Regex(
            """(\[[^\]]+]\((?:https?://[^)\s]+|/[^)\s]+)\)|https?://[^\s)]+|`[^`]+`|/[\w.\-@/]+(?:[:#]L?\d+(?::\d+|C\d+)?)?|@[A-Za-z0-9_.\-/]+|#[a-z0-9\-]+)""",
        )
        var lastIndex = 0
        tokenRegex.findAll(source).forEach { match ->
            if (match.range.first > lastIndex) {
                appendStyledInlineText(
                    value = source.substring(lastIndex, match.range.first),
                    textColor = textColor,
                    heading = isHeading,
                )
            }
            val token = match.value
            when {
                token.startsWith("[") && token.contains("](") -> {
                    val linkMatch = Regex("""\[([^\]]+)]\(([^)]+)\)""").matchEntire(token)
                    val label = linkMatch?.groupValues?.getOrNull(1).orEmpty()
                    val target = linkMatch?.groupValues?.getOrNull(2).orEmpty()
                    val isLocalPath = target.startsWith("/")
                    pushStyle(
                        SpanStyle(
                            color = if (isLocalPath) pathColor else linkColor,
                            textDecoration = if (isLocalPath) null else TextDecoration.Underline,
                            fontFamily = if (isLocalPath) monoFamily else null,
                            background = if (isLocalPath) pathBackground else Color.Unspecified,
                            fontWeight = if (isHeading) FontWeight.SemiBold else null,
                        ),
                    )
                    if (target.startsWith("http://") || target.startsWith("https://")) {
                        withLink(
                            LinkAnnotation.Url(
                                url = target,
                                styles = TextLinkStyles(
                                    style = SpanStyle(
                                        color = linkColor,
                                        textDecoration = TextDecoration.Underline,
                                        fontWeight = if (isHeading) FontWeight.SemiBold else null,
                                    ),
                                ),
                            ),
                        ) {
                            append(label)
                        }
                    } else {
                        append(label)
                    }
                    pop()
                }

                token.startsWith("http://") || token.startsWith("https://") -> {
                    withLink(
                        LinkAnnotation.Url(
                            url = token,
                            styles = TextLinkStyles(
                                style = SpanStyle(
                                    color = linkColor,
                                    textDecoration = TextDecoration.Underline,
                                ),
                            ),
                        ),
                    ) {
                        append(token)
                    }
                }

                token.startsWith("`") && token.endsWith("`") -> {
                    pushStyle(
                        SpanStyle(
                            fontFamily = monoFamily,
                            background = inlineCodeBackground,
                            color = textColor,
                        ),
                    )
                    append(token.removePrefix("`").removeSuffix("`"))
                    pop()
                }

                token.startsWith("/") || token.startsWith("@") || token.startsWith("#") -> {
                    pushStyle(
                        SpanStyle(
                            fontFamily = monoFamily,
                            color = pathColor,
                            background = pathBackground,
                        ),
                    )
                    append(token)
                    pop()
                }

                else -> append(token)
            }
            lastIndex = match.range.last + 1
        }
        if (lastIndex < source.length) {
            appendStyledInlineText(
                value = source.substring(lastIndex),
                textColor = textColor,
                heading = isHeading,
            )
        }
    }
}

private fun AnnotatedString.Builder.appendStyledInlineText(
    value: String,
    textColor: Color,
    heading: Boolean,
) {
    if (value.isEmpty()) {
        return
    }
    val emphasisRegex = Regex("""(\*\*.+?\*\*|(?<!\*)\*[^*\n]+?\*(?!\*)|_[^_\n]+?_)""")
    var lastIndex = 0
    emphasisRegex.findAll(value).forEach { match ->
        if (match.range.first > lastIndex) {
            append(value.substring(lastIndex, match.range.first))
        }
        val token = match.value
        pushStyle(
            SpanStyle(
                color = textColor,
                fontWeight = when {
                    token.startsWith("**") && heading -> FontWeight.Bold
                    token.startsWith("**") -> FontWeight.SemiBold
                    else -> null
                },
                fontStyle = when {
                    token.startsWith("*") && !token.startsWith("**") -> FontStyle.Italic
                    token.startsWith("_") -> FontStyle.Italic
                    else -> null
                },
            ),
        )
        append(
            when {
                token.startsWith("**") -> token.removePrefix("**").removeSuffix("**")
                token.startsWith("*") -> token.removePrefix("*").removeSuffix("*")
                token.startsWith("_") -> token.removePrefix("_").removeSuffix("_")
                else -> token
            },
        )
        pop()
        lastIndex = match.range.last + 1
    }
    if (lastIndex < value.length) {
        append(value.substring(lastIndex))
    }
}
