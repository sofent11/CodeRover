package com.coderover.android.ui.turn

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.coderover.android.data.model.ApprovalRequest
import com.coderover.android.ui.shared.GlassCard
import com.coderover.android.ui.theme.monoFamily

@Composable
internal fun TurnApprovalBanner(
    approval: ApprovalRequest,
    onApprove: () -> Unit,
    onDeny: () -> Unit,
) {
    GlassCard(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp),
        cornerRadius = 24.dp,
    ) {
        Text("Approval required", style = MaterialTheme.typography.titleSmall)
        Spacer(Modifier.height(6.dp))
        approval.command?.let {
            Text(it, style = MaterialTheme.typography.bodyLarge.copy(fontFamily = monoFamily))
            Spacer(Modifier.height(6.dp))
        }
        approval.reason?.let {
            Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(10.dp))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = onApprove) { Text("Approve") }
            OutlinedButton(onClick = onDeny) { Text("Deny") }
        }
    }
}
