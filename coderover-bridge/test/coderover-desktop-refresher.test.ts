// FILE: coderover-desktop-refresher.test.ts
// Purpose: Verifies desktop refresh defaults, failure hardening, and rollout-based throttling.

import { test } from "bun:test";
import { strict as assert } from "node:assert";

import {
  CodeRoverDesktopRefresher,
  readBridgeConfig,
} from "../src/coderover-desktop-refresher";
import {
  createSessionRolloutActivityWatcher,
  type SessionRolloutActivityEvent,
} from "../src/rollout-watch";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("readBridgeConfig keeps safe defaults and explicit overrides", () => {
  const macConfig = readBridgeConfig({ env: {}, platform: "darwin" });
  const macEndpointConfig = readBridgeConfig({
    env: { CODEROVER_ENDPOINT: "ws://localhost:8080" },
    platform: "darwin",
  });
  const linuxConfig = readBridgeConfig({ env: {}, platform: "linux" });
  const linuxCommandConfig = readBridgeConfig({
    env: { CODEROVER_REFRESH_COMMAND: "echo refresh" },
    platform: "linux",
  });
  const explicitOnConfig = readBridgeConfig({
    env: {
      CODEROVER_ENDPOINT: "ws://localhost:8080",
      CODEROVER_REFRESH_ENABLED: "true",
    },
    platform: "darwin",
  });
  const explicitOffConfig = readBridgeConfig({
    env: {
      CODEROVER_REFRESH_COMMAND: "echo refresh",
      CODEROVER_REFRESH_ENABLED: "false",
    },
    platform: "darwin",
  });
  const relayConfig = readBridgeConfig({
    env: {
      CODEROVER_RELAY_URLS: "wss://relay-a.example.com, wss://relay-b.example.com/coderover",
    },
    platform: "darwin",
  });

  assert.equal(macConfig.refreshEnabled, false);
  assert.equal(macEndpointConfig.refreshEnabled, false);
  assert.equal(linuxConfig.refreshEnabled, false);
  assert.equal(linuxCommandConfig.refreshEnabled, false);
  assert.equal(explicitOnConfig.refreshEnabled, true);
  assert.equal(explicitOffConfig.refreshEnabled, false);
  assert.deepEqual(relayConfig.relayUrls, [
    "wss://relay-a.example.com",
    "wss://relay-b.example.com/coderover",
  ]);
});

test("session/new falls back once to the new-thread route when session id is still unknown", async () => {
  const refreshCalls: string[] = [];
  const refresher = new CodeRoverDesktopRefresher({
    enabled: true,
    debounceMs: 0,
    fallbackNewThreadMs: 15,
    refreshExecutor: async (targetUrl) => {
      refreshCalls.push(targetUrl);
    },
  });

  refresher.handleInbound(JSON.stringify({
    method: "session/new",
    params: {},
  }));

  await wait(40);

  assert.deepEqual(refreshCalls, ["coderover://threads/new"]);
  refresher.handleTransportReset();
});

test("session/update cancels the fallback and refreshes the concrete thread route", async () => {
  const refreshCalls: string[] = [];
  const watchedThreads: string[] = [];
  let stopCount = 0;
  const refresher = new CodeRoverDesktopRefresher({
    enabled: true,
    debounceMs: 0,
    fallbackNewThreadMs: 40,
    refreshExecutor: async (targetUrl) => {
      refreshCalls.push(targetUrl);
    },
    watchSessionRolloutFactory: ({ sessionId }) => {
      watchedThreads.push(sessionId);
      return {
        stop() {
          stopCount += 1;
        },
        get sessionId() {
          return sessionId;
        },
      };
    },
  });

  refresher.handleInbound(JSON.stringify({
    method: "session/new",
    params: {},
  }));
  await wait(10);
  refresher.handleOutbound(JSON.stringify({
    method: "session/update",
    params: {
      sessionId: "thread-123",
      update: {
        sessionUpdate: "session_info_update",
        _meta: {
          coderover: {
            sessionId: "thread-123",
            runState: "running",
          },
        },
      },
    },
  }));

  await wait(25);

  assert.deepEqual(refreshCalls, ["coderover://threads/thread-123"]);
  assert.deepEqual(watchedThreads, ["thread-123"]);

  await wait(30);
  assert.deepEqual(refreshCalls, ["coderover://threads/thread-123"]);

  refresher.handleTransportReset();
  assert.equal(stopCount, 1);
});

test("rollout growth refreshes are throttled during long runs", async () => {
  const refreshCalls: string[] = [];
  let watcherHooks:
    | {
      sessionId: string;
      onEvent: (event: SessionRolloutActivityEvent) => void;
    }
    | null = null;
  let currentTime = 0;

  const refresher = new CodeRoverDesktopRefresher({
    enabled: true,
    debounceMs: 0,
    midRunRefreshThrottleMs: 3_000,
    now: () => currentTime,
    refreshExecutor: async (targetUrl) => {
      refreshCalls.push(targetUrl);
    },
    watchSessionRolloutFactory: (hooks) => {
      watcherHooks = {
        sessionId: hooks.sessionId,
        onEvent: hooks.onEvent,
      };
      return {
        stop() {},
        get sessionId() {
          return hooks.sessionId;
        },
      };
    },
  });

  const emitGrowth = (size: number): void => {
    const hooks = watcherHooks;
    if (!hooks) {
      throw new Error("expected rollout watcher hooks");
    }
    hooks.onEvent({
      reason: "growth",
      sessionId: hooks.sessionId,
      rolloutPath: "/tmp/rollout-thread-456.jsonl",
      size,
    });
  };

  refresher.handleInbound(JSON.stringify({
    method: "session/prompt",
    params: {
      sessionId: "thread-456",
    },
  }));
  await wait(10);
  refreshCalls.length = 0;

  currentTime = 1_000;
  emitGrowth(10);
  await wait(10);
  assert.deepEqual(refreshCalls, ["coderover://threads/thread-456"]);

  refreshCalls.length = 0;
  currentTime = 2_000;
  emitGrowth(15);
  await wait(10);
  assert.deepEqual(refreshCalls, []);

  currentTime = 4_500;
  emitGrowth(20);
  await wait(10);
  assert.deepEqual(refreshCalls, ["coderover://threads/thread-456"]);
});

test("completion session/update bypasses duplicate-target dedupe and still stops the watcher", async () => {
  const refreshCalls: string[] = [];
  let stopCount = 0;
  let currentTime = 3_000;

  const refresher = new CodeRoverDesktopRefresher({
    enabled: true,
    debounceMs: 0,
    now: () => currentTime,
    refreshExecutor: async (targetUrl) => {
      refreshCalls.push(targetUrl);
    },
    watchSessionRolloutFactory: () => ({
      stop() {
        stopCount += 1;
      },
      get sessionId() {
        return "thread-789";
      },
    }),
  });

  refresher.handleInbound(JSON.stringify({
    method: "session/prompt",
    params: {
      sessionId: "thread-789",
    },
  }));
  await wait(10);

  currentTime = 4_500;
  refresher.handleOutbound(JSON.stringify({
    method: "session/update",
    params: {
      sessionId: "thread-789",
      update: {
        sessionUpdate: "session_info_update",
        _meta: {
          coderover: {
            sessionId: "thread-789",
            turnId: "turn-789",
            runState: "completed",
          },
        },
      },
    },
  }));
  await wait(10);

  currentTime = 4_700;
  refresher.handleOutbound(JSON.stringify({
    method: "session/update",
    params: {
      sessionId: "thread-789",
      update: {
        sessionUpdate: "session_info_update",
        _meta: {
          coderover: {
            sessionId: "thread-789",
            turnId: "turn-789",
            runState: "completed",
          },
        },
      },
    },
  }));
  await wait(10);

  assert.deepEqual(refreshCalls, [
    "coderover://threads/thread-789",
    "coderover://threads/thread-789",
  ]);
  assert.equal(stopCount, 1);
});

test("completion session/update is retried after a slow in-flight refresh finishes", async () => {
  const refreshCalls: string[] = [];
  let releaseSlowRefresh!: () => void;

  const refresher = new CodeRoverDesktopRefresher({
    enabled: true,
    debounceMs: 0,
    refreshExecutor: async (targetUrl) => {
      refreshCalls.push(targetUrl);
      if (refreshCalls.length === 1) {
        await new Promise<void>((resolve) => {
          releaseSlowRefresh = resolve;
        });
      }
    },
    watchSessionRolloutFactory: () => ({
      stop() {},
      get sessionId() {
        return "thread-slow";
      },
    }),
  });

  refresher.handleInbound(JSON.stringify({
    method: "session/prompt",
    params: {
      sessionId: "thread-slow",
    },
  }));
  await wait(10);

  refresher.handleOutbound(JSON.stringify({
    method: "session/update",
    params: {
      sessionId: "thread-slow",
      update: {
        sessionUpdate: "session_info_update",
        _meta: {
          coderover: {
            sessionId: "thread-slow",
            turnId: "turn-slow",
            runState: "completed",
          },
        },
      },
    },
  }));
  await wait(10);

  assert.equal(refreshCalls.length, 1);

  const releaseRefresh = releaseSlowRefresh;
  releaseRefresh();
  await wait(20);

  assert.deepEqual(refreshCalls, [
    "coderover://threads/thread-slow",
    "coderover://threads/thread-slow",
  ]);
});

test("completion refresh keeps its own thread target even if another thread queues behind it", async () => {
  const refreshCalls: string[] = [];
  let stopCount = 0;

  const refresher = new CodeRoverDesktopRefresher({
    enabled: true,
    debounceMs: 1_200,
    refreshExecutor: async (targetUrl) => {
      refreshCalls.push(targetUrl);
    },
    watchSessionRolloutFactory: ({ sessionId }) => ({
      stop() {
        if (sessionId === "thread-a") {
          stopCount += 1;
        }
      },
      get sessionId() {
        return sessionId;
      },
    }),
  });

  refresher.handleInbound(JSON.stringify({
    method: "session/prompt",
    params: { sessionId: "thread-a" },
  }));
  await wait(10);
  refreshCalls.length = 0;
  refresher.clearRefreshTimer();

  refresher.handleOutbound(JSON.stringify({
    method: "session/update",
    params: {
      sessionId: "thread-a",
      update: {
        sessionUpdate: "session_info_update",
        _meta: {
          coderover: {
            sessionId: "thread-a",
            turnId: "turn-a",
            runState: "completed",
          },
        },
      },
    },
  }));
  refresher.handleInbound(JSON.stringify({
    method: "session/prompt",
    params: { sessionId: "thread-b" },
  }));
  refresher.clearRefreshTimer();
  await refresher.runPendingRefresh();
  await refresher.runPendingRefresh();

  assert.deepEqual(refreshCalls, [
    "coderover://threads/thread-a",
    "coderover://threads/thread-b",
  ]);
  assert.equal(stopCount, 1);
});

test("handleTransportReset cancels pending refreshes and clears watcher state", async () => {
  const refreshCalls: string[] = [];
  let stopCount = 0;

  const refresher = new CodeRoverDesktopRefresher({
    enabled: true,
    debounceMs: 30,
    refreshExecutor: async (targetUrl) => {
      refreshCalls.push(targetUrl);
    },
    watchSessionRolloutFactory: () => ({
      stop() {
        stopCount += 1;
      },
      get sessionId() {
        return "thread-reset";
      },
    }),
  });

  refresher.handleInbound(JSON.stringify({
    method: "session/prompt",
    params: {
      sessionId: "thread-reset",
    },
  }));
  refresher.handleTransportReset();
  await wait(50);

  assert.deepEqual(refreshCalls, []);
  assert.equal(stopCount, 1);
});

test("handleTransportReset clears duplicate-target memory so the next refresh can run", async () => {
  const refreshCalls: string[] = [];
  let currentTime = 5_000;

  const refresher = new CodeRoverDesktopRefresher({
    enabled: true,
    debounceMs: 1_200,
    now: () => currentTime,
    refreshExecutor: async (targetUrl) => {
      refreshCalls.push(targetUrl);
    },
    watchSessionRolloutFactory: () => ({
      stop() {},
      get sessionId() {
        return "thread-reset-dedupe";
      },
    }),
  });

  refresher.handleInbound(JSON.stringify({
    method: "session/prompt",
    params: { sessionId: "thread-reset-dedupe" },
  }));
  await wait(10);

  refresher.handleTransportReset();

  currentTime = 5_100;
  refresher.handleInbound(JSON.stringify({
    method: "session/prompt",
    params: { sessionId: "thread-reset-dedupe" },
  }));
  await wait(10);

  assert.deepEqual(refreshCalls, [
    "coderover://threads/thread-reset-dedupe",
    "coderover://threads/thread-reset-dedupe",
  ]);
});

test("desktop refresh disables itself after a desktop-unavailable AppleScript failure", async () => {
  let attempts = 0;
  let stopCount = 0;

  const refresher = new CodeRoverDesktopRefresher({
    enabled: true,
    debounceMs: 0,
    refreshBackend: "applescript",
    refreshExecutor: async () => {
      attempts += 1;
      throw new Error("Unable to find application named CodeRover");
    },
    watchSessionRolloutFactory: () => ({
      stop() {
        stopCount += 1;
      },
      get sessionId() {
        return "thread-disable";
      },
    }),
  });

  refresher.handleInbound(JSON.stringify({
    method: "session/prompt",
    params: {
      sessionId: "thread-disable-1",
    },
  }));
  await wait(10);

  refresher.handleInbound(JSON.stringify({
    method: "session/prompt",
    params: {
      sessionId: "thread-disable-2",
    },
  }));
  await wait(10);

  assert.equal(attempts, 1);
  assert.equal(stopCount, 1);
  assert.equal(refresher.runtimeRefreshAvailable, false);
});

test("custom refresh commands only disable after repeated failures", async () => {
  let attempts = 0;

  const refresher = new CodeRoverDesktopRefresher({
    enabled: true,
    debounceMs: 0,
    refreshBackend: "command",
    customRefreshFailureThreshold: 3,
    refreshExecutor: async () => {
      attempts += 1;
      throw new Error("command failed");
    },
  });

  for (const threadId of ["thread-cmd-1", "thread-cmd-2", "thread-cmd-3", "thread-cmd-4"]) {
    refresher.handleInbound(JSON.stringify({
      method: "session/prompt",
      params: { sessionId: threadId },
    }));
    await wait(10);
  }

  assert.equal(attempts, 3);
  assert.equal(refresher.runtimeRefreshAvailable, false);
});

test("rollout watcher retries transient filesystem errors before succeeding", async () => {
  const events: Array<{ reason: string }> = [];
  const errors: Error[] = [];
  let readdirCalls = 0;

  const watcher = createSessionRolloutActivityWatcher({
    sessionId: "thread-watch-ok",
    intervalMs: 5,
    lookupTimeoutMs: 100,
    idleTimeoutMs: 100,
    transientErrorRetryLimit: 2,
    fsModule: {
      existsSync: () => true,
      readdirSync: () => {
        readdirCalls += 1;
        if (readdirCalls === 1) {
          const error = new Error("temporary missing dir") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }

        return [{
          name: "rollout-thread-watch-ok.jsonl",
          isDirectory: () => false,
          isFile: () => true,
        }];
      },
      statSync: () => ({ size: 12 }),
    },
    onEvent: (event) => events.push({ reason: event.reason }),
    onError: (error) => errors.push(error),
  });

  await wait(25);
  watcher.stop();

  assert.equal(errors.length, 0);
  assert.equal(events[0]?.reason, "materialized");
});

test("rollout watcher stops after repeated transient filesystem failures", async () => {
  const errors: Error[] = [];
  let currentTime = 0;

  const watcher = createSessionRolloutActivityWatcher({
    sessionId: "thread-watch-fail",
    intervalMs: 5,
    lookupTimeoutMs: 100,
    idleTimeoutMs: 100,
    transientErrorRetryLimit: 1,
    now: () => {
      currentTime += 5;
      return currentTime;
    },
    fsModule: {
      existsSync: () => true,
      readdirSync: () => {
        const error = new Error("still missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      },
      statSync: () => ({ size: 0 }),
    },
    onError: (error) => errors.push(error),
  });

  await wait(25);
  watcher.stop();

  assert.equal(errors.length, 1);
});
