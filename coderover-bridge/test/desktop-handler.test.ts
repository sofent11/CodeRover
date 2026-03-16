// FILE: desktop-handler.test.ts
// Purpose: Verifies explicit desktop restart routing and provider/platform errors for bridge desktop methods.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { handleDesktopRequest } from "../src/desktop-handler";

function waitForTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("desktop/restartApp relaunches Codex for the requested thread", async () => {
  const executorCalls: Array<[string, readonly string[] | undefined]> = [];
  const responses: Array<Record<string, any>> = [];
  let running = true;

  const handled = handleDesktopRequest(JSON.stringify({
    id: "restart-1",
    method: "desktop/restartApp",
    params: {
      provider: "codex",
      threadId: "thread-123",
    },
  }), (response) => {
    responses.push(JSON.parse(response) as Record<string, any>);
  }, {
    platform: "darwin",
    codexBundleId: "com.openai.codex",
    codexAppPath: "/Applications/Codex.app",
    executor: async (file, args) => {
      executorCalls.push([file, args]);
      if (file === "pkill") {
        running = false;
      }
      return { stdout: "", stderr: "" };
    },
    isAppRunning: async () => running,
    sleepFn: async () => {},
    threadMaterializeWaitMs: 0,
  });

  assert.equal(handled, true);
  await waitForTick();

  assert.deepEqual(executorCalls, [
    ["pkill", ["-x", "Codex"]],
    ["open", ["-b", "com.openai.codex"]],
    ["open", ["-b", "com.openai.codex", "codex://threads/thread-123"]],
  ]);
  assert.deepEqual(responses, [{
    id: "restart-1",
    result: {
      success: true,
      provider: "codex",
      restarted: true,
      targetUrl: "codex://threads/thread-123",
      threadId: "thread-123",
      desktopKnown: false,
    },
  }]);
});

test("desktop/restartApp opens Codex when the desktop app is not already running", async () => {
  const executorCalls: Array<[string, readonly string[] | undefined]> = [];
  const responses: Array<Record<string, any>> = [];

  handleDesktopRequest(JSON.stringify({
    id: "restart-2",
    method: "desktop/restartApp",
    params: {
      provider: "codex",
      threadId: "thread-closed-app",
    },
  }), (response) => {
    responses.push(JSON.parse(response) as Record<string, any>);
  }, {
    platform: "darwin",
    codexBundleId: "com.openai.codex",
    codexAppPath: "/Applications/Codex.app",
    executor: async (file, args) => {
      executorCalls.push([file, args]);
      return { stdout: "", stderr: "" };
    },
    isAppRunning: async () => false,
    sleepFn: async () => {},
    threadMaterializeWaitMs: 0,
  });

  await waitForTick();

  assert.deepEqual(executorCalls, [
    ["open", ["-b", "com.openai.codex"]],
    ["open", ["-b", "com.openai.codex", "codex://threads/thread-closed-app"]],
  ]);
  assert.equal(responses[0]?.result?.restarted, false);
});

test("desktop/restartApp reports desktopKnown when rollout already exists", async () => {
  const executorCalls: Array<[string, readonly string[] | undefined]> = [];
  const responses: Array<Record<string, any>> = [];
  let running = true;

  const fakeFS = {
    existsSync(targetPath: string) {
      return targetPath.endsWith("/sessions");
    },
    readdirSync() {
      return [{
        isDirectory: () => false,
        isFile: () => true,
        name: "rollout-2026-thread-known.jsonl",
      }];
    },
    statSync() {
      return { size: 128 };
    },
  };

  handleDesktopRequest(JSON.stringify({
    id: "restart-3",
    method: "desktop/restartApp",
    params: {
      provider: "codex",
      threadId: "thread-known",
    },
  }), (response) => {
    responses.push(JSON.parse(response) as Record<string, any>);
  }, {
    platform: "darwin",
    env: { CODEROVER_HOME: "/tmp/coderover-home" },
    fsModule: fakeFS,
    executor: async (file, args) => {
      executorCalls.push([file, args]);
      if (file === "pkill") {
        running = false;
      }
      return { stdout: "", stderr: "" };
    },
    isAppRunning: async () => running,
    sleepFn: async () => {},
  });

  await waitForTick();

  assert.equal(executorCalls.length, 3);
  assert.equal(responses[0]?.result?.desktopKnown, true);
});

test("desktop/restartApp returns a bridge error when thread id is missing", async () => {
  const responses: Array<Record<string, any>> = [];

  handleDesktopRequest(JSON.stringify({
    id: "restart-4",
    method: "desktop/restartApp",
    params: {
      provider: "codex",
    },
  }), (response) => {
    responses.push(JSON.parse(response) as Record<string, any>);
  }, {
    platform: "darwin",
  });

  await waitForTick();

  assert.equal(responses.length, 1);
  assert.equal(responses[0]?.error?.data?.errorCode, "missing_thread_id");
});

test("desktop/restartApp refuses unsupported providers", async () => {
  const responses: Array<Record<string, any>> = [];

  handleDesktopRequest(JSON.stringify({
    id: "restart-5",
    method: "desktop/restartApp",
    params: {
      provider: "claude",
      threadId: "thread-claude",
    },
  }), (response) => {
    responses.push(JSON.parse(response) as Record<string, any>);
  });

  await waitForTick();

  assert.equal(responses.length, 1);
  assert.equal(responses[0]?.error?.data?.errorCode, "unsupported_provider");
});

test("desktop/restartApp refuses non-mac platforms", async () => {
  const responses: Array<Record<string, any>> = [];

  handleDesktopRequest(JSON.stringify({
    id: "restart-6",
    method: "desktop/restartApp",
    params: {
      provider: "codex",
      threadId: "thread-456",
    },
  }), (response) => {
    responses.push(JSON.parse(response) as Record<string, any>);
  }, {
    platform: "linux",
  });

  await waitForTick();

  assert.equal(responses.length, 1);
  assert.equal(responses[0]?.error?.data?.errorCode, "unsupported_platform");
});
