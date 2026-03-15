"use strict";
// FILE: coderover-desktop-refresher.test.ts
// Purpose: Verifies desktop refresh defaults, failure hardening, and rollout-based throttling.
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const node_assert_1 = require("node:assert");
const coderover_desktop_refresher_1 = require("../src/coderover-desktop-refresher");
const rollout_watch_1 = require("../src/rollout-watch");
function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
(0, node_test_1.test)("readBridgeConfig keeps safe defaults and explicit overrides", () => {
    const macConfig = (0, coderover_desktop_refresher_1.readBridgeConfig)({ env: {}, platform: "darwin" });
    const macEndpointConfig = (0, coderover_desktop_refresher_1.readBridgeConfig)({
        env: { CODEROVER_ENDPOINT: "ws://localhost:8080" },
        platform: "darwin",
    });
    const linuxConfig = (0, coderover_desktop_refresher_1.readBridgeConfig)({ env: {}, platform: "linux" });
    const linuxCommandConfig = (0, coderover_desktop_refresher_1.readBridgeConfig)({
        env: { CODEROVER_REFRESH_COMMAND: "echo refresh" },
        platform: "linux",
    });
    const explicitOnConfig = (0, coderover_desktop_refresher_1.readBridgeConfig)({
        env: {
            CODEROVER_ENDPOINT: "ws://localhost:8080",
            CODEROVER_REFRESH_ENABLED: "true",
        },
        platform: "darwin",
    });
    const explicitOffConfig = (0, coderover_desktop_refresher_1.readBridgeConfig)({
        env: {
            CODEROVER_REFRESH_COMMAND: "echo refresh",
            CODEROVER_REFRESH_ENABLED: "false",
        },
        platform: "darwin",
    });
    const relayConfig = (0, coderover_desktop_refresher_1.readBridgeConfig)({
        env: {
            CODEROVER_RELAY_URLS: "wss://relay-a.example.com, wss://relay-b.example.com/coderover",
        },
        platform: "darwin",
    });
    node_assert_1.strict.equal(macConfig.refreshEnabled, false);
    node_assert_1.strict.equal(macEndpointConfig.refreshEnabled, false);
    node_assert_1.strict.equal(linuxConfig.refreshEnabled, false);
    node_assert_1.strict.equal(linuxCommandConfig.refreshEnabled, false);
    node_assert_1.strict.equal(explicitOnConfig.refreshEnabled, true);
    node_assert_1.strict.equal(explicitOffConfig.refreshEnabled, false);
    node_assert_1.strict.deepEqual(relayConfig.relayUrls, [
        "wss://relay-a.example.com",
        "wss://relay-b.example.com/coderover",
    ]);
});
(0, node_test_1.test)("thread/start falls back once to the new-thread route when thread id is still unknown", async () => {
    const refreshCalls = [];
    const refresher = new coderover_desktop_refresher_1.CodeRoverDesktopRefresher({
        enabled: true,
        debounceMs: 0,
        fallbackNewThreadMs: 15,
        refreshExecutor: async (targetUrl) => {
            refreshCalls.push(targetUrl);
        },
    });
    refresher.handleInbound(JSON.stringify({
        method: "thread/start",
        params: {},
    }));
    await wait(40);
    node_assert_1.strict.deepEqual(refreshCalls, ["coderover://threads/new"]);
    refresher.handleTransportReset();
});
(0, node_test_1.test)("thread/started cancels the fallback and refreshes the concrete thread route", async () => {
    const refreshCalls = [];
    const watchedThreads = [];
    let stopCount = 0;
    const refresher = new coderover_desktop_refresher_1.CodeRoverDesktopRefresher({
        enabled: true,
        debounceMs: 0,
        fallbackNewThreadMs: 40,
        refreshExecutor: async (targetUrl) => {
            refreshCalls.push(targetUrl);
        },
        watchThreadRolloutFactory: ({ threadId }) => {
            watchedThreads.push(threadId);
            return {
                stop() {
                    stopCount += 1;
                },
                get threadId() {
                    return threadId;
                },
            };
        },
    });
    refresher.handleInbound(JSON.stringify({
        method: "thread/start",
        params: {},
    }));
    await wait(10);
    refresher.handleOutbound(JSON.stringify({
        method: "thread/started",
        params: {
            thread: {
                id: "thread-123",
            },
        },
    }));
    await wait(25);
    node_assert_1.strict.deepEqual(refreshCalls, ["coderover://threads/thread-123"]);
    node_assert_1.strict.deepEqual(watchedThreads, ["thread-123"]);
    await wait(30);
    node_assert_1.strict.deepEqual(refreshCalls, ["coderover://threads/thread-123"]);
    refresher.handleTransportReset();
    node_assert_1.strict.equal(stopCount, 1);
});
(0, node_test_1.test)("rollout growth refreshes are throttled during long runs", async () => {
    const refreshCalls = [];
    let watcherHooks = null;
    let currentTime = 0;
    const refresher = new coderover_desktop_refresher_1.CodeRoverDesktopRefresher({
        enabled: true,
        debounceMs: 0,
        midRunRefreshThrottleMs: 3_000,
        now: () => currentTime,
        refreshExecutor: async (targetUrl) => {
            refreshCalls.push(targetUrl);
        },
        watchThreadRolloutFactory: (hooks) => {
            watcherHooks = {
                threadId: hooks.threadId,
                onEvent: hooks.onEvent,
            };
            return {
                stop() { },
                get threadId() {
                    return hooks.threadId;
                },
            };
        },
    });
    const emitGrowth = (size) => {
        const hooks = watcherHooks;
        if (!hooks) {
            throw new Error("expected rollout watcher hooks");
        }
        hooks.onEvent({
            reason: "growth",
            threadId: hooks.threadId,
            rolloutPath: "/tmp/rollout-thread-456.jsonl",
            size,
        });
    };
    refresher.handleInbound(JSON.stringify({
        method: "turn/start",
        params: {
            threadId: "thread-456",
        },
    }));
    await wait(10);
    refreshCalls.length = 0;
    currentTime = 1_000;
    emitGrowth(10);
    await wait(10);
    node_assert_1.strict.deepEqual(refreshCalls, ["coderover://threads/thread-456"]);
    refreshCalls.length = 0;
    currentTime = 2_000;
    emitGrowth(15);
    await wait(10);
    node_assert_1.strict.deepEqual(refreshCalls, []);
    currentTime = 4_500;
    emitGrowth(20);
    await wait(10);
    node_assert_1.strict.deepEqual(refreshCalls, ["coderover://threads/thread-456"]);
});
(0, node_test_1.test)("turn/completed bypasses duplicate-target dedupe and still stops the watcher", async () => {
    const refreshCalls = [];
    let stopCount = 0;
    let currentTime = 3_000;
    const refresher = new coderover_desktop_refresher_1.CodeRoverDesktopRefresher({
        enabled: true,
        debounceMs: 0,
        now: () => currentTime,
        refreshExecutor: async (targetUrl) => {
            refreshCalls.push(targetUrl);
        },
        watchThreadRolloutFactory: () => ({
            stop() {
                stopCount += 1;
            },
            get threadId() {
                return "thread-789";
            },
        }),
    });
    refresher.handleInbound(JSON.stringify({
        method: "turn/start",
        params: {
            threadId: "thread-789",
        },
    }));
    await wait(10);
    currentTime = 4_500;
    refresher.handleOutbound(JSON.stringify({
        method: "turn/completed",
        params: {
            threadId: "thread-789",
            turnId: "turn-789",
        },
    }));
    await wait(10);
    currentTime = 4_700;
    refresher.handleOutbound(JSON.stringify({
        method: "turn/completed",
        params: {
            threadId: "thread-789",
            turnId: "turn-789",
        },
    }));
    await wait(10);
    node_assert_1.strict.deepEqual(refreshCalls, [
        "coderover://threads/thread-789",
        "coderover://threads/thread-789",
    ]);
    node_assert_1.strict.equal(stopCount, 1);
});
(0, node_test_1.test)("turn/completed is retried after a slow in-flight refresh finishes", async () => {
    const refreshCalls = [];
    let releaseSlowRefresh;
    const refresher = new coderover_desktop_refresher_1.CodeRoverDesktopRefresher({
        enabled: true,
        debounceMs: 0,
        refreshExecutor: async (targetUrl) => {
            refreshCalls.push(targetUrl);
            if (refreshCalls.length === 1) {
                await new Promise((resolve) => {
                    releaseSlowRefresh = resolve;
                });
            }
        },
        watchThreadRolloutFactory: () => ({
            stop() { },
            get threadId() {
                return "thread-slow";
            },
        }),
    });
    refresher.handleInbound(JSON.stringify({
        method: "turn/start",
        params: {
            threadId: "thread-slow",
        },
    }));
    await wait(10);
    refresher.handleOutbound(JSON.stringify({
        method: "turn/completed",
        params: {
            threadId: "thread-slow",
            turnId: "turn-slow",
        },
    }));
    await wait(10);
    node_assert_1.strict.equal(refreshCalls.length, 1);
    const releaseRefresh = releaseSlowRefresh;
    releaseRefresh();
    await wait(20);
    node_assert_1.strict.deepEqual(refreshCalls, [
        "coderover://threads/thread-slow",
        "coderover://threads/thread-slow",
    ]);
});
(0, node_test_1.test)("completion refresh keeps its own thread target even if another thread queues behind it", async () => {
    const refreshCalls = [];
    let stopCount = 0;
    const refresher = new coderover_desktop_refresher_1.CodeRoverDesktopRefresher({
        enabled: true,
        debounceMs: 1_200,
        refreshExecutor: async (targetUrl) => {
            refreshCalls.push(targetUrl);
        },
        watchThreadRolloutFactory: ({ threadId }) => ({
            stop() {
                if (threadId === "thread-a") {
                    stopCount += 1;
                }
            },
            get threadId() {
                return threadId;
            },
        }),
    });
    refresher.handleInbound(JSON.stringify({
        method: "turn/start",
        params: { threadId: "thread-a" },
    }));
    await wait(10);
    refreshCalls.length = 0;
    refresher.clearRefreshTimer();
    refresher.handleOutbound(JSON.stringify({
        method: "turn/completed",
        params: {
            threadId: "thread-a",
            turnId: "turn-a",
        },
    }));
    refresher.handleInbound(JSON.stringify({
        method: "turn/start",
        params: { threadId: "thread-b" },
    }));
    refresher.clearRefreshTimer();
    await refresher.runPendingRefresh();
    await refresher.runPendingRefresh();
    node_assert_1.strict.deepEqual(refreshCalls, [
        "coderover://threads/thread-a",
        "coderover://threads/thread-b",
    ]);
    node_assert_1.strict.equal(stopCount, 1);
});
(0, node_test_1.test)("handleTransportReset cancels pending refreshes and clears watcher state", async () => {
    const refreshCalls = [];
    let stopCount = 0;
    const refresher = new coderover_desktop_refresher_1.CodeRoverDesktopRefresher({
        enabled: true,
        debounceMs: 30,
        refreshExecutor: async (targetUrl) => {
            refreshCalls.push(targetUrl);
        },
        watchThreadRolloutFactory: () => ({
            stop() {
                stopCount += 1;
            },
            get threadId() {
                return "thread-reset";
            },
        }),
    });
    refresher.handleInbound(JSON.stringify({
        method: "turn/start",
        params: {
            threadId: "thread-reset",
        },
    }));
    refresher.handleTransportReset();
    await wait(50);
    node_assert_1.strict.deepEqual(refreshCalls, []);
    node_assert_1.strict.equal(stopCount, 1);
});
(0, node_test_1.test)("handleTransportReset clears duplicate-target memory so the next refresh can run", async () => {
    const refreshCalls = [];
    let currentTime = 5_000;
    const refresher = new coderover_desktop_refresher_1.CodeRoverDesktopRefresher({
        enabled: true,
        debounceMs: 1_200,
        now: () => currentTime,
        refreshExecutor: async (targetUrl) => {
            refreshCalls.push(targetUrl);
        },
        watchThreadRolloutFactory: () => ({
            stop() { },
            get threadId() {
                return "thread-reset-dedupe";
            },
        }),
    });
    refresher.handleInbound(JSON.stringify({
        method: "turn/start",
        params: { threadId: "thread-reset-dedupe" },
    }));
    await wait(10);
    refresher.handleTransportReset();
    currentTime = 5_100;
    refresher.handleInbound(JSON.stringify({
        method: "turn/start",
        params: { threadId: "thread-reset-dedupe" },
    }));
    await wait(10);
    node_assert_1.strict.deepEqual(refreshCalls, [
        "coderover://threads/thread-reset-dedupe",
        "coderover://threads/thread-reset-dedupe",
    ]);
});
(0, node_test_1.test)("desktop refresh disables itself after a desktop-unavailable AppleScript failure", async () => {
    let attempts = 0;
    let stopCount = 0;
    const refresher = new coderover_desktop_refresher_1.CodeRoverDesktopRefresher({
        enabled: true,
        debounceMs: 0,
        refreshBackend: "applescript",
        refreshExecutor: async () => {
            attempts += 1;
            throw new Error("Unable to find application named CodeRover");
        },
        watchThreadRolloutFactory: () => ({
            stop() {
                stopCount += 1;
            },
            get threadId() {
                return "thread-disable";
            },
        }),
    });
    refresher.handleInbound(JSON.stringify({
        method: "turn/start",
        params: {
            threadId: "thread-disable-1",
        },
    }));
    await wait(10);
    refresher.handleInbound(JSON.stringify({
        method: "turn/start",
        params: {
            threadId: "thread-disable-2",
        },
    }));
    await wait(10);
    node_assert_1.strict.equal(attempts, 1);
    node_assert_1.strict.equal(stopCount, 1);
    node_assert_1.strict.equal(refresher.runtimeRefreshAvailable, false);
});
(0, node_test_1.test)("custom refresh commands only disable after repeated failures", async () => {
    let attempts = 0;
    const refresher = new coderover_desktop_refresher_1.CodeRoverDesktopRefresher({
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
            method: "turn/start",
            params: { threadId },
        }));
        await wait(10);
    }
    node_assert_1.strict.equal(attempts, 3);
    node_assert_1.strict.equal(refresher.runtimeRefreshAvailable, false);
});
(0, node_test_1.test)("rollout watcher retries transient filesystem errors before succeeding", async () => {
    const events = [];
    const errors = [];
    let readdirCalls = 0;
    const watcher = (0, rollout_watch_1.createThreadRolloutActivityWatcher)({
        threadId: "thread-watch-ok",
        intervalMs: 5,
        lookupTimeoutMs: 100,
        idleTimeoutMs: 100,
        transientErrorRetryLimit: 2,
        fsModule: {
            existsSync: () => true,
            readdirSync: () => {
                readdirCalls += 1;
                if (readdirCalls === 1) {
                    const error = new Error("temporary missing dir");
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
    node_assert_1.strict.equal(errors.length, 0);
    node_assert_1.strict.equal(events[0]?.reason, "materialized");
});
(0, node_test_1.test)("rollout watcher stops after repeated transient filesystem failures", async () => {
    const errors = [];
    let currentTime = 0;
    const watcher = (0, rollout_watch_1.createThreadRolloutActivityWatcher)({
        threadId: "thread-watch-fail",
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
                const error = new Error("still missing");
                error.code = "ENOENT";
                throw error;
            },
            statSync: () => ({ size: 0 }),
        },
        onError: (error) => errors.push(error),
    });
    await wait(25);
    watcher.stop();
    node_assert_1.strict.equal(errors.length, 1);
});
