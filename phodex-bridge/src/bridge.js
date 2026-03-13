// FILE: bridge.js
// Purpose: Runs Codex locally, serves a stable local bridge socket, and coordinates desktop refreshes for Codex.app.
// Layer: CLI service
// Exports: startBridge
// Depends on: ./qr, ./codex-desktop-refresher, ./codex-transport

const {
  CodexDesktopRefresher,
  readBridgeConfig,
} = require("./codex-desktop-refresher");
const { createCodexTransport } = require("./codex-transport");
const { printQR } = require("./qr");
const { rememberActiveThread } = require("./session-state");
const { handleGitRequest } = require("./git-handler");
const { handleWorkspaceRequest } = require("./workspace-handler");
const { createRuntimeManager } = require("./runtime-manager");
const { loadOrCreateBridgeDeviceState } = require("./secure-device-state");
const {
  buildTransportCandidates,
  startLocalBridgeServer,
} = require("./local-bridge-server");
const { createBridgeSecureTransport } = require("./secure-transport");

const PAIRING_QR_REPRINT_INTERVAL_MS = 4 * 60 * 1000;

function startBridge() {
  const config = readBridgeConfig();
  const deviceState = loadOrCreateBridgeDeviceState();
  const bridgeId = deviceState.bridgeId || deviceState.macDeviceId;
  const desktopRefresher = new CodexDesktopRefresher({
    enabled: config.refreshEnabled,
    debounceMs: config.refreshDebounceMs,
    refreshCommand: config.refreshCommand,
    bundleId: config.codexBundleId,
    appPath: config.codexAppPath,
  });

  let isShuttingDown = false;
  let codex = null;
  let codexRestartTimer = null;
  let codexRestartAttempt = 0;
  let pairingQRRefreshTimer = null;
  let secureTransport = null;
  const runtimeManager = createRuntimeManager({
    sendApplicationMessage(rawMessage) {
      sendApplicationResponse(rawMessage);
    },
    logPrefix: "[remodex]",
  });
  const localServer = startLocalBridgeServer({
    bridgeId,
    host: config.localHost,
    port: config.localPort,
    logPrefix: "[remodex]",
    onClientClose({ transportId }) {
      secureTransport?.handleTransportClosed(transportId);
    },
    onError(error) {
      console.error(`[remodex] Failed to start local bridge server on ${config.localHost}:${config.localPort}.`);
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
  console.log(`[remodex] Local bridge listening on ws://<this-mac>:${config.localPort}/bridge/${bridgeId}`);
  secureTransport = createBridgeSecureTransport({
    sessionId: bridgeId,
    deviceState,
    transportCandidates,
  });

  printFreshPairingQR();
  pairingQRRefreshTimer = setInterval(() => {
    if (isShuttingDown) {
      return;
    }
    printFreshPairingQR();
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

  // Routes decrypted app payloads through the same bridge handlers as before.
  function handleApplicationMessage(rawMessage) {
    if (handleWorkspaceRequest(rawMessage, sendApplicationResponse)) {
      return;
    }
    if (handleGitRequest(rawMessage, sendApplicationResponse)) {
      return;
    }
    maybeTrackPhoneThread(rawMessage);
    void runtimeManager.handleClientMessage(rawMessage).catch((error) => {
      console.error(`[remodex] ${error.message}`);
    });
  }

  // Encrypts bridge-generated responses before writing them to the paired transport.
  function sendApplicationResponse(rawMessage) {
    secureTransport.queueOutboundApplicationMessage(rawMessage);
  }

  function rememberThreadFromMessage(source, rawMessage) {
    const threadId = extractThreadId(rawMessage);
    if (!threadId || threadId.startsWith("claude:") || threadId.startsWith("gemini:")) {
      return;
    }

    rememberActiveThread(threadId, source);
  }

  function maybeTrackPhoneThread(rawMessage) {
    let parsed = null;
    try {
      parsed = JSON.parse(rawMessage);
    } catch {
      return;
    }

    const provider = readString(parsed?.params?.provider);
    if (provider && provider !== "codex") {
      return;
    }
    desktopRefresher.handleInbound(rawMessage);
    rememberThreadFromMessage("phone", rawMessage);
  }

  function launchCodexTransport() {
    const transport = createCodexTransport({
      endpoint: config.codexEndpoint,
      env: process.env,
      logPrefix: "[remodex]",
    });
    codex = transport;
    runtimeManager.attachCodexTransport(transport);

    transport.onError((error) => {
      if (codex !== transport) {
        return;
      }
      handleCodexTransportFailure(error);
    });

    transport.onMessage((message) => {
      if (codex !== transport) {
        return;
      }

      codexRestartAttempt = 0;
      desktopRefresher.handleOutbound(message);
      rememberThreadFromMessage("codex", message);
      runtimeManager.handleCodexTransportMessage(message);
    });

    transport.onClose(() => {
      if (codex !== transport) {
        return;
      }

      if (isShuttingDown) {
        desktopRefresher.handleTransportReset();
        localServer.stop();
        return;
      }

      handleCodexTransportFailure(
        new Error("Codex app-server transport closed unexpectedly.")
      );
    });
  }

  function handleCodexTransportFailure(error) {
    if (isShuttingDown) {
      return;
    }

    const message = error?.message || "Unknown Codex transport failure";
    console.error(`[remodex] ${message}`);
    desktopRefresher.handleTransportReset();
    localServer.disconnectAllClients();
    runtimeManager.handleCodexTransportClosed(message);
    printFreshPairingQR();

    if (codex) {
      const failedTransport = codex;
      codex = null;
      failedTransport.shutdown();
    }

    scheduleCodexRestart();
  }

  function scheduleCodexRestart() {
    if (codexRestartTimer || isShuttingDown) {
      return;
    }

    const delayMs = Math.min(4_000, 500 * (2 ** Math.min(codexRestartAttempt, 3)));
    codexRestartAttempt += 1;
    console.log(`[remodex] Restarting Codex transport in ${delayMs}ms...`);
    codexRestartTimer = setTimeout(() => {
      codexRestartTimer = null;
      launchCodexTransport();
    }, delayMs);
  }

  function printFreshPairingQR() {
    printQR(secureTransport.createPairingPayload());
  }

  function shutdownBridge(beforeExit = () => {}) {
    beforeExit();
    if (codexRestartTimer) {
      clearTimeout(codexRestartTimer);
      codexRestartTimer = null;
    }
    if (pairingQRRefreshTimer) {
      clearInterval(pairingQRRefreshTimer);
      pairingQRRefreshTimer = null;
    }
    codex?.shutdown();
    runtimeManager.shutdown();
    setTimeout(() => process.exit(0), 100);
  }
}

function extractThreadId(rawMessage) {
  let parsed = null;
  try {
    parsed = JSON.parse(rawMessage);
  } catch {
    return null;
  }

  const method = parsed?.method;
  const params = parsed?.params;

  if (method === "turn/start") {
    return readString(params?.threadId) || readString(params?.thread_id);
  }

  if (method === "thread/start" || method === "thread/started") {
    return (
      readString(params?.threadId)
      || readString(params?.thread_id)
      || readString(params?.thread?.id)
      || readString(params?.thread?.threadId)
      || readString(params?.thread?.thread_id)
    );
  }

  if (method === "turn/completed") {
    return (
      readString(params?.threadId)
      || readString(params?.thread_id)
      || readString(params?.turn?.threadId)
      || readString(params?.turn?.thread_id)
    );
  }

  return null;
}

function readString(value) {
  return typeof value === "string" && value ? value : null;
}

module.exports = { startBridge };
