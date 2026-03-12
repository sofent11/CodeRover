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
  let codexHandshakeState = config.codexEndpoint ? "warm" : "cold";
  const forwardedInitializeRequestIds = new Set();
  let codex = null;
  let codexRestartTimer = null;
  let codexRestartAttempt = 0;
  let pairingQRRefreshTimer = null;
  let secureTransport = null;
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
    if (!codex) {
      localServer.disconnectAllClients();
      return;
    }

    if (handleBridgeManagedHandshakeMessage(rawMessage)) {
      return;
    }
    if (handleWorkspaceRequest(rawMessage, sendApplicationResponse)) {
      return;
    }
    if (handleGitRequest(rawMessage, sendApplicationResponse)) {
      return;
    }
    desktopRefresher.handleInbound(rawMessage);
    rememberThreadFromMessage("phone", rawMessage);
    codex.send(rawMessage);
  }

  // Encrypts bridge-generated responses before writing them to the paired transport.
  function sendApplicationResponse(rawMessage) {
    secureTransport.queueOutboundApplicationMessage(rawMessage);
  }

  function rememberThreadFromMessage(source, rawMessage) {
    const threadId = extractThreadId(rawMessage);
    if (!threadId) {
      return;
    }

    rememberActiveThread(threadId, source);
  }

  // The spawned/shared Codex app-server stays warm across phone reconnects.
  // When iPhone reconnects it sends initialize again, but forwarding that to the
  // already-initialized Codex transport only produces "Already initialized".
  function handleBridgeManagedHandshakeMessage(rawMessage) {
    let parsed = null;
    try {
      parsed = JSON.parse(rawMessage);
    } catch {
      return false;
    }

    const method = typeof parsed?.method === "string" ? parsed.method.trim() : "";
    if (!method) {
      return false;
    }

    if (method === "initialize" && parsed.id != null) {
      if (codexHandshakeState !== "warm") {
        forwardedInitializeRequestIds.add(String(parsed.id));
        return false;
      }

      sendApplicationResponse(JSON.stringify({
        id: parsed.id,
        result: {
          bridgeManaged: true,
        },
      }));
      return true;
    }

    if (method === "initialized") {
      return codexHandshakeState === "warm";
    }

    return false;
  }

  // Learns whether the underlying Codex transport has already completed its own MCP handshake.
  function trackCodexHandshakeState(rawMessage) {
    let parsed = null;
    try {
      parsed = JSON.parse(rawMessage);
    } catch {
      return;
    }

    const responseId = parsed?.id;
    if (responseId == null) {
      return;
    }

    const responseKey = String(responseId);
    if (!forwardedInitializeRequestIds.has(responseKey)) {
      return;
    }

    forwardedInitializeRequestIds.delete(responseKey);

    if (parsed?.result != null) {
      codexHandshakeState = "warm";
      return;
    }

    const errorMessage = typeof parsed?.error?.message === "string"
      ? parsed.error.message.toLowerCase()
      : "";
    if (errorMessage.includes("already initialized")) {
      codexHandshakeState = "warm";
    }
  }

  function launchCodexTransport() {
    resetCodexHandshakeState();

    const transport = createCodexTransport({
      endpoint: config.codexEndpoint,
      env: process.env,
      logPrefix: "[remodex]",
    });
    codex = transport;

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
      trackCodexHandshakeState(message);
      desktopRefresher.handleOutbound(message);
      rememberThreadFromMessage("codex", message);
      secureTransport.queueOutboundApplicationMessage(message);
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
    resetCodexHandshakeState();
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

  function resetCodexHandshakeState() {
    codexHandshakeState = config.codexEndpoint ? "warm" : "cold";
    forwardedInitializeRequestIds.clear();
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
