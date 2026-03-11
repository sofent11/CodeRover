// FILE: local-bridge-server.test.js
// Purpose: Verifies the QR transport candidates stay limited to directly reachable LAN or explicit tailnet endpoints.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, os, ../src/local-bridge-server

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const { buildTransportCandidates } = require("../src/local-bridge-server");

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
