package com.remodex.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.remodex.android.app.AppViewModel
import com.remodex.android.ui.RemodexApp
import com.remodex.android.ui.theme.RemodexTheme

class MainActivity : ComponentActivity() {
    private val viewModel by viewModels<AppViewModel>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            val state by viewModel.state.collectAsStateWithLifecycle()
            RemodexTheme(fontStyle = state.fontStyle) {
                RemodexApp(
                    state = state,
                    viewModel = viewModel,
                )
            }
        }
    }
}
