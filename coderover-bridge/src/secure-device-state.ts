// FILE: secure-device-state.ts
// Purpose: Persists the bridge device identity and trusted phone registry for E2EE pairing.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID, generateKeyPairSync } from "crypto";
import { execFileSync } from "child_process";

interface JsonWebKeyLike {
  x?: string;
  d?: string;
}

export interface BridgeDeviceState {
  version: 1;
  bridgeId: string;
  macDeviceId: string;
  macIdentityPublicKey: string;
  macIdentityPrivateKey: string;
  trustedPhones: Record<string, string>;
}

interface BridgeDeviceStateWithMigrationFlag extends BridgeDeviceState {
  didMigrate?: boolean;
}

const STORE_DIR = path.join(os.homedir(), ".coderover");
const STORE_FILE = path.join(STORE_DIR, "device-state.json");
const KEYCHAIN_SERVICE = "com.coderover.bridge.device-state";
const KEYCHAIN_ACCOUNT = "default";

export function loadOrCreateBridgeDeviceState(): BridgeDeviceState {
  const existingState = readBridgeDeviceState();
  if (existingState) {
    const stableState = stripMigrationMarker(existingState);
    if (existingState.didMigrate) {
      writeBridgeDeviceState(stableState);
    }
    return stableState;
  }

  const nextState = createBridgeDeviceState();
  writeBridgeDeviceState(nextState);
  return nextState;
}

export function rememberTrustedPhone(
  state: BridgeDeviceState,
  phoneDeviceId: unknown,
  phoneIdentityPublicKey: unknown
): BridgeDeviceState {
  const normalizedDeviceId = normalizeNonEmptyString(phoneDeviceId);
  const normalizedPublicKey = normalizeNonEmptyString(phoneIdentityPublicKey);
  if (!normalizedDeviceId || !normalizedPublicKey) {
    return state;
  }

  const nextState: BridgeDeviceState = {
    ...state,
    trustedPhones: {
      ...(state.trustedPhones || {}),
      [normalizedDeviceId]: normalizedPublicKey,
    },
  };
  writeBridgeDeviceState(nextState);
  return nextState;
}

export function getTrustedPhonePublicKey(
  state: BridgeDeviceState,
  phoneDeviceId: unknown
): string | null {
  const normalizedDeviceId = normalizeNonEmptyString(phoneDeviceId);
  if (!normalizedDeviceId) {
    return null;
  }
  return state.trustedPhones?.[normalizedDeviceId] || null;
}

function createBridgeDeviceState(): BridgeDeviceState {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privateJwk = privateKey.export({ format: "jwk" }) as JsonWebKeyLike;
  const publicJwk = publicKey.export({ format: "jwk" }) as JsonWebKeyLike;

  return {
    version: 1,
    bridgeId: randomUUID(),
    macDeviceId: randomUUID(),
    macIdentityPublicKey: base64UrlToBase64(publicJwk.x),
    macIdentityPrivateKey: base64UrlToBase64(privateJwk.d),
    trustedPhones: {},
  };
}

function readBridgeDeviceState(): BridgeDeviceStateWithMigrationFlag | null {
  const keychainState = readBridgeDeviceStateRecord(readKeychainStoredDeviceStateString());
  if (keychainState) {
    return keychainState;
  }

  const fileState = readBridgeDeviceStateRecord(readFileStoredDeviceStateString());
  if (fileState) {
    if (process.platform === "darwin") {
      writeKeychainStateString(JSON.stringify(stripMigrationMarker(fileState), null, 2));
    }
    return fileState;
  }

  return null;
}

function readBridgeDeviceStateRecord(
  storedState: string | null
): BridgeDeviceStateWithMigrationFlag | null {
  const rawState = decodeStoredDeviceStateString(storedState);
  if (!rawState) {
    return null;
  }
  try {
    return normalizeBridgeDeviceState(JSON.parse(rawState));
  } catch {
    return null;
  }
}

function writeBridgeDeviceState(state: BridgeDeviceState): void {
  const serialized = JSON.stringify(state, null, 2);
  fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.writeFileSync(STORE_FILE, serialized, { mode: 0o600 });
  try {
    fs.chmodSync(STORE_FILE, 0o600);
  } catch {
    // Best-effort only on filesystems that support POSIX modes.
  }

  if (process.platform === "darwin") {
    writeKeychainStateString(serialized);
  }
}

function readKeychainStoredDeviceStateString(): string | null {
  if (process.platform !== "darwin") {
    return null;
  }

  return readKeychainStateString();
}

function readFileStoredDeviceStateString(): string | null {
  if (!fs.existsSync(STORE_FILE)) {
    return null;
  }

  try {
    return fs.readFileSync(STORE_FILE, "utf8");
  } catch {
    return null;
  }
}

function readKeychainStateString(): string | null {
  try {
    return execFileSync(
      "security",
      [
        "find-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        KEYCHAIN_ACCOUNT,
        "-w",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
  } catch {
    return null;
  }
}

export function decodeStoredDeviceStateString(value: unknown): string | null {
  const normalized = normalizeNonEmptyString(value);
  if (!normalized) {
    return null;
  }

  if (looksLikeHexEncodedUTF8(normalized)) {
    try {
      return Buffer.from(normalized, "hex").toString("utf8");
    } catch {
      return normalized;
    }
  }

  return normalized;
}

function writeKeychainStateString(value: string): boolean {
  try {
    execFileSync(
      "security",
      [
        "add-generic-password",
        "-U",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        KEYCHAIN_ACCOUNT,
        "-w",
        value,
      ],
      { stdio: ["ignore", "ignore", "ignore"] }
    );
    return true;
  } catch {
    return false;
  }
}

function normalizeBridgeDeviceState(rawState: unknown): BridgeDeviceStateWithMigrationFlag {
  const record = rawState && typeof rawState === "object"
    ? (rawState as Record<string, unknown>)
    : {};
  const rawBridgeId = normalizeNonEmptyString(record.bridgeId);
  const rawMacDeviceId = normalizeNonEmptyString(record.macDeviceId);
  const bridgeId = isCanonicalUUID(rawBridgeId) ? rawBridgeId : randomUUID();
  const macDeviceId = isCanonicalUUID(rawMacDeviceId) ? rawMacDeviceId : randomUUID();
  const macIdentityPublicKey = normalizeNonEmptyString(record.macIdentityPublicKey);
  const macIdentityPrivateKey = normalizeNonEmptyString(record.macIdentityPrivateKey);

  if (!macIdentityPublicKey || !macIdentityPrivateKey) {
    throw new Error("Bridge device state is incomplete");
  }

  const trustedPhones: Record<string, string> = {};
  if (record.trustedPhones && typeof record.trustedPhones === "object") {
    for (const [deviceId, publicKey] of Object.entries(record.trustedPhones as Record<string, unknown>)) {
      const normalizedDeviceId = normalizeNonEmptyString(deviceId);
      const normalizedPublicKey = normalizeNonEmptyString(publicKey);
      if (!isCanonicalUUID(normalizedDeviceId) || !normalizedPublicKey) {
        continue;
      }
      trustedPhones[normalizedDeviceId] = normalizedPublicKey;
    }
  }

  const didMigrate = (
    bridgeId !== rawBridgeId
    || macDeviceId !== rawMacDeviceId
    || Object.keys(trustedPhones).length !== Object.keys((record.trustedPhones as Record<string, unknown>) || {}).length
  );

  return {
    version: 1,
    bridgeId,
    macDeviceId,
    macIdentityPublicKey,
    macIdentityPrivateKey,
    trustedPhones,
    didMigrate,
  };
}

function normalizeNonEmptyString(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function looksLikeHexEncodedUTF8(value: string): boolean {
  if (value.length < 2 || value.length % 2 !== 0) {
    return false;
  }

  return /^[0-9a-f]+$/i.test(value);
}

function isCanonicalUUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim());
}

function stripMigrationMarker(state: BridgeDeviceStateWithMigrationFlag): BridgeDeviceState {
  const { didMigrate: _didMigrate, ...stableState } = state;
  return stableState;
}

function base64UrlToBase64(value: string | undefined): string {
  if (typeof value !== "string" || value.length === 0) {
    return "";
  }

  const padded = `${value}${"=".repeat((4 - (value.length % 4 || 4)) % 4)}`;
  return padded.replace(/-/g, "+").replace(/_/g, "/");
}
