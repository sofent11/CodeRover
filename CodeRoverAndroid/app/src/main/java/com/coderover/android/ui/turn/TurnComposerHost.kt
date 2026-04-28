package com.coderover.android.ui.turn

import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import android.util.Log
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.platform.LocalContext
import com.coderover.android.app.AppViewModel
import com.coderover.android.data.model.AccessMode
import com.coderover.android.data.model.AppState
import com.coderover.android.data.model.CodeRoverReviewTarget
import com.coderover.android.data.model.ImageAttachment
import com.coderover.android.data.model.TurnSkillMention
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable
internal fun TurnComposerHost(
    state: AppState,
    input: String,
    onInputChanged: (String) -> Unit,
    isRunning: Boolean,
    onSend: (String, List<ImageAttachment>, List<TurnSkillMention>, Boolean) -> Unit,
    onStartReview: (String, CodeRoverReviewTarget, String?) -> Unit,
    onShowStatus: () -> Unit,
    onStop: () -> Unit,
    onReconnect: () -> Unit,
    onSelectModel: (String?) -> Unit,
    onSelectReasoning: (String?) -> Unit,
    onSelectAccessMode: (AccessMode) -> Unit,
    turnViewModel: TurnViewModel,
    viewModel: AppViewModel,
) {
    val isCodexThread = remember(state.selectedThread?.provider, state.selectedProviderId) {
        (state.selectedThread?.provider ?: state.selectedProviderId).trim().lowercase() == "codex"
    }
    val context = LocalContext.current
    val clipboardManager = remember(context) {
        context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    }
    val coroutineScope = rememberCoroutineScope()
    val selectedModel = remember(state.availableModels, state.selectedModelId) {
        resolveSelectedModelOption(state)
    }
    val orderedModels = remember(state.availableModels) { orderedComposerModels(state.availableModels) }
    val autocompleteRequest = remember(input, state.selectedThreadId) {
        turnViewModel.autocompleteRequest(input, state.selectedThreadId)
    }
    val selectedModelTitle = remember(selectedModel) {
        selectedModel?.let(::composerModelTitle) ?: "Select model"
    }
    val selectedReasoningTitle = remember(selectedModel, state.selectedReasoningEffort) {
        selectedModel?.let {
            state.selectedReasoningEffort
                ?.takeIf { effort -> it.supportedReasoningEfforts.contains(effort) }
                ?.let(::composerReasoningTitle)
                ?: it.defaultReasoningEffort?.let(::composerReasoningTitle)
                ?: it.supportedReasoningEfforts.firstOrNull()?.let(::composerReasoningTitle)
        } ?: "Select reasoning"
    }
    fun enqueueImageUris(uris: List<android.net.Uri>) {
        if (uris.isEmpty()) {
            turnViewModel.setComposerNotice("No image available.")
            return
        }
        val intakePlan = turnViewModel.prepareAttachmentIntake(uris.size)
        uris.take(intakePlan.acceptedCount).zip(intakePlan.reservedAttachmentIds).forEach { (uri, attachmentId) ->
            coroutineScope.launch {
                val payload = withContext(Dispatchers.IO) {
                    TurnComposerAttachmentIntake.readBytes(context, uri)
                }
                turnViewModel.resolveComposerAttachment(attachmentId, payload)
            }
        }
    }
    val imagePickerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.GetMultipleContents(),
    ) { uris ->
        if (uris.isEmpty()) {
            return@rememberLauncherForActivityResult
        }
        enqueueImageUris(uris)
    }
    val cameraLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.TakePicturePreview(),
    ) { bitmap: Bitmap? ->
        if (bitmap == null) {
            return@rememberLauncherForActivityResult
        }
        val reservedId = turnViewModel.prepareAttachmentIntake(1).reservedAttachmentIds.firstOrNull()
            ?: return@rememberLauncherForActivityResult
        coroutineScope.launch {
            val payload = withContext(Dispatchers.IO) {
                TurnComposerAttachmentIntake.encodeCameraPreview(bitmap)
            }
            turnViewModel.resolveComposerAttachment(reservedId, payload)
        }
    }

    LaunchedEffect(state.selectedThread?.cwd, state.isConnected) {
        if (!state.isConnected) return@LaunchedEffect
        val cwd = state.selectedThread?.cwd ?: return@LaunchedEffect

        runCatching {
            turnViewModel.refreshGitStatus(viewModel, state)
            viewModel.gitBranchesWithStatus(cwd)
        }.onFailure { failure ->
            Log.w("TurnComposerHost", "Failed to refresh git status for $cwd", failure)
        }
    }

    LaunchedEffect(autocompleteRequest) {
        if (autocompleteRequest == null) {
            turnViewModel.clearAutocomplete()
            return@LaunchedEffect
        }
        delay(250L)
        runCatching {
            turnViewModel.refreshAutocomplete(
                request = autocompleteRequest,
                fuzzyFileSearch = viewModel::fuzzyFileSearch,
                listSkills = viewModel::listSkills,
            )
        }.onFailure { failure ->
            Log.w("TurnComposerHost", "Failed to refresh autocomplete", failure)
        }
    }


    LaunchedEffect(state.selectedThreadId, state.isConnected, isCodexThread) {
        if (!state.isConnected || !isCodexThread) return@LaunchedEffect
        val threadId = state.selectedThreadId ?: return@LaunchedEffect
        viewModel.refreshContextWindowUsage(threadId)
    }

    fun applyInputChange(value: String) {
        turnViewModel.onInputChangedForFileAutocomplete(value)
        turnViewModel.onInputChangedForSkillAutocomplete(value)
        turnViewModel.onInputChangedForSlashCommandAutocomplete(value, isEnabled = isCodexThread)
        onInputChanged(value)
    }

    TurnComposerView(
        state = state,
        input = input,
        onInputChanged = ::applyInputChange,
        isRunning = isRunning,
        onSend = onSend,
        onStartReview = onStartReview,
        onShowStatus = onShowStatus,
        onStop = onStop,
        onReconnect = onReconnect,
        onSelectModel = onSelectModel,
        onSelectReasoning = onSelectReasoning,
        onSelectAccessMode = onSelectAccessMode,
        viewModel = viewModel,
        turnViewModel = turnViewModel,
        isCodexThread = isCodexThread,
        selectedModel = selectedModel,
        orderedModels = orderedModels,
        selectedModelTitle = selectedModelTitle,
        selectedReasoningTitle = selectedReasoningTitle,
        onTapAddImage = {
            if (turnViewModel.remainingAttachmentSlots > 0) {
                imagePickerLauncher.launch("image/*")
            }
        },
        onTapTakePhoto = {
            if (turnViewModel.remainingAttachmentSlots > 0) {
                cameraLauncher.launch(null)
            }
        },
        onTapPasteImage = {
            val imageUris = TurnComposerAttachmentIntake.imageUrisFromClipboard(clipboardManager)
            if (imageUris.isEmpty()) {
                turnViewModel.setComposerNotice("Clipboard does not contain an image.")
            } else {
                enqueueImageUris(imageUris)
            }
        },
    )
}
