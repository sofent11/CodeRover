// FILE: local-bridge-server.test.js
// Purpose: Verifies the QR transport candidates stay limited to directly reachable LAN or explicit tailnet endpoints.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, os, ../src/local-bridge-server

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const { WebSocket } = require("ws");
const {
  buildTransportCandidates,
  startLocalBridgeServer,
} = require("../src/local-bridge-server");

test("buildTransportCandidates excludes hostname, utun, and link-local addresses", () => {
  const originalNetworkInterfaces = os.networkInterfaces;

  os.networkInterfaces = () => ({
    en0: [
      { address: "192.168.1.11", family: "IPv4", internal: false },
    ],
    utun7: [
      { address: "10.20.0.1", family: "IPv4", internal: false },
    ],
    en11: [
      { address: "169.254.119.222", family: "IPv4", internal: false },
    ],
  });

  try {
    const candidates = buildTransportCandidates({
      bridgeId: "bridge-1",
      localPort: 8765,
    });

    assert.deepEqual(candidates, [
      {
        kind: "local_ipv4",
        url: "ws://192.168.1.11:8765/bridge/bridge-1",
        label: "192.168.1.11",
      },
    ]);
  } finally {
    os.networkInterfaces = originalNetworkInterfaces;
  }
});

test("buildTransportCandidates appends explicit tailnet endpoint after LAN candidates", () => {
  const originalNetworkInterfaces = os.networkInterfaces;

  os.networkInterfaces = () => ({
    en0: [
      { address: "192.168.1.11", family: "IPv4", internal: false },
    ],
  });

  try {
    const candidates = buildTransportCandidates({
      bridgeId: "bridge-2",
      localPort: 8765,
      tailnetUrl: "ws://remodex-host.tailnet.ts.net:8765",
    });

    assert.deepEqual(candidates, [
      {
        kind: "local_ipv4",
        url: "ws://192.168.1.11:8765/bridge/bridge-2",
        label: "192.168.1.11",
      },
      {
        kind: "tailnet",
        url: "ws://remodex-host.tailnet.ts.net:8765/bridge/bridge-2",
        label: "Tailnet",
      },
    ]);
  } finally {
    os.networkInterfaces = originalNetworkInterfaces;
  }
});

test("buildTransportCandidates includes Tailscale utun addresses as tailnet candidates", () => {
  const originalNetworkInterfaces = os.networkInterfaces;

  os.networkInterfaces = () => ({
    en0: [
      { address: "192.168.1.11", family: "IPv4", internal: false },
    ],
    utun4: [
      { address: "100.82.80.46", family: "IPv4", internal: false },
    ],
  });

  try {
    const candidates = buildTransportCandidates({
      bridgeId: "bridge-3",
      localPort: 8765,
    });

    assert.deepEqual(candidates, [
      {
        kind: "local_ipv4",
        url: "ws://192.168.1.11:8765/bridge/bridge-3",
        label: "192.168.1.11",
      },
      {
        kind: "tailnet_ipv4",
        url: "ws://100.82.80.46:8765/bridge/bridge-3",
        label: "100.82.80.46",
      },
    ]);
  } finally {
    os.networkInterfaces = originalNetworkInterfaces;
  }
});

test("startLocalBridgeServer rejects clients while bridge upstream is unavailable", async () => {
  const server = startLocalBridgeServer({
    bridgeId: "bridge-unavailable",
    host: "127.0.0.1",
    port: 0,
    canAcceptConnection: () => false,
  });

  await new Promise((resolve) => setTimeout(resolve, 25));

  const response = await new Promise((resolve, reject) => {
    const client = new WebSocket(
      `ws://127.0.0.1:${server.resolvedPort()}/bridge/bridge-unavailable`
    );

    client.once("unexpected-response", (_request, incomingMessage) => {
      resolve({
        statusCode: incomingMessage.statusCode,
      });
      client.terminate();
    });

    client.once("open", () => {
      reject(new Error("connection should have been rejected"));
      client.terminate();
    });

    client.once("error", () => {
      // The ws client reports an error after the 503 upgrade rejection; the
      // unexpected-response handler above captures the actual status code.
    });
  });

  server.stop();

  assert.equal(response.statusCode, 503);
});
