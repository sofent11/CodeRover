// FILE: QRScannerView.swift
// Purpose: AVFoundation camera-based QR scanner for local bridge pairing.
// Layer: View
// Exports: QRScannerView
// Depends on: SwiftUI, AVFoundation

import AVFoundation
import SwiftUI

struct QRScannerView: View {
    let onScan: (CodeRoverPairingQRPayload) -> Void

    @State private var scannerError: String?
    @State private var lastRejectedCode: String?
    @State private var lastRejectedMessage: String?
    @State private var hasCameraPermission = false
    @State private var isCheckingPermission = true

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if isCheckingPermission {
                ProgressView()
                    .tint(.white)
            } else if hasCameraPermission {
                QRCameraPreview { code, resetScanLock in
                    handleScanResult(code, resetScanLock: resetScanLock)
                }
                .ignoresSafeArea()

                scannerOverlay
            } else {
                cameraPermissionView
            }
        }
        .task {
            await checkCameraPermission()
        }
        .alert("Scan Error", isPresented: Binding(
            get: { scannerError != nil },
            set: { if !$0 { scannerError = nil } }
        )) {
            Button("OK", role: .cancel) { scannerError = nil }
        } message: {
            Text(scannerError ?? "Invalid QR code")
        }
    }

    private var scannerOverlay: some View {
        VStack(spacing: 24) {
            Spacer()

            RoundedRectangle(cornerRadius: 20)
                .stroke(Color.white.opacity(0.6), lineWidth: 2)
                .frame(width: 250, height: 250)

            Text("Scan QR code from CodeRover CLI")
                .font(AppFont.subheadline(weight: .medium))
                .foregroundStyle(.white)

            Spacer()
        }
    }

    private var cameraPermissionView: some View {
        VStack(spacing: 20) {
            Image(systemName: "camera.fill")
                .font(.system(size: 48))
                .foregroundStyle(.secondary)

            Text("Camera access needed")
                .font(AppFont.title3(weight: .semibold))
                .foregroundStyle(.white)

            Text("Open Settings and allow camera access to scan the pairing QR code.")
                .font(AppFont.subheadline())
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)

            Button("Open Settings") {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            }
            .buttonStyle(.borderedProminent)
        }
    }

    private func checkCameraPermission() async {
        let status = AVCaptureDevice.authorizationStatus(for: .video)
        switch status {
        case .authorized:
            hasCameraPermission = true
        case .notDetermined:
            hasCameraPermission = await AVCaptureDevice.requestAccess(for: .video)
        default:
            hasCameraPermission = false
        }
        isCheckingPermission = false
    }

    private func handleScanResult(_ code: String, resetScanLock: @escaping () -> Void) {
        guard let data = code.data(using: .utf8) else {
            rejectScan(
                code: code,
                message: "QR code contains invalid text encoding.",
                resetScanLock: resetScanLock
            )
            return
        }

        let decoder = JSONDecoder()
        guard let payload = try? decoder.decode(CodeRoverPairingQRPayload.self, from: data) else {
            rejectScan(
                code: code,
                message: "Not a valid secure pairing code. Make sure you're scanning a QR from the latest CodeRover bridge.",
                resetScanLock: resetScanLock
            )
            return
        }

        guard payload.v == coderoverPairingQRVersion else {
            rejectScan(
                code: code,
                message: "This QR code uses an unsupported pairing format. Update the iPhone app or the Mac bridge and try again.",
                resetScanLock: resetScanLock
            )
            return
        }

        guard !payload.bridgeId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            rejectScan(
                code: code,
                message: "QR code is missing the bridge ID. Re-generate the code from the bridge.",
                resetScanLock: resetScanLock
            )
            return
        }

        guard !payload.transportCandidates.isEmpty else {
            rejectScan(
                code: code,
                message: "QR code is missing bridge transports. Re-generate the code from the bridge.",
                resetScanLock: resetScanLock
            )
            return
        }

        let expiryDate = Date(timeIntervalSince1970: TimeInterval(payload.expiresAt) / 1000)
        if expiryDate.addingTimeInterval(coderoverSecureClockSkewToleranceSeconds) < Date() {
            rejectScan(
                code: code,
                message: "This pairing QR code has expired. Generate a new one from the Mac bridge.",
                resetScanLock: resetScanLock
            )
            return
        }

        lastRejectedCode = nil
        lastRejectedMessage = nil
        HapticFeedback.shared.triggerImpactFeedback(style: .heavy)
        onScan(payload)
    }

    private func rejectScan(
        code: String,
        message: String,
        resetScanLock: @escaping () -> Void
    ) {
        let isDuplicateRejection = lastRejectedCode == code && lastRejectedMessage == message
        lastRejectedCode = code
        lastRejectedMessage = message
        if !isDuplicateRejection {
            scannerError = message
        }
        resetScanLock()
    }
}

// MARK: - Camera Preview UIViewRepresentable

private struct QRCameraPreview: UIViewRepresentable {
    let onScan: (String, _ resetScanLock: @escaping () -> Void) -> Void

    func makeUIView(context: Context) -> QRCameraUIView {
        let view = QRCameraUIView()
        view.onScan = { [weak view] code in
            onScan(code) {
                view?.resetScanLock()
            }
        }
        return view
    }

    func updateUIView(_ uiView: QRCameraUIView, context: Context) {}
}

private class QRCameraUIView: UIView, AVCaptureMetadataOutputObjectsDelegate {
    var onScan: ((String) -> Void)?

    private let captureSession = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "com.coderover.qr-camera")
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var hasScanned = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        setupCamera()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setupCamera()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        previewLayer?.frame = bounds
    }

    private func setupCamera() {
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device) else {
            return
        }

        if captureSession.canAddInput(input) {
            captureSession.addInput(input)
        }

        let output = AVCaptureMetadataOutput()
        if captureSession.canAddOutput(output) {
            captureSession.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]
        }

        let layer = AVCaptureVideoPreviewLayer(session: captureSession)
        layer.videoGravity = .resizeAspectFill
        self.layer.addSublayer(layer)
        previewLayer = layer

        sessionQueue.async { [weak self] in
            self?.captureSession.startRunning()
        }
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard !hasScanned,
              let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              object.type == .qr,
              let code = object.stringValue else {
            return
        }

        hasScanned = true
        onScan?(code)
    }

    func resetScanLock() {
        hasScanned = false
    }

    deinit {
        let session = captureSession
        sessionQueue.async {
            session.stopRunning()
        }
    }
}
