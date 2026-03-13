package com.coderover.android.ui.turn

import android.content.ClipboardManager
import android.content.Context
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.TextView
import androidx.appcompat.widget.AppCompatEditText

internal fun TurnComposerPasteInterceptingEditText.applyComposerConfiguration(
    input: String,
    textColor: Int,
    onFocusedChanged: (Boolean) -> Unit,
    onSend: () -> Unit,
    sendEnabled: Boolean,
    onPasteImageData: (List<ByteArray>) -> Unit,
    onInputChanged: (String) -> Unit,
) {
    background = null
    setTextColor(textColor)
    gravity = Gravity.TOP or Gravity.START
    textSize = 16f
    setPadding(0, 16, 0, 16)
    inputType = InputType.TYPE_CLASS_TEXT or
        InputType.TYPE_TEXT_FLAG_MULTI_LINE or
        InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or
        InputType.TYPE_TEXT_FLAG_AUTO_CORRECT
    imeOptions = EditorInfo.IME_ACTION_SEND or EditorInfo.IME_FLAG_NO_EXTRACT_UI
    minLines = 1
    maxLines = 10
    isVerticalScrollBarEnabled = false
    overScrollMode = View.OVER_SCROLL_NEVER
    setHorizontallyScrolling(false)
    configureHeightBounds()
    syncTextFromModel(input)
    this.onFocusedChanged = onFocusedChanged
    this.onSendRequested = onSend
    this.onPasteImageData = onPasteImageData
    this.onInputChanged = onInputChanged
    this.sendEnabled = sendEnabled
    installEditorActionListenerIfNeeded()
    installFocusListenerIfNeeded()
    installComposerWatcherIfNeeded()
}

internal class TurnComposerPasteInterceptingEditText(
    context: Context,
) : AppCompatEditText(context) {
    var onFocusedChanged: ((Boolean) -> Unit)? = null
    var onSendRequested: (() -> Unit)? = null
    var onPasteImageData: ((List<ByteArray>) -> Unit)? = null
    var onInputChanged: ((String) -> Unit)? = null
    var clipboardManager: ClipboardManager? = null
    var sendEnabled: Boolean = false
    private var isSyncingFromModel = false
    private var composerWatcherInstalled = false
    private var editorActionListenerInstalled = false
    private var focusListenerInstalled = false
    private var lastReportedFocus: Boolean? = null

    fun configureHeightBounds() {
        val lineHeightPx = lineHeight.takeIf { it > 0 } ?: return
        val minHeightPx = lineHeightPx + paddingTop + paddingBottom
        val maxHeightPx = lineHeightPx * 6 + paddingTop + paddingBottom
        minHeight = minHeightPx
        maxHeight = maxHeightPx
        if (layoutParams == null) {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            )
        }
    }

    fun updateScrollMode() {
        val lineHeightPx = lineHeight.takeIf { it > 0 } ?: return
        val maxHeightPx = lineHeightPx * 6 + paddingTop + paddingBottom
        post {
            val contentHeight = layout?.height?.plus(paddingTop + paddingBottom) ?: measuredHeight
            val shouldScroll = contentHeight > maxHeightPx
            if (isVerticalScrollBarEnabled != shouldScroll) {
                isVerticalScrollBarEnabled = shouldScroll
            }
            val targetOverscrollMode = if (shouldScroll) {
                View.OVER_SCROLL_IF_CONTENT_SCROLLS
            } else {
                View.OVER_SCROLL_NEVER
            }
            if (overScrollMode != targetOverscrollMode) {
                overScrollMode = targetOverscrollMode
            }
        }
    }

    fun syncTextFromModel(input: String) {
        val currentText = text?.toString().orEmpty()
        if (currentText == input) {
            return
        }
        val targetSelectionStart = selectionStart
            .takeIf { it >= 0 }
            ?.coerceAtMost(input.length)
            ?: input.length
        val targetSelectionEnd = selectionEnd
            .takeIf { it >= 0 }
            ?.coerceAtMost(input.length)
            ?: targetSelectionStart
        isSyncingFromModel = true
        setText(input)
        if (targetSelectionStart == targetSelectionEnd) {
            setSelection(targetSelectionStart)
        } else {
            setSelection(
                minOf(targetSelectionStart, targetSelectionEnd),
                maxOf(targetSelectionStart, targetSelectionEnd),
            )
        }
        isSyncingFromModel = false
        updateScrollMode()
    }

    fun installEditorActionListenerIfNeeded() {
        if (editorActionListenerInstalled) {
            return
        }
        editorActionListenerInstalled = true
        setOnEditorActionListener { _: TextView, actionId: Int, _ ->
            if (actionId == EditorInfo.IME_ACTION_SEND && sendEnabled) {
                onSendRequested?.invoke()
                true
            } else {
                false
            }
        }
    }

    fun installFocusListenerIfNeeded() {
        if (focusListenerInstalled) {
            return
        }
        focusListenerInstalled = true
        setOnFocusChangeListener { _, hasFocus ->
            if (lastReportedFocus != hasFocus) {
                lastReportedFocus = hasFocus
                onFocusedChanged?.invoke(hasFocus)
            }
        }
    }

    fun installComposerWatcherIfNeeded() {
        if (composerWatcherInstalled) {
            return
        }
        composerWatcherInstalled = true
        addTextChangedListener(
            object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
                override fun afterTextChanged(s: Editable?) {
                    updateScrollMode()
                    if (!isSyncingFromModel) {
                        onInputChanged?.invoke(s?.toString().orEmpty())
                    }
                }
            },
        )
    }

    override fun onTextContextMenuItem(id: Int): Boolean {
        if (id == android.R.id.paste || id == android.R.id.pasteAsPlainText) {
            val imageData = imageDataFromClipboard()
            if (imageData.isNotEmpty()) {
                onPasteImageData?.invoke(imageData)
                val hasString = clipboardManager?.primaryClip
                    ?.let { clip ->
                        (0 until clip.itemCount).any { index ->
                            !clip.getItemAt(index).coerceToText(context).isNullOrBlank()
                        }
                    }
                    ?: false
                if (!hasString) {
                    return true
                }
            }
        }
        return super.onTextContextMenuItem(id)
    }

    private fun imageDataFromClipboard(): List<ByteArray> {
        val clip = clipboardManager?.primaryClip ?: return emptyList()
        val payloads = mutableListOf<ByteArray>()
        for (index in 0 until clip.itemCount) {
            val item = clip.getItemAt(index)
            val uri = item.uri
            if (uri != null) {
                runCatching {
                    context.contentResolver.openInputStream(uri)?.use { stream ->
                        stream.readBytes()
                    }
                }.getOrNull()?.let(payloads::add)
            }
        }
        return payloads
    }
}
