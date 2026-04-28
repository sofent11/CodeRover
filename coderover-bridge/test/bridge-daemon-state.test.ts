import { afterEach, beforeEach, test } from "bun:test";
import { strict as assert } from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  createEmptyBridgeRuntimeState,
  isBridgeProcessRunning,
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
  assert.equal((fs.statSync(resolveBridgeRuntimeStatePath()).mode & 0o777), 0o600);
});

test("bridge runtime state recovers from backup when the primary file is corrupt", () => {
  const state = createEmptyBridgeRuntimeState();
  state.status = "running";
  state.pid = 1234;
  state.instanceId = "bridge-instance-backup";

  writeBridgeRuntimeState(state);
  writeBridgeRuntimeState({
    ...state,
    pid: 5678,
  });
  fs.writeFileSync(resolveBridgeRuntimeStatePath(), "{not valid json", "utf8");

  const recovered = readBridgeRuntimeState();
  assert.equal(recovered?.pid, 1234);
  assert.equal(recovered?.instanceId, "bridge-instance-backup");
});

test("bridge process checks require a fresh heartbeat and matching instance command", () => {
  const now = Date.parse("2026-04-28T10:00:00.000Z");
  const state = {
    ...createEmptyBridgeRuntimeState(),
    status: "running" as const,
    instanceId: "instance-123",
    heartbeatAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };

  assert.equal(isBridgeProcessRunning(42, {
    state,
    nowMs: now,
    processExists: () => true,
    readCommandLine: () => "bun /repo/bin/coderover.js serve --daemonized --coderover-instance-id=instance-123",
  }), true);

  assert.equal(isBridgeProcessRunning(42, {
    state,
    nowMs: now,
    processExists: () => true,
    readCommandLine: () => "node unrelated-server.js",
  }), false);

  assert.equal(isBridgeProcessRunning(42, {
    state: {
      ...state,
      heartbeatAt: new Date(now - 60_000).toISOString(),
    },
    nowMs: now,
    processExists: () => true,
    readCommandLine: () => "bun /repo/bin/coderover.js serve --daemonized --coderover-instance-id=instance-123",
  }), false);
});

test("bridge process checks fall back to command validation when no instance id is present", () => {
  const now = Date.parse("2026-04-28T10:00:00.000Z");
  const state = {
    ...createEmptyBridgeRuntimeState(),
    status: "running" as const,
    instanceId: null,
    mode: "foreground" as const,
    heartbeatAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };

  assert.equal(isBridgeProcessRunning(42, {
    state,
    nowMs: now,
    processExists: () => true,
    readCommandLine: () => "bun /repo/bin/coderover.js serve",
  }), true);

  assert.equal(isBridgeProcessRunning(42, {
    state,
    nowMs: now,
    processExists: () => true,
    readCommandLine: () => "node unrelated-server.js",
  }), false);
});
