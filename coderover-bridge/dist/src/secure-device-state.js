"use strict";
// FILE: secure-device-state.ts
// Purpose: Persists the bridge device identity and trusted phone registry for E2EE pairing.
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadOrCreateBridgeDeviceState = loadOrCreateBridgeDeviceState;
exports.rememberTrustedPhone = rememberTrustedPhone;
exports.getTrustedPhonePublicKey = getTrustedPhonePublicKey;
exports.decodeStoredDeviceStateString = decodeStoredDeviceStateString;
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto_1 = require("crypto");
const child_process_1 = require("child_process");
const STORE_DIR = path.join(os.homedir(), ".coderover");
const STORE_FILE = path.join(STORE_DIR, "device-state.json");
const KEYCHAIN_SERVICE = "com.coderover.bridge.device-state";
const KEYCHAIN_ACCOUNT = "default";
function loadOrCreateBridgeDeviceState() {
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
function rememberTrustedPhone(state, phoneDeviceId, phoneIdentityPublicKey) {
    const normalizedDeviceId = normalizeNonEmptyString(phoneDeviceId);
    const normalizedPublicKey = normalizeNonEmptyString(phoneIdentityPublicKey);
    if (!normalizedDeviceId || !normalizedPublicKey) {
        return state;
    }
    const nextState = {
        ...state,
        trustedPhones: {
            ...(state.trustedPhones || {}),
            [normalizedDeviceId]: normalizedPublicKey,
        },
    };
    writeBridgeDeviceState(nextState);
    return nextState;
}
function getTrustedPhonePublicKey(state, phoneDeviceId) {
    const normalizedDeviceId = normalizeNonEmptyString(phoneDeviceId);
    if (!normalizedDeviceId) {
        return null;
    }
    return state.trustedPhones?.[normalizedDeviceId] || null;
}
function createBridgeDeviceState() {
    const { publicKey, privateKey } = (0, crypto_1.generateKeyPairSync)("ed25519");
    const privateJwk = privateKey.export({ format: "jwk" });
    const publicJwk = publicKey.export({ format: "jwk" });
    return {
        version: 1,
        bridgeId: (0, crypto_1.randomUUID)(),
        macDeviceId: (0, crypto_1.randomUUID)(),
        macIdentityPublicKey: base64UrlToBase64(publicJwk.x),
        macIdentityPrivateKey: base64UrlToBase64(privateJwk.d),
        trustedPhones: {},
    };
}
function readBridgeDeviceState() {
    const rawState = decodeStoredDeviceStateString(readStoredDeviceStateString());
    if (!rawState) {
        return null;
    }
    try {
        return normalizeBridgeDeviceState(JSON.parse(rawState));
    }
    catch {
        return null;
    }
}
function writeBridgeDeviceState(state) {
    const serialized = JSON.stringify(state, null, 2);
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(STORE_FILE, serialized, { mode: 0o600 });
    try {
        fs.chmodSync(STORE_FILE, 0o600);
    }
    catch {
        // Best-effort only on filesystems that support POSIX modes.
    }
    if (process.platform === "darwin") {
        writeKeychainStateString(serialized);
    }
}
function readStoredDeviceStateString() {
    if (process.platform === "darwin") {
        const keychainValue = readKeychainStateString();
        if (keychainValue) {
            return keychainValue;
        }
    }
    if (!fs.existsSync(STORE_FILE)) {
        return null;
    }
    try {
        return fs.readFileSync(STORE_FILE, "utf8");
    }
    catch {
        return null;
    }
}
function readKeychainStateString() {
    try {
        return (0, child_process_1.execFileSync)("security", [
            "find-generic-password",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            KEYCHAIN_ACCOUNT,
            "-w",
        ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    }
    catch {
        return null;
    }
}
function decodeStoredDeviceStateString(value) {
    const normalized = normalizeNonEmptyString(value);
    if (!normalized) {
        return null;
    }
    if (looksLikeHexEncodedUTF8(normalized)) {
        try {
            return Buffer.from(normalized, "hex").toString("utf8");
        }
        catch {
            return normalized;
        }
    }
    return normalized;
}
function writeKeychainStateString(value) {
    try {
        (0, child_process_1.execFileSync)("security", [
            "add-generic-password",
            "-U",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            KEYCHAIN_ACCOUNT,
            "-w",
            value,
        ], { stdio: ["ignore", "ignore", "ignore"] });
        return true;
    }
    catch {
        return false;
    }
}
function normalizeBridgeDeviceState(rawState) {
    const record = rawState && typeof rawState === "object"
        ? rawState
        : {};
    const rawBridgeId = normalizeNonEmptyString(record.bridgeId);
    const rawMacDeviceId = normalizeNonEmptyString(record.macDeviceId);
    const bridgeId = isCanonicalUUID(rawBridgeId) ? rawBridgeId : (0, crypto_1.randomUUID)();
    const macDeviceId = isCanonicalUUID(rawMacDeviceId) ? rawMacDeviceId : (0, crypto_1.randomUUID)();
    const macIdentityPublicKey = normalizeNonEmptyString(record.macIdentityPublicKey);
    const macIdentityPrivateKey = normalizeNonEmptyString(record.macIdentityPrivateKey);
    if (!macIdentityPublicKey || !macIdentityPrivateKey) {
        throw new Error("Bridge device state is incomplete");
    }
    const trustedPhones = {};
    if (record.trustedPhones && typeof record.trustedPhones === "object") {
        for (const [deviceId, publicKey] of Object.entries(record.trustedPhones)) {
            const normalizedDeviceId = normalizeNonEmptyString(deviceId);
            const normalizedPublicKey = normalizeNonEmptyString(publicKey);
            if (!isCanonicalUUID(normalizedDeviceId) || !normalizedPublicKey) {
                continue;
            }
            trustedPhones[normalizedDeviceId] = normalizedPublicKey;
        }
    }
    const didMigrate = (bridgeId !== rawBridgeId
        || macDeviceId !== rawMacDeviceId
        || Object.keys(trustedPhones).length !== Object.keys(record.trustedPhones || {}).length);
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
function normalizeNonEmptyString(value) {
    if (typeof value !== "string") {
        return "";
    }
    return value.trim();
}
function looksLikeHexEncodedUTF8(value) {
    if (value.length < 2 || value.length % 2 !== 0) {
        return false;
    }
    return /^[0-9a-f]+$/i.test(value);
}
function isCanonicalUUID(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim());
}
function stripMigrationMarker(state) {
    const { didMigrate: _didMigrate, ...stableState } = state;
    return stableState;
}
function base64UrlToBase64(value) {
    if (typeof value !== "string" || value.length === 0) {
        return "";
    }
    const padded = `${value}${"=".repeat((4 - (value.length % 4 || 4)) % 4)}`;
    return padded.replace(/-/g, "+").replace(/_/g, "/");
}
