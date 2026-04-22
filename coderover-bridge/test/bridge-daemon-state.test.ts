import { afterEach, beforeEach, test } from "bun:test";
import { strict as assert } from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  createEmptyBridgeRuntimeState,
  readBridgeRuntimeState,
  resolveBridgeRuntimeStatePath,
  writeBridgeRuntimeState,
} from "../src/bridge-daemon-state";

let previousHome: string | undefined;
let tempHome = "";

beforeEach(() => {
  previousHome = process.env.CODEROVER_HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "coderover-bridge-daemon-"));
  process.env.CODEROVER_HOME = tempHome;
});

afterEach(() => {
  if (previousHome === undefined) {
    delete process.env.CODEROVER_HOME;
  } else {
    process.env.CODEROVER_HOME = previousHome;
  }
  fs.rmSync(tempHome, { recursive: true, force: true });
});

test("bridge runtime state persists pairing payload and transport metadata", () => {
  const state = createEmptyBridgeRuntimeState();
  state.status = "running";
  state.pid = 4242;
  state.mode = "daemon";
  state.bridgeId = "bridge-123";
  state.macDeviceId = "device-123";
  state.localUrl = "ws://127.0.0.1:8765/bridge/bridge-123";
  state.transportCandidates = [
    { kind: "local_ipv4", url: state.localUrl, label: "127.0.0.1" },
  ];
  state.pairingPayload = {
    bridgeId: "bridge-123",
    macDeviceId: "device-123",
    transportCandidates: state.transportCandidates,
    expiresAt: Date.now() + 60_000,
  };
  state.observability.outboundBufferMessages = 4;
  state.observability.lastSecureErrorCode = "resume_gap";
  state.observability.counters.outboundBufferDrops = 7;

  writeBridgeRuntimeState(state);

  const persisted = readBridgeRuntimeState();
  assert.ok(persisted);
  assert.equal(persisted?.status, "running");
  assert.equal(persisted?.pid, 4242);
  assert.equal(persisted?.mode, "daemon");
  assert.equal(persisted?.pairingPayload?.bridgeId, "bridge-123");
  assert.equal(persisted?.transportCandidates[0]?.url, state.localUrl);
  assert.equal(persisted?.observability.outboundBufferMessages, 4);
  assert.equal(persisted?.observability.lastSecureErrorCode, "resume_gap");
  assert.equal(persisted?.observability.counters.outboundBufferDrops, 7);
  assert.ok(fs.existsSync(resolveBridgeRuntimeStatePath()));
});
