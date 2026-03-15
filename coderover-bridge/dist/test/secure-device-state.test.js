"use strict";
// FILE: secure-device-state.test.ts
// Purpose: Verifies persisted bridge identity can be read back from Keychain's hex-encoded output.
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const node_assert_1 = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const node_module_1 = require("node:module");
const secure_device_state_1 = require("../src/secure-device-state");
const runtimeRequire = (0, node_module_1.createRequire)(__filename);
(0, node_test_1.test)("decodeStoredDeviceStateString preserves plain JSON", () => {
    const json = JSON.stringify({ bridgeId: "bridge-1" });
    node_assert_1.strict.equal((0, secure_device_state_1.decodeStoredDeviceStateString)(json), json);
});
(0, node_test_1.test)("decodeStoredDeviceStateString decodes Keychain hex output", () => {
    const json = JSON.stringify({ bridgeId: "bridge-1", macDeviceId: "mac-1" }, null, 2);
    const hex = Buffer.from(json, "utf8").toString("hex");
    node_assert_1.strict.equal((0, secure_device_state_1.decodeStoredDeviceStateString)(hex), json);
});
(0, node_test_1.test)("bridge device state persists trusted phones across reloads", () => {
    const originalHome = process.env.HOME;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "coderover-secure-state-"));
    const modulePath = runtimeRequire.resolve("../src/secure-device-state");
    try {
        process.env.HOME = tempHome;
        delete runtimeRequire.cache[modulePath];
        const secureDeviceState = runtimeRequire("../src/secure-device-state");
        const initial = secureDeviceState.loadOrCreateBridgeDeviceState();
        const updated = secureDeviceState.rememberTrustedPhone(initial, "11111111-1111-4111-8111-111111111111", "phone-public-key");
        delete runtimeRequire.cache[modulePath];
        const reloadedSecureDeviceState = runtimeRequire("../src/secure-device-state");
        const reloaded = reloadedSecureDeviceState.loadOrCreateBridgeDeviceState();
        node_assert_1.strict.equal(reloaded.bridgeId, updated.bridgeId);
        node_assert_1.strict.equal(reloaded.macDeviceId, updated.macDeviceId);
        node_assert_1.strict.equal(reloaded.trustedPhones["11111111-1111-4111-8111-111111111111"], "phone-public-key");
    }
    finally {
        delete runtimeRequire.cache[modulePath];
        process.env.HOME = originalHome;
        fs.rmSync(tempHome, { recursive: true, force: true });
    }
});
(0, node_test_1.test)("bridge device state falls back to file when keychain payload is invalid", () => {
    const originalHome = process.env.HOME;
    const originalPlatform = process.platform;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "coderover-secure-state-"));
    const modulePath = runtimeRequire.resolve("../src/secure-device-state");
    const childProcessModule = runtimeRequire("node:child_process");
    const originalExecFileSync = childProcessModule.execFileSync;
    const stableState = {
        version: 1,
        bridgeId: "5c6d0bc5-0b98-4390-bd15-3dfd3a839da5",
        macDeviceId: "23babf51-9e1f-4215-bced-ddfb7d62ca31",
        macIdentityPublicKey: "public-key",
        macIdentityPrivateKey: "private-key",
        trustedPhones: {},
    };
    try {
        process.env.HOME = tempHome;
        fs.mkdirSync(path.join(tempHome, ".coderover"), { recursive: true });
        fs.writeFileSync(path.join(tempHome, ".coderover", "device-state.json"), JSON.stringify(stableState, null, 2));
        Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
        childProcessModule.execFileSync = ((command, args) => {
            if (command !== "security") {
                throw new Error(`Unexpected command: ${command}`);
            }
            if (args?.[0] === "find-generic-password") {
                return "not-json";
            }
            if (args?.[0] === "add-generic-password") {
                return "";
            }
            throw new Error(`Unexpected security args: ${String(args)}`);
        });
        delete runtimeRequire.cache[modulePath];
        const secureDeviceState = runtimeRequire("../src/secure-device-state");
        const loaded = secureDeviceState.loadOrCreateBridgeDeviceState();
        node_assert_1.strict.equal(loaded.bridgeId, stableState.bridgeId);
        node_assert_1.strict.equal(loaded.macDeviceId, stableState.macDeviceId);
    }
    finally {
        delete runtimeRequire.cache[modulePath];
        Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
        childProcessModule.execFileSync = originalExecFileSync;
        process.env.HOME = originalHome;
        fs.rmSync(tempHome, { recursive: true, force: true });
    }
});
