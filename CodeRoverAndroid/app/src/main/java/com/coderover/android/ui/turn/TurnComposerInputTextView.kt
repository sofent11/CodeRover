package com.coderover.android.ui.turn

import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView

@Composable
internal fun TurnComposerInputTextView(
    input: String,
    onInputChanged: (String) -> Unit,
    onFocusedChanged: (Boolean) -> Unit,
    onPasteImageData: (List<ByteArray>) -> Unit,
    onSend: () -> Unit,
    sendEnabled: Boolean,
) {
    val context = LocalContext.current
    val textColor = MaterialTheme.colorScheme.onSurface.toArgb()
    val cursorColor = MaterialTheme.colorScheme.primary.toArgb()
    val keyboardService = remember(context) {
        context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    }
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 28.dp),
    ) {
        if (input.isEmpty()) {
            Text(
                text = "Ask for follow-up changes, or type / for Codex commands",
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.52f),
                modifier = Modifier
                    .align(Alignment.TopStart)
                    .padding(top = 8.dp),
            )
        }
        AndroidView(
            factory = { viewContext ->
                TurnComposerPasteInterceptingEditText(viewContext).apply {
                    applyComposerConfiguration(
                        input = input,
                        textColor = textColor,
                        onFocusedChanged = onFocusedChanged,
                        onSend = onSend,
                        sendEnabled = sendEnabled,
                        onPasteImageData = onPasteImageData,
                        onInputChanged = onInputChanged,
                    )
                }
            },
            update = { editText ->
                editText.syncTextFromModel(input)
                editText.setTextColor(textColor)
                editText.highlightColor = cursorColor
                editText.onFocusedChanged = onFocusedChanged
                editText.onSendRequested = onSend
                editText.onPasteImageData = onPasteImageData
                editText.onInputChanged = onInputChanged
                editText.clipboardManager = keyboardService
                editText.sendEnabled = sendEnabled
                editText.configureHeightBounds()
                editText.updateScrollMode()
            },
            modifier = Modifier
                .fillMaxWidth()
                .wrapContentHeight()
                .heightIn(min = 28.dp),
        )
    }
}
