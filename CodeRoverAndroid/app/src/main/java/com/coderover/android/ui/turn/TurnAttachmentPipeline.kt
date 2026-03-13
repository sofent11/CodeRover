package com.coderover.android.ui.turn

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Rect
import android.util.Base64
import com.coderover.android.data.model.ImageAttachment
import java.io.ByteArrayOutputStream
import java.util.UUID

data class TurnComposerImageAttachment(
    val id: String = UUID.randomUUID().toString(),
    val state: TurnComposerImageAttachmentState,
)

sealed interface TurnComposerImageAttachmentState {
    data object Loading : TurnComposerImageAttachmentState
    data class Ready(val value: ImageAttachment) : TurnComposerImageAttachmentState
    data object Failed : TurnComposerImageAttachmentState
}

object TurnAttachmentPipeline {
    const val thumbnailSidePx = 70
    const val thumbnailCornerRadiusDp = 12
    private const val maxPayloadDimensionPx = 1600
    private const val jpegQuality = 80

    fun makeAttachment(sourceData: ByteArray): ImageAttachment? {
        val bitmap = BitmapFactory.decodeByteArray(sourceData, 0, sourceData.size) ?: return null
        val normalized = normalizeBitmap(bitmap)
        val payloadBytes = ByteArrayOutputStream().use { stream ->
            if (!normalized.compress(Bitmap.CompressFormat.JPEG, jpegQuality, stream)) {
                return null
            }
            stream.toByteArray()
        }
        val thumbnail = makeThumbnailBase64(normalized) ?: return null
        return ImageAttachment(
            thumbnailBase64JPEG = thumbnail,
            payloadDataURL = "data:image/jpeg;base64," + Base64.encodeToString(payloadBytes, Base64.NO_WRAP),
            sourceUrl = null,
        )
    }

    private fun normalizeBitmap(bitmap: Bitmap): Bitmap {
        val width = bitmap.width.toFloat()
        val height = bitmap.height.toFloat()
        val longestSide = maxOf(width, height)
        if (longestSide <= maxPayloadDimensionPx) {
            return bitmap
        }
        val scale = maxPayloadDimensionPx / longestSide
        return Bitmap.createScaledBitmap(
            bitmap,
            (width * scale).toInt().coerceAtLeast(1),
            (height * scale).toInt().coerceAtLeast(1),
            true,
        )
    }

    private fun makeThumbnailBase64(bitmap: Bitmap): String? {
        val side = thumbnailSidePx
        val sourceRatio = bitmap.width.toFloat() / bitmap.height.toFloat()
        val destBitmap = Bitmap.createBitmap(side, side, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(destBitmap)
        val destRect = Rect(0, 0, side, side)
        val srcRect = if (sourceRatio > 1f) {
            val newWidth = (bitmap.height * 1f).toInt()
            val left = ((bitmap.width - newWidth) / 2).coerceAtLeast(0)
            Rect(left, 0, left + newWidth, bitmap.height)
        } else {
            val newHeight = (bitmap.width / 1f).toInt()
            val top = ((bitmap.height - newHeight) / 2).coerceAtLeast(0)
            Rect(0, top, bitmap.width, top + newHeight)
        }
        canvas.drawBitmap(bitmap, srcRect, destRect, null)
        val bytes = ByteArrayOutputStream().use { stream ->
            if (!destBitmap.compress(Bitmap.CompressFormat.JPEG, jpegQuality, stream)) {
                return null
            }
            stream.toByteArray()
        }
        return Base64.encodeToString(bytes, Base64.NO_WRAP)
    }
}
