package com.coderover.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.coderover.android.app.AppViewModel
import com.coderover.android.ui.CodeRoverApp
import com.coderover.android.ui.theme.CodeRoverTheme

class MainActivity : ComponentActivity() {
    private val viewModel by viewModels<AppViewModel>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            val state by viewModel.state.collectAsStateWithLifecycle()
            CodeRoverTheme(fontStyle = state.fontStyle) {
                CodeRoverApp(
                    state = state,
                    viewModel = viewModel,
                )
            }
        }
    }
}
