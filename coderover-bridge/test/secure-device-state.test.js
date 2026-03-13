// FILE: secure-device-state.test.js
// Purpose: Verifies persisted bridge identity can be read back from Keychain's hex-encoded output.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, ../src/secure-device-state

const test = require("node:test");
const assert = require("node:assert/strict");
const { decodeStoredDeviceStateString } = require("../src/secure-device-state");

test("decodeStoredDeviceStateString preserves plain JSON", () => {
  const json = JSON.stringify({ bridgeId: "bridge-1" });
  assert.equal(decodeStoredDeviceStateString(json), json);
});

test("decodeStoredDeviceStateString decodes Keychain hex output", () => {
  const json = JSON.stringify({ bridgeId: "bridge-1", macDeviceId: "mac-1" }, null, 2);
  const hex = Buffer.from(json, "utf8").toString("hex");
  assert.equal(decodeStoredDeviceStateString(hex), json);
});
