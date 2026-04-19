// FILE: bridge-status-handler.test.ts
// Purpose: Verifies bridge status, update prompt, and keep-awake preference RPCs.

import { test } from "bun:test";
import { strict as assert } from "node:assert";

import { createBridgeStatusHandler } from "../src/bridge-status-handler";

function waitForTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("bridge/status/read returns bridge version, compatibility, and keep-awake state", async () => {
  const responses: Array<Record<string, any>> = [];
  const handler = createBridgeStatusHandler({
    readPackageVersionStatus: async () => ({
      bridgeVersion: "1.1.2",
      bridgeLatestVersion: "1.2.0",
    }),
    getPreferences: () => ({
      version: 1,
      keepAwakeEnabled: true,
    }),
    getKeepAwakeActive: () => true,
    getTrustedDeviceCount: () => 3,
    minimumSupportedIOSVersion: "1.0",
    minimumSupportedAndroidVersion: "0.1.0",
  });

  const handled = handler(JSON.stringify({
    id: "bridge-status-1",
    method: "bridge/status/read",
    params: {},
  }), (response) => {
    responses.push(JSON.parse(response) as Record<string, any>);
  });

  assert.equal(handled, true);
  await waitForTick();

  assert.equal(responses[0]?.result?.bridgeVersion, "1.1.2");
  assert.equal(responses[0]?.result?.bridgeLatestVersion, "1.2.0");
  assert.equal(responses[0]?.result?.updateAvailable, true);
  assert.equal(responses[0]?.result?.keepAwakeEnabled, true);
  assert.equal(responses[0]?.result?.keepAwakeActive, true);
  assert.equal(responses[0]?.result?.trustedDeviceCount, 3);
  assert.equal(responses[0]?.result?.supportedMobileVersions?.ios?.minimumVersion, "1.0");
  assert.equal(responses[0]?.result?.supportedMobileVersions?.android?.minimumVersion, "0.1.0");
});

test("bridge/updatePrompt/read returns a dedicated upgrade payload", async () => {
  const responses: Array<Record<string, any>> = [];
  const handler = createBridgeStatusHandler({
    readPackageVersionStatus: async () => ({
      bridgeVersion: "1.0.0",
      bridgeLatestVersion: "1.1.0",
    }),
  });

  handler(JSON.stringify({
    id: "bridge-status-2",
    method: "bridge/updatePrompt/read",
    params: {},
  }), (response) => {
    responses.push(JSON.parse(response) as Record<string, any>);
  });

  await waitForTick();

  assert.equal(responses[0]?.result?.shouldPrompt, true);
  assert.equal(responses[0]?.result?.kind, "bridge_update_available");
  assert.match(responses[0]?.result?.message ?? "", /1\.0\.0/);
  assert.equal(responses[0]?.result?.upgradeCommand, "bun add -g coderover@latest");
});

test("bridge/preferences/update persists keep-awake preference changes", async () => {
  const responses: Array<Record<string, any>> = [];
  let keepAwakeEnabled = true;
  let keepAwakeActive = true;

  const handler = createBridgeStatusHandler({
    getPreferences: () => ({
      version: 1,
      keepAwakeEnabled,
    }),
    updatePreferences: (updates) => {
      keepAwakeEnabled = updates.keepAwakeEnabled ?? keepAwakeEnabled;
      keepAwakeActive = keepAwakeEnabled;
      return {
        version: 1,
        keepAwakeEnabled,
      };
    },
    getKeepAwakeActive: () => keepAwakeActive,
  });

  handler(JSON.stringify({
    id: "bridge-status-3",
    method: "bridge/preferences/update",
    params: {
      keepAwakeEnabled: false,
    },
  }), (response) => {
    responses.push(JSON.parse(response) as Record<string, any>);
  });

  await waitForTick();

  assert.equal(keepAwakeEnabled, false);
  assert.equal(responses[0]?.result?.success, true);
  assert.equal(responses[0]?.result?.keepAwakeEnabled, false);
  assert.equal(responses[0]?.result?.keepAwakeActive, false);
});
