// FILE: local-bridge-server.js
// Purpose: Hosts the stable local WebSocket endpoint that iPhone clients can reconnect to directly.
// Layer: CLI helper
// Exports: startLocalBridgeServer, buildTransportCandidates
// Depends on: http, os, ws

const http = require("http");
const os = require("os");
const { WebSocketServer, WebSocket } = require("ws");

const CLOSE_CODE_INVALID_ROUTE = 4000;
const CLOSE_CODE_IPHONE_REPLACED = 4003;
const CLOSE_CODE_UPSTREAM_RESTARTING = 4004;
const HEARTBEAT_INTERVAL_MS = 30_000;

function startLocalBridgeServer({
  bridgeId,
  host = "0.0.0.0",
  port = 8765,
  logPrefix = "[remodex]",
  canAcceptConnection = () => true,
  onMessage,
  onError,
} = {}) {
  const routePath = `/bridge/${bridgeId}`;
  const server = http.createServer((req, res) => {
    if (req.url === routePath) {
      res.writeHead(426, { "content-type": "text/plain; charset=utf-8" });
      res.end("Upgrade Required");
      return;
    }

    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "not_found" }));
  });
  const wss = new WebSocketServer({ noServer: true });
  let currentClient = null;
  const heartbeat = setInterval(() => {
    if (!currentClient) {
      return;
    }

    if (currentClient._bridgeAlive === false) {
      try {
        currentClient.terminate();
      } catch {
        // Best-effort cleanup only.
      }
      return;
    }

    currentClient._bridgeAlive = false;
    try {
      currentClient.ping();
    } catch {
      // Best-effort only.
    }
  }, HEARTBEAT_INTERVAL_MS);

  server.on("upgrade", (req, socket, head) => {
    if (req.url !== routePath) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    if (!canAcceptConnection()) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws) => {
    if (currentClient && currentClient !== ws) {
      if (
        currentClient.readyState === WebSocket.OPEN
        || currentClient.readyState === WebSocket.CONNECTING
      ) {
        currentClient.close(
          CLOSE_CODE_IPHONE_REPLACED,
          "Replaced by newer iPhone connection"
        );
      }
    }
    currentClient = ws;
    ws._bridgeAlive = true;
    console.log(`${logPrefix} local client connected (${routePath})`);

    ws.on("pong", () => {
      ws._bridgeAlive = true;
    });

    ws.on("message", (data) => {
      const message = typeof data === "string" ? data : data.toString("utf8");
      onMessage?.(message, {
        sendControlMessage(controlMessage) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(controlMessage));
          }
        },
        sendWireMessage(wireMessage) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(wireMessage);
          }
        },
      });
    });

    ws.on("close", () => {
      if (currentClient === ws) {
        currentClient = null;
      }
      console.log(`${logPrefix} local client disconnected`);
    });

    ws.on("error", (error) => {
      console.error(`${logPrefix} local WebSocket error:`, error.message);
    });
  });

  server.on("error", (error) => {
    onError?.(error);
  });
  server.listen(port, host);

  return {
    bridgeId,
    host,
    port,
    routePath,
    resolvedPort() {
      return server.address()?.port || port;
    },
    disconnectCurrentClient(
      code = CLOSE_CODE_UPSTREAM_RESTARTING,
      reason = "Bridge upstream restarting"
    ) {
      if (!currentClient) {
        return;
      }

      const clientToClose = currentClient;
      currentClient = null;
      try {
        clientToClose.close(code, reason);
      } catch {
        // Best-effort cleanup only.
      }
    },
    stop() {
      if (currentClient) {
        try {
          currentClient.close(CLOSE_CODE_INVALID_ROUTE, "Bridge shutting down");
        } catch {
          // Best-effort shutdown only.
        }
      }
      for (const client of wss.clients) {
        try {
          client.terminate();
        } catch {
          // Best-effort shutdown only.
        }
      }
      clearInterval(heartbeat);
      wss.close();
      server.close();
    },
  };
}

function buildTransportCandidates({
  bridgeId,
  localPort,
  tailnetUrl = "",
} = {}) {
  const routePath = `/bridge/${bridgeId}`;
  const candidates = [];
  const seen = new Set();

  function addCandidate(kind, url, label) {
    const normalizedUrl = normalizeNonEmptyString(url);
    if (!normalizedUrl || seen.has(normalizedUrl)) {
      return;
    }
    seen.add(normalizedUrl);
    candidates.push({
      kind,
      url: normalizedUrl,
      label: normalizeNonEmptyString(label) || null,
    });
  }

  for (const address of listReachableLocalIPv4Addresses()) {
    addCandidate("local_ipv4", `ws://${address}:${localPort}${routePath}`, address);
  }

  const normalizedTailnetUrl = normalizeNonEmptyString(tailnetUrl);
  if (normalizedTailnetUrl) {
    addCandidate("tailnet", buildCandidateUrl(normalizedTailnetUrl, routePath), "Tailnet");
  }

  return candidates;
}

function listReachableLocalIPv4Addresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const [interfaceName, networkDetails] of Object.entries(interfaces)) {
    if (!Array.isArray(networkDetails)) {
      continue;
    }

    for (const detail of networkDetails) {
      if (!detail || detail.internal || detail.family !== "IPv4") {
        continue;
      }
      if (!isReachableLocalIPv4(detail.address, interfaceName)) {
        continue;
      }
      addresses.push(detail.address);
    }
  }

  return addresses;
}

function isReachableLocalIPv4(address, interfaceName) {
  if (!isPrivateIPv4(address)) {
    return false;
  }

  if (address.startsWith("169.254.")) {
    return false;
  }

  const normalizedInterfaceName = normalizeNonEmptyString(interfaceName).toLowerCase();
  if (!normalizedInterfaceName) {
    return true;
  }

  if (
    normalizedInterfaceName.startsWith("utun")
    || normalizedInterfaceName.startsWith("bridge")
    || normalizedInterfaceName.startsWith("awdl")
    || normalizedInterfaceName.startsWith("llw")
    || normalizedInterfaceName.startsWith("ap")
    || normalizedInterfaceName.startsWith("anpi")
  ) {
    return false;
  }

  return true;
}

function isPrivateIPv4(address) {
  if (typeof address !== "string") {
    return false;
  }

  const octets = address.split(".").map((value) => Number.parseInt(value, 10));
  if (octets.length !== 4 || octets.some((value) => Number.isNaN(value) || value < 0 || value > 255)) {
    return false;
  }

  if (octets[0] === 10) {
    return true;
  }

  if (octets[0] === 192 && octets[1] === 168) {
    return true;
  }

  return octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31;
}

function buildCandidateUrl(baseUrl, routePath) {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  if (normalizedBase.endsWith(routePath)) {
    return normalizedBase;
  }
  return `${normalizedBase}${routePath}`;
}

function normalizeNonEmptyString(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

module.exports = {
  buildTransportCandidates,
  startLocalBridgeServer,
};
