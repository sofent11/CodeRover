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
  let secureTransport = null;
  const localServer = startLocalBridgeServer({
    bridgeId,
    host: config.localHost,
    port: config.localPort,
    logPrefix: "[remodex]",
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

  const codex = createCodexTransport({
    endpoint: config.codexEndpoint,
    env: process.env,
    logPrefix: "[remodex]",
  });

  codex.onError((error) => {
    if (config.codexEndpoint) {
      console.error(`[remodex] Failed to connect to Codex endpoint: ${config.codexEndpoint}`);
    } else {
      console.error("[remodex] Failed to start `codex app-server`.");
      console.error(`[remodex] Launch command: ${codex.describe()}`);
      console.error("[remodex] Make sure the Codex CLI is installed and that the launcher works on this OS.");
    }
    console.error(error.message);
    process.exit(1);
  });

  printQR(secureTransport.createPairingPayload());

  codex.onMessage((message) => {
    trackCodexHandshakeState(message);
    desktopRefresher.handleOutbound(message);
    rememberThreadFromMessage("codex", message);
    secureTransport.queueOutboundApplicationMessage(message);
  });

  codex.onClose(() => {
    isShuttingDown = true;
    desktopRefresher.handleTransportReset();
    localServer.stop();
  });

  process.on("SIGINT", () => shutdown(codex, () => {
    isShuttingDown = true;
    localServer.stop();
  }));
  process.on("SIGTERM", () => shutdown(codex, () => {
    isShuttingDown = true;
    localServer.stop();
  }));

  // Routes decrypted app payloads through the same bridge handlers as before.
  function handleApplicationMessage(rawMessage) {
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
}

function shutdown(codex, beforeExit = () => {}) {
  beforeExit();

  codex.shutdown();

  setTimeout(() => process.exit(0), 100);
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
