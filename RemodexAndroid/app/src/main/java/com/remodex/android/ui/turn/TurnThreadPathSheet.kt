package com.remodex.android.ui.turn

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.remodex.android.ui.theme.monoFamily

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun TurnThreadPathSheet(
    path: String,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState()
    val folderName = path.substringAfterLast('/').ifEmpty { path }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp, vertical = 10.dp)
                .verticalScroll(rememberScrollState()),
        ) {
            Text(
                text = folderName,
                style = MaterialTheme.typography.headlineSmall,
                modifier = Modifier.padding(bottom = 16.dp),
            )
            SelectionContainer {
                Text(
                    text = path,
                    style = MaterialTheme.typography.bodyMedium.copy(fontFamily = monoFamily),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}
