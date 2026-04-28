// FILE: bridge-daemon.ts
// Purpose: Manages detached bridge startup and status inspection without relying on terminal logs.

import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { spawn } from "child_process";

import {
  createEmptyBridgeRuntimeState,
  isBridgeProcessRunning,
  readBridgeRuntimeState,
  resolveBridgeLogDir,
  writeBridgeRuntimeState,
  type BridgeRuntimeState,
} from "./bridge-daemon-state";
import { printQR } from "./qr";

const STATUS_REFRESH_SIGNAL = "SIGUSR1";
const STOP_SIGNAL = "SIGTERM";
const STATUS_REFRESH_WAIT_MS = 1500;
const STATUS_REFRESH_POLL_MS = 50;

export interface StartBridgeDaemonResult {
  pid: number;
  logFile: string;
  errorLogFile: string;
}

export async function startBridgeDaemon(binPath: string): Promise<StartBridgeDaemonResult> {
  const currentState = readBridgeStatusSnapshot();
  if (currentState?.status === "running" && currentState.pid) {
    throw new Error(`Bridge daemon already running (pid ${currentState.pid}).`);
  }

  const logDir = resolveBridgeLogDir();
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, "bridge-daemon.log");
  const errorLogFile = path.join(logDir, "bridge-daemon.err.log");
  const stdoutFd = fs.openSync(logFile, "a");
  const stderrFd = fs.openSync(errorLogFile, "a");
  const instanceId = randomUUID();

  try {
    const child = spawn(process.execPath, [
      binPath,
      "serve",
      "--daemonized",
      `--coderover-instance-id=${instanceId}`,
    ], {
      detached: true,
      stdio: ["ignore", stdoutFd, stderrFd],
      env: {
        ...process.env,
        CODEROVER_BRIDGE_INSTANCE_ID: instanceId,
      },
    });

    child.unref();
    return {
      pid: child.pid,
      logFile,
      errorLogFile,
    };
  } finally {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
  }
}

export async function readBridgeStatus(options: { refreshPairing?: boolean } = {}): Promise<BridgeRuntimeState | null> {
  const state = readBridgeStatusSnapshot();
  if (!state) {
    return null;
  }

  if (state.status !== "running" || !state.pid) {
    return state;
  }

  if (options.refreshPairing !== false) {
    await requestPairingRefresh(state);
  }

  return readBridgeStatusSnapshot();
}

export function printBridgeStatus(state: BridgeRuntimeState | null): void {
  if (!state) {
    console.log("[coderover] Bridge is not running.");
    return;
  }

  console.log(`[coderover] Bridge ${state.status}`);
  if (state.pid) {
    console.log(`PID: ${state.pid}`);
  }
  console.log(`Mode: ${state.mode}`);
  if (state.startedAt) {
    console.log(`Started: ${state.startedAt}`);
  }
  console.log(`Updated: ${state.updatedAt}`);
  if (state.bridgeId) {
    console.log(`Bridge ID: ${state.bridgeId}`);
  }
  if (state.macDeviceId) {
    console.log(`Device ID: ${state.macDeviceId}`);
  }
  if (state.localUrl) {
    console.log(`Local endpoint: ${state.localUrl}`);
  }
  console.log(`Connected clients: ${state.connectedClients}`);
  console.log(`Secure channel ready: ${state.secureChannelReady ? "yes" : "no"}`);
  console.log(`Outbound buffer: ${state.observability.outboundBufferMessages} msgs / ${state.observability.outboundBufferBytes} bytes`);
  console.log(`Secure counters: handshake_failures=${state.observability.counters.handshakeFailures}, replacements=${state.observability.counters.replacedConnections}, resume_gaps=${state.observability.counters.resumeGaps}, buffer_drops=${state.observability.counters.outboundBufferDrops}, shutdown_timeouts=${state.observability.counters.shutdownTimeouts}`);
  if (state.observability.lastSecureErrorCode) {
    console.log(`Last secure error: ${state.observability.lastSecureErrorCode}`);
  }
  if (state.logFile) {
    console.log(`Log: ${state.logFile}`);
  }
  if (state.errorLogFile) {
    console.log(`Error log: ${state.errorLogFile}`);
  }
  if (state.lastError) {
    console.log(`Last error: ${state.lastError}`);
  }

  for (const candidate of state.transportCandidates) {
    console.log(`Transport [${candidate.kind}]: ${candidate.url}`);
  }

  if (state.pairingPayload) {
    printQR(state.pairingPayload);
  }
}

export async function stopBridgeDaemon(): Promise<boolean> {
  const state = readBridgeStatusSnapshot();
  if (!state?.pid || state.status !== "running") {
    return false;
  }
  if (!isBridgeProcessRunning(state.pid, { state })) {
    return false;
  }

  try {
    process.kill(state.pid, STOP_SIGNAL);
  } catch {
    return false;
  }

  const deadline = Date.now() + STATUS_REFRESH_WAIT_MS;
  while (Date.now() < deadline) {
    if (!isBridgeProcessRunning(state.pid, { state })) {
      const nextState = {
        ...(readBridgeRuntimeState() || createEmptyBridgeRuntimeState()),
        status: "stopped" as const,
        pid: null,
        secureChannelReady: false,
        connectedClients: 0,
        updatedAt: new Date().toISOString(),
      };
      writeBridgeRuntimeState(nextState);
      return true;
    }
    await sleep(STATUS_REFRESH_POLL_MS);
  }

  return false;
}

function readBridgeStatusSnapshot(): BridgeRuntimeState | null {
  const state = readBridgeRuntimeState();
  if (!state) {
    return null;
  }

  if (state.status === "running" && state.pid && !isBridgeProcessRunning(state.pid, { state })) {
    const nextState: BridgeRuntimeState = {
      ...state,
      status: "stopped",
      pid: null,
      secureChannelReady: false,
      connectedClients: 0,
      updatedAt: new Date().toISOString(),
      lastError: state.lastError || "Bridge process is no longer running.",
    };
    writeBridgeRuntimeState(nextState);
    return nextState;
  }

  return state;
}

async function requestPairingRefresh(state: BridgeRuntimeState): Promise<void> {
  if (!state.pid || !isBridgeProcessRunning(state.pid, { state })) {
    return;
  }

  const previousExpiresAt = state.pairingPayload?.expiresAt ?? null;
  try {
    process.kill(state.pid, STATUS_REFRESH_SIGNAL);
  } catch {
    return;
  }

  const deadline = Date.now() + STATUS_REFRESH_WAIT_MS;
  while (Date.now() < deadline) {
    const nextState = readBridgeRuntimeState();
    if (
      nextState?.pid === state.pid
      && nextState.pairingPayload?.expiresAt != null
      && nextState.pairingPayload.expiresAt !== previousExpiresAt
    ) {
      return;
    }
    await sleep(STATUS_REFRESH_POLL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
