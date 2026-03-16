// FILE: local-bridge-server.ts
// Purpose: Hosts the stable local WebSocket endpoint that iPhone clients can reconnect to directly.

import * as http from "http";
import * as os from "os";
import type { AddressInfo } from "net";

import { WebSocketServer, WebSocket } from "ws";

import type { TransportCandidateShape } from "./bridge-types";
import { debugError, debugLog } from "./debug-log";

const CLOSE_CODE_INVALID_ROUTE = 4000;
const CLOSE_CODE_IPHONE_REPLACED = 4003;
const CLOSE_CODE_UPSTREAM_RESTARTING = 4004;
const HEARTBEAT_INTERVAL_MS = 30_000;
const STALE_PAIRING_CLOSE_DELAY_MS = 200;
const BRIDGE_PATH_PREFIX = "/bridge/";
const STALE_PAIRING_ERROR_MESSAGE =
  "This bridge pairing is no longer valid. Scan a new QR code to pair again.";

interface BridgeWebSocket extends WebSocket {
  _bridgeAlive?: boolean;
  _bridgeTransportId?: string;
}

export interface LocalBridgeTransport {
  transportId: string;
  sendControlMessage(controlMessage: Record<string, unknown>): void;
  sendWireMessage(wireMessage: string): void;
  closeTransport(code?: number, reason?: string): void;
}

interface LocalBridgeClientCloseEvent {
  transportId: string;
}

interface StartLocalBridgeServerOptions {
  bridgeId?: string;
  host?: string;
  port?: number;
  logPrefix?: string;
  canAcceptConnection?: () => boolean;
  onMessage?: (message: string, transport: LocalBridgeTransport) => void;
  onClientClose?: (event: LocalBridgeClientCloseEvent) => void;
  onError?: (error: Error) => void;
}

export interface LocalBridgeServer {
  bridgeId: string;
  host: string;
  port: number;
  routePath: string;
  resolvedPort(): number;
  disconnectClient(transportId: string, code?: number, reason?: string): void;
  disconnectAllClients(code?: number, reason?: string): void;
  disconnectCurrentClient(code?: number, reason?: string): void;
  stop(): void;
}

function isNetworkInterfaceInfoArray(
  value: unknown
): value is os.NetworkInterfaceInfo[] {
  return Array.isArray(value);
}

export function startLocalBridgeServer({
  bridgeId = "",
  host = "0.0.0.0",
  port = 8765,
  logPrefix = "[coderover]",
  canAcceptConnection = () => true,
  onMessage,
  onClientClose,
  onError,
}: StartLocalBridgeServerOptions = {}): LocalBridgeServer {
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
  let nextClientId = 1;
  const clients = new Map<string, BridgeWebSocket>();
  const heartbeat = setInterval(() => {
    for (const ws of clients.values()) {
      if (ws._bridgeAlive === false) {
        try {
          ws.terminate();
        } catch {
          // Best-effort cleanup only.
        }
        continue;
      }

      ws._bridgeAlive = false;
      try {
        ws.ping();
      } catch {
        // Best-effort only.
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  server.on("upgrade", (req, socket, head) => {
    if (req.url !== routePath && isBridgeRoutePath(req.url)) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        const bridgeSocket = ws as BridgeWebSocket;
        console.warn(`${logPrefix} rejected stale bridge route ${req.url}; expected ${routePath}`);
        try {
          bridgeSocket.send(
            JSON.stringify({
              kind: "secureError",
              code: "pairing_expired",
              message: STALE_PAIRING_ERROR_MESSAGE,
            })
          );
          setTimeout(() => {
            try {
              bridgeSocket.close(CLOSE_CODE_INVALID_ROUTE, "Bridge pairing expired");
            } catch {
              try {
                bridgeSocket.terminate();
              } catch {
                // Best-effort only.
              }
            }
          }, STALE_PAIRING_CLOSE_DELAY_MS);
        } catch {
          try {
            bridgeSocket.terminate();
          } catch {
            // Best-effort only.
          }
        }
      });
      return;
    }

    if (req.url !== routePath) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    if (!canAcceptConnection()) {
      socket.end(
        "HTTP/1.1 503 Service Unavailable\r\n"
        + "Connection: close\r\n"
        + "Content-Length: 0\r\n"
        + "\r\n"
      );
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws) => {
    const bridgeSocket = ws as BridgeWebSocket;
    const transportId = `transport-${nextClientId}`;
    nextClientId += 1;
    bridgeSocket._bridgeTransportId = transportId;
    bridgeSocket._bridgeAlive = true;
    clients.set(transportId, bridgeSocket);
    console.log(`${logPrefix} local client connected (${routePath}, ${transportId})`);

    bridgeSocket.on("pong", () => {
      bridgeSocket._bridgeAlive = true;
    });

    bridgeSocket.on("message", (data) => {
      const message = typeof data === "string" ? data : data.toString("utf8");
      debugLog(
        `${logPrefix} local client message (${transportId}) bytes=${Buffer.byteLength(message, "utf8")}`
      );
      onMessage?.(message, {
        transportId,
        sendControlMessage(controlMessage: Record<string, unknown>) {
          if (bridgeSocket.readyState === WebSocket.OPEN) {
            const payload = JSON.stringify(controlMessage);
            debugLog(
              `${logPrefix} send control (${transportId}) bytes=${Buffer.byteLength(payload, "utf8")}`
            );
            try {
              bridgeSocket.send(payload);
            } catch (error) {
              debugError(
                `${logPrefix} send control failed (${transportId}): ${getErrorMessage(error)}`
              );
            }
          }
        },
        sendWireMessage(wireMessage: string) {
          if (bridgeSocket.readyState === WebSocket.OPEN) {
            debugLog(
              `${logPrefix} send wire (${transportId}) bytes=${Buffer.byteLength(wireMessage, "utf8")}`
            );
            try {
              bridgeSocket.send(wireMessage);
            } catch (error) {
              debugError(
                `${logPrefix} send wire failed (${transportId}): ${getErrorMessage(error)}`
              );
            }
          }
        },
        closeTransport(
          code = CLOSE_CODE_IPHONE_REPLACED,
          reason = "Replaced by newer iPhone connection"
        ) {
          try {
            debugLog(`${logPrefix} close transport (${transportId}) code=${code} reason=${reason}`);
            bridgeSocket.close(code, reason);
          } catch {
            // Best-effort cleanup only.
          }
        },
      });
    });

    bridgeSocket.on("close", (code, reasonBuffer) => {
      clients.delete(transportId);
      onClientClose?.({ transportId });
      const reason = reasonBuffer.toString("utf8");
      console.log(
        `${logPrefix} local client disconnected (${transportId}) code=${code} reason=${reason || "none"}`
      );
    });

    bridgeSocket.on("error", (error) => {
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
      const address = server.address() as AddressInfo | null;
      return address?.port || port;
    },
    disconnectClient(
      transportId: string,
      code = CLOSE_CODE_UPSTREAM_RESTARTING,
      reason = "Bridge upstream restarting"
    ) {
      const clientToClose = clients.get(transportId);
      if (!clientToClose) {
        return;
      }

      clients.delete(transportId);
      try {
        clientToClose.close(code, reason);
      } catch {
        // Best-effort cleanup only.
      }
    },
    disconnectAllClients(
      code = CLOSE_CODE_UPSTREAM_RESTARTING,
      reason = "Bridge upstream restarting"
    ) {
      for (const transportId of [...clients.keys()]) {
        this.disconnectClient(transportId, code, reason);
      }
    },
    disconnectCurrentClient(
      code = CLOSE_CODE_UPSTREAM_RESTARTING,
      reason = "Bridge upstream restarting"
    ) {
      this.disconnectAllClients(code, reason);
    },
    stop() {
      for (const transportId of [...clients.keys()]) {
        this.disconnectClient(transportId, CLOSE_CODE_INVALID_ROUTE, "Bridge shutting down");
      }
      for (const client of wss.clients) {
        try {
          (client as BridgeWebSocket).terminate();
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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface BuildTransportCandidatesOptions {
  bridgeId?: string;
  localPort?: number;
  tailnetUrl?: string;
  relayUrls?: string[] | string;
  networkInterfaces?: typeof os.networkInterfaces;
}

export function buildTransportCandidates({
  bridgeId = "",
  localPort = 8765,
  tailnetUrl = "",
  relayUrls = [],
  networkInterfaces = os.networkInterfaces,
}: BuildTransportCandidatesOptions = {}): TransportCandidateShape[] {
  const routePath = `/bridge/${bridgeId}`;
  const candidates: TransportCandidateShape[] = [];
  const seen = new Set<string>();

  function addCandidate(kind: string, url: string, label?: string): void {
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

  for (const address of listReachableLocalIPv4Addresses(networkInterfaces)) {
    addCandidate("local_ipv4", `ws://${address}:${localPort}${routePath}`, address);
  }

  for (const address of listReachableTailnetIPv4Addresses(networkInterfaces)) {
    addCandidate("tailnet_ipv4", `ws://${address}:${localPort}${routePath}`, address);
  }

  const normalizedTailnetUrl = normalizeNonEmptyString(tailnetUrl);
  if (normalizedTailnetUrl) {
    addCandidate("tailnet", buildCandidateUrl(normalizedTailnetUrl, routePath), "Tailnet");
  }

  for (const relayUrl of normalizeRelayUrls(relayUrls)) {
    const candidateUrl = buildCandidateUrl(relayUrl, routePath);
    addCandidate("relay", candidateUrl, describeRelayCandidate(candidateUrl));
  }

  return candidates;
}

function listReachableLocalIPv4Addresses(
  networkInterfaces: typeof os.networkInterfaces
): string[] {
  return listReachableIPv4Addresses(isReachableLocalIPv4, networkInterfaces);
}

function listReachableTailnetIPv4Addresses(
  networkInterfaces: typeof os.networkInterfaces
): string[] {
  return listReachableIPv4Addresses(isReachableTailnetIPv4, networkInterfaces);
}

function isBridgeRoutePath(pathname: string | undefined): boolean {
  return typeof pathname === "string" && pathname.startsWith(BRIDGE_PATH_PREFIX);
}

function listReachableIPv4Addresses(
  addressFilter: (address: string, interfaceName: string) => boolean,
  networkInterfaces: typeof os.networkInterfaces
): string[] {
  const interfaces = networkInterfaces();
  const addresses: string[] = [];

  for (const [interfaceName, networkDetails] of Object.entries(interfaces)) {
    if (!isNetworkInterfaceInfoArray(networkDetails)) {
      continue;
    }

    for (const detail of networkDetails) {
      if (!detail || detail.internal || detail.family !== "IPv4") {
        continue;
      }
      if (!addressFilter(detail.address, interfaceName)) {
        continue;
      }
      addresses.push(detail.address);
    }
  }

  return addresses;
}

function isReachableLocalIPv4(address: string, interfaceName: string): boolean {
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

function isReachableTailnetIPv4(address: string, interfaceName: string): boolean {
  if (!isTailnetCarrierIPv4(address)) {
    return false;
  }

  const normalizedInterfaceName = normalizeNonEmptyString(interfaceName).toLowerCase();
  if (!normalizedInterfaceName) {
    return false;
  }

  return normalizedInterfaceName.startsWith("utun")
    || normalizedInterfaceName.includes("tailscale");
}

function isPrivateIPv4(address: string): boolean {
  const octets = parseIpv4Octets(address);
  if (!octets) {
    return false;
  }

  if (octets[0] === 10) {
    return true;
  }

  if (octets[0] === 192 && octets[1] === 168) {
    return true;
  }

  const firstOctet = octets[0];
  const secondOctet = octets[1];
  return firstOctet === 172 && secondOctet != null && secondOctet >= 16 && secondOctet <= 31;
}

function isTailnetCarrierIPv4(address: string): boolean {
  const octets = parseIpv4Octets(address);
  if (!octets) {
    return false;
  }

  const firstOctet = octets[0];
  const secondOctet = octets[1];
  return firstOctet === 100 && secondOctet != null && secondOctet >= 64 && secondOctet <= 127;
}

function parseIpv4Octets(address: string): number[] | null {
  if (typeof address !== "string") {
    return null;
  }

  const octets = address.split(".").map((value) => Number.parseInt(value, 10));
  if (octets.length !== 4 || octets.some((value) => Number.isNaN(value) || value < 0 || value > 255)) {
    return null;
  }
  return octets;
}

function buildCandidateUrl(baseUrl: string, routePath: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  if (normalizedBase.endsWith(routePath)) {
    return normalizedBase;
  }
  return `${normalizedBase}${routePath}`;
}

function normalizeRelayUrls(relayUrls: string[] | string): string[] {
  if (typeof relayUrls === "string") {
    return relayUrls
      .split(/[,\n]/)
      .map((value) => normalizeNonEmptyString(value))
      .filter(Boolean);
  }

  if (!Array.isArray(relayUrls)) {
    return [];
  }

  return relayUrls
    .map((value) => normalizeNonEmptyString(value))
    .filter(Boolean);
}

function describeRelayCandidate(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname) {
      return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
    }
  } catch {
    // Fall back to a generic label when the URL is not fully parseable.
  }

  return "Relay";
}

function normalizeNonEmptyString(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}
