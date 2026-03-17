// FILE: bridge.ts
// Purpose: Runs CodeRover locally, serves a stable local bridge socket, and coordinates desktop refreshes for CodeRover.app.

import {
  CodeRoverDesktopRefresher,
  readBridgeConfig,
} from "./coderover-desktop-refresher";
import { printQR } from "./qr";
import { rememberActiveSession } from "./session-state";
import { handleGitRequest } from "./git-handler";
import { handleContextWindowReadRequest } from "./coderover-context-window-handler";
import { handleWorkspaceRequest } from "./workspace-handler";
import { handleDesktopRequest } from "./desktop-handler";
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
      if (handleDesktopRequest(rawMessage, sendApplicationResponse, { env: process.env })) {
        return;
      }
      if (handleContextWindowReadRequest(rawMessage, sendApplicationResponse)) {
        return;
      }
    if (handleWorkspaceRequest(rawMessage, sendApplicationResponse)) {
      return;
    }
    if (handleGitRequest(rawMessage, sendApplicationResponse)) {
      return;
    }
    maybeTrackPhoneSession(rawMessage);
    void runtimeManager.handleClientMessage(rawMessage).catch((error: Error) => {
      console.error(`[coderover] ${error.message}`);
    });
  }

  function sendApplicationResponse(rawMessage: string): void {
    logBridgeFlow("bridge->phone", rawMessage);
    desktopRefresher.handleOutbound(rawMessage);
    debugLog(`[coderover] queue outbound application bytes=${Buffer.byteLength(rawMessage, "utf8")}`);
    secureTransport?.queueOutboundApplicationMessage(rawMessage);
  }

  function rememberSessionFromMessage(source: string, rawMessage: string): void {
    const sessionId = extractSessionId(rawMessage);
    if (!sessionId || sessionId.startsWith("claude:") || sessionId.startsWith("gemini:")) {
      return;
    }
    rememberActiveSession(sessionId, source);
  }

  function maybeTrackPhoneSession(rawMessage: string): void {
    const parsed = safeParseJSON(rawMessage);
    if (!parsed) {
      return;
    }

    const provider = readString(asRecord(parsed.params)?.provider);
    if (provider && provider !== "codex") {
      return;
    }
    desktopRefresher.handleInbound(rawMessage);
    rememberSessionFromMessage("phone", rawMessage);
  }

  function printFreshPairingQR(): void {
    if (secureTransport) {
      printQR(secureTransport.createPairingPayload());
    }
  }

  function shutdownBridge(beforeExit: () => void = () => {}): void {
    beforeExit();
    if (pairingQRRefreshTimer) {
      clearInterval(pairingQRRefreshTimer);
      pairingQRRefreshTimer = null;
    }
    runtimeManager.shutdown();
    setTimeout(() => process.exit(0), 100);
  }
}

function extractSessionIdFromMessage(rawMessage: string): string | null {
  return extractSessionId(rawMessage);
}

function extractSessionId(rawMessage: string): string | null {
  const parsed = safeParseJSON(rawMessage);
  if (!parsed) {
    return null;
  }
  return extractBridgeMessageSessionId(parsed);
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
  const sessionId = extractBridgeMessageSessionIdForLogs(parsed);
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
  if (sessionId) {
    parts.push(`session=${sessionId}`);
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

function extractBridgeMessageSessionIdForLogs(parsed: JsonRecord): string | null {
  const params = asRecord(parsed.params);
  const update = asRecord(params?.update);
  const meta = asRecord(update?._meta);
  return (
    extractBridgeMessageSessionId(parsed)
    || extractBridgeSessionIdFromResult(parsed)
    || extractCoderoverSessionId(asRecord(meta?.coderover))
  );
}

function extractBridgeMessageSessionId(parsed: JsonRecord): string | null {
  const params = asRecord(parsed.params);
  const update = asRecord(params?.update);
  const result = asRecord(parsed.result);
  return (
    readString(params?.sessionId)
    || readString(params?.session_id)
    || readString(result?.sessionId)
    || readString(result?.session_id)
    || extractCoderoverSessionId(asRecord(asRecord(update?._meta)?.coderover))
  );
}

function extractBridgeSessionIdFromResult(parsed: JsonRecord): string | null {
  const result = asRecord(parsed.result);
  if (!result) {
    return null;
  }
  return readString(result.sessionId) || readString(result.session_id);
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

function extractCoderoverSessionId(coderoverMeta: JsonRecord | null): string | null {
  return readString(coderoverMeta?.sessionId) || readString(coderoverMeta?.threadId);
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
