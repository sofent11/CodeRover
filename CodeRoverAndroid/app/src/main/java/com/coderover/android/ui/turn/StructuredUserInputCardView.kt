package com.coderover.android.ui.turn

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.coderover.android.data.model.ChatMessage
import com.coderover.android.ui.theme.Border

@Composable
internal fun UserInputPromptMessageContent(
    message: ChatMessage,
    onSubmitStructuredInput: (kotlinx.serialization.json.JsonElement, Map<String, String>) -> Unit,
) {
    val request = message.structuredUserInputRequest
    var selectedOptions by remember(message.id) { mutableStateOf<Map<String, String>>(emptyMap()) }
    var typedAnswers by remember(message.id) { mutableStateOf<Map<String, String>>(emptyMap()) }
    var hasSubmitted by remember(message.id) { mutableStateOf(false) }

    if (request == null) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                text = "CodeRover needs a decision before it can continue.",
                style = MaterialTheme.typography.bodyMedium,
            )
            if (message.text.isNotBlank()) {
                Text(
                    text = message.text.trim(),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        return
    }

    fun resolvedAnswer(questionId: String): String? {
        val typed = typedAnswers[questionId]?.trim()?.takeIf(String::isNotEmpty)
        if (typed != null) return typed
        return selectedOptions[questionId]?.trim()?.takeIf(String::isNotEmpty)
    }

    val isSubmitDisabled = hasSubmitted || !request.questions.all { question ->
        resolvedAnswer(question.id) != null
    }

    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        request.questions.forEachIndexed { index, question ->
            if (index > 0) {
                Spacer(Modifier.height(2.dp))
            }
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                question.header.trim().takeIf(String::isNotEmpty)?.let { header ->
                    Text(
                        text = header.uppercase(),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Text(
                    text = question.question.trim(),
                    style = MaterialTheme.typography.bodyMedium,
                )
                if (question.options.isNotEmpty()) {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        question.options.forEach { option ->
                            val isSelected = selectedOptions[question.id] == option.label
                            Surface(
                                shape = RoundedCornerShape(14.dp),
                                color = if (isSelected) {
                                    MaterialTheme.colorScheme.tertiary.copy(alpha = 0.12f)
                                } else {
                                    MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.45f)
                                },
                                border = androidx.compose.foundation.BorderStroke(
                                    1.dp,
                                    if (isSelected) MaterialTheme.colorScheme.tertiary else Border,
                                ),
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable(enabled = !hasSubmitted) {
                                        selectedOptions = selectedOptions + (question.id to option.label)
                                    },
                            ) {
                                Column(modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
                                    Text(
                                        text = option.label,
                                        style = MaterialTheme.typography.bodyMedium,
                                        color = if (isSelected) MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.onSurface,
                                    )
                                    option.description.trim().takeIf(String::isNotEmpty)?.let { description ->
                                        Spacer(Modifier.height(2.dp))
                                        Text(
                                            text = description,
                                            style = MaterialTheme.typography.labelMedium,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
                if (question.isOther || question.options.isEmpty()) {
                    OutlinedTextField(
                        value = typedAnswers[question.id].orEmpty(),
                        onValueChange = { typedAnswers = typedAnswers + (question.id to it) },
                        modifier = Modifier.fillMaxWidth(),
                        minLines = if (question.isSecret) 1 else 2,
                        label = { Text(if (question.isSecret) "Secret answer" else "Your answer") },
                        enabled = !hasSubmitted,
                    )
                }
            }
        }

        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            Button(
                onClick = {
                    val answers = request.questions.associate { question ->
                        question.id to resolvedAnswer(question.id).orEmpty()
                    }
                    hasSubmitted = true
                    onSubmitStructuredInput(request.requestId, answers)
                },
                enabled = !isSubmitDisabled,
                shape = RoundedCornerShape(999.dp),
            ) {
                Text(if (hasSubmitted) "Sent" else "Send")
            }
        }
    }
}
