// FILE: secure-device-state.test.ts
// Purpose: Verifies persisted bridge identity can be read back from Keychain's hex-encoded output.

import { test } from "bun:test";
import { strict as assert } from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  __setExecFileSyncForTests,
  decodeStoredDeviceStateString,
  loadOrCreateBridgeDeviceState,
  rememberTrustedPhone,
} from "../src/secure-device-state";

test("decodeStoredDeviceStateString preserves plain JSON", () => {
  const json = JSON.stringify({ bridgeId: "bridge-1" });
  assert.equal(decodeStoredDeviceStateString(json), json);
});

test("decodeStoredDeviceStateString decodes Keychain hex output", () => {
  const json = JSON.stringify({ bridgeId: "bridge-1", macDeviceId: "mac-1" }, null, 2);
  const hex = Buffer.from(json, "utf8").toString("hex");
  assert.equal(decodeStoredDeviceStateString(hex), json);
});

test("bridge device state persists trusted phones across reloads", () => {
  const originalHome = process.env.HOME;
  const originalCoderoverHome = process.env.CODEROVER_HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "coderover-secure-state-"));

  try {
    process.env.HOME = tempHome;
    process.env.CODEROVER_HOME = path.join(tempHome, ".coderover");
    const initial = loadOrCreateBridgeDeviceState();
    const updated = rememberTrustedPhone(
      initial,
      "11111111-1111-4111-8111-111111111111",
      "phone-public-key"
    );

    const reloaded = loadOrCreateBridgeDeviceState();

    assert.equal(reloaded.bridgeId, updated.bridgeId);
    assert.equal(reloaded.macDeviceId, updated.macDeviceId);
    assert.equal(
      reloaded.trustedPhones["11111111-1111-4111-8111-111111111111"],
      "phone-public-key"
    );
  } finally {
    process.env.CODEROVER_HOME = originalCoderoverHome;
    process.env.HOME = originalHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test("bridge device state falls back to file when keychain payload is invalid", () => {
  const originalHome = process.env.HOME;
  const originalCoderoverHome = process.env.CODEROVER_HOME;
  const originalPlatform = process.platform;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "coderover-secure-state-"));
  const coderoverHome = path.join(tempHome, ".coderover");
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
    process.env.CODEROVER_HOME = coderoverHome;
    fs.mkdirSync(coderoverHome, { recursive: true });
    fs.writeFileSync(
      path.join(coderoverHome, "device-state.json"),
      JSON.stringify(stableState, null, 2)
    );

    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    __setExecFileSyncForTests(((command: string, args?: readonly string[]) => {
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
    }) as typeof import("child_process").execFileSync);

    const loaded = loadOrCreateBridgeDeviceState();

    assert.equal(loaded.bridgeId, stableState.bridgeId);
    assert.equal(loaded.macDeviceId, stableState.macDeviceId);
  } finally {
    __setExecFileSyncForTests(null);
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    process.env.CODEROVER_HOME = originalCoderoverHome;
    process.env.HOME = originalHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test("bridge device state preserves legacy non-UUID bridge identity fields", () => {
  const originalHome = process.env.HOME;
  const originalCoderoverHome = process.env.CODEROVER_HOME;
  const originalDisableKeychain = process.env.CODEROVER_DISABLE_KEYCHAIN;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "coderover-secure-state-"));
  const coderoverHome = path.join(tempHome, ".coderover");
  const legacyState = {
    version: 1,
    bridgeId: "bridge-local-macbook",
    macDeviceId: "macbook-pro-local",
    macIdentityPublicKey: "public-key",
    macIdentityPrivateKey: "private-key",
    trustedPhones: {
      "11111111-1111-4111-8111-111111111111": "phone-public-key",
    },
  };

  try {
    process.env.HOME = tempHome;
    process.env.CODEROVER_HOME = coderoverHome;
    process.env.CODEROVER_DISABLE_KEYCHAIN = "true";
    fs.mkdirSync(coderoverHome, { recursive: true });
    fs.writeFileSync(
      path.join(coderoverHome, "device-state.json"),
      JSON.stringify(legacyState, null, 2)
    );

    const loaded = loadOrCreateBridgeDeviceState();

    assert.equal(loaded.bridgeId, legacyState.bridgeId);
    assert.equal(loaded.macDeviceId, legacyState.macDeviceId);
    assert.equal(
      loaded.trustedPhones["11111111-1111-4111-8111-111111111111"],
      "phone-public-key"
    );
  } finally {
    if (typeof originalDisableKeychain === "string") {
      process.env.CODEROVER_DISABLE_KEYCHAIN = originalDisableKeychain;
    } else {
      delete process.env.CODEROVER_DISABLE_KEYCHAIN;
    }
    process.env.CODEROVER_HOME = originalCoderoverHome;
    process.env.HOME = originalHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});
