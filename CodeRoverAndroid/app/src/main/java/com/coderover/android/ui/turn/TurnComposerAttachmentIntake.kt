package com.coderover.android.ui.turn

import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import java.io.ByteArrayOutputStream

internal object TurnComposerAttachmentIntake {
    fun imageUrisFromClipboard(
        clipboardManager: ClipboardManager,
    ): List<Uri> {
        val clip = clipboardManager.primaryClip ?: return emptyList()
        return buildList {
            for (index in 0 until clip.itemCount) {
                clip.getItemAt(index).uri?.let(::add)
            }
        }
    }

    fun readBytes(
        context: Context,
        uri: Uri,
    ): ByteArray? {
        return runCatching {
            context.contentResolver.openInputStream(uri)?.use { stream ->
                stream.readBytes()
            }
        }.getOrNull()
    }

    fun encodeCameraPreview(
        bitmap: Bitmap,
    ): ByteArray? {
        return runCatching {
            ByteArrayOutputStream().use { stream ->
                if (!bitmap.compress(Bitmap.CompressFormat.JPEG, 90, stream)) {
                    null
                } else {
                    stream.toByteArray()
                }
            }
        }.getOrNull()
    }
}
