package com.coderover.android.ui.turn

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.coderover.android.data.model.SkillMetadata

@Composable
internal fun SkillAutocompletePanel(
    skills: List<SkillMetadata>,
    onSelect: (SkillMetadata) -> Unit,
) {
    skills.take(3).forEach { skill ->
        Text(
            text = "#${skill.name}",
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.tertiary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .fillMaxWidth()
                .clickable { onSelect(skill) }
                .background(MaterialTheme.colorScheme.tertiary.copy(alpha = 0.08f), RoundedCornerShape(8.dp))
                .padding(vertical = 6.dp, horizontal = 10.dp),
        )
    }
}
