package com.coderover.android.ui.turn

import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.Warning
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.unit.dp

@Composable
internal fun ComposerAttachmentTile(
    attachment: TurnComposerImageAttachment,
    onRemove: (String) -> Unit,
) {
    val thumbnail = remember(attachment) {
        when (val state = attachment.state) {
            is TurnComposerImageAttachmentState.Ready -> {
                runCatching {
                    BitmapFactory.decodeByteArray(
                        Base64.decode(state.value.thumbnailBase64JPEG, Base64.DEFAULT),
                        0,
                        Base64.decode(state.value.thumbnailBase64JPEG, Base64.DEFAULT).size,
                    )?.asImageBitmap()
                }.getOrNull()
            }
            else -> null
        }
    }
    Box(
        modifier = Modifier
            .size(TurnAttachmentPipeline.thumbnailSidePx.dp)
            .clip(RoundedCornerShape(TurnAttachmentPipeline.thumbnailCornerRadiusDp.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant),
    ) {
        when {
            thumbnail != null -> Image(
                bitmap = thumbnail,
                contentDescription = null,
                modifier = Modifier.matchParentSize(),
            )
            attachment.state == TurnComposerImageAttachmentState.Failed -> Icon(
                imageVector = Icons.Outlined.Warning,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.error,
                modifier = Modifier.align(Alignment.Center),
            )
            attachment.state == TurnComposerImageAttachmentState.Loading -> CircularProgressIndicator(
                modifier = Modifier
                    .size(20.dp)
                    .align(Alignment.Center),
                strokeWidth = 2.dp,
            )
            else -> Icon(
                imageVector = Icons.Outlined.Image,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.align(Alignment.Center),
            )
        }
        IconButton(
            onClick = { onRemove(attachment.id) },
            modifier = Modifier.align(Alignment.TopEnd),
        ) {
            Icon(Icons.Outlined.Close, contentDescription = "Remove image")
        }
    }
}
