// FILE: SecureTransportModels.swift
// Purpose: Defines the wire payloads, device trust records, and crypto helpers for CodeRover E2EE.
// Layer: Service support
// Exports: Pairing/session models plus transcript, nonce, and key utility helpers
// Depends on: Foundation, CryptoKit

import CryptoKit
import Foundation

let coderoverSecureProtocolVersion = 1
let coderoverPairingQRVersion = 3
let coderoverSecureHandshakeTag = "coderover-e2ee-v1"
let coderoverSecureHandshakeLabel = "client-auth"
let coderoverSecureClockSkewToleranceSeconds: TimeInterval = 60

enum CodeRoverSecureHandshakeMode: String, Codable, Sendable {
    case qrBootstrap = "qr_bootstrap"
    case trustedReconnect = "trusted_reconnect"
}

enum CodeRoverSecureConnectionState: Equatable, Sendable {
    case notPaired
    case trustedMac
    case handshaking
    case encrypted
    case reconnecting
    case rePairRequired
    case updateRequired
}

struct CodeRoverPairingQRPayload: Codable, Sendable {
    let v: Int
    let bridgeId: String
    let macDeviceId: String
    let macIdentityPublicKey: String
    let transportCandidates: [CodeRoverTransportCandidate]
    let expiresAt: Int64
}

struct CodeRoverBridgePairingRecord: Codable, Hashable, Identifiable, Sendable {
    var bridgeId: String
    var macDeviceId: String
    var macIdentityPublicKey: String
    var transportCandidates: [CodeRoverTransportCandidate]
    var preferredTransportURL: String?
    var lastSuccessfulTransportURL: String?
    var secureProtocolVersion: Int
    var lastAppliedBridgeOutboundSeq: Int
    var lastPairedAt: Date

    var id: String { macDeviceId }
}

struct CodeRoverTransportCandidate: Codable, Hashable, Sendable {
    let kind: String
    let url: String
    let label: String?
}

struct CodeRoverPhoneIdentityState: Codable, Sendable {
    let phoneDeviceId: String
    let phoneIdentityPrivateKey: String
    let phoneIdentityPublicKey: String
}

struct CodeRoverTrustedMacRecord: Codable, Sendable {
    let macDeviceId: String
    let macIdentityPublicKey: String
    let lastPairedAt: Date
}

struct CodeRoverTrustedMacRegistry: Codable, Sendable {
    var records: [String: CodeRoverTrustedMacRecord]

    static let empty = CodeRoverTrustedMacRegistry(records: [:])
}

struct SecureClientHello: Codable, Sendable {
    let kind = "clientHello"
    let protocolVersion: Int
    let sessionId: String
    let handshakeMode: CodeRoverSecureHandshakeMode
    let phoneDeviceId: String
    let phoneIdentityPublicKey: String
    let phoneEphemeralPublicKey: String
    let clientNonce: String
}

struct SecureServerHello: Codable, Sendable {
    let kind: String
    let protocolVersion: Int
    let sessionId: String
    let handshakeMode: CodeRoverSecureHandshakeMode
    let macDeviceId: String
    let macIdentityPublicKey: String
    let macEphemeralPublicKey: String
    let serverNonce: String
    let keyEpoch: Int
    let expiresAtForTranscript: Int64
    let macSignature: String
    let clientNonce: String?
}

struct SecureClientAuth: Codable, Sendable {
    let kind = "clientAuth"
    let sessionId: String
    let phoneDeviceId: String
    let keyEpoch: Int
    let phoneSignature: String
}

struct SecureReadyMessage: Codable, Sendable {
    let kind: String
    let sessionId: String
    let keyEpoch: Int
    let macDeviceId: String
}

struct SecureResumeState: Codable, Sendable {
    let kind = "resumeState"
    let sessionId: String
    let keyEpoch: Int
    let lastAppliedBridgeOutboundSeq: Int
}

struct SecureErrorMessage: Codable, Sendable {
    let kind: String
    let code: String
    let message: String
}

struct SecureEnvelope: Codable, Sendable {
    let kind: String
    let v: Int
    let sessionId: String
    let keyEpoch: Int
    let sender: String
    let counter: Int
    let ciphertext: String
    let tag: String
}

struct SecureApplicationPayload: Codable, Sendable {
    let bridgeOutboundSeq: Int?
    let payloadText: String
}

struct CodeRoverSecureSession {
    let sessionId: String
    let keyEpoch: Int
    let macDeviceId: String
    let macIdentityPublicKey: String
    let phoneToMacKey: SymmetricKey
    let macToPhoneKey: SymmetricKey
    var lastInboundBridgeOutboundSeq: Int
    var lastInboundCounter: Int
    var nextOutboundCounter: Int
}

struct CodeRoverPendingHandshake {
    let mode: CodeRoverSecureHandshakeMode
    let transcriptBytes: Data
    let phoneEphemeralPrivateKey: Curve25519.KeyAgreement.PrivateKey
    let phoneDeviceId: String
}

enum CodeRoverSecureTransportError: LocalizedError {
    case invalidQR(String)
    case secureError(String)
    case incompatibleVersion(String)
    case invalidHandshake(String)
    case decryptFailed
    case timedOut(String)

    var errorDescription: String? {
        switch self {
        case .invalidQR(let message),
             .secureError(let message),
             .incompatibleVersion(let message),
             .invalidHandshake(let message),
             .timedOut(let message):
            return message
        case .decryptFailed:
            return "Unable to decrypt the secure CodeRover payload."
        }
    }
}

extension CodeRoverSecureConnectionState {
    var blocksAutomaticReconnect: Bool {
        switch self {
        case .rePairRequired, .updateRequired:
            return true
        case .notPaired, .trustedMac, .handshaking, .encrypted, .reconnecting:
            return false
        }
    }

    var statusLabel: String {
        switch self {
        case .notPaired:
            return "Not paired"
        case .trustedMac:
            return "Trusted Mac"
        case .handshaking:
            return "Secure handshake in progress"
        case .encrypted:
            return "End-to-end encrypted"
        case .reconnecting:
            return "Reconnecting securely"
        case .rePairRequired:
            return "Re-pair required"
        case .updateRequired:
            return "Update required"
        }
    }
}

// Builds the exact transcript bytes used by both signatures and HKDF salt.
func coderoverSecureTranscriptBytes(
    sessionId: String,
    protocolVersion: Int,
    handshakeMode: CodeRoverSecureHandshakeMode,
    keyEpoch: Int,
    macDeviceId: String,
    phoneDeviceId: String,
    macIdentityPublicKey: String,
    phoneIdentityPublicKey: String,
    macEphemeralPublicKey: String,
    phoneEphemeralPublicKey: String,
    clientNonce: Data,
    serverNonce: Data,
    expiresAtForTranscript: Int64
) -> Data {
    var data = Data()
    data.appendLengthPrefixedUTF8(coderoverSecureHandshakeTag)
    data.appendLengthPrefixedUTF8(sessionId)
    data.appendLengthPrefixedUTF8(String(protocolVersion))
    data.appendLengthPrefixedUTF8(handshakeMode.rawValue)
    data.appendLengthPrefixedUTF8(String(keyEpoch))
    data.appendLengthPrefixedUTF8(macDeviceId)
    data.appendLengthPrefixedUTF8(phoneDeviceId)
    data.appendLengthPrefixedData(Data(base64EncodedOrEmpty: macIdentityPublicKey))
    data.appendLengthPrefixedData(Data(base64EncodedOrEmpty: phoneIdentityPublicKey))
    data.appendLengthPrefixedData(Data(base64EncodedOrEmpty: macEphemeralPublicKey))
    data.appendLengthPrefixedData(Data(base64EncodedOrEmpty: phoneEphemeralPublicKey))
    data.appendLengthPrefixedData(clientNonce)
    data.appendLengthPrefixedData(serverNonce)
    data.appendLengthPrefixedUTF8(String(expiresAtForTranscript))
    return data
}

// Keeps the client-auth signature domain-separated from the shared transcript signature.
func coderoverClientAuthTranscript(from transcriptBytes: Data) -> Data {
    var data = transcriptBytes
    data.appendLengthPrefixedUTF8(coderoverSecureHandshakeLabel)
    return data
}

// Derives the deterministic AES-GCM nonce from direction + counter.
func coderoverSecureNonce(sender: String, counter: Int) -> Data {
    var nonce = Data(repeating: 0, count: 12)
    nonce[0] = (sender == "mac") ? 1 : 2
    var remaining = UInt64(counter)
    for index in stride(from: 11, through: 1, by: -1) {
        nonce[index] = UInt8(remaining & 0xff)
        remaining >>= 8
    }
    return nonce
}

func coderoverSecureFingerprint(for publicKeyBase64: String) -> String {
    let digest = SHA256.hash(data: Data(base64EncodedOrEmpty: publicKeyBase64))
    return digest.compactMap { String(format: "%02x", $0) }.joined().prefix(12).uppercased()
}

func coderoverPhoneIdentityStateFromSecureStore() -> CodeRoverPhoneIdentityState {
    if let existing: CodeRoverPhoneIdentityState = SecureStore.readCodable(
        CodeRoverPhoneIdentityState.self,
        for: CodeRoverSecureKeys.phoneIdentityState
    ) {
        return existing
    }

    let privateKey = Curve25519.Signing.PrivateKey()
    let next = CodeRoverPhoneIdentityState(
        phoneDeviceId: UUID().uuidString,
        phoneIdentityPrivateKey: privateKey.rawRepresentation.base64EncodedString(),
        phoneIdentityPublicKey: privateKey.publicKey.rawRepresentation.base64EncodedString()
    )
    SecureStore.writeCodable(next, for: CodeRoverSecureKeys.phoneIdentityState)
    return next
}

func coderoverTrustedMacRegistryFromSecureStore() -> CodeRoverTrustedMacRegistry {
    SecureStore.readCodable(CodeRoverTrustedMacRegistry.self, for: CodeRoverSecureKeys.trustedMacRegistry)
    ?? .empty
}

extension Data {
    init(base64EncodedOrEmpty value: String) {
        self = Data(base64Encoded: value) ?? Data()
    }

    mutating func appendLengthPrefixedUTF8(_ value: String) {
        appendLengthPrefixedData(Data(value.utf8))
    }

    mutating func appendLengthPrefixedData(_ value: Data) {
        var length = UInt32(value.count).bigEndian
        append(Data(bytes: &length, count: MemoryLayout<UInt32>.size))
        append(value)
    }
}
