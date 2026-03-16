// FILE: secure-transport.test.ts
// Purpose: Verifies the bridge-side E2EE handshake rejects plaintext and round-trips encrypted payloads.
// Layer: Unit test
// Exports: bun:test suite
// Depends on: bun:test, node:assert/strict, crypto, ../src/secure-transport

import { test } from "bun:test";
import { strict as assert } from "node:assert";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  sign,
} from "crypto";
import {
  HANDSHAKE_MODE_QR_BOOTSTRAP,
  HANDSHAKE_MODE_TRUSTED_RECONNECT,
  createBridgeSecureTransport,
  nonceForDirection,
} from "../src/secure-transport";
import type { BridgeDeviceState } from "../src/secure-device-state";

type BridgeSecureTransport = ReturnType<typeof createBridgeSecureTransport>;
type HandshakeMode =
  | typeof HANDSHAKE_MODE_QR_BOOTSTRAP
  | typeof HANDSHAKE_MODE_TRUSTED_RECONNECT;
type SecureSender = "mac" | "iphone";

interface OkpKeyPair {
  privateKey: string;
  publicKey: string;
}

interface SecureErrorMessage {
  kind: "secureError";
  code: string;
  message?: string;
  [key: string]: unknown;
}

interface ServerHelloMessage {
  kind: "serverHello";
  keyEpoch: number;
  macEphemeralPublicKey: string;
  serverNonce: string;
  expiresAtForTranscript: number;
  [key: string]: unknown;
}

interface SecureReadyMessage {
  kind: "secureReady";
  sessionId: string;
  keyEpoch: number;
  macDeviceId: string;
  [key: string]: unknown;
}

type ControlMessage =
  | SecureErrorMessage
  | SecureReadyMessage
  | ServerHelloMessage
  | Record<string, unknown>;

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

interface EncryptedPayload {
  bridgeOutboundSeq?: number;
  payloadText?: string;
  [key: string]: unknown;
}

interface HandshakeResult {
  applicationMessages: string[];
  controlMessages: ControlMessage[];
  serverHello: ServerHelloMessage;
  transcriptBytes: Buffer;
}

function isServerHelloMessage(message: ControlMessage | undefined): message is ServerHelloMessage {
  return Boolean(message && message.kind === "serverHello");
}

function isSecureReadyMessage(message: ControlMessage | undefined): message is SecureReadyMessage {
  return Boolean(message && message.kind === "secureReady");
}

test("secure transport rejects plaintext JSON-RPC before the secure handshake", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateJwk = privateKey.export({ format: "jwk" });
  const publicJwk = publicKey.export({ format: "jwk" });
  assert.ok(privateJwk.d);
  assert.ok(publicJwk.x);
  const secureTransport = createBridgeSecureTransport({
    sessionId: "session-1",
    deviceState: createBridgeDeviceState({
      bridgeId: "bridge-1",
      macDeviceId: "mac-1",
      macIdentityPrivateKey: base64UrlToBase64(privateJwk.d),
      macIdentityPublicKey: base64UrlToBase64(publicJwk.x),
    }),
  });

  const controlMessages: ControlMessage[] = [];
  const handled = secureTransport.handleIncomingWireMessage(
    JSON.stringify({
      id: "1",
      method: "initialize",
      params: {},
    }),
    {
      sendControlMessage(message) {
        controlMessages.push(message);
      },
      onApplicationMessage() {
        throw new Error("plaintext application payload should not be forwarded");
      },
    }
  );

  assert.equal(handled, true);
  assert.equal(controlMessages[0]?.kind, "secureError");
  assert.equal(controlMessages[0]?.code, "update_required");
});

test("secure transport round-trips encrypted payloads after a trusted reconnect handshake", () => {
  const macIdentity = createOkpKeyPair("ed25519");
  const phoneIdentity = createOkpKeyPair("ed25519");
  const phoneEphemeral = createOkpKeyPair("x25519");
  const secureTransport = createBridgeSecureTransport({
    sessionId: "session-2",
    deviceState: createBridgeDeviceState({
      bridgeId: "bridge-2",
      macDeviceId: "mac-2",
      macIdentityPrivateKey: macIdentity.privateKey,
      macIdentityPublicKey: macIdentity.publicKey,
      trustedPhones: {
        "phone-2": phoneIdentity.publicKey,
      },
    }),
  });

  const controlMessages: ControlMessage[] = [];
  const applicationMessages: string[] = [];
  const wireMessages: string[] = [];

  const clientNonce = Buffer.alloc(32, 7);
  secureTransport.handleIncomingWireMessage(
    JSON.stringify({
      kind: "clientHello",
      protocolVersion: 1,
      sessionId: "session-2",
      handshakeMode: HANDSHAKE_MODE_TRUSTED_RECONNECT,
      phoneDeviceId: "phone-2",
      phoneIdentityPublicKey: phoneIdentity.publicKey,
      phoneEphemeralPublicKey: phoneEphemeral.publicKey,
      clientNonce: clientNonce.toString("base64"),
    }),
    {
      transportId: "transport-1",
      sendControlMessage(message) {
        controlMessages.push(message);
      },
      onApplicationMessage(message) {
        applicationMessages.push(message);
      },
      sendWireMessage(message) {
        wireMessages.push(message);
      },
    }
  );

  const serverHello = controlMessages.find((message) => message.kind === "serverHello");
  assert.ok(isServerHelloMessage(serverHello), "expected serverHello");

  const transcriptBytes = buildTranscriptBytes({
    sessionId: "session-2",
    protocolVersion: 1,
    handshakeMode: HANDSHAKE_MODE_TRUSTED_RECONNECT,
    keyEpoch: serverHello.keyEpoch,
    macDeviceId: "mac-2",
    phoneDeviceId: "phone-2",
    macIdentityPublicKey: macIdentity.publicKey,
    phoneIdentityPublicKey: phoneIdentity.publicKey,
    macEphemeralPublicKey: serverHello.macEphemeralPublicKey,
    phoneEphemeralPublicKey: phoneEphemeral.publicKey,
    clientNonce,
    serverNonce: Buffer.from(serverHello.serverNonce, "base64"),
    expiresAtForTranscript: 0,
  });
  const phoneAuthTranscript = Buffer.concat([
    transcriptBytes,
    encodeLengthPrefixedUTF8("client-auth"),
  ]);
  const phoneSignature = sign(
    null,
    phoneAuthTranscript,
    createPrivateKey({
      key: {
        crv: "Ed25519",
        d: base64ToBase64Url(phoneIdentity.privateKey),
        kty: "OKP",
        x: base64ToBase64Url(phoneIdentity.publicKey),
      },
      format: "jwk",
    })
  );

  secureTransport.handleIncomingWireMessage(
    JSON.stringify({
      kind: "clientAuth",
      sessionId: "session-2",
      phoneDeviceId: "phone-2",
      keyEpoch: serverHello.keyEpoch,
      phoneSignature: phoneSignature.toString("base64"),
    }),
    {
      transportId: "transport-1",
      sendControlMessage(message) {
        controlMessages.push(message);
      },
      onApplicationMessage(message) {
        applicationMessages.push(message);
      },
    }
  );

  const secureReady = controlMessages.find((message) => message.kind === "secureReady");
  assert.ok(isSecureReadyMessage(secureReady), "expected secureReady");

  const sharedSecret = diffieHellman({
    privateKey: createPrivateKey({
      key: {
        crv: "X25519",
        d: base64ToBase64Url(phoneEphemeral.privateKey),
        kty: "OKP",
        x: base64ToBase64Url(phoneEphemeral.publicKey),
      },
      format: "jwk",
    }),
    publicKey: createPublicKey({
      key: {
        crv: "X25519",
        kty: "OKP",
        x: base64ToBase64Url(serverHello.macEphemeralPublicKey),
      },
      format: "jwk",
    }),
  });
  const salt = createHash("sha256").update(transcriptBytes).digest();
  const infoPrefix = `coderover-e2ee-v1|session-2|mac-2|phone-2|${serverHello.keyEpoch}`;
  const phoneToMacKey = Buffer.from(
    hkdfSync("sha256", sharedSecret, salt, Buffer.from(`${infoPrefix}|phoneToMac`, "utf8"), 32)
  );
  const macToPhoneKey = Buffer.from(
    hkdfSync("sha256", sharedSecret, salt, Buffer.from(`${infoPrefix}|macToPhone`, "utf8"), 32)
  );

  secureTransport.handleIncomingWireMessage(
    JSON.stringify({
      kind: "resumeState",
      sessionId: "session-2",
      keyEpoch: serverHello.keyEpoch,
      lastAppliedBridgeOutboundSeq: 0,
    }),
    {
      transportId: "transport-1",
      sendControlMessage(message) {
        controlMessages.push(message);
      },
      onApplicationMessage(message) {
        applicationMessages.push(message);
      },
    }
  );

  secureTransport.queueOutboundApplicationMessage(
    JSON.stringify({ id: "response-1", result: { ok: true } })
  );
  assert.equal(wireMessages.length, 1);
  assert.ok(wireMessages[0]);

  const outboundEnvelope = JSON.parse(wireMessages[0]) as EncryptedEnvelope;
  const outboundPayload = decryptEnvelope(outboundEnvelope, macToPhoneKey);
  assert.equal(outboundPayload.bridgeOutboundSeq, 1);
  assert.equal(outboundPayload.payloadText, JSON.stringify({ id: "response-1", result: { ok: true } }));

  const inboundEnvelope = encryptEnvelope(
    {
      payloadText: JSON.stringify({ id: "request-1", method: "thread/list", params: {} }),
    },
    phoneToMacKey,
    "iphone",
    0,
    "session-2",
    serverHello.keyEpoch
  );
  secureTransport.handleIncomingWireMessage(
    JSON.stringify(inboundEnvelope),
    {
      transportId: "transport-1",
      sendControlMessage(message) {
        controlMessages.push(message);
      },
      onApplicationMessage(message) {
        applicationMessages.push(message);
      },
    }
  );

  assert.deepEqual(applicationMessages, [
    JSON.stringify({ id: "request-1", method: "thread/list", params: {} }),
  ]);
});

test("secure transport broadcasts outbound messages to multiple resumed phones", () => {
  const macIdentity = createOkpKeyPair("ed25519");
  const firstPhoneIdentity = createOkpKeyPair("ed25519");
  const firstPhoneEphemeral = createOkpKeyPair("x25519");
  const secondPhoneIdentity = createOkpKeyPair("ed25519");
  const secondPhoneEphemeral = createOkpKeyPair("x25519");
  const firstWireMessages: string[] = [];
  const secondWireMessages: string[] = [];
  const secureTransport = createBridgeSecureTransport({
    sessionId: "session-multi",
    deviceState: createBridgeDeviceState({
      bridgeId: "bridge-multi",
      macDeviceId: "mac-multi",
      macIdentityPrivateKey: macIdentity.privateKey,
      macIdentityPublicKey: macIdentity.publicKey,
    }),
  });

  const firstHandshake = finishHandshake({
    secureTransport,
    transportId: "transport-a",
    sessionId: "session-multi",
    macDeviceId: "mac-multi",
    phoneDeviceId: "phone-a",
    macIdentity,
    phoneIdentity: firstPhoneIdentity,
    phoneEphemeral: firstPhoneEphemeral,
    handshakeMode: HANDSHAKE_MODE_QR_BOOTSTRAP,
    lastAppliedBridgeOutboundSeq: 0,
    wireMessages: firstWireMessages,
  });
  const secondHandshake = finishHandshake({
    secureTransport,
    transportId: "transport-b",
    sessionId: "session-multi",
    macDeviceId: "mac-multi",
    phoneDeviceId: "phone-b",
    macIdentity,
    phoneIdentity: secondPhoneIdentity,
    phoneEphemeral: secondPhoneEphemeral,
    handshakeMode: HANDSHAKE_MODE_QR_BOOTSTRAP,
    lastAppliedBridgeOutboundSeq: 0,
    wireMessages: secondWireMessages,
  });

  secureTransport.queueOutboundApplicationMessage(
    JSON.stringify({ id: "broadcast-1", result: { ok: true } })
  );

  assert.equal(firstWireMessages.length, 1);
  assert.equal(secondWireMessages.length, 1);

  const firstKeys = deriveSessionKeys({
    sessionId: "session-multi",
    macDeviceId: "mac-multi",
    phoneDeviceId: "phone-a",
    phoneEphemeral: firstPhoneEphemeral,
    serverHello: firstHandshake.serverHello,
    transcriptBytes: firstHandshake.transcriptBytes,
  });
  const secondKeys = deriveSessionKeys({
    sessionId: "session-multi",
    macDeviceId: "mac-multi",
    phoneDeviceId: "phone-b",
    phoneEphemeral: secondPhoneEphemeral,
    serverHello: secondHandshake.serverHello,
    transcriptBytes: secondHandshake.transcriptBytes,
  });

  assert.ok(firstWireMessages[0]);
  assert.ok(secondWireMessages[0]);
  const firstPayload = decryptEnvelope(JSON.parse(firstWireMessages[0]) as EncryptedEnvelope, firstKeys.macToPhoneKey);
  const secondPayload = decryptEnvelope(JSON.parse(secondWireMessages[0]) as EncryptedEnvelope, secondKeys.macToPhoneKey);

  assert.equal(firstPayload.bridgeOutboundSeq, 1);
  assert.equal(secondPayload.bridgeOutboundSeq, 1);
  assert.equal(firstPayload.payloadText, JSON.stringify({ id: "broadcast-1", result: { ok: true } }));
  assert.equal(secondPayload.payloadText, JSON.stringify({ id: "broadcast-1", result: { ok: true } }));
});

test("qr bootstrap keeps previously paired phones trusted when a second phone scans", () => {
  const macIdentity = createOkpKeyPair("ed25519");
  const firstPhoneIdentity = createOkpKeyPair("ed25519");
  const firstPhoneEphemeral = createOkpKeyPair("x25519");
  const secondPhoneIdentity = createOkpKeyPair("ed25519");
  const secondPhoneEphemeral = createOkpKeyPair("x25519");
  const secureTransport = createBridgeSecureTransport({
    sessionId: "session-3",
    deviceState: createBridgeDeviceState({
      bridgeId: "bridge-3",
      macDeviceId: "mac-3",
      macIdentityPrivateKey: macIdentity.privateKey,
      macIdentityPublicKey: macIdentity.publicKey,
    }),
  });

  finishHandshake({
    secureTransport,
    transportId: "transport-3a",
    sessionId: "session-3",
    macDeviceId: "mac-3",
    phoneDeviceId: "phone-3a",
    macIdentity,
    phoneIdentity: firstPhoneIdentity,
    phoneEphemeral: firstPhoneEphemeral,
    handshakeMode: HANDSHAKE_MODE_QR_BOOTSTRAP,
    lastAppliedBridgeOutboundSeq: 0,
  });

  const controlMessages: ControlMessage[] = [];
  secureTransport.handleIncomingWireMessage(
    JSON.stringify({
      kind: "clientHello",
      protocolVersion: 1,
      sessionId: "session-3",
      handshakeMode: HANDSHAKE_MODE_QR_BOOTSTRAP,
      phoneDeviceId: "phone-3b",
      phoneIdentityPublicKey: secondPhoneIdentity.publicKey,
      phoneEphemeralPublicKey: secondPhoneEphemeral.publicKey,
      clientNonce: Buffer.alloc(32, 9).toString("base64"),
    }),
    {
      transportId: "transport-3b",
      sendControlMessage(message) {
        controlMessages.push(message);
      },
      onApplicationMessage() {
        throw new Error("second phone bootstrap should be rejected before app traffic");
      },
    }
  );

  const serverHello = controlMessages.find((message) => message.kind === "serverHello");
  assert.ok(isServerHelloMessage(serverHello), "expected serverHello for replacement bootstrap");

  secureTransport.handleIncomingWireMessage(
    JSON.stringify({
      kind: "clientAuth",
      sessionId: "session-3",
      phoneDeviceId: "phone-3b",
      keyEpoch: serverHello.keyEpoch,
      phoneSignature: sign(
        null,
        Buffer.concat([
          buildTranscriptBytes({
            sessionId: "session-3",
            protocolVersion: 1,
            handshakeMode: HANDSHAKE_MODE_QR_BOOTSTRAP,
            keyEpoch: serverHello.keyEpoch,
            macDeviceId: "mac-3",
            phoneDeviceId: "phone-3b",
            macIdentityPublicKey: macIdentity.publicKey,
            phoneIdentityPublicKey: secondPhoneIdentity.publicKey,
            macEphemeralPublicKey: serverHello.macEphemeralPublicKey,
            phoneEphemeralPublicKey: secondPhoneEphemeral.publicKey,
            clientNonce: Buffer.alloc(32, 9),
            serverNonce: Buffer.from(serverHello.serverNonce, "base64"),
            expiresAtForTranscript: serverHello.expiresAtForTranscript,
          }),
          encodeLengthPrefixedUTF8("client-auth"),
        ]),
        createPrivateKey({
          key: {
            crv: "Ed25519",
            d: base64ToBase64Url(secondPhoneIdentity.privateKey),
            kty: "OKP",
            x: base64ToBase64Url(secondPhoneIdentity.publicKey),
          },
          format: "jwk",
        })
      ).toString("base64"),
    }),
    {
      transportId: "transport-3b",
      sendControlMessage(message) {
        controlMessages.push(message);
      },
      onApplicationMessage() {
        throw new Error("replacement bootstrap should not forward app traffic");
      },
    }
  );

  const secureReady = controlMessages.find((message) => message.kind === "secureReady");
  assert.ok(isSecureReadyMessage(secureReady), "expected secureReady after second phone bootstrap");

  const reconnectMessages: ControlMessage[] = [];
  secureTransport.handleIncomingWireMessage(
    JSON.stringify({
      kind: "clientHello",
      protocolVersion: 1,
      sessionId: "session-3",
      handshakeMode: HANDSHAKE_MODE_TRUSTED_RECONNECT,
      phoneDeviceId: "phone-3a",
      phoneIdentityPublicKey: firstPhoneIdentity.publicKey,
      phoneEphemeralPublicKey: createOkpKeyPair("x25519").publicKey,
      clientNonce: Buffer.alloc(32, 5).toString("base64"),
    }),
    {
      transportId: "transport-3c",
      sendControlMessage(message) {
        reconnectMessages.push(message);
      },
      onApplicationMessage() {
        throw new Error("trusted reconnect should not forward app traffic during handshake");
      },
    }
  );

  assert.equal(reconnectMessages[0]?.kind, "serverHello");
});

test("qr bootstrap starts a fresh replay window instead of leaking buffered messages", () => {
  const macIdentity = createOkpKeyPair("ed25519");
  const phoneIdentity = createOkpKeyPair("ed25519");
  const firstEphemeral = createOkpKeyPair("x25519");
  const secondEphemeral = createOkpKeyPair("x25519");
  const wireMessages: string[] = [];
  const secureTransport = createBridgeSecureTransport({
    sessionId: "session-4",
    deviceState: createBridgeDeviceState({
      bridgeId: "bridge-4",
      macDeviceId: "mac-4",
      macIdentityPrivateKey: macIdentity.privateKey,
      macIdentityPublicKey: macIdentity.publicKey,
    }),
  });

  finishHandshake({
    secureTransport,
    transportId: "transport-4",
    sessionId: "session-4",
    macDeviceId: "mac-4",
    phoneDeviceId: "phone-4",
    macIdentity,
    phoneIdentity,
    phoneEphemeral: firstEphemeral,
    handshakeMode: HANDSHAKE_MODE_QR_BOOTSTRAP,
    lastAppliedBridgeOutboundSeq: 0,
    wireMessages,
  });

  secureTransport.queueOutboundApplicationMessage(
    JSON.stringify({ id: "stale-response", result: { ok: true } })
  );
  assert.equal(wireMessages.length, 1);

  finishHandshake({
    secureTransport,
    transportId: "transport-4",
    sessionId: "session-4",
    macDeviceId: "mac-4",
    phoneDeviceId: "phone-4",
    macIdentity,
    phoneIdentity,
    phoneEphemeral: secondEphemeral,
    handshakeMode: HANDSHAKE_MODE_QR_BOOTSTRAP,
    lastAppliedBridgeOutboundSeq: 0,
    wireMessages,
  });

  assert.equal(wireMessages.length, 1);
});

function finishHandshake({
  secureTransport,
  transportId = "transport-unknown",
  sessionId,
  macDeviceId,
  phoneDeviceId,
  macIdentity,
  phoneIdentity,
  phoneEphemeral,
  handshakeMode,
  lastAppliedBridgeOutboundSeq,
  wireMessages = [],
}: {
  secureTransport: BridgeSecureTransport;
  transportId?: string;
  sessionId: string;
  macDeviceId: string;
  phoneDeviceId: string;
  macIdentity: OkpKeyPair;
  phoneIdentity: OkpKeyPair;
  phoneEphemeral: OkpKeyPair;
  handshakeMode: HandshakeMode;
  lastAppliedBridgeOutboundSeq: number;
  wireMessages?: string[];
}): HandshakeResult {
  const controlMessages: ControlMessage[] = [];
  const applicationMessages: string[] = [];
  const clientNonce = Buffer.alloc(32, 7);

  secureTransport.handleIncomingWireMessage(
    JSON.stringify({
      kind: "clientHello",
      protocolVersion: 1,
      sessionId,
      handshakeMode,
      phoneDeviceId,
      phoneIdentityPublicKey: phoneIdentity.publicKey,
      phoneEphemeralPublicKey: phoneEphemeral.publicKey,
      clientNonce: clientNonce.toString("base64"),
    }),
    {
      transportId,
      sendControlMessage(message) {
        controlMessages.push(message);
      },
      onApplicationMessage(message) {
        applicationMessages.push(message);
      },
      sendWireMessage(message) {
        wireMessages.push(message);
      },
    }
  );

  const serverHello = controlMessages.find((message) => message.kind === "serverHello");
  assert.ok(isServerHelloMessage(serverHello), "expected serverHello");

  const transcriptBytes = buildTranscriptBytes({
    sessionId,
    protocolVersion: 1,
    handshakeMode,
    keyEpoch: serverHello.keyEpoch,
    macDeviceId,
    phoneDeviceId,
    macIdentityPublicKey: macIdentity.publicKey,
    phoneIdentityPublicKey: phoneIdentity.publicKey,
    macEphemeralPublicKey: serverHello.macEphemeralPublicKey,
    phoneEphemeralPublicKey: phoneEphemeral.publicKey,
    clientNonce,
    serverNonce: Buffer.from(serverHello.serverNonce, "base64"),
    expiresAtForTranscript: serverHello.expiresAtForTranscript,
  });
  const phoneAuthTranscript = Buffer.concat([
    transcriptBytes,
    encodeLengthPrefixedUTF8("client-auth"),
  ]);
  const phoneSignature = sign(
    null,
    phoneAuthTranscript,
    createPrivateKey({
      key: {
        crv: "Ed25519",
        d: base64ToBase64Url(phoneIdentity.privateKey),
        kty: "OKP",
        x: base64ToBase64Url(phoneIdentity.publicKey),
      },
      format: "jwk",
    })
  );

  secureTransport.handleIncomingWireMessage(
    JSON.stringify({
      kind: "clientAuth",
      sessionId,
      phoneDeviceId,
      keyEpoch: serverHello.keyEpoch,
      phoneSignature: phoneSignature.toString("base64"),
    }),
    {
      transportId,
      sendControlMessage(message) {
        controlMessages.push(message);
      },
      onApplicationMessage(message) {
        applicationMessages.push(message);
      },
      sendWireMessage(message) {
        wireMessages.push(message);
      },
    }
  );

  const secureReady = controlMessages.find((message) => message.kind === "secureReady");
  assert.ok(isSecureReadyMessage(secureReady), "expected secureReady");

  secureTransport.handleIncomingWireMessage(
    JSON.stringify({
      kind: "resumeState",
      sessionId,
      keyEpoch: serverHello.keyEpoch,
      lastAppliedBridgeOutboundSeq,
    }),
    {
      transportId,
      sendControlMessage(message) {
        controlMessages.push(message);
      },
      onApplicationMessage(message) {
        applicationMessages.push(message);
      },
      sendWireMessage(message) {
        wireMessages.push(message);
      },
    }
  );

  return { applicationMessages, controlMessages, serverHello, transcriptBytes };
}

function createBridgeDeviceState({
  bridgeId,
  macDeviceId,
  macIdentityPrivateKey,
  macIdentityPublicKey,
  trustedPhones = {},
}: {
  bridgeId: string;
  macDeviceId: string;
  macIdentityPrivateKey: string;
  macIdentityPublicKey: string;
  trustedPhones?: Record<string, string>;
}): BridgeDeviceState {
  return {
    version: 1,
    bridgeId,
    macDeviceId,
    macIdentityPrivateKey,
    macIdentityPublicKey,
    trustedPhones,
  };
}

function deriveSessionKeys({
  sessionId,
  macDeviceId,
  phoneDeviceId,
  phoneEphemeral,
  serverHello,
  transcriptBytes,
}: {
  sessionId: string;
  macDeviceId: string;
  phoneDeviceId: string;
  phoneEphemeral: OkpKeyPair;
  serverHello: ServerHelloMessage;
  transcriptBytes: Buffer;
}): { phoneToMacKey: Buffer; macToPhoneKey: Buffer } {
  const sharedSecret = diffieHellman({
    privateKey: createPrivateKey({
      key: {
        crv: "X25519",
        d: base64ToBase64Url(phoneEphemeral.privateKey),
        kty: "OKP",
        x: base64ToBase64Url(phoneEphemeral.publicKey),
      },
      format: "jwk",
    }),
    publicKey: createPublicKey({
      key: {
        crv: "X25519",
        kty: "OKP",
        x: base64ToBase64Url(serverHello.macEphemeralPublicKey),
      },
      format: "jwk",
    }),
  });
  const salt = createHash("sha256").update(transcriptBytes).digest();
  const infoPrefix = `coderover-e2ee-v1|${sessionId}|${macDeviceId}|${phoneDeviceId}|${serverHello.keyEpoch}`;

  return {
    phoneToMacKey: Buffer.from(
      hkdfSync("sha256", sharedSecret, salt, Buffer.from(`${infoPrefix}|phoneToMac`, "utf8"), 32)
    ),
    macToPhoneKey: Buffer.from(
      hkdfSync("sha256", sharedSecret, salt, Buffer.from(`${infoPrefix}|macToPhone`, "utf8"), 32)
    ),
  };
}

function createOkpKeyPair(type: "ed25519" | "x25519"): OkpKeyPair {
  const { privateKey, publicKey } = type === "ed25519"
    ? generateKeyPairSync("ed25519")
    : generateKeyPairSync("x25519");
  const privateJwk = privateKey.export({ format: "jwk" });
  const publicJwk = publicKey.export({ format: "jwk" });
  assert.ok(privateJwk.d);
  assert.ok(publicJwk.x);
  return {
    privateKey: base64UrlToBase64(privateJwk.d),
    publicKey: base64UrlToBase64(publicJwk.x),
  };
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
}: {
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
}): Buffer {
  return Buffer.concat([
    encodeLengthPrefixedUTF8("coderover-e2ee-v1"),
    encodeLengthPrefixedUTF8(sessionId),
    encodeLengthPrefixedUTF8(String(protocolVersion)),
    encodeLengthPrefixedUTF8(handshakeMode),
    encodeLengthPrefixedUTF8(String(keyEpoch)),
    encodeLengthPrefixedUTF8(macDeviceId),
    encodeLengthPrefixedUTF8(phoneDeviceId),
    encodeLengthPrefixedBuffer(Buffer.from(macIdentityPublicKey, "base64")),
    encodeLengthPrefixedBuffer(Buffer.from(phoneIdentityPublicKey, "base64")),
    encodeLengthPrefixedBuffer(Buffer.from(macEphemeralPublicKey, "base64")),
    encodeLengthPrefixedBuffer(Buffer.from(phoneEphemeralPublicKey, "base64")),
    encodeLengthPrefixedBuffer(clientNonce),
    encodeLengthPrefixedBuffer(serverNonce),
    encodeLengthPrefixedUTF8(String(expiresAtForTranscript)),
  ]);
}

function encodeLengthPrefixedUTF8(value: string): Buffer {
  return encodeLengthPrefixedBuffer(Buffer.from(value, "utf8"));
}

function encodeLengthPrefixedBuffer(buffer: Buffer): Buffer {
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(buffer.length, 0);
  return Buffer.concat([length, buffer]);
}

function encryptEnvelope(
  payloadObject: Record<string, unknown>,
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
  return {
    kind: "encryptedEnvelope",
    v: 1,
    sessionId,
    keyEpoch,
    sender,
    counter,
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

function decryptEnvelope(envelope: EncryptedEnvelope, key: Buffer): EncryptedPayload {
  const nonce = nonceForDirection(envelope.sender, envelope.counter);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}

function base64UrlToBase64(value: string): string {
  const padded = `${value}${"=".repeat((4 - (value.length % 4 || 4)) % 4)}`;
  return padded.replace(/-/g, "+").replace(/_/g, "/");
}

function base64ToBase64Url(value: string): string {
  return value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
