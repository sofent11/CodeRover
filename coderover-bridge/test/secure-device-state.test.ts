// FILE: secure-device-state.test.ts
// Purpose: Verifies persisted bridge identity can be read back from Keychain's hex-encoded output.

import test = require("node:test");
import assert = require("node:assert/strict");
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { decodeStoredDeviceStateString } from "../src/secure-device-state";

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
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "coderover-secure-state-"));
  const modulePath = require.resolve("../src/secure-device-state");

  try {
    process.env.HOME = tempHome;
    delete require.cache[modulePath];
    const secureDeviceState = require("../src/secure-device-state") as typeof import("../src/secure-device-state");

    const initial = secureDeviceState.loadOrCreateBridgeDeviceState();
    const updated = secureDeviceState.rememberTrustedPhone(
      initial,
      "11111111-1111-4111-8111-111111111111",
      "phone-public-key"
    );

    delete require.cache[modulePath];
    const reloadedSecureDeviceState = require("../src/secure-device-state") as typeof import("../src/secure-device-state");
    const reloaded = reloadedSecureDeviceState.loadOrCreateBridgeDeviceState();

    assert.equal(reloaded.bridgeId, updated.bridgeId);
    assert.equal(reloaded.macDeviceId, updated.macDeviceId);
    assert.equal(
      reloaded.trustedPhones["11111111-1111-4111-8111-111111111111"],
      "phone-public-key"
    );
  } finally {
    delete require.cache[modulePath];
    process.env.HOME = originalHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});
