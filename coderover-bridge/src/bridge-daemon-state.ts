// FILE: bridge-daemon-state.ts
// Purpose: Persists daemon/runtime state so CLI commands can inspect the current bridge without scraping logs.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { PairingPayloadShape } from "./qr";
import type { TransportCandidateShape } from "./bridge-types";

export interface BridgeRuntimeState {
  version: 1;
  status: "running" | "stopped";
  pid: number | null;
  mode: "foreground" | "daemon";
  startedAt: string | null;
  updatedAt: string;
  bridgeId: string | null;
  macDeviceId: string | null;
  localUrl: string | null;
  routePath: string | null;
  transportCandidates: TransportCandidateShape[];
  pairingPayload: PairingPayloadShape | null;
  connectedClients: number;
  secureChannelReady: boolean;
  logFile: string | null;
  errorLogFile: string | null;
  lastError: string | null;
  observability: BridgeObservabilityState;
}

export interface BridgeObservabilityState {
  outboundBufferMessages: number;
  outboundBufferBytes: number;
  outboundBufferMinSeq: number | null;
  outboundBufferMaxSeq: number | null;
  pendingHandshakeCount: number;
  secureTransportLimits: Record<string, unknown> | null;
  lastSecureErrorCode: string | null;
  counters: {
    handshakeFailures: number;
    replacedConnections: number;
    resumeGaps: number;
    outboundBufferDrops: number;
    shutdownTimeouts: number;
  };
}

const BRIDGE_RUNTIME_STATE_VERSION = 1;
const BRIDGE_RUNTIME_STATE_FILE = "bridge-runtime.json";
const BRIDGE_LOG_DIR = "logs";

export function resolveCoderoverHome(): string {
  const configuredHome = process.env.CODEROVER_HOME?.trim();
  if (configuredHome) {
    return configuredHome;
  }
  return path.join(os.homedir(), ".coderover");
}

export function resolveBridgeRuntimeStatePath(): string {
  return path.join(resolveCoderoverHome(), BRIDGE_RUNTIME_STATE_FILE);
}

export function resolveBridgeLogDir(): string {
  return path.join(resolveCoderoverHome(), BRIDGE_LOG_DIR);
}

export function readBridgeRuntimeState(): BridgeRuntimeState | null {
  const statePath = resolveBridgeRuntimeStatePath();
  if (!fs.existsSync(statePath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(statePath, "utf8");
    return normalizeBridgeRuntimeState(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function writeBridgeRuntimeState(state: BridgeRuntimeState): void {
  const statePath = resolveBridgeRuntimeStatePath();
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(normalizeBridgeRuntimeState(state), null, 2));
}

export function createEmptyBridgeRuntimeState(): BridgeRuntimeState {
  return {
    version: BRIDGE_RUNTIME_STATE_VERSION,
    status: "stopped",
    pid: null,
    mode: "foreground",
    startedAt: null,
    updatedAt: new Date().toISOString(),
    bridgeId: null,
    macDeviceId: null,
    localUrl: null,
    routePath: null,
    transportCandidates: [],
    pairingPayload: null,
    connectedClients: 0,
    secureChannelReady: false,
    logFile: null,
    errorLogFile: null,
    lastError: null,
    observability: createEmptyBridgeObservabilityState(),
  };
}

export function isBridgeProcessRunning(pid: unknown): boolean {
  if (!Number.isInteger(pid) || Number(pid) <= 0) {
    return false;
  }

  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function normalizeBridgeRuntimeState(rawState: unknown): BridgeRuntimeState {
  const record = rawState && typeof rawState === "object"
    ? rawState as Record<string, unknown>
    : {};
  const transportCandidates = Array.isArray(record.transportCandidates)
    ? record.transportCandidates
      .map(normalizeTransportCandidate)
      .filter((value): value is TransportCandidateShape => value != null)
    : [];

  return {
    version: BRIDGE_RUNTIME_STATE_VERSION,
    status: record.status === "running" ? "running" : "stopped",
    pid: Number.isInteger(record.pid) && Number(record.pid) > 0 ? Number(record.pid) : null,
    mode: record.mode === "daemon" ? "daemon" : "foreground",
    startedAt: normalizeOptionalString(record.startedAt),
    updatedAt: normalizeOptionalString(record.updatedAt) || new Date().toISOString(),
    bridgeId: normalizeOptionalString(record.bridgeId),
    macDeviceId: normalizeOptionalString(record.macDeviceId),
    localUrl: normalizeOptionalString(record.localUrl),
    routePath: normalizeOptionalString(record.routePath),
    transportCandidates,
    pairingPayload: normalizePairingPayload(record.pairingPayload, transportCandidates),
    connectedClients: Number.isFinite(record.connectedClients) && Number(record.connectedClients) >= 0
      ? Number(record.connectedClients)
      : 0,
    secureChannelReady: Boolean(record.secureChannelReady),
    logFile: normalizeOptionalString(record.logFile),
    errorLogFile: normalizeOptionalString(record.errorLogFile),
    lastError: normalizeOptionalString(record.lastError),
    observability: normalizeBridgeObservabilityState(record.observability),
  };
}

function createEmptyBridgeObservabilityState(): BridgeObservabilityState {
  return {
    outboundBufferMessages: 0,
    outboundBufferBytes: 0,
    outboundBufferMinSeq: null,
    outboundBufferMaxSeq: null,
    pendingHandshakeCount: 0,
    secureTransportLimits: null,
    lastSecureErrorCode: null,
    counters: {
      handshakeFailures: 0,
      replacedConnections: 0,
      resumeGaps: 0,
      outboundBufferDrops: 0,
      shutdownTimeouts: 0,
    },
  };
}

function normalizeBridgeObservabilityState(rawState: unknown): BridgeObservabilityState {
  const record = rawState && typeof rawState === "object"
    ? rawState as Record<string, unknown>
    : {};
  const counters = record.counters && typeof record.counters === "object"
    ? record.counters as Record<string, unknown>
    : {};

  return {
    outboundBufferMessages: normalizeCount(record.outboundBufferMessages),
    outboundBufferBytes: normalizeCount(record.outboundBufferBytes),
    outboundBufferMinSeq: normalizeNullableCount(record.outboundBufferMinSeq),
    outboundBufferMaxSeq: normalizeNullableCount(record.outboundBufferMaxSeq),
    pendingHandshakeCount: normalizeCount(record.pendingHandshakeCount),
    secureTransportLimits: record.secureTransportLimits && typeof record.secureTransportLimits === "object"
      ? record.secureTransportLimits as Record<string, unknown>
      : null,
    lastSecureErrorCode: normalizeOptionalString(record.lastSecureErrorCode),
    counters: {
      handshakeFailures: normalizeCount(counters.handshakeFailures),
      replacedConnections: normalizeCount(counters.replacedConnections),
      resumeGaps: normalizeCount(counters.resumeGaps),
      outboundBufferDrops: normalizeCount(counters.outboundBufferDrops),
      shutdownTimeouts: normalizeCount(counters.shutdownTimeouts),
    },
  };
}

function normalizeTransportCandidate(rawCandidate: unknown): TransportCandidateShape | null {
  const record = rawCandidate && typeof rawCandidate === "object"
    ? rawCandidate as Record<string, unknown>
    : null;
  const kind = normalizeOptionalString(record?.kind);
  const url = normalizeOptionalString(record?.url);
  if (!kind || !url) {
    return null;
  }
  return {
    kind,
    url,
    label: normalizeOptionalString(record?.label),
  };
}

function normalizePairingPayload(
  rawPayload: unknown,
  fallbackCandidates: TransportCandidateShape[]
): PairingPayloadShape | null {
  const record = rawPayload && typeof rawPayload === "object"
    ? rawPayload as Record<string, unknown>
    : null;
  const bridgeId = normalizeOptionalString(record?.bridgeId);
  const macDeviceId = normalizeOptionalString(record?.macDeviceId);
  const expiresAt = (
    typeof record?.expiresAt === "number"
    || typeof record?.expiresAt === "string"
  ) ? record.expiresAt : null;
  if (!bridgeId || !macDeviceId || expiresAt == null) {
    return null;
  }

  const transportCandidates = Array.isArray(record?.transportCandidates)
    ? record?.transportCandidates
      .map(normalizeTransportCandidate)
      .filter((value): value is TransportCandidateShape => value != null)
    : fallbackCandidates;

  return {
    ...record,
    bridgeId,
    macDeviceId,
    transportCandidates,
    expiresAt,
  };
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeCount(value: unknown): number {
  return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : 0;
}

function normalizeNullableCount(value: unknown): number | null {
  return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : null;
}
