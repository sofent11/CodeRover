package com.coderover.android.ui.components

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

@Composable
fun PairingScannerView(
    modifier: Modifier = Modifier,
    onCodeScanned: (String, resetScanLock: () -> Unit) -> Unit,
    permissionDeniedContent: @Composable (() -> Unit)? = null,
    overlayContent: @Composable (() -> Unit)? = null,
) {
    val context = LocalContext.current
    var isCheckingPermission by remember { mutableStateOf(true) }
    var hasCameraPermission by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED,
        )
    }
    val permissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission(),
    ) { granted ->
        hasCameraPermission = granted
        isCheckingPermission = false
    }

    LaunchedEffect(Unit) {
        if (!hasCameraPermission) {
            permissionLauncher.launch(Manifest.permission.CAMERA)
        } else {
            isCheckingPermission = false
        }
    }

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(Color.Black),
    ) {
        when {
            isCheckingPermission -> {
                Box(
                    modifier = Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(
                        color = Color.White,
                    )
                }
            }
            hasCameraPermission -> {
                CameraPreview(
                    modifier = Modifier.fillMaxSize(),
                    onCodeScanned = onCodeScanned,
                )
                if (overlayContent != null) {
                    overlayContent()
                }
            }
            else -> {
                if (permissionDeniedContent != null) {
                    permissionDeniedContent()
                } else {
                    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Button(onClick = {
                            isCheckingPermission = true
                            permissionLauncher.launch(Manifest.permission.CAMERA)
                        }) {
                            Text("Allow Camera")
                        }
                    }
                }
            }
        }
    }
}

@SuppressLint("UnsafeOptInUsageError")
@Composable
private fun CameraPreview(
    modifier: Modifier,
    onCodeScanned: (String, resetScanLock: () -> Unit) -> Unit,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val cameraExecutor = remember { Executors.newSingleThreadExecutor() }
    val didScan = remember { AtomicBoolean(false) }
    val currentOnCodeScanned by rememberUpdatedState(onCodeScanned)
    val isDisposed = remember { AtomicBoolean(false) }
    val cameraProviderRef = remember { AtomicReference<ProcessCameraProvider?>(null) }
    val previewRef = remember { AtomicReference<Preview?>(null) }
    val imageAnalysisRef = remember { AtomicReference<ImageAnalysis?>(null) }

    val resetScanLock: () -> Unit = {
        didScan.set(false)
    }
    val analyzer = remember {
        QrCodeAnalyzer(
            onCodeScanned = { code ->
                if (didScan.compareAndSet(false, true)) {
                    currentOnCodeScanned(code, resetScanLock)
                }
            },
        )
    }

    DisposableEffect(cameraExecutor, analyzer) {
        isDisposed.set(false)
        onDispose {
            isDisposed.set(true)
            val imageAnalysis = imageAnalysisRef.getAndSet(null)
            imageAnalysis?.clearAnalyzer()
            val preview = previewRef.getAndSet(null)
            cameraProviderRef.getAndSet(null)?.let { cameraProvider ->
                if (preview != null || imageAnalysis != null) {
                    cameraProvider.unbind(
                        *listOfNotNull(preview, imageAnalysis).toTypedArray(),
                    )
                } else {
                    cameraProvider.unbindAll()
                }
            }
            analyzer.close()
            cameraExecutor.shutdown()
        }
    }

    Box(modifier = modifier) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { androidContext ->
                val previewView = PreviewView(androidContext)
                val cameraProviderFuture = ProcessCameraProvider.getInstance(androidContext)
                cameraProviderFuture.addListener(
                    {
                        val cameraProvider = cameraProviderFuture.get()
                        if (isDisposed.get()) {
                            cameraProvider.unbindAll()
                            return@addListener
                        }
                        val preview = Preview.Builder().build().also {
                            it.surfaceProvider = previewView.surfaceProvider
                        }
                        val imageAnalysis = ImageAnalysis.Builder()
                            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                            .build()
                            .also {
                                it.setAnalyzer(cameraExecutor, analyzer)
                            }

                        val cameraSelector = CameraSelector.DEFAULT_BACK_CAMERA
                        cameraProvider.unbindAll()
                        cameraProvider.bindToLifecycle(
                            lifecycleOwner,
                            cameraSelector,
                            preview,
                            imageAnalysis,
                        )
                        cameraProviderRef.set(cameraProvider)
                        previewRef.set(preview)
                        imageAnalysisRef.set(imageAnalysis)
                    },
                    ContextCompat.getMainExecutor(androidContext),
                )
                previewView
            },
        )
    }
}

private class QrCodeAnalyzer(
    private val onCodeScanned: (String) -> Unit,
) : ImageAnalysis.Analyzer {
    private val scanner = BarcodeScanning.getClient(
        BarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
            .build(),
    )

    override fun analyze(imageProxy: ImageProxy) {
        val mediaImage = imageProxy.image
        if (mediaImage == null) {
            imageProxy.close()
            return
        }

        val inputImage = InputImage.fromMediaImage(mediaImage, imageProxy.imageInfo.rotationDegrees)
        scanner.process(inputImage)
            .addOnSuccessListener { barcodes ->
                barcodes.firstOrNull()?.rawValue?.let(onCodeScanned)
            }
            .addOnFailureListener {
                // Ignore noisy scan failures and keep analyzing.
            }
            .addOnCompleteListener {
                imageProxy.close()
            }
    }

    fun close() {
        scanner.close()
    }
}
