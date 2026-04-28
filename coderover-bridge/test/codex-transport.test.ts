// FILE: codex-transport.test.ts
// Purpose: Verifies Codex transport readiness behavior for spawned and WebSocket-backed app-server connections.

import { test } from "bun:test";
import { strict as assert } from "node:assert";
import * as net from "node:net";
import { WebSocketServer } from "ws";

import { createCodexTransport } from "../src/codex-transport";

test("WebSocket Codex transport queues early sends until the socket opens", async () => {
  const server = await startWebSocketServer();
  const payload = JSON.stringify({ jsonrpc: "2.0", id: "early-1", method: "model/list" });
  const receivedMessage = new Promise<string>((resolve) => {
    server.wss.on("connection", (socket) => {
      socket.on("message", (chunk) => {
        resolve(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      });
    });
  });
  const transport = createCodexTransport({
    endpoint: `ws://127.0.0.1:${server.port}`,
  });

  try {
    transport.send(payload);

    assert.equal(await receivedMessage, payload);
  } finally {
    await transport.shutdown();
    await server.close();
  }
});

test("WebSocket Codex transport reports queued sends when connection fails before open", async () => {
  const port = await reserveUnusedPort();
  const transport = createCodexTransport({
    endpoint: `ws://127.0.0.1:${port}`,
  });
  const errors: Error[] = [];
  transport.onError((error) => {
    errors.push(error);
  });

  try {
    transport.send(JSON.stringify({ jsonrpc: "2.0", id: "early-fail", method: "thread/list" }));
    await waitFor(() => errors.length > 0);

    assert.ok(errors.length > 0);
  } finally {
    await transport.shutdown();
  }
});

async function startWebSocketServer(): Promise<{
  port: number;
  wss: WebSocketServer;
  close(): Promise<void>;
}> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => {
    wss.on("listening", resolve);
  });
  const address = wss.address();
  assert.equal(typeof address, "object");
  assert.ok(address && typeof address.port === "number");
  return {
    port: address.port,
    wss,
    close() {
      return new Promise((resolve) => {
        wss.close(() => resolve());
      });
    },
  };
}

async function reserveUnusedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && typeof address.port === "number");
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  return port;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(predicate(), true);
}
