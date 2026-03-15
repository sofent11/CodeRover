// FILE: local-bridge-server.test.ts
// Purpose: Verifies the QR transport candidates stay limited to directly reachable LAN or explicit tailnet endpoints.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as os from "os";
import { WebSocket } from "ws";

import {
  buildTransportCandidates,
  startLocalBridgeServer,
  type LocalBridgeTransport,
} from "../src/local-bridge-server";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mockNetworkInterfaces(
  mock: typeof os.networkInterfaces
): () => void {
  const original = os.networkInterfaces;
  Object.defineProperty(os, "networkInterfaces", {
    configurable: true,
    writable: true,
    value: mock,
  });
  return () => {
    Object.defineProperty(os, "networkInterfaces", {
      configurable: true,
      writable: true,
      value: original,
    });
  };
}

test("buildTransportCandidates excludes hostname, utun, and link-local addresses", () => {
  const restoreNetworkInterfaces = mockNetworkInterfaces(() => ({
    en0: [
      { address: "192.168.1.11", family: "IPv4", internal: false, cidr: null, mac: "", netmask: "" },
    ],
    utun7: [
      { address: "10.20.0.1", family: "IPv4", internal: false, cidr: null, mac: "", netmask: "" },
    ],
    en11: [
      { address: "169.254.119.222", family: "IPv4", internal: false, cidr: null, mac: "", netmask: "" },
    ],
  }));

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
    restoreNetworkInterfaces();
  }
});

test("buildTransportCandidates appends explicit tailnet endpoint after LAN candidates", () => {
  const restoreNetworkInterfaces = mockNetworkInterfaces(() => ({
    en0: [
      { address: "192.168.1.11", family: "IPv4", internal: false, cidr: null, mac: "", netmask: "" },
    ],
  }));

  try {
    const candidates = buildTransportCandidates({
      bridgeId: "bridge-2",
      localPort: 8765,
      tailnetUrl: "ws://coderover-host.tailnet.ts.net:8765",
    });

    assert.deepEqual(candidates, [
      {
        kind: "local_ipv4",
        url: "ws://192.168.1.11:8765/bridge/bridge-2",
        label: "192.168.1.11",
      },
      {
        kind: "tailnet",
        url: "ws://coderover-host.tailnet.ts.net:8765/bridge/bridge-2",
        label: "Tailnet",
      },
    ]);
  } finally {
    restoreNetworkInterfaces();
  }
});

test("buildTransportCandidates appends explicit relay endpoints after LAN and tailnet candidates", () => {
  const restoreNetworkInterfaces = mockNetworkInterfaces(() => ({
    en0: [
      { address: "192.168.1.11", family: "IPv4", internal: false, cidr: null, mac: "", netmask: "" },
    ],
    utun4: [
      { address: "100.82.80.46", family: "IPv4", internal: false, cidr: null, mac: "", netmask: "" },
    ],
  }));

  try {
    const candidates = buildTransportCandidates({
      bridgeId: "bridge-relay",
      localPort: 8765,
      tailnetUrl: "wss://my-mac.tailnet.example",
      relayUrls: [
        "wss://relay-1.example.com",
        "wss://relay-2.example.com/coderover",
      ],
    });

    assert.deepEqual(candidates, [
      {
        kind: "local_ipv4",
        url: "ws://192.168.1.11:8765/bridge/bridge-relay",
        label: "192.168.1.11",
      },
      {
        kind: "tailnet_ipv4",
        url: "ws://100.82.80.46:8765/bridge/bridge-relay",
        label: "100.82.80.46",
      },
      {
        kind: "tailnet",
        url: "wss://my-mac.tailnet.example/bridge/bridge-relay",
        label: "Tailnet",
      },
      {
        kind: "relay",
        url: "wss://relay-1.example.com/bridge/bridge-relay",
        label: "relay-1.example.com",
      },
      {
        kind: "relay",
        url: "wss://relay-2.example.com/coderover/bridge/bridge-relay",
        label: "relay-2.example.com",
      },
    ]);
  } finally {
    restoreNetworkInterfaces();
  }
});

test("buildTransportCandidates includes Tailscale utun addresses as tailnet candidates", () => {
  const restoreNetworkInterfaces = mockNetworkInterfaces(() => ({
    en0: [
      { address: "192.168.1.11", family: "IPv4", internal: false, cidr: null, mac: "", netmask: "" },
    ],
    utun4: [
      { address: "100.82.80.46", family: "IPv4", internal: false, cidr: null, mac: "", netmask: "" },
    ],
  }));

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
    restoreNetworkInterfaces();
  }
});

test("startLocalBridgeServer rejects clients while bridge upstream is unavailable", async () => {
  const server = startLocalBridgeServer({
    bridgeId: "bridge-unavailable",
    host: "127.0.0.1",
    port: 0,
    canAcceptConnection: () => false,
  });

  await delay(25);

  const response = await new Promise<{ statusCode: number | undefined }>((resolve, reject) => {
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

test("startLocalBridgeServer keeps multiple clients connected at the same time", async () => {
  const received: Array<{ transportId: string; message: string }> = [];
  const server = startLocalBridgeServer({
    bridgeId: "bridge-multi",
    host: "127.0.0.1",
    port: 0,
    onMessage(message: string, transport: LocalBridgeTransport) {
      received.push({
        transportId: transport.transportId,
        message,
      });
    },
  });

  await delay(25);

  const firstClient = new WebSocket(
    `ws://127.0.0.1:${server.resolvedPort()}/bridge/bridge-multi`
  );
  const secondClient = new WebSocket(
    `ws://127.0.0.1:${server.resolvedPort()}/bridge/bridge-multi`
  );

  await Promise.all([
    new Promise<void>((resolve, reject) => {
      firstClient.once("open", () => resolve());
      firstClient.once("error", reject);
    }),
    new Promise<void>((resolve, reject) => {
      secondClient.once("open", () => resolve());
      secondClient.once("error", reject);
    }),
  ]);

  firstClient.send("first");
  secondClient.send("second");

  await delay(25);

  assert.equal(firstClient.readyState, WebSocket.OPEN);
  assert.equal(secondClient.readyState, WebSocket.OPEN);
  assert.equal(received.length, 2);
  assert.ok(received[0]);
  assert.ok(received[1]);
  assert.notEqual(received[0].transportId, received[1].transportId);

  firstClient.terminate();
  secondClient.terminate();
  server.stop();
});

test("startLocalBridgeServer reports stale bridge routes as pairing_expired", async () => {
  const server = startLocalBridgeServer({
    bridgeId: "bridge-current",
    host: "127.0.0.1",
    port: 0,
  });

  await delay(25);

  const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const client = new WebSocket(
      `ws://127.0.0.1:${server.resolvedPort()}/bridge/bridge-old`
    );

    client.once("message", (data) => {
      const payload = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
      resolve(payload);
      client.terminate();
    });

    client.once("error", reject);
  });

  server.stop();

  assert.deepEqual(result, {
    kind: "secureError",
    code: "pairing_expired",
    message: "This bridge pairing is no longer valid. Scan a new QR code to pair again.",
  });
});
