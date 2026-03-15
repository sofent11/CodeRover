"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
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
const STALE_PAIRING_CLOSE_DELAY_MS = 200;
const BRIDGE_PATH_PREFIX = "/bridge/";
const STALE_PAIRING_ERROR_MESSAGE = "This bridge pairing is no longer valid. Scan a new QR code to pair again.";
function startLocalBridgeServer({ bridgeId, host = "0.0.0.0", port = 8765, logPrefix = "[coderover]", canAcceptConnection = () => true, onMessage, onClientClose, onError, } = {}) {
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
    const clients = new Map();
    const heartbeat = setInterval(() => {
        for (const ws of clients.values()) {
            if (ws._bridgeAlive === false) {
                try {
                    ws.terminate();
                }
                catch {
                    // Best-effort cleanup only.
                }
                continue;
            }
            ws._bridgeAlive = false;
            try {
                ws.ping();
            }
            catch {
                // Best-effort only.
            }
        }
    }, HEARTBEAT_INTERVAL_MS);
    server.on("upgrade", (req, socket, head) => {
        if (req.url !== routePath && isBridgeRoutePath(req.url)) {
            wss.handleUpgrade(req, socket, head, (ws) => {
                console.warn(`${logPrefix} rejected stale bridge route ${req.url}; expected ${routePath}`);
                try {
                    ws.send(JSON.stringify({
                        kind: "secureError",
                        code: "pairing_expired",
                        message: STALE_PAIRING_ERROR_MESSAGE,
                    }));
                    setTimeout(() => {
                        try {
                            ws.close(CLOSE_CODE_INVALID_ROUTE, "Bridge pairing expired");
                        }
                        catch {
                            try {
                                ws.terminate();
                            }
                            catch {
                                // Best-effort only.
                            }
                        }
                    }, STALE_PAIRING_CLOSE_DELAY_MS);
                }
                catch {
                    try {
                        ws.terminate();
                    }
                    catch {
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
            socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
            socket.destroy();
            return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit("connection", ws, req);
        });
    });
    wss.on("connection", (ws) => {
        const transportId = `transport-${nextClientId}`;
        nextClientId += 1;
        ws._bridgeTransportId = transportId;
        ws._bridgeAlive = true;
        clients.set(transportId, ws);
        console.log(`${logPrefix} local client connected (${routePath}, ${transportId})`);
        ws.on("pong", () => {
            ws._bridgeAlive = true;
        });
        ws.on("message", (data) => {
            const message = typeof data === "string" ? data : data.toString("utf8");
            onMessage?.(message, {
                transportId,
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
                closeTransport(code = CLOSE_CODE_IPHONE_REPLACED, reason = "Replaced by newer iPhone connection") {
                    try {
                        ws.close(code, reason);
                    }
                    catch {
                        // Best-effort cleanup only.
                    }
                },
            });
        });
        ws.on("close", () => {
            clients.delete(transportId);
            onClientClose?.({ transportId });
            console.log(`${logPrefix} local client disconnected (${transportId})`);
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
        disconnectClient(transportId, code = CLOSE_CODE_UPSTREAM_RESTARTING, reason = "Bridge upstream restarting") {
            const clientToClose = clients.get(transportId);
            if (!clientToClose) {
                return;
            }
            clients.delete(transportId);
            try {
                clientToClose.close(code, reason);
            }
            catch {
                // Best-effort cleanup only.
            }
        },
        disconnectAllClients(code = CLOSE_CODE_UPSTREAM_RESTARTING, reason = "Bridge upstream restarting") {
            for (const transportId of [...clients.keys()]) {
                this.disconnectClient(transportId, code, reason);
            }
        },
        disconnectCurrentClient(code = CLOSE_CODE_UPSTREAM_RESTARTING, reason = "Bridge upstream restarting") {
            this.disconnectAllClients(code, reason);
        },
        stop() {
            for (const transportId of [...clients.keys()]) {
                this.disconnectClient(transportId, CLOSE_CODE_INVALID_ROUTE, "Bridge shutting down");
            }
            for (const client of wss.clients) {
                try {
                    client.terminate();
                }
                catch {
                    // Best-effort shutdown only.
                }
            }
            clearInterval(heartbeat);
            wss.close();
            server.close();
        },
    };
}
function buildTransportCandidates({ bridgeId, localPort, tailnetUrl = "", relayUrls = [], } = {}) {
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
    for (const address of listReachableTailnetIPv4Addresses()) {
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
function listReachableLocalIPv4Addresses() {
    return listReachableIPv4Addresses(isReachableLocalIPv4);
}
function listReachableTailnetIPv4Addresses() {
    return listReachableIPv4Addresses(isReachableTailnetIPv4);
}
function isBridgeRoutePath(pathname) {
    return typeof pathname === "string" && pathname.startsWith(BRIDGE_PATH_PREFIX);
}
function listReachableIPv4Addresses(addressFilter) {
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
            if (!addressFilter(detail.address, interfaceName)) {
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
    if (normalizedInterfaceName.startsWith("utun")
        || normalizedInterfaceName.startsWith("bridge")
        || normalizedInterfaceName.startsWith("awdl")
        || normalizedInterfaceName.startsWith("llw")
        || normalizedInterfaceName.startsWith("ap")
        || normalizedInterfaceName.startsWith("anpi")) {
        return false;
    }
    return true;
}
function isReachableTailnetIPv4(address, interfaceName) {
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
function isTailnetCarrierIPv4(address) {
    if (typeof address !== "string") {
        return false;
    }
    const octets = address.split(".").map((value) => Number.parseInt(value, 10));
    if (octets.length !== 4 || octets.some((value) => Number.isNaN(value) || value < 0 || value > 255)) {
        return false;
    }
    return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}
function buildCandidateUrl(baseUrl, routePath) {
    const normalizedBase = baseUrl.replace(/\/+$/, "");
    if (normalizedBase.endsWith(routePath)) {
        return normalizedBase;
    }
    return `${normalizedBase}${routePath}`;
}
function normalizeRelayUrls(relayUrls) {
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
function describeRelayCandidate(url) {
    try {
        const parsed = new URL(url);
        if (parsed.hostname) {
            return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
        }
    }
    catch {
        // Fall back to a generic label when the URL is not fully parseable.
    }
    return "Relay";
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
