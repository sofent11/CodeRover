// FILE: bridge.ts
// Purpose: Runs CodeRover locally, serves a stable local bridge socket, and coordinates desktop refreshes for CodeRover.app.

import {
  CodeRoverDesktopRefresher,
  readBridgeConfig,
} from "./coderover-desktop-refresher";
import { BridgeKeepAwakeController } from "./bridge-keep-awake";
import { createBridgeStatusHandler } from "./bridge-status-handler";
import { logBridgeEvent, normalizeBridgeError } from "./bridge-logger";
import { routeBridgeApplicationMessage, type BridgeMessageDispatcher } from "./bridge-message-router";
import { runBridgeShutdownTasks } from "./bridge-shutdown";
import { createCodexTransport } from "./codex-transport";
import { printQR } from "./qr";
import { rememberActiveThread } from "./session-state";
import { handleGitRequest } from "./git-handler";
import { handleThreadContextRequest } from "./thread-context-handler";
import { handleWorkspaceRequest } from "./workspace-handler";
import { handleDesktopRequest } from "./desktop-handler";
import { loadOrCreateBridgeDeviceState } from "./secure-device-state";
import { debugLog } from "./debug-log";
import { createRuntimeManager } from "./runtime-manager";
import { updateBridgePreferences } from "./bridge-preferences";
import {
  buildTransportCandidates,
  startLocalBridgeServer,
} from "./local-bridge-server";
import { createBridgeSecureTransport } from "./secure-transport";
import {
  writeBridgeRuntimeState,
  type BridgeObservabilityState,
  type BridgeRuntimeState,
} from "./bridge-daemon-state";
import type { PairingPayloadShape } from "./qr";

type JsonRecord = Record<string, unknown>;

interface BridgeConfigShape {
  refreshEnabled: boolean;
  refreshDebounceMs: number;
  refreshCommand: string;
  coderoverBundleId: string;
  coderoverAppPath: string;
  keepAwakeEnabled: boolean;
  localHost: string;
  localPort: number;
  tailnetUrl: string;
  relayUrls: string[];
  coderoverEndpoint: string;
}

export interface StartBridgeOptions {
  mode?: "foreground" | "daemon";
  printQr?: boolean;
  logFile?: string | null;
  errorLogFile?: string | null;
}

export function startBridge({
  mode = "foreground",
  printQr = true,
  logFile = null,
  errorLogFile = null,
}: StartBridgeOptions = {}): void {
  const config = readBridgeConfig() as BridgeConfigShape;
  const deviceState = loadOrCreateBridgeDeviceState();
  const bridgeId = deviceState.bridgeId || deviceState.macDeviceId;
  const transportCandidates = buildTransportCandidates({
    bridgeId,
    localPort: config.localPort,
    tailnetUrl: config.tailnetUrl,
    relayUrls: config.relayUrls,
  });
  const desktopRefresher = new CodeRoverDesktopRefresher({
    enabled: config.refreshEnabled,
    debounceMs: config.refreshDebounceMs,
    refreshCommand: config.refreshCommand,
    bundleId: config.coderoverBundleId,
    appPath: config.coderoverAppPath,
  });
  const keepAwakeController = new BridgeKeepAwakeController({
    enabled: config.keepAwakeEnabled,
  });
  const handleBridgeStatusRequest = createBridgeStatusHandler({
    getTrustedDeviceCount: () => Object.keys(loadOrCreateBridgeDeviceState().trustedPhones || {}).length,
    getKeepAwakeActive: () => keepAwakeController.isActive,
    getTransportCandidates: () => currentPairingPayload?.transportCandidates || transportCandidates,
    getObservability: () => buildObservabilityState(),
    updatePreferences: (updates) => {
      const nextPreferences = updateBridgePreferences(updates);
      keepAwakeController.setEnabled(nextPreferences.keepAwakeEnabled);
      return nextPreferences;
    },
  });

  let isShuttingDown = false;
  const startedAt = new Date().toISOString();
  let codexTransport: ReturnType<typeof createCodexTransport> | null = null;
  let codexRestartTimer: NodeJS.Timeout | null = null;
  let codexRestartAttempt = 0;
  let secureTransport: ReturnType<typeof createBridgeSecureTransport> | null = null;
  let currentPairingPayload: PairingPayloadShape | null = null;
  let lastError: string | null = null;
  let shutdownTimeoutCount = 0;
  let shutdownPromise: Promise<void> | null = null;
  const connectedTransportIds = new Set<string>();
  const localDispatchers: BridgeMessageDispatcher[] = [
    {
      name: "desktop",
      handle(rawMessage, sendResponse) {
        return handleDesktopRequest(rawMessage, sendResponse, { env: process.env });
      },
    },
    {
      name: "bridge_status",
      handle: handleBridgeStatusRequest,
    },
    {
      name: "thread_context",
      handle: handleThreadContextRequest,
    },
    {
      name: "workspace",
      handle: handleWorkspaceRequest,
    },
    {
      name: "git",
      handle: handleGitRequest,
    },
  ];
  const runtimeManager = createRuntimeManager({
    sendApplicationMessage(rawMessage) {
      sendApplicationResponse(rawMessage);
    },
    logPrefix: "[coderover]",
  });
  const localServer = startLocalBridgeServer({
    bridgeId,
    host: config.localHost,
    port: config.localPort,
    logPrefix: "[coderover]",
    onClientOpen({ transportId }) {
      connectedTransportIds.add(transportId);
      updateRuntimeState();
    },
    onClientClose({ transportId }) {
      connectedTransportIds.delete(transportId);
      secureTransport?.handleTransportClosed(transportId);
      updateRuntimeState();
    },
    onError(error) {
      logBridgeEvent("error", "local_server_start_failed", {
        host: config.localHost,
        port: config.localPort,
        error: error.message,
      });
      lastError = error.message;
      updateRuntimeState();
      process.exit(1);
    },
    onMessage(message, transport) {
      if (!secureTransport) {
        return;
      }
      secureTransport.handleIncomingWireMessage(message, {
        ...transport,
        onApplicationMessage(plaintextMessage) {
          handleApplicationMessage(plaintextMessage);
        },
      });
    },
  });
  console.log(
    `[coderover] Local bridge listening on ws://<this-mac>:${config.localPort}/bridge/${bridgeId}`
  );
  secureTransport = createBridgeSecureTransport({
    sessionId: bridgeId,
    deviceState,
    transportCandidates,
    onDiagnosticsChanged() {
      updateRuntimeState();
    },
    onEvent(event) {
      const logLevel = event.kind === "buffer_trim"
        ? "debug"
        : (event.kind === "secure_error" || event.kind === "resume_gap" ? "warn" : "info");
      logBridgeEvent(
        logLevel,
        event.kind,
        {
          code: event.code || null,
          transportId: event.transportId || null,
          phoneDeviceId: event.phoneDeviceId || null,
          droppedMessages: event.droppedMessages ?? null,
          droppedBytes: event.droppedBytes ?? null,
          minRetainedBridgeOutboundSeq: event.minRetainedBridgeOutboundSeq ?? null,
        }
      );
    },
  });
  updateRuntimeState();
  refreshPairingPayload({ logToConsole: printQr });
  launchCodexTransport();

  process.on("SIGINT", () => {
    void shutdownBridge();
  });
  process.on("SIGTERM", () => {
    void shutdownBridge();
  });
  process.on("SIGUSR1", () => {
    if (!isShuttingDown) {
      refreshPairingPayload({ logToConsole: false });
    }
  });

  function handleApplicationMessage(rawMessage: string): void {
    logBridgeFlow("phone->bridge", rawMessage);
    void routeBridgeApplicationMessage(rawMessage, {
      dispatchers: localDispatchers,
      runtimeClient: runtimeManager,
      sendResponse: sendApplicationResponse,
      onBeforeRuntime: maybeTrackPhoneThread,
      onError(error) {
        lastError = error.message;
        logBridgeEvent("error", "runtime_message_failed", error);
        updateRuntimeState();
      },
    });
  }

  function sendApplicationResponse(rawMessage: string): void {
    logBridgeFlow("bridge->phone", rawMessage);
    debugLog(`[coderover] queue outbound application bytes=${Buffer.byteLength(rawMessage, "utf8")}`);
    secureTransport?.queueOutboundApplicationMessage(rawMessage);
    updateRuntimeState();
  }

  function rememberThreadFromMessage(source: string, rawMessage: string): void {
    const threadId = extractThreadId(rawMessage);
    if (!threadId || threadId.startsWith("claude:") || threadId.startsWith("gemini:")) {
      return;
    }
    rememberActiveThread(threadId, source);
  }

  function maybeTrackPhoneThread(rawMessage: string): void {
    const parsed = safeParseJSON(rawMessage);
    if (!parsed) {
      return;
    }

    const provider = readString(asRecord(parsed.params)?.provider);
    if (provider && provider !== "codex") {
      return;
    }
    desktopRefresher.handleInbound(rawMessage);
    rememberThreadFromMessage("phone", rawMessage);
  }

  function launchCodexTransport(): void {
    const transport = createCodexTransport({
      endpoint: config.coderoverEndpoint,
      env: process.env,
    });
    codexTransport = transport;
    runtimeManager.attachCodexTransport(transport);

    transport.onError((error) => {
      if (codexTransport === transport) {
        handleCodexTransportFailure(error);
      }
    });

    transport.onMessage((message) => {
      if (codexTransport !== transport) {
        return;
      }

      logBridgeFlow("codex->bridge", message);
      codexRestartAttempt = 0;
      lastError = null;
      desktopRefresher.handleOutbound(message);
      rememberThreadFromMessage("codex", message);
      runtimeManager.handleCodexTransportMessage(message);
      updateRuntimeState();
    });

    transport.onClose(() => {
      if (codexTransport !== transport) {
        return;
      }

      if (isShuttingDown) {
        desktopRefresher.handleTransportReset();
        void localServer.stop();
        return;
      }

      handleCodexTransportFailure(new Error("Codex app-server transport closed unexpectedly."));
    });
  }

  function handleCodexTransportFailure(error: Error): void {
    if (isShuttingDown) {
      return;
    }

    const normalizedError = normalizeBridgeError(error);
    lastError = normalizedError.message;
    logBridgeEvent("error", "codex_transport_failed", normalizedError);
    desktopRefresher.handleTransportReset();
    localServer.disconnectAllClients();
    runtimeManager.handleCodexTransportClosed(error.message);
    refreshPairingPayload({ logToConsole: printQr });
    updateRuntimeState();

    if (codexTransport) {
      const failedTransport = codexTransport;
      codexTransport = null;
      void failedTransport.shutdown();
    }

    scheduleCodexRestart();
  }

  function scheduleCodexRestart(): void {
    if (codexRestartTimer || isShuttingDown) {
      return;
    }

    const delayMs = Math.min(4_000, 500 * (2 ** Math.min(codexRestartAttempt, 3)));
    codexRestartAttempt += 1;
    logBridgeEvent("info", "codex_transport_restart_scheduled", { delayMs, attempt: codexRestartAttempt });
    codexRestartTimer = setTimeout(() => {
      codexRestartTimer = null;
      launchCodexTransport();
    }, delayMs);
  }

  function refreshPairingPayload({ logToConsole }: { logToConsole: boolean }): void {
    if (!secureTransport) {
      return;
    }
    currentPairingPayload = secureTransport.createPairingPayload();
    if (logToConsole) {
      printQR(currentPairingPayload);
    }
    updateRuntimeState();
  }

  function updateRuntimeState(overrides: Partial<BridgeRuntimeState> = {}): void {
    writeBridgeRuntimeState({
      version: 1,
      status: overrides.status || (isShuttingDown ? "stopped" : "running"),
      pid: overrides.pid === undefined ? (isShuttingDown ? null : process.pid) : overrides.pid,
      mode,
      startedAt,
      updatedAt: new Date().toISOString(),
      bridgeId,
      macDeviceId: deviceState.macDeviceId,
      localUrl: `ws://127.0.0.1:${config.localPort}/bridge/${bridgeId}`,
      routePath: localServer.routePath,
      transportCandidates,
      pairingPayload: currentPairingPayload,
      connectedClients: connectedTransportIds.size,
      secureChannelReady: secureTransport?.isSecureChannelReady() || false,
      logFile,
      errorLogFile,
      lastError,
      observability: buildObservabilityState(),
      ...overrides,
    });
  }

  async function shutdownBridge(): Promise<void> {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    isShuttingDown = true;
    keepAwakeController.shutdown();
    shutdownPromise = (async () => {
      if (codexRestartTimer) {
        clearTimeout(codexRestartTimer);
        codexRestartTimer = null;
      }
      updateRuntimeState({
        status: "stopped",
        pid: null,
        connectedClients: 0,
        secureChannelReady: false,
      });
      const activeTransport = codexTransport;
      codexTransport = null;
      const shutdownResult = await runBridgeShutdownTasks([
        {
          label: "local_server",
          run() {
            return localServer.stop();
          },
        },
        {
          label: "codex_transport",
          run() {
            return activeTransport?.shutdown();
          },
        },
        {
          label: "runtime_manager",
          run() {
            return runtimeManager.shutdown();
          },
        },
      ], {
        timeoutMs: 2_000,
        onTimeout(pendingLabels) {
          shutdownTimeoutCount += 1;
          lastError = `Bridge shutdown timed out while waiting for: ${pendingLabels.join(", ") || "unknown"}`;
          logBridgeEvent("warn", "bridge_shutdown_timeout", { pendingLabels });
          updateRuntimeState({
            status: "stopped",
            pid: null,
            connectedClients: 0,
            secureChannelReady: false,
          });
        },
      });
      if (!shutdownResult.timedOut) {
        logBridgeEvent("info", "bridge_shutdown_complete", {
          completedLabels: shutdownResult.completedLabels,
        });
      }
      updateRuntimeState({
        status: "stopped",
        pid: null,
        connectedClients: 0,
        secureChannelReady: false,
      });
      process.exit(0);
    })();
    return shutdownPromise;
  }

  function buildObservabilityState(): BridgeObservabilityState {
    const secureDiagnostics = secureTransport?.getDiagnostics();
    return {
      outboundBufferMessages: secureDiagnostics?.outboundBufferMessages || 0,
      outboundBufferBytes: secureDiagnostics?.outboundBufferBytes || 0,
      outboundBufferMinSeq: secureDiagnostics?.outboundBufferMinSeq || null,
      outboundBufferMaxSeq: secureDiagnostics?.outboundBufferMaxSeq || null,
      lastSecureErrorCode: secureDiagnostics?.lastSecureErrorCode || null,
      counters: {
        handshakeFailures: secureDiagnostics?.handshakeFailureCount || 0,
        replacedConnections: secureDiagnostics?.replacedConnectionCount || 0,
        resumeGaps: secureDiagnostics?.resumeGapCount || 0,
        outboundBufferDrops: secureDiagnostics?.outboundBufferDropCount || 0,
        shutdownTimeouts: shutdownTimeoutCount,
      },
    };
  }
}

function extractThreadId(rawMessage: string): string | null {
  const parsed = safeParseJSON(rawMessage);
  if (!parsed) {
    return null;
  }

  const method = readString(parsed.method);
  const params = asRecord(parsed.params);

  if (method === "turn/start") {
    return readString(params?.threadId) || readString(params?.thread_id);
  }

  if (method === "thread/start" || method === "thread/started") {
    const thread = asRecord(params?.thread);
    return (
      readString(params?.threadId)
      || readString(params?.thread_id)
      || readString(thread?.id)
      || readString(thread?.threadId)
      || readString(thread?.thread_id)
    );
  }

  if (method === "turn/completed") {
    const turn = asRecord(params?.turn);
    return (
      readString(params?.threadId)
      || readString(params?.thread_id)
      || readString(turn?.threadId)
      || readString(turn?.thread_id)
    );
  }

  return null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function logBridgeFlow(stage: string, rawMessage: string): void {
  const summary = summarizeBridgeMessage(rawMessage);
  if (summary) {
    debugLog(`[coderover] [bridge-flow] stage=${stage} ${summary}`);
  }
}

function summarizeBridgeMessage(rawMessage: string): string {
  const parsed = safeParseJSON(rawMessage);
  if (!parsed) {
    return `non-json bytes=${rawMessage.length}`;
  }

  const method = readString(parsed.method);
  const id = readString(parsed.id) || (typeof parsed.id === "number" ? String(parsed.id) : null);
  const params = asRecord(parsed.params);
  const threadId = extractBridgeMessageThreadId(parsed);
  const turnId = extractBridgeMessageTurnId(params);
  const itemId = extractBridgeMessageItemId(params);
  const parts: string[] = [];

  if (method) {
    parts.push(`method=${method}`);
  } else if (id) {
    parts.push(`response=${id}`);
  } else {
    parts.push("message=unknown");
  }
  if (threadId) {
    parts.push(`thread=${threadId}`);
  }
  if (turnId) {
    parts.push(`turn=${turnId}`);
  }
  if (itemId) {
    parts.push(`item=${itemId}`);
  }

  const error = asRecord(parsed.error);
  if (error?.message) {
    parts.push(`error=${JSON.stringify(error.message)}`);
  }
  return parts.join(" ");
}

function extractBridgeMessageThreadId(parsed: JsonRecord): string | null {
  const params = asRecord(parsed.params);
  const thread = asRecord(params?.thread);
  const turn = asRecord(params?.turn);
  const item = asRecord(params?.item);
  return (
    extractThreadId(JSON.stringify(parsed))
    || readString(params?.threadId)
    || readString(params?.thread_id)
    || readString(thread?.id)
    || readString(turn?.threadId)
    || readString(turn?.thread_id)
    || readString(item?.threadId)
    || readString(item?.thread_id)
  );
}

function extractBridgeMessageTurnId(params: JsonRecord | null): string | null {
  const turn = asRecord(params?.turn);
  const item = asRecord(params?.item);
  return (
    readString(params?.turnId)
    || readString(params?.turn_id)
    || readString(turn?.id)
    || readString(item?.turnId)
    || readString(item?.turn_id)
  );
}

function extractBridgeMessageItemId(params: JsonRecord | null): string | null {
  const item = asRecord(params?.item);
  return (
    readString(params?.itemId)
    || readString(params?.item_id)
    || readString(item?.id)
    || readString(params?.messageId)
    || readString(params?.message_id)
  );
}

function safeParseJSON(value: string): JsonRecord | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonRecord)
      : null;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}
