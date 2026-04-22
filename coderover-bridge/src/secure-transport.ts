// FILE: secure-transport.ts
// Purpose: Owns the bridge-side E2EE handshake, envelope crypto, and reconnect catch-up buffer.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify,
} from "crypto";

import type { TransportCandidateShape } from "./bridge-types";
import {
  getTrustedPhonePublicKey,
  rememberTrustedPhone,
  type BridgeDeviceState,
} from "./secure-device-state";
import { debugError, debugLog } from "./debug-log";

export const PAIRING_QR_VERSION = 3;
export const SECURE_PROTOCOL_VERSION = 1;
export const HANDSHAKE_MODE_QR_BOOTSTRAP = "qr_bootstrap";
export const HANDSHAKE_MODE_TRUSTED_RECONNECT = "trusted_reconnect";

const HANDSHAKE_TAG = "coderover-e2ee-v1";
const SECURE_SENDER_MAC = "mac";
const SECURE_SENDER_IPHONE = "iphone";
const CLOSE_CODE_REPLACED_CONNECTION = 4003;
const MAX_PAIRING_AGE_MS = 5 * 60 * 1000;
const MAX_BRIDGE_OUTBOUND_MESSAGES = 500;
const MAX_BRIDGE_OUTBOUND_BYTES = 10 * 1024 * 1024;

type HandshakeMode =
  | typeof HANDSHAKE_MODE_QR_BOOTSTRAP
  | typeof HANDSHAKE_MODE_TRUSTED_RECONNECT;
type SecureSender = typeof SECURE_SENDER_MAC | typeof SECURE_SENDER_IPHONE;
type JsonRecord = Record<string, unknown>;

interface BridgeSecureTransportOptions {
  sessionId: string;
  deviceState: BridgeDeviceState;
  transportCandidates?: TransportCandidateShape[];
  onDiagnosticsChanged?: () => void;
  onEvent?: (event: SecureTransportEvent) => void;
}

interface SecureErrorMessage {
  kind: "secureError";
  code: string;
  message: string;
  [key: string]: unknown;
}

interface ServerHelloMessage {
  kind: "serverHello";
  protocolVersion: number;
  sessionId: string;
  handshakeMode: HandshakeMode;
  macDeviceId: string;
  macIdentityPublicKey: string;
  macEphemeralPublicKey: string;
  serverNonce: string;
  keyEpoch: number;
  expiresAtForTranscript: number;
  macSignature: string;
  clientNonce: string;
  [key: string]: unknown;
}

interface SecureReadyMessage {
  kind: "secureReady";
  sessionId: string;
  keyEpoch: number;
  macDeviceId: string;
  [key: string]: unknown;
}

type SecureControlMessage = SecureErrorMessage | ServerHelloMessage | SecureReadyMessage | JsonRecord;

interface SecureTransportContext {
  transportId?: string;
  sendControlMessage?: (message: SecureControlMessage) => void;
  onApplicationMessage?: (message: string) => void;
  sendWireMessage?: (message: string) => void;
  closeTransport?: (code?: number, reason?: string) => void;
}

interface PendingHandshake {
  transportId: string;
  sessionId: string;
  handshakeMode: HandshakeMode;
  keyEpoch: number;
  phoneDeviceId: string;
  phoneIdentityPublicKey: string;
  phoneEphemeralPublicKey: string;
  macEphemeralPrivateKey: string;
  macEphemeralPublicKey: string;
  transcriptBytes: Buffer;
  expiresAtForTranscript: number;
  sendWireMessage?: (message: string) => void;
  closeTransport?: (code?: number, reason?: string) => void;
}

interface ActiveSession {
  transportId: string;
  sessionId: string;
  keyEpoch: number;
  phoneDeviceId: string;
  phoneIdentityPublicKey: string;
  phoneToMacKey: Buffer;
  macToPhoneKey: Buffer;
  lastInboundCounter: number;
  nextOutboundCounter: number;
  isResumed: boolean;
  minBridgeOutboundSeq: number;
  sendWireMessage?: (message: string) => void;
  closeTransport?: (code?: number, reason?: string) => void;
}

export interface SecureTransportDiagnostics {
  handshakeFailureCount: number;
  replacedConnectionCount: number;
  resumeGapCount: number;
  outboundBufferDropCount: number;
  outboundBufferMessages: number;
  outboundBufferBytes: number;
  outboundBufferMinSeq: number | null;
  outboundBufferMaxSeq: number | null;
  lastSecureErrorCode: string | null;
}

export interface SecureTransportEvent {
  kind: "secure_error" | "connection_replaced" | "resume_gap" | "buffer_trim";
  code?: string;
  phoneDeviceId?: string;
  transportId?: string;
  droppedMessages?: number;
  droppedBytes?: number;
  minRetainedBridgeOutboundSeq?: number | null;
}

interface OutboundBufferEntry {
  bridgeOutboundSeq: number;
  payloadText: string;
  sizeBytes: number;
}

interface PairingPayload {
  v: number;
  bridgeId: string;
  macDeviceId: string;
  macIdentityPublicKey: string;
  transportCandidates: TransportCandidateShape[];
  expiresAt: number;
  [key: string]: unknown;
}

interface EncryptedEnvelope {
  kind: "encryptedEnvelope";
  v: number;
  sessionId: string;
  keyEpoch: number;
  sender: SecureSender;
  counter: number;
  ciphertext: string;
  tag: string;
}

interface TranscriptInput {
  sessionId: string;
  protocolVersion: number;
  handshakeMode: HandshakeMode;
  keyEpoch: number;
  macDeviceId: string;
  phoneDeviceId: string;
  macIdentityPublicKey: string;
  phoneIdentityPublicKey: string;
  macEphemeralPublicKey: string;
  phoneEphemeralPublicKey: string;
  clientNonce: Buffer;
  serverNonce: Buffer;
  expiresAtForTranscript: number;
}

interface BridgeSecureTransport {
  PAIRING_QR_VERSION: number;
  SECURE_PROTOCOL_VERSION: number;
  createPairingPayload(): PairingPayload;
  handleIncomingWireMessage(rawMessage: string, transport?: SecureTransportContext): boolean;
  handleTransportClosed(transportId: string): void;
  getDiagnostics(): SecureTransportDiagnostics;
  isSecureChannelReady(): boolean;
  queueOutboundApplicationMessage(payloadText: string): void;
}

export function createBridgeSecureTransport({
  sessionId,
  deviceState,
  transportCandidates = [],
  onDiagnosticsChanged = () => {},
  onEvent = () => {},
}: BridgeSecureTransportOptions): BridgeSecureTransport {
  let currentDeviceState = deviceState;
  const pendingHandshakes = new Map<string, PendingHandshake>();
  const activeSessions = new Map<string, ActiveSession>();
  const activeTransportIdByPhone = new Map<string, string>();
  let currentPairingExpiresAt = Date.now() + MAX_PAIRING_AGE_MS;
  let nextKeyEpoch = 1;
  let nextBridgeOutboundSeq = 1;
  let outboundBufferBytes = 0;
  const outboundBuffer: OutboundBufferEntry[] = [];
  let handshakeFailureCount = 0;
  let replacedConnectionCount = 0;
  let resumeGapCount = 0;
  let outboundBufferDropCount = 0;
  let lastSecureErrorCode: string | null = null;

  function createPairingPayload(): PairingPayload {
    currentPairingExpiresAt = Date.now() + MAX_PAIRING_AGE_MS;
    return {
      v: PAIRING_QR_VERSION,
      bridgeId: sessionId,
      macDeviceId: currentDeviceState.macDeviceId,
      macIdentityPublicKey: currentDeviceState.macIdentityPublicKey,
      transportCandidates,
      expiresAt: currentPairingExpiresAt,
    };
  }

  function handleIncomingWireMessage(rawMessage: string, transport: SecureTransportContext = {}): boolean {
    const {
      transportId = "transport-unknown",
      sendControlMessage = () => {},
      onApplicationMessage = () => {},
      sendWireMessage,
      closeTransport,
    } = transport;
    const parsed = safeParseJSON(rawMessage);
    if (!parsed) {
      return false;
    }

    const kind = normalizeNonEmptyString(parsed.kind);
    if (!kind) {
      if (parsed.method || parsed.id != null) {
        sendControlMessage(createSecureError({
          code: "update_required",
          message: "This bridge requires the latest CodeRover iPhone app for secure pairing.",
        }));
        return true;
      }
      return false;
    }

      switch (kind) {
      case "clientHello":
        handleClientHello(parsed, {
          transportId,
          sendControlMessage,
          ...(sendWireMessage ? { sendWireMessage } : {}),
          ...(closeTransport ? { closeTransport } : {}),
        });
        return true;
      case "clientAuth":
        handleClientAuth(parsed, {
          transportId,
          sendControlMessage,
          ...(sendWireMessage ? { sendWireMessage } : {}),
          ...(closeTransport ? { closeTransport } : {}),
        });
        return true;
      case "resumeState":
        handleResumeState(parsed, transportId, sendControlMessage);
        return true;
      case "encryptedEnvelope":
        return handleEncryptedEnvelope(parsed, { transportId, sendControlMessage, onApplicationMessage });
      default:
        return false;
    }
  }

  function queueOutboundApplicationMessage(payloadText: string): void {
    const normalizedPayload = normalizeNonEmptyString(payloadText);
    if (!normalizedPayload) {
      return;
    }

    const bufferEntry: OutboundBufferEntry = {
      bridgeOutboundSeq: nextBridgeOutboundSeq,
      payloadText: normalizedPayload,
      sizeBytes: Buffer.byteLength(normalizedPayload, "utf8"),
    };
    nextBridgeOutboundSeq += 1;
    outboundBuffer.push(bufferEntry);
    outboundBufferBytes += bufferEntry.sizeBytes;
    debugSecureLog(
      `queue outbound seq=${bufferEntry.bridgeOutboundSeq} bytes=${bufferEntry.sizeBytes} `
      + `buffered=${outboundBuffer.length} bufferBytes=${outboundBufferBytes}`
    );
    trimOutboundBuffer();

    for (const activeSession of activeSessions.values()) {
      if (activeSession.isResumed) {
        sendBufferedEntry(bufferEntry, activeSession);
      }
    }
  }

  function getDiagnostics(): SecureTransportDiagnostics {
    return {
      handshakeFailureCount,
      replacedConnectionCount,
      resumeGapCount,
      outboundBufferDropCount,
      outboundBufferMessages: outboundBuffer.length,
      outboundBufferBytes,
      outboundBufferMinSeq: outboundBuffer[0]?.bridgeOutboundSeq ?? null,
      outboundBufferMaxSeq: outboundBuffer[outboundBuffer.length - 1]?.bridgeOutboundSeq ?? null,
      lastSecureErrorCode,
    };
  }

  function isSecureChannelReady(): boolean {
    return [...activeSessions.values()].some((session) => session.isResumed);
  }

  function handleClientHello(
    message: JsonRecord,
    {
      transportId,
      sendControlMessage,
      sendWireMessage,
      closeTransport,
    }: Required<Pick<SecureTransportContext, "transportId" | "sendControlMessage">>
      & Pick<SecureTransportContext, "sendWireMessage" | "closeTransport">
  ): void {
    const protocolVersion = Number(message.protocolVersion);
    const incomingSessionId = normalizeNonEmptyString(message.sessionId);
    const handshakeMode = normalizeHandshakeMode(message.handshakeMode);
    const phoneDeviceId = normalizeNonEmptyString(message.phoneDeviceId);
    const phoneIdentityPublicKey = normalizeNonEmptyString(message.phoneIdentityPublicKey);
    const phoneEphemeralPublicKey = normalizeNonEmptyString(message.phoneEphemeralPublicKey);
    const clientNonceBase64 = normalizeNonEmptyString(message.clientNonce);

    if (protocolVersion !== SECURE_PROTOCOL_VERSION || incomingSessionId !== sessionId) {
      sendControlMessage(reportSecureError({
        code: "update_required",
        message: "The bridge and iPhone are not using the same secure transport version.",
        countHandshakeFailure: true,
      }));
      return;
    }

    if (!phoneDeviceId || !phoneIdentityPublicKey || !phoneEphemeralPublicKey || !clientNonceBase64) {
      sendControlMessage(reportSecureError({
        code: "invalid_client_hello",
        message: "The iPhone handshake is missing required secure fields.",
        countHandshakeFailure: true,
      }));
      return;
    }

    if (!handshakeMode) {
      sendControlMessage(reportSecureError({
        code: "invalid_handshake_mode",
        message: "The iPhone requested an unknown secure pairing mode.",
        countHandshakeFailure: true,
      }));
      return;
    }

    if (handshakeMode === HANDSHAKE_MODE_QR_BOOTSTRAP && Date.now() > currentPairingExpiresAt) {
      sendControlMessage(reportSecureError({
        code: "pairing_expired",
        message: "The pairing QR code has expired. Generate a new QR code from the bridge.",
        countHandshakeFailure: true,
      }));
      return;
    }

    const trustedPhonePublicKey = getTrustedPhonePublicKey(currentDeviceState, phoneDeviceId);
    if (handshakeMode === HANDSHAKE_MODE_TRUSTED_RECONNECT) {
      if (!trustedPhonePublicKey) {
        sendControlMessage(reportSecureError({
          code: "phone_not_trusted",
          message: "This iPhone is not trusted by the current bridge session. Scan a fresh QR code to pair again.",
          countHandshakeFailure: true,
        }));
        return;
      }
      if (trustedPhonePublicKey !== phoneIdentityPublicKey) {
        sendControlMessage(reportSecureError({
          code: "phone_identity_changed",
          message: "The trusted iPhone identity does not match this reconnect attempt.",
          countHandshakeFailure: true,
        }));
        return;
      }
    }

    const clientNonce = base64ToBuffer(clientNonceBase64);
    if (!clientNonce || clientNonce.length === 0) {
      sendControlMessage(reportSecureError({
        code: "invalid_client_nonce",
        message: "The iPhone secure nonce could not be decoded.",
        countHandshakeFailure: true,
      }));
      return;
    }

    const ephemeral = generateKeyPairSync("x25519");
    const privateJwk = ephemeral.privateKey.export({ format: "jwk" }) as JsonRecord;
    const publicJwk = ephemeral.publicKey.export({ format: "jwk" }) as JsonRecord;
    const macEphemeralPrivateKey = normalizeNonEmptyString(privateJwk.d);
    const macEphemeralPublicKey = normalizeNonEmptyString(publicJwk.x);
    if (!macEphemeralPrivateKey || !macEphemeralPublicKey) {
      sendControlMessage(reportSecureError({
        code: "invalid_ephemeral_key",
        message: "The bridge could not generate a secure handshake key.",
        countHandshakeFailure: true,
      }));
      return;
    }

    const serverNonce = randomBytes(32);
    const keyEpoch = nextKeyEpoch;
    const expiresAtForTranscript = handshakeMode === HANDSHAKE_MODE_QR_BOOTSTRAP ? currentPairingExpiresAt : 0;
    const transcriptBytes = buildTranscriptBytes({
      sessionId,
      protocolVersion,
      handshakeMode,
      keyEpoch,
      macDeviceId: currentDeviceState.macDeviceId,
      phoneDeviceId,
      macIdentityPublicKey: currentDeviceState.macIdentityPublicKey,
      phoneIdentityPublicKey,
      macEphemeralPublicKey: base64UrlToBase64(macEphemeralPublicKey),
      phoneEphemeralPublicKey,
      clientNonce,
      serverNonce,
      expiresAtForTranscript,
    });
    const macSignature = signTranscript(
      currentDeviceState.macIdentityPrivateKey,
      currentDeviceState.macIdentityPublicKey,
      transcriptBytes
    );
    debugSecureLog(
      `serverHello mode=${handshakeMode} session=${shortId(sessionId)} keyEpoch=${keyEpoch} `
      + `mac=${shortId(currentDeviceState.macDeviceId)} phone=${shortId(phoneDeviceId)} `
      + `macKey=${shortFingerprint(currentDeviceState.macIdentityPublicKey)} `
      + `phoneKey=${shortFingerprint(phoneIdentityPublicKey)} `
      + `transcript=${transcriptDigest(transcriptBytes)}`
    );

    pendingHandshakes.set(transportId, {
      transportId,
      sessionId,
      handshakeMode,
      keyEpoch,
      phoneDeviceId,
      phoneIdentityPublicKey,
      phoneEphemeralPublicKey,
      macEphemeralPrivateKey: base64UrlToBase64(macEphemeralPrivateKey),
      macEphemeralPublicKey: base64UrlToBase64(macEphemeralPublicKey),
      transcriptBytes,
      expiresAtForTranscript,
      ...(sendWireMessage ? { sendWireMessage } : {}),
      ...(closeTransport ? { closeTransport } : {}),
    });
    removeActiveSession(transportId);

    const pendingHandshake = pendingHandshakes.get(transportId);
    if (!pendingHandshake) {
      return;
    }

    sendControlMessage({
      kind: "serverHello",
      protocolVersion: SECURE_PROTOCOL_VERSION,
      sessionId,
      handshakeMode,
      macDeviceId: currentDeviceState.macDeviceId,
      macIdentityPublicKey: currentDeviceState.macIdentityPublicKey,
      macEphemeralPublicKey: pendingHandshake.macEphemeralPublicKey,
      serverNonce: serverNonce.toString("base64"),
      keyEpoch,
      expiresAtForTranscript,
      macSignature,
      clientNonce: clientNonceBase64,
    });
  }

  function handleClientAuth(
    message: JsonRecord,
    {
      transportId,
      sendControlMessage,
      sendWireMessage,
      closeTransport,
    }: Required<Pick<SecureTransportContext, "transportId" | "sendControlMessage">>
      & Pick<SecureTransportContext, "sendWireMessage" | "closeTransport">
  ): void {
    const pendingHandshake = pendingHandshakes.get(transportId);
    if (!pendingHandshake) {
      sendControlMessage(reportSecureError({
        code: "unexpected_client_auth",
        message: "The bridge did not have a pending secure handshake to finalize.",
      }));
      return;
    }

    const incomingSessionId = normalizeNonEmptyString(message.sessionId);
    const phoneDeviceId = normalizeNonEmptyString(message.phoneDeviceId);
    const keyEpoch = Number(message.keyEpoch);
    const phoneSignature = normalizeNonEmptyString(message.phoneSignature);
    if (
      incomingSessionId !== pendingHandshake.sessionId
      || phoneDeviceId !== pendingHandshake.phoneDeviceId
      || keyEpoch !== pendingHandshake.keyEpoch
      || !phoneSignature
    ) {
      pendingHandshakes.delete(transportId);
      sendControlMessage(reportSecureError({
        code: "invalid_client_auth",
        message: "The secure client authentication payload was invalid.",
        countHandshakeFailure: true,
      }));
      return;
    }

    const clientAuthTranscript = Buffer.concat([
      pendingHandshake.transcriptBytes,
      encodeLengthPrefixedUTF8("client-auth"),
    ]);
    const phoneVerified = verifyTranscript(
      pendingHandshake.phoneIdentityPublicKey,
      clientAuthTranscript,
      phoneSignature
    );
    if (!phoneVerified) {
      pendingHandshakes.delete(transportId);
      sendControlMessage(reportSecureError({
        code: "invalid_phone_signature",
        message: "The iPhone secure signature could not be verified.",
        countHandshakeFailure: true,
      }));
      return;
    }

    const sharedSecret = diffieHellman({
      privateKey: createPrivateKey({
        key: {
          crv: "X25519",
          d: base64ToBase64Url(pendingHandshake.macEphemeralPrivateKey),
          kty: "OKP",
          x: base64ToBase64Url(pendingHandshake.macEphemeralPublicKey),
        },
        format: "jwk",
      }),
      publicKey: createPublicKey({
        key: {
          crv: "X25519",
          kty: "OKP",
          x: base64ToBase64Url(pendingHandshake.phoneEphemeralPublicKey),
        },
        format: "jwk",
      }),
    });
    const salt = createHash("sha256").update(pendingHandshake.transcriptBytes).digest();
    const infoPrefix = [
      HANDSHAKE_TAG,
      pendingHandshake.sessionId,
      currentDeviceState.macDeviceId,
      pendingHandshake.phoneDeviceId,
      String(pendingHandshake.keyEpoch),
    ].join("|");

    const existingTransportId = activeTransportIdByPhone.get(pendingHandshake.phoneDeviceId);
    const activeSession: ActiveSession = {
      transportId,
      sessionId: pendingHandshake.sessionId,
      keyEpoch: pendingHandshake.keyEpoch,
      phoneDeviceId: pendingHandshake.phoneDeviceId,
      phoneIdentityPublicKey: pendingHandshake.phoneIdentityPublicKey,
      phoneToMacKey: deriveAesKey(sharedSecret, salt, `${infoPrefix}|phoneToMac`),
      macToPhoneKey: deriveAesKey(sharedSecret, salt, `${infoPrefix}|macToPhone`),
      lastInboundCounter: -1,
      nextOutboundCounter: 0,
      isResumed: false,
      minBridgeOutboundSeq:
        pendingHandshake.handshakeMode === HANDSHAKE_MODE_QR_BOOTSTRAP ? nextBridgeOutboundSeq : 1,
      ...((sendWireMessage || pendingHandshake.sendWireMessage)
        ? { sendWireMessage: sendWireMessage || pendingHandshake.sendWireMessage }
        : {}),
      ...((closeTransport || pendingHandshake.closeTransport)
        ? { closeTransport: closeTransport || pendingHandshake.closeTransport }
        : {}),
    };
    activeSessions.set(transportId, activeSession);
    activeTransportIdByPhone.set(activeSession.phoneDeviceId, transportId);
    if (existingTransportId && existingTransportId !== transportId) {
      replacedConnectionCount += 1;
      emitStateChange({
        kind: "connection_replaced",
        phoneDeviceId: activeSession.phoneDeviceId,
        transportId: existingTransportId,
      });
      const replacedSession = activeSessions.get(existingTransportId);
      replacedSession?.closeTransport?.(
        CLOSE_CODE_REPLACED_CONNECTION,
        "Replaced by newer connection for this iPhone"
      );
      removeActiveSession(existingTransportId);
    } else {
      onDiagnosticsChanged();
    }

    nextKeyEpoch = pendingHandshake.keyEpoch + 1;
    if (
      pendingHandshake.handshakeMode === HANDSHAKE_MODE_QR_BOOTSTRAP
      || getTrustedPhonePublicKey(currentDeviceState, pendingHandshake.phoneDeviceId)
    ) {
      currentDeviceState = rememberTrustedPhone(
        currentDeviceState,
        pendingHandshake.phoneDeviceId,
        pendingHandshake.phoneIdentityPublicKey
      );
    }

    pendingHandshakes.delete(transportId);
    sendControlMessage({
      kind: "secureReady",
      sessionId,
      keyEpoch: activeSession.keyEpoch,
      macDeviceId: currentDeviceState.macDeviceId,
    });
  }

  function handleResumeState(
    message: JsonRecord,
    transportId: string,
    sendControlMessage: (message: SecureControlMessage) => void
  ): void {
    const activeSession = requireOwnedSession(transportId);
    if (!activeSession) {
      sendControlMessage(reportSecureError({
        code: "secure_channel_unavailable",
        message: "The secure channel is not ready yet on the bridge.",
      }));
      return;
    }

    const incomingSessionId = normalizeNonEmptyString(message.sessionId);
    const keyEpoch = Number(message.keyEpoch);
    if (incomingSessionId !== sessionId || keyEpoch !== activeSession.keyEpoch) {
      return;
    }

    const lastAppliedBridgeOutboundSeq = Number(message.lastAppliedBridgeOutboundSeq) || 0;
    const resumeFloor = Math.max(lastAppliedBridgeOutboundSeq, activeSession.minBridgeOutboundSeq - 1);
    const minimumBufferedSeq = outboundBuffer[0]?.bridgeOutboundSeq ?? null;
    if (
      minimumBufferedSeq != null
      && outboundBuffer.length > 0
      && resumeFloor < minimumBufferedSeq - 1
    ) {
      resumeGapCount += 1;
      sendControlMessage(reportSecureError({
        code: "resume_gap",
        message: "The bridge no longer has the full reconnect buffer for this session. Re-read the thread to resync.",
      }));
      emitStateChange({
        kind: "resume_gap",
        transportId,
        phoneDeviceId: activeSession.phoneDeviceId,
        minRetainedBridgeOutboundSeq: minimumBufferedSeq,
      });
      return;
    }
    const missingEntries = outboundBuffer.filter((entry) => entry.bridgeOutboundSeq > resumeFloor);
    debugSecureLog(
      `resumeState transport=${shortId(transportId)} keyEpoch=${keyEpoch} `
      + `lastApplied=${lastAppliedBridgeOutboundSeq} pending=${missingEntries.length}`
    );
    activeSession.isResumed = true;
    onDiagnosticsChanged();
    for (const entry of missingEntries) {
      sendBufferedEntry(entry, activeSession);
    }
  }

  function handleEncryptedEnvelope(
    message: JsonRecord,
    {
      transportId,
      sendControlMessage,
      onApplicationMessage,
    }: Required<Pick<SecureTransportContext, "transportId" | "sendControlMessage" | "onApplicationMessage">>
  ): boolean {
    const activeSession = requireOwnedSession(transportId);
    if (!activeSession) {
      sendControlMessage(reportSecureError({
        code: "secure_channel_unavailable",
        message: "The secure channel is not ready yet on the bridge.",
      }));
      return true;
    }

    const incomingSessionId = normalizeNonEmptyString(message.sessionId);
    const keyEpoch = Number(message.keyEpoch);
    const sender = normalizeSecureSender(message.sender);
    const counter = Number(message.counter);
    if (
      incomingSessionId !== sessionId
      || keyEpoch !== activeSession.keyEpoch
      || sender !== SECURE_SENDER_IPHONE
      || !Number.isInteger(counter)
      || counter <= activeSession.lastInboundCounter
    ) {
      sendControlMessage(reportSecureError({
        code: "invalid_envelope",
        message: "The bridge rejected an invalid or replayed secure envelope.",
      }));
      return true;
    }

    const plaintextBuffer = decryptEnvelopeBuffer(
      message,
      activeSession.phoneToMacKey,
      SECURE_SENDER_IPHONE,
      counter
    );
    if (!plaintextBuffer) {
      sendControlMessage(reportSecureError({
        code: "decrypt_failed",
        message: "The bridge could not decrypt the iPhone secure payload.",
      }));
      return true;
    }

    activeSession.lastInboundCounter = counter;
    const payloadObject = safeParseJSON(plaintextBuffer.toString("utf8"));
    const payloadText = normalizeNonEmptyString(payloadObject?.payloadText);
    if (!payloadText) {
      sendControlMessage(reportSecureError({
        code: "invalid_payload",
        message: "The secure payload did not contain a usable application message.",
      }));
      return true;
    }

    onApplicationMessage(payloadText);
    return true;
  }

  function handleTransportClosed(transportId: string): void {
    debugSecureLog(`transport closed transport=${shortId(transportId)}`);
    pendingHandshakes.delete(transportId);
    removeActiveSession(transportId);
  }

  function removeActiveSession(transportId: string): void {
    const activeSession = activeSessions.get(transportId);
    if (!activeSession) {
      return;
    }
    activeSessions.delete(transportId);
    if (activeTransportIdByPhone.get(activeSession.phoneDeviceId) === transportId) {
      activeTransportIdByPhone.delete(activeSession.phoneDeviceId);
    }
    onDiagnosticsChanged();
  }

  function trimOutboundBuffer(): void {
    let droppedMessages = 0;
    let droppedBytes = 0;
    while (
      outboundBuffer.length > MAX_BRIDGE_OUTBOUND_MESSAGES
      || outboundBufferBytes > MAX_BRIDGE_OUTBOUND_BYTES
    ) {
      const removed = outboundBuffer.shift();
      if (!removed) {
        break;
      }
      outboundBufferBytes = Math.max(0, outboundBufferBytes - removed.sizeBytes);
      droppedMessages += 1;
      droppedBytes += removed.sizeBytes;
      outboundBufferDropCount += 1;
    }
    if (droppedMessages > 0) {
      emitStateChange({
        kind: "buffer_trim",
        droppedMessages,
        droppedBytes,
        minRetainedBridgeOutboundSeq: outboundBuffer[0]?.bridgeOutboundSeq ?? null,
      });
    }
  }

  function sendBufferedEntry(entry: OutboundBufferEntry, activeSession: ActiveSession): void {
    if (!activeSession.isResumed) {
      return;
    }

    const envelope = encryptEnvelopePayload(
      {
        bridgeOutboundSeq: entry.bridgeOutboundSeq,
        payloadText: entry.payloadText,
      },
      activeSession.macToPhoneKey,
      SECURE_SENDER_MAC,
      activeSession.nextOutboundCounter,
      sessionId,
      activeSession.keyEpoch
    );
    activeSession.nextOutboundCounter += 1;
    const wireMessage = JSON.stringify(envelope);
    debugSecureLog(
      `send envelope transport=${shortId(activeSession.transportId)} seq=${entry.bridgeOutboundSeq} `
      + `payloadBytes=${entry.sizeBytes} wireBytes=${Buffer.byteLength(wireMessage, "utf8")}`
    );
    try {
      activeSession.sendWireMessage?.(wireMessage);
    } catch (error) {
      debugError(
        `[coderover][secure] send failed transport=${shortId(activeSession.transportId)} `
        + `seq=${entry.bridgeOutboundSeq} error=${getErrorMessage(error)}`
      );
      activeSession.closeTransport?.(1011, "Bridge send failed");
      removeActiveSession(activeSession.transportId);
    }
  }

  return {
    PAIRING_QR_VERSION,
    SECURE_PROTOCOL_VERSION,
    createPairingPayload,
    handleIncomingWireMessage,
    handleTransportClosed,
    getDiagnostics,
    isSecureChannelReady,
    queueOutboundApplicationMessage,
  };

  function requireOwnedSession(transportId: string): ActiveSession | null {
    const activeSession = activeSessions.get(transportId);
    if (!activeSession) {
      return null;
    }
    if (activeSession.transportId !== transportId) {
      return null;
    }
    if (activeTransportIdByPhone.get(activeSession.phoneDeviceId) !== transportId) {
      return null;
    }
    if (activeSession.sessionId !== sessionId) {
      return null;
    }
    return activeSession;
  }

  function reportSecureError(
    {
      code,
      message,
      countHandshakeFailure = false,
    }: {
      code: string;
      message: string;
      countHandshakeFailure?: boolean;
    }
  ): SecureErrorMessage {
    lastSecureErrorCode = code;
    if (countHandshakeFailure) {
      handshakeFailureCount += 1;
    }
    emitStateChange({
      kind: "secure_error",
      code,
    });
    return createSecureError({ code, message });
  }

  function emitStateChange(event: SecureTransportEvent): void {
    onEvent(event);
    onDiagnosticsChanged();
  }
}

function debugSecureLog(message: string): void {
  debugLog(`[coderover][secure] ${message}`);
}

function shortId(value: unknown): string {
  const normalized = normalizeNonEmptyString(value);
  return normalized ? normalized.slice(0, 8) : "none";
}

function shortFingerprint(publicKeyBase64: string): string {
  const bytes = base64ToBuffer(publicKeyBase64);
  if (!bytes || bytes.length === 0) {
    return "invalid";
  }
  return createHash("sha256").update(bytes).digest("hex").slice(0, 12);
}

function transcriptDigest(transcriptBytes: Buffer): string {
  return createHash("sha256").update(transcriptBytes).digest("hex").slice(0, 16);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function encryptEnvelopePayload(
  payloadObject: JsonRecord,
  key: Buffer,
  sender: SecureSender,
  counter: number,
  sessionId: string,
  keyEpoch: number
): EncryptedEnvelope {
  const nonce = nonceForDirection(sender, counter);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payloadObject), "utf8")),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    kind: "encryptedEnvelope",
    v: SECURE_PROTOCOL_VERSION,
    sessionId,
    keyEpoch,
    sender,
    counter,
    ciphertext: ciphertext.toString("base64"),
    tag: tag.toString("base64"),
  };
}

function decryptEnvelopeBuffer(
  envelope: JsonRecord,
  key: Buffer,
  sender: SecureSender,
  counter: number
): Buffer | null {
  try {
    const nonce = nonceForDirection(sender, counter);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(base64ToBuffer(envelope.tag) ?? Buffer.alloc(0));
    return Buffer.concat([
      decipher.update(base64ToBuffer(envelope.ciphertext) ?? Buffer.alloc(0)),
      decipher.final(),
    ]);
  } catch {
    return null;
  }
}

function deriveAesKey(sharedSecret: Buffer, salt: Buffer, infoLabel: string): Buffer {
  return Buffer.from(hkdfSync("sha256", sharedSecret, salt, Buffer.from(infoLabel, "utf8"), 32));
}

function signTranscript(privateKeyBase64: string, publicKeyBase64: string, transcriptBytes: Buffer): string {
  const signature = sign(
    null,
    transcriptBytes,
    createPrivateKey({
      key: {
        crv: "Ed25519",
        d: base64ToBase64Url(privateKeyBase64),
        kty: "OKP",
        x: base64ToBase64Url(publicKeyBase64),
      },
      format: "jwk",
    })
  );
  return signature.toString("base64");
}

function verifyTranscript(publicKeyBase64: string, transcriptBytes: Buffer, signatureBase64: string): boolean {
  try {
    return verify(
      null,
      transcriptBytes,
      createPublicKey({
        key: {
          crv: "Ed25519",
          kty: "OKP",
          x: base64ToBase64Url(publicKeyBase64),
        },
        format: "jwk",
      }),
      base64ToBuffer(signatureBase64) ?? Buffer.alloc(0)
    );
  } catch {
    return false;
  }
}

function buildTranscriptBytes({
  sessionId,
  protocolVersion,
  handshakeMode,
  keyEpoch,
  macDeviceId,
  phoneDeviceId,
  macIdentityPublicKey,
  phoneIdentityPublicKey,
  macEphemeralPublicKey,
  phoneEphemeralPublicKey,
  clientNonce,
  serverNonce,
  expiresAtForTranscript,
}: TranscriptInput): Buffer {
  return Buffer.concat([
    encodeLengthPrefixedUTF8(HANDSHAKE_TAG),
    encodeLengthPrefixedUTF8(sessionId),
    encodeLengthPrefixedUTF8(String(protocolVersion)),
    encodeLengthPrefixedUTF8(handshakeMode),
    encodeLengthPrefixedUTF8(String(keyEpoch)),
    encodeLengthPrefixedUTF8(macDeviceId),
    encodeLengthPrefixedUTF8(phoneDeviceId),
    encodeLengthPrefixedBuffer(base64ToBuffer(macIdentityPublicKey) ?? Buffer.alloc(0)),
    encodeLengthPrefixedBuffer(base64ToBuffer(phoneIdentityPublicKey) ?? Buffer.alloc(0)),
    encodeLengthPrefixedBuffer(base64ToBuffer(macEphemeralPublicKey) ?? Buffer.alloc(0)),
    encodeLengthPrefixedBuffer(base64ToBuffer(phoneEphemeralPublicKey) ?? Buffer.alloc(0)),
    encodeLengthPrefixedBuffer(clientNonce),
    encodeLengthPrefixedBuffer(serverNonce),
    encodeLengthPrefixedUTF8(String(expiresAtForTranscript)),
  ]);
}

function encodeLengthPrefixedUTF8(value: string): Buffer {
  return encodeLengthPrefixedBuffer(Buffer.from(String(value), "utf8"));
}

function encodeLengthPrefixedBuffer(buffer: Buffer): Buffer {
  const lengthBuffer = Buffer.allocUnsafe(4);
  lengthBuffer.writeUInt32BE(buffer.length, 0);
  return Buffer.concat([lengthBuffer, buffer]);
}

export function nonceForDirection(sender: SecureSender | string, counter: number): Buffer {
  const nonce = Buffer.alloc(12, 0);
  nonce.writeUInt8(sender === SECURE_SENDER_MAC ? 1 : 2, 0);
  let value = BigInt(counter);
  for (let index = 11; index >= 1; index -= 1) {
    nonce[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  return nonce;
}

function createSecureError({ code, message }: { code: string; message: string }): SecureErrorMessage {
  return {
    kind: "secureError",
    code,
    message,
  };
}

function normalizeNonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeParseJSON(value: unknown): JsonRecord | null {
  if (typeof value !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonRecord)
      : null;
  } catch {
    return null;
  }
}

function base64ToBuffer(value: unknown): Buffer | null {
  if (typeof value !== "string") {
    return null;
  }
  try {
    return Buffer.from(value, "base64");
  } catch {
    return null;
  }
}

function base64UrlToBase64(value: string): string {
  const padded = `${value}${"=".repeat((4 - (value.length % 4 || 4)) % 4)}`;
  return padded.replace(/-/g, "+").replace(/_/g, "/");
}

function base64ToBase64Url(value: string): string {
  return value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function normalizeHandshakeMode(value: unknown): HandshakeMode | null {
  const normalized = normalizeNonEmptyString(value);
  if (
    normalized === HANDSHAKE_MODE_QR_BOOTSTRAP
    || normalized === HANDSHAKE_MODE_TRUSTED_RECONNECT
  ) {
    return normalized;
  }
  return null;
}

function normalizeSecureSender(value: unknown): SecureSender | null {
  const normalized = normalizeNonEmptyString(value);
  if (normalized === SECURE_SENDER_MAC || normalized === SECURE_SENDER_IPHONE) {
    return normalized;
  }
  return null;
}
