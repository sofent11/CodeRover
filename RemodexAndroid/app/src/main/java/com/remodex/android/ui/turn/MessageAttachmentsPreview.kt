package com.remodex.android.ui.turn

import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import com.remodex.android.data.model.CodexImageAttachment

@Composable
internal fun MessageAttachmentsPreview(
    attachments: List<CodexImageAttachment>,
) {
    var previewAttachment by remember { mutableStateOf<CodexImageAttachment?>(null) }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        attachments.forEach { attachment ->
            val thumbnail = remember(attachment.thumbnailBase64JPEG) {
                runCatching {
                    val bytes = Base64.decode(attachment.thumbnailBase64JPEG, Base64.DEFAULT)
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
                }.getOrNull()
            }
            thumbnail?.let { bitmap ->
                Image(
                    bitmap = bitmap,
                    contentDescription = null,
                    modifier = Modifier
                        .size(TurnAttachmentPipeline.thumbnailSidePx.dp)
                        .clip(
                            RoundedCornerShape(TurnAttachmentPipeline.thumbnailCornerRadiusDp.dp),
                        )
                        .clickable { previewAttachment = attachment },
                    contentScale = ContentScale.Crop,
                )
            }
        }
    }

    previewAttachment?.let { attachment ->
        AttachmentPreviewDialog(
            attachment = attachment,
            onDismiss = { previewAttachment = null }
        )
    }
}
