package com.coderover.android.ui.turn

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.coderover.android.data.model.FuzzyFileMatch
import com.coderover.android.data.model.QueuedTurnDraft
import com.coderover.android.data.model.SkillMetadata
import com.coderover.android.ui.shared.StatusTag
import com.coderover.android.ui.theme.PlanAccent

@Composable
internal fun ComposerTopPanels(
    turnViewModel: TurnViewModel,
    queuedDrafts: List<QueuedTurnDraft>,
    canSteerDrafts: Boolean,
    showsPlanMode: Boolean,
    onSteerDraft: (String) -> Unit,
    onFileSelected: (FuzzyFileMatch) -> Unit,
    onSkillSelected: (SkillMetadata) -> Unit,
    onRemoveDraft: (String) -> Unit,
) {
    AnimatedVisibility(
        visible = turnViewModel.composerNoticeMessage != null ||
            turnViewModel.autocompleteFiles.isNotEmpty() ||
            turnViewModel.autocompleteSkills.isNotEmpty() ||
            queuedDrafts.isNotEmpty() ||
            (turnViewModel.isPlanModeArmed && showsPlanMode),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(bottom = 8.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            turnViewModel.composerNoticeMessage?.let { notice ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 4.dp, vertical = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    StatusTag(
                        text = "Images",
                        containerColor = MaterialTheme.colorScheme.surfaceVariant,
                        contentColor = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        text = notice,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }

            if (turnViewModel.isPlanModeArmed && showsPlanMode) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 4.dp, vertical = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    StatusTag(
                        text = "Plan mode",
                        containerColor = PlanAccent.copy(alpha = 0.14f),
                        contentColor = PlanAccent,
                    )
                    Text(
                        text = "Structured plan before execution.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }

            FileAutocompletePanel(
                files = turnViewModel.autocompleteFiles,
                onSelect = onFileSelected,
            )
            SkillAutocompletePanel(
                skills = turnViewModel.autocompleteSkills,
                onSelect = onSkillSelected,
            )
            QueuedDraftsPanel(
                drafts = queuedDrafts,
                canSteerDrafts = canSteerDrafts,
                steeringDraftId = turnViewModel.steeringDraftId,
                onSteerDraft = onSteerDraft,
                onRemoveDraft = onRemoveDraft,
            )
        }
    }
}
