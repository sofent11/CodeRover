package com.coderover.android.ui.turn

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.coderover.android.data.model.TurnComposerMentionedFile
import com.coderover.android.data.model.TurnComposerMentionedSkill

@Composable
internal fun FileMentionChip(
    fileName: String,
    onRemove: (() -> Unit)? = null,
) {
    MentionChip(
        label = fileName,
        accent = MaterialTheme.colorScheme.primary,
        background = MaterialTheme.colorScheme.primary.copy(alpha = 0.08f),
        onRemove = onRemove,
    )
}

@Composable
internal fun SkillMentionChip(
    skillName: String,
    onRemove: (() -> Unit)? = null,
) {
    MentionChip(
        label = skillName,
        accent = MaterialTheme.colorScheme.tertiary,
        background = MaterialTheme.colorScheme.tertiary.copy(alpha = 0.08f),
        onRemove = onRemove,
    )
}

@Composable
private fun MentionChip(
    label: String,
    accent: Color,
    background: Color,
    onRemove: (() -> Unit)?,
) {
    Surface(
        shape = RoundedCornerShape(8.dp),
        color = background,
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = label,
                style = MaterialTheme.typography.labelMedium,
                color = accent,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            onRemove?.let {
                IconButton(
                    onClick = it,
                    modifier = Modifier
                        .padding(start = 2.dp)
                        .align(Alignment.CenterVertically),
                ) {
                    Icon(
                        imageVector = Icons.Outlined.Close,
                        contentDescription = "Remove mention",
                        tint = accent,
                        modifier = Modifier.padding(2.dp),
                    )
                }
            }
        }
    }
}

@Composable
internal fun FileMentionChipRow(
    files: List<TurnComposerMentionedFile>,
    onRemove: (String) -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        files.forEach { file ->
            FileMentionChip(fileName = file.fileName, onRemove = { onRemove(file.id) })
        }
    }
}

@Composable
internal fun SkillMentionChipRow(
    skills: List<TurnComposerMentionedSkill>,
    onRemove: (String) -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        skills.forEach { skill ->
            SkillMentionChip(skillName = skill.name, onRemove = { onRemove(skill.id) })
        }
    }
}
