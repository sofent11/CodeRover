// FILE: bridge.ts
// Purpose: Runs CodeRover locally, serves a stable local bridge socket, and coordinates desktop refreshes for CodeRover.app.

import {
  CodeRoverDesktopRefresher,
  readBridgeConfig,
} from "./coderover-desktop-refresher";
import { createCodexTransport } from "./codex-transport";
import { printQR } from "./qr";
import { rememberActiveThread } from "./session-state";
import { handleGitRequest } from "./git-handler";
import { handleThreadContextRequest } from "./thread-context-handler";
import { handleWorkspaceRequest } from "./workspace-handler";
import { loadOrCreateBridgeDeviceState } from "./secure-device-state";
import { debugLog } from "./debug-log";
import { createRuntimeManager } from "./runtime-manager";
import {
  buildTransportCandidates,
  startLocalBridgeServer,
} from "./local-bridge-server";
import { createBridgeSecureTransport } from "./secure-transport";

const PAIRING_QR_REPRINT_INTERVAL_MS = 4 * 60 * 1000;

type JsonRecord = Record<string, unknown>;

interface BridgeConfigShape {
  refreshEnabled: boolean;
  refreshDebounceMs: number;
  refreshCommand: string;
  coderoverBundleId: string;
  coderoverAppPath: string;
  localHost: string;
  localPort: number;
  tailnetUrl: string;
  relayUrls: string[];
  coderoverEndpoint: string;
}

export function startBridge(): void {
  const config = readBridgeConfig() as BridgeConfigShape;
  const deviceState = loadOrCreateBridgeDeviceState();
  const bridgeId = deviceState.bridgeId || deviceState.macDeviceId;
  const desktopRefresher = new CodeRoverDesktopRefresher({
    enabled: config.refreshEnabled,
    debounceMs: config.refreshDebounceMs,
    refreshCommand: config.refreshCommand,
    bundleId: config.coderoverBundleId,
    appPath: config.coderoverAppPath,
  });

  let isShuttingDown = false;
  let codexTransport: ReturnType<typeof createCodexTransport> | null = null;
  let codexRestartTimer: NodeJS.Timeout | null = null;
  let codexRestartAttempt = 0;
  let pairingQRRefreshTimer: NodeJS.Timeout | null = null;
  let secureTransport: ReturnType<typeof createBridgeSecureTransport> | null = null;
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
    onClientClose({ transportId }) {
      secureTransport?.handleTransportClosed(transportId);
    },
    onError(error) {
      console.error(
        `[coderover] Failed to start local bridge server on ${config.localHost}:${config.localPort}.`
      );
      console.error(error.message);
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
  const transportCandidates = buildTransportCandidates({
    bridgeId,
    localPort: config.localPort,
    tailnetUrl: config.tailnetUrl,
    relayUrls: config.relayUrls,
  });
  console.log(
    `[coderover] Local bridge listening on ws://<this-mac>:${config.localPort}/bridge/${bridgeId}`
  );
  secureTransport = createBridgeSecureTransport({
    sessionId: bridgeId,
    deviceState,
    transportCandidates,
  });

  printFreshPairingQR();
  pairingQRRefreshTimer = setInterval(() => {
    if (!isShuttingDown) {
      printFreshPairingQR();
    }
  }, PAIRING_QR_REPRINT_INTERVAL_MS);
  launchCodexTransport();

  process.on("SIGINT", () => shutdownBridge(() => {
    isShuttingDown = true;
    localServer.stop();
  }));
  process.on("SIGTERM", () => shutdownBridge(() => {
    isShuttingDown = true;
    localServer.stop();
  }));

  function handleApplicationMessage(rawMessage: string): void {
    logBridgeFlow("phone->bridge", rawMessage);
    if (handleThreadContextRequest(rawMessage, sendApplicationResponse)) {
      return;
    }
    if (handleWorkspaceRequest(rawMessage, sendApplicationResponse)) {
      return;
    }
    if (handleGitRequest(rawMessage, sendApplicationResponse)) {
      return;
    }
    maybeTrackPhoneThread(rawMessage);
    void runtimeManager.handleClientMessage(rawMessage).catch((error: Error) => {
      console.error(`[coderover] ${error.message}`);
    });
  }

  function sendApplicationResponse(rawMessage: string): void {
    logBridgeFlow("bridge->phone", rawMessage);
    secureTransport?.queueOutboundApplicationMessage(rawMessage);
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
      desktopRefresher.handleOutbound(message);
      rememberThreadFromMessage("codex", message);
      runtimeManager.handleCodexTransportMessage(message);
    });

    transport.onClose(() => {
      if (codexTransport !== transport) {
        return;
      }

      if (isShuttingDown) {
        desktopRefresher.handleTransportReset();
        localServer.stop();
        return;
      }

      handleCodexTransportFailure(new Error("Codex app-server transport closed unexpectedly."));
    });
  }

  function handleCodexTransportFailure(error: Error): void {
    if (isShuttingDown) {
      return;
    }

    console.error(`[coderover] ${error.message || "Unknown Codex transport failure"}`);
    desktopRefresher.handleTransportReset();
    localServer.disconnectAllClients();
    runtimeManager.handleCodexTransportClosed(error.message);
    printFreshPairingQR();

    if (codexTransport) {
      const failedTransport = codexTransport;
      codexTransport = null;
      failedTransport.shutdown();
    }

    scheduleCodexRestart();
  }

  function scheduleCodexRestart(): void {
    if (codexRestartTimer || isShuttingDown) {
      return;
    }

    const delayMs = Math.min(4_000, 500 * (2 ** Math.min(codexRestartAttempt, 3)));
    codexRestartAttempt += 1;
    console.log(`[coderover] Restarting Codex transport in ${delayMs}ms...`);
    codexRestartTimer = setTimeout(() => {
      codexRestartTimer = null;
      launchCodexTransport();
    }, delayMs);
  }

  function printFreshPairingQR(): void {
    if (secureTransport) {
      printQR(secureTransport.createPairingPayload());
    }
  }

  function shutdownBridge(beforeExit: () => void = () => {}): void {
    beforeExit();
    if (codexRestartTimer) {
      clearTimeout(codexRestartTimer);
      codexRestartTimer = null;
    }
    if (pairingQRRefreshTimer) {
      clearInterval(pairingQRRefreshTimer);
      pairingQRRefreshTimer = null;
    }
    codexTransport?.shutdown();
    runtimeManager.shutdown();
    setTimeout(() => process.exit(0), 100);
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
