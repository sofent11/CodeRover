package com.remodex.android.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.launch
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.remodex.android.app.AppViewModel
import com.remodex.android.data.model.AccessMode
import com.remodex.android.data.model.AppState
import com.remodex.android.data.model.ConnectionPhase
import com.remodex.android.data.model.ModelOption
import com.remodex.android.data.model.FuzzyFileMatch
import com.remodex.android.data.model.SkillMetadata
import com.remodex.android.ui.GlassCard
import com.remodex.android.ui.StatusTag
import com.remodex.android.ui.theme.Border
import com.remodex.android.ui.theme.PlanAccent
import com.remodex.android.ui.theme.CommandAccent
import androidx.compose.ui.graphics.Color
import androidx.compose.material.icons.filled.KeyboardArrowDown

import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.ui.graphics.SolidColor

@Composable
fun ComposerCard(
    state: AppState,
    input: String,
    onInputChanged: (String) -> Unit,
    isRunning: Boolean,
    onSend: (Boolean) -> Unit,
    onStop: () -> Unit,
    onReconnect: () -> Unit,
    onSelectModel: (String?) -> Unit,
    onSelectReasoning: (String?) -> Unit,
    onSelectAccessMode: (AccessMode) -> Unit,
    viewModel: AppViewModel,
) {
    val coroutineScope = rememberCoroutineScope()
    var isPlanModeArmed by rememberSaveable(state.selectedThreadId) { mutableStateOf(false) }
    var plusMenuExpanded by remember { mutableStateOf(false) }
    var modelMenuExpanded by remember { mutableStateOf(false) }
    var reasoningMenuExpanded by remember { mutableStateOf(false) }
    var accessMenuExpanded by remember { mutableStateOf(false) }
    var gitMenuExpanded by remember { mutableStateOf(false) }
    var isFocused by remember { mutableStateOf(false) }
    var isLocalMode by rememberSaveable { mutableStateOf(true) }
    
    var autocompleteFiles by remember { mutableStateOf<List<FuzzyFileMatch>>(emptyList()) }
    var autocompleteSkills by remember { mutableStateOf<List<SkillMetadata>>(emptyList()) }
    
    val selectedModel = remember(state.availableModels, state.selectedModelId) {
        resolveSelectedModelOption(state)
    }
    val orderedModels = remember(state.availableModels) { orderedComposerModels(state.availableModels) }
    val reasoningOptions = remember(selectedModel) {
        selectedModel?.supportedReasoningEfforts
            ?.map(::composerReasoningTitle)
            .orEmpty()
    }
    val selectedModelTitle = remember(selectedModel) {
        selectedModel?.let(::composerModelTitle) ?: "Model"
    }
    val selectedReasoningTitle = remember(selectedModel, state.selectedReasoningEffort) {
        selectedModel?.let {
            state.selectedReasoningEffort
                ?.takeIf { effort -> it.supportedReasoningEfforts.contains(effort) }
                ?.let(::composerReasoningTitle)
                ?: it.defaultReasoningEffort?.let(::composerReasoningTitle)
                ?: it.supportedReasoningEfforts.firstOrNull()?.let(::composerReasoningTitle)
        } ?: "Reasoning"
    }
    val sendEnabled = input.isNotBlank() && state.isConnected

    val lastWordStartIndex = input.lastIndexOfAny(charArrayOf(' ', '\n')) + 1
    val currentWord = input.substring(lastWordStartIndex)

    val currentCwd = state.selectedThread?.cwd
    LaunchedEffect(currentCwd, state.isConnected) {
        if (currentCwd != null && currentCwd.isNotBlank() && state.isConnected) {
            viewModel.gitStatus(currentCwd)
        }
    }

    LaunchedEffect(currentWord, state.selectedThreadId) {
        if (currentWord.startsWith("@") && currentWord.length >= 1) {
            val query = currentWord.substring(1)
            autocompleteSkills = emptyList()
            state.selectedThreadId?.let { threadId ->
                autocompleteFiles = viewModel.fuzzyFileSearch(query, threadId)
            }
        } else if (currentWord.startsWith("#") && currentWord.length >= 1) {
            val query = currentWord.substring(1)
            autocompleteFiles = emptyList()
            val allSkills = viewModel.listSkills()
            autocompleteSkills = allSkills.filter {
                it.name.contains(query, ignoreCase = true)
            }
        } else {
            autocompleteFiles = emptyList()
            autocompleteSkills = emptyList()
        }
    }

    val onItemSelected = { selectedText: String ->
        val newText = input.substring(0, lastWordStartIndex) + selectedText + " "
        onInputChanged(newText)
        autocompleteFiles = emptyList()
        autocompleteSkills = emptyList()
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        AnimatedVisibility(visible = !state.isConnected) {
            GlassCard(
                modifier = Modifier.fillMaxWidth(),
                cornerRadius = 22.dp,
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(
                        verticalArrangement = Arrangement.spacedBy(2.dp),
                    ) {
                        Text("Disconnected", style = MaterialTheme.typography.labelLarge)
                        Text(
                            text = composerConnectionMessage(state),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    if (state.activePairing != null) {
                        TextButton(onClick = onReconnect) {
                            Text(
                                text = if (state.connectionPhase == ConnectionPhase.CONNECTING) {
                                    "Reconnecting..."
                                } else {
                                    "Reconnect"
                                },
                            )
                        }
                    }
                }
            }
        }

        GlassCard(
            modifier = Modifier.fillMaxWidth(),
            cornerRadius = 28.dp,
        ) {
            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(0.dp),
            ) {
                // Top: Mentions and Queued Drafts
                val threadIdForQueue = state.selectedThreadId
                val queuedDrafts = if (threadIdForQueue != null) state.queuedTurnDraftsByThread[threadIdForQueue].orEmpty() else emptyList()

                AnimatedVisibility(visible = autocompleteFiles.isNotEmpty() || autocompleteSkills.isNotEmpty() || queuedDrafts.isNotEmpty() || isPlanModeArmed) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(bottom = 8.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp)
                    ) {
                        if (isPlanModeArmed) {
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
                                    overflow = TextOverflow.Ellipsis
                                )
                            }
                        }

                        autocompleteFiles.take(3).forEach { file ->
                            Text(
                                text = "@${file.path}",
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.primary,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable { onItemSelected("@" + file.path) }
                                    .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.08f), RoundedCornerShape(8.dp))
                                    .padding(vertical = 6.dp, horizontal = 10.dp)
                            )
                        }
                        autocompleteSkills.take(3).forEach { skill ->
                            Text(
                                text = "#${skill.name}",
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.tertiary,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable { onItemSelected("#" + skill.name) }
                                    .background(MaterialTheme.colorScheme.tertiary.copy(alpha = 0.08f), RoundedCornerShape(8.dp))
                                    .padding(vertical = 6.dp, horizontal = 10.dp)
                            )
                        }

                        queuedDrafts.forEach { draft ->
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f), RoundedCornerShape(8.dp))
                                    .padding(horizontal = 8.dp, vertical = 4.dp),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Text(
                                    text = draft.text,
                                    style = MaterialTheme.typography.bodySmall,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f)
                                )
                                IconButton(
                                    onClick = { if (threadIdForQueue != null) viewModel.removeQueuedDraft(threadIdForQueue, draft.id) },
                                    modifier = Modifier.size(20.dp)
                                ) {
                                    Icon(
                                        Icons.Outlined.Close,
                                        contentDescription = "Remove draft",
                                        modifier = Modifier.size(14.dp)
                                    )
                                }
                            }
                        }
                    }
                }

                // Middle: Text Input
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 4.dp)
                ) {
                    if (input.isEmpty()) {
                        Text(
                            text = "Ask for follow-up changes",
                            style = MaterialTheme.typography.bodyLarge,
                            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                            modifier = Modifier.padding(vertical = 8.dp)
                        )
                    }
                    BasicTextField(
                        value = input,
                        onValueChange = onInputChanged,
                        modifier = Modifier
                            .fillMaxWidth()
                            .onFocusChanged { isFocused = it.isFocused }
                            .padding(vertical = 8.dp),
                        textStyle = MaterialTheme.typography.bodyLarge.copy(
                            color = MaterialTheme.colorScheme.onSurface
                        ),
                        cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                        keyboardOptions = KeyboardOptions(
                            imeAction = ImeAction.Send,
                            capitalization = KeyboardCapitalization.Sentences,
                        ),
                        keyboardActions = KeyboardActions(onSend = { if (sendEnabled) onSend(isPlanModeArmed) }),
                        minLines = 1,
                        maxLines = 10,
                    )
                }

                // Bottom: Toolbar Row
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconButton(
                        onClick = { plusMenuExpanded = true },
                        enabled = !isRunning,
                        modifier = Modifier.size(32.dp),
                    ) {
                        Icon(
                            Icons.Outlined.Add, 
                            contentDescription = "Composer options",
                            tint = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        DropdownMenu(
                            expanded = plusMenuExpanded,
                            onDismissRequest = { plusMenuExpanded = false },
                        ) {
                            DropdownMenuItem(
                                text = { Text(if (isPlanModeArmed) "Disable Plan Mode" else "Enable Plan Mode") },
                                leadingIcon = {
                                    if (isPlanModeArmed) {
                                        Icon(Icons.Outlined.Check, contentDescription = null)
                                    }
                                },
                                onClick = {
                                    isPlanModeArmed = !isPlanModeArmed
                                    plusMenuExpanded = false
                                },
                            )
                        }
                    }

                    Box {
                        ComposerMetaButton(
                            title = selectedModelTitle,
                            enabled = orderedModels.isNotEmpty() && !isRunning,
                            onClick = { modelMenuExpanded = true },
                        )
                        DropdownMenu(
                            expanded = modelMenuExpanded,
                            onDismissRequest = { modelMenuExpanded = false },
                        ) {
                            orderedModels.forEach { model ->
                                DropdownMenuItem(
                                    text = { Text(composerModelTitle(model)) },
                                    leadingIcon = if (selectedModel?.id == model.id) {
                                        { Icon(Icons.Outlined.Check, contentDescription = null) }
                                    } else {
                                        null
                                    },
                                    onClick = {
                                        onSelectModel(model.id)
                                        modelMenuExpanded = false
                                    },
                                )
                            }
                        }
                    }

                    Box {
                        ComposerMetaButton(
                            title = selectedReasoningTitle,
                            enabled = reasoningOptions.isNotEmpty() && !isRunning,
                            onClick = { reasoningMenuExpanded = true },
                        )
                        DropdownMenu(
                            expanded = reasoningMenuExpanded,
                            onDismissRequest = { reasoningMenuExpanded = false },
                        ) {
                            selectedModel?.supportedReasoningEfforts?.forEach { effort ->
                                DropdownMenuItem(
                                    text = { Text(composerReasoningTitle(effort)) },
                                    leadingIcon = if (state.selectedReasoningEffort == effort) {
                                        { Icon(Icons.Outlined.Check, contentDescription = null) }
                                    } else {
                                        null
                                    },
                                    onClick = {
                                        onSelectReasoning(effort)
                                        reasoningMenuExpanded = false
                                    },
                                )
                            }
                        }
                    }

                    Spacer(Modifier.weight(1f))

                    ContextWindowProgressRing(
                        percentage = state.contextWindowUsage?.percentage ?: 0.05f,
                        size = 18.dp
                    )

                    Spacer(Modifier.width(4.dp))

                    if (isRunning) {
                        IconButton(
                            onClick = onStop,
                            modifier = Modifier
                                .size(40.dp)
                                .background(MaterialTheme.colorScheme.onSurface, CircleShape),
                        ) {
                            Icon(
                                Icons.Outlined.Close,
                                contentDescription = "Stop",
                                tint = MaterialTheme.colorScheme.surface,
                                modifier = Modifier.size(20.dp)
                            )
                        }
                    } else {
                        IconButton(
                            onClick = { onSend(isPlanModeArmed) },
                            enabled = sendEnabled,
                            modifier = Modifier
                                .size(40.dp)
                                .background(
                                    if (sendEnabled) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant,
                                    CircleShape,
                                ),
                        ) {
                            Icon(
                                Icons.AutoMirrored.Outlined.Send,
                                contentDescription = "Send",
                                tint = if (sendEnabled) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f),
                                modifier = Modifier.size(20.dp)
                            )
                        }
                    }
                }
            }
        }

        // New Control Row (Secondary Row)
        AnimatedVisibility(visible = !isFocused) {
            Surface(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(999.dp),
                color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 12.dp, vertical = 6.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    // Local/Cloud Switcher
                    Surface(
                        onClick = { isLocalMode = !isLocalMode },
                        shape = RoundedCornerShape(999.dp),
                        color = MaterialTheme.colorScheme.surface.copy(alpha = 0.7f),
                    ) {
                        Row(
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(6.dp)
                        ) {
                            Box(
                                modifier = Modifier
                                    .size(6.dp)
                                    .background(if (isLocalMode) CommandAccent else PlanAccent, CircleShape)
                            )
                            Text(
                                text = if (isLocalMode) "Local" else "Cloud",
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurface
                            )
                        }
                    }

                    // Access Mode Badge
                    Box {
                        ComposerSecondaryChip(
                            label = "Access",
                            value = state.accessMode.displayName,
                            onClick = { accessMenuExpanded = true },
                        )
                        DropdownMenu(
                            expanded = accessMenuExpanded,
                            onDismissRequest = { accessMenuExpanded = false },
                        ) {
                            AccessMode.entries.forEach { mode ->
                                DropdownMenuItem(
                                    text = { Text(mode.displayName) },
                                    leadingIcon = if (state.accessMode == mode) {
                                        { Icon(Icons.Outlined.Check, contentDescription = null) }
                                    } else {
                                        null
                                    },
                                    onClick = {
                                        onSelectAccessMode(mode)
                                        accessMenuExpanded = false
                                    },
                                )
                            }
                        }
                    }

                    // Git Branch Selector
                    state.gitRepoSyncResult?.branch?.let { branch ->
                        Box {
                            val isDirty = state.gitRepoSyncResult?.isDirty == true
                            val branchText = if (isDirty) "$branch*" else branch
                            
                            Surface(
                                onClick = { gitMenuExpanded = true },
                                shape = RoundedCornerShape(999.dp),
                                color = Color.Transparent
                            ) {
                                Row(
                                    modifier = Modifier.padding(horizontal = 4.dp, vertical = 4.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(4.dp)
                                ) {
                                    Icon(
                                        painter = androidx.compose.ui.res.painterResource(id = android.R.drawable.ic_menu_share),
                                        contentDescription = null,
                                        modifier = Modifier.size(14.dp),
                                        tint = MaterialTheme.colorScheme.onSurfaceVariant
                                    )
                                    Text(
                                        text = branchText,
                                        style = MaterialTheme.typography.labelMedium,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis
                                    )
                                }
                            }

                            DropdownMenu(
                                expanded = gitMenuExpanded,
                                onDismissRequest = { gitMenuExpanded = false }
                            ) {
                                com.remodex.android.data.model.TurnGitActionKind.entries.forEach { action ->
                                    DropdownMenuItem(
                                        text = { Text(action.title) },
                                        onClick = {
                                            gitMenuExpanded = false
                                            val currentCwdLocal = state.selectedThread?.cwd
                                            if (currentCwdLocal != null) {
                                                coroutineScope.launch {
                                                    viewModel.performGitAction(currentCwdLocal, action)
                                                    viewModel.gitStatus(currentCwdLocal)
                                                }
                                            }
                                        }
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
internal fun ComposerMetaButton(
    title: String,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    Surface(
        onClick = onClick,
        enabled = enabled,
        shape = RoundedCornerShape(8.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f)
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp)
        ) {
            Text(
                text = title,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Icon(
                Icons.Default.KeyboardArrowDown,
                contentDescription = null,
                modifier = Modifier.size(14.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

@Composable
internal fun ComposerSecondaryChip(
    label: String,
    value: String,
    onClick: () -> Unit,
) {
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(999.dp),
        color = Color.Transparent
    ) {
        Text(
            text = "$label: $value",
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(horizontal = 4.dp, vertical = 4.dp)
        )
    }
}


@Composable
internal fun ComposerStaticChip(
    label: String,
    value: String,
) {
    Surface(
        shape = RoundedCornerShape(999.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.46f),
    ) {
        Text(
            text = "$label: $value",
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
        )
    }
}

internal fun resolveSelectedModelOption(state: AppState): ModelOption? {
    return state.availableModels.firstOrNull {
        it.id == state.selectedModelId || it.model == state.selectedModelId
    } ?: state.availableModels.firstOrNull { it.isDefault }
        ?: state.availableModels.firstOrNull()
}

internal fun orderedComposerModels(models: List<ModelOption>): List<ModelOption> {
    val preferredOrder = listOf(
        "gpt-5.1-codex-mini",
        "gpt-5.2",
        "gpt-5.1-codex-max",
        "gpt-5.2-codex",
        "gpt-5.3-codex",
    )
    val ranks = preferredOrder.withIndex().associate { (index, model) -> model to index }
    return models.sortedWith(
        compareBy<ModelOption> { ranks[it.model.lowercase()] ?: Int.MAX_VALUE }
            .thenByDescending { composerModelTitle(it) },
    )
}

internal fun composerModelTitle(model: ModelOption): String {
    return when (model.model.lowercase()) {
        "gpt-5.3-codex" -> "GPT-5.3-Codex"
        "gpt-5.2-codex" -> "GPT-5.2-Codex"
        "gpt-5.1-codex-max" -> "GPT-5.1-Codex-Max"
        "gpt-5.4" -> "GPT-5.4"
        "gpt-5.2" -> "GPT-5.2"
        "gpt-5.1-codex-mini" -> "GPT-5.1-Codex-Mini"
        else -> model.title
    }
}

internal fun composerReasoningTitle(effort: String): String {
    return when (effort.trim().lowercase()) {
        "minimal", "low" -> "Low"
        "medium" -> "Medium"
        "high" -> "High"
        "xhigh", "extra_high", "extra-high", "very_high", "very-high" -> "Extra High"
        else -> effort.split('_', '-').joinToString(" ") { token ->
            token.replaceFirstChar { character -> character.titlecase() }
        }
    }
}



internal fun composerConnectionMessage(state: AppState): String {
    return when (state.connectionPhase) {
        ConnectionPhase.CONNECTING -> "Re-establishing the local bridge session."
        ConnectionPhase.LOADING_CHATS -> "Connected securely. Loading conversation history."
        ConnectionPhase.SYNCING -> "Syncing recent thread state from your Mac."
        ConnectionPhase.CONNECTED -> "Connected to your paired Mac."
        ConnectionPhase.OFFLINE -> "Reconnect to the paired bridge before sending."
    }
}

@Composable
internal fun ContextWindowProgressRing(
    percentage: Float,
    modifier: Modifier = Modifier,
    size: androidx.compose.ui.unit.Dp = 20.dp,
    strokeWidth: androidx.compose.ui.unit.Dp = 3.dp
) {
    val trackColor = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.1f)
    val progressColor = if (percentage > 0.9f) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary
    
    Canvas(modifier = modifier.size(size)) {
        drawArc(
            color = trackColor,
            startAngle = 0f,
            sweepAngle = 360f,
            useCenter = false,
            style = Stroke(width = strokeWidth.toPx(), cap = StrokeCap.Round),
            size = Size(size.toPx(), size.toPx())
        )
        
        drawArc(
            color = progressColor,
            startAngle = -90f,
            sweepAngle = 360f * percentage,
            useCenter = false,
            style = Stroke(width = strokeWidth.toPx(), cap = StrokeCap.Round),
            size = Size(size.toPx(), size.toPx())
        )
    }
}

