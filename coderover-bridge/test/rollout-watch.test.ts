// @ts-nocheck
export {};

// FILE: rollout-watch.test.js
// Purpose: Verifies rollout-backed context-window reads used by the Codex status sheet.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, fs, os, path, ../src/rollout-watch, ../src/thread-context-handler

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { readLatestContextWindowUsage } = require("../src/rollout-watch");
const { handleThreadContextRequest } = require("../src/thread-context-handler");

test("readLatestContextWindowUsage returns the newest usage snapshot from a thread rollout", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coderover-rollout-"));
  const sessionsRoot = path.join(root, "sessions", "2026", "03", "14");
  fs.mkdirSync(sessionsRoot, { recursive: true });

  const rolloutPath = path.join(sessionsRoot, "rollout-thread-123.jsonl");
  fs.writeFileSync(
    rolloutPath,
    [
      JSON.stringify({ type: "event", info: { tokens_used: 120, token_limit: 2000 } }),
      JSON.stringify({ type: "event", usage: { tokensUsed: 180, tokenLimit: 2000 } }),
      "",
    ].join("\n"),
    "utf8"
  );

  const result = readLatestContextWindowUsage({
    threadId: "thread-123",
    root: path.join(root, "sessions"),
  });

  assert.deepEqual(result, {
    rolloutPath,
    usage: {
      tokensUsed: 180,
      tokenLimit: 2000,
    },
  });

  fs.rmSync(root, { recursive: true, force: true });
});

test("handleThreadContextRequest returns usage payload for thread/contextWindow/read", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coderover-thread-context-"));
  const sessionsRoot = path.join(root, "sessions", "2026", "03", "14");
  fs.mkdirSync(sessionsRoot, { recursive: true });

  const rolloutPath = path.join(sessionsRoot, "rollout-thread-ctx.jsonl");
  fs.writeFileSync(
    rolloutPath,
    `${JSON.stringify({ usage: { tokensUsed: 42, tokenLimit: 1024 } })}\n`,
    "utf8"
  );

  const originalCoderoverHome = process.env.CODEROVER_HOME;
  process.env.CODEROVER_HOME = root;

  try {
    const response = await new Promise((resolve) => {
      const handled = handleThreadContextRequest(
        JSON.stringify({
          id: "req-1",
          method: "thread/contextWindow/read",
          params: { threadId: "thread-ctx" },
        }),
        (rawResponse) => resolve({ handled, rawResponse })
      );
    });

    assert.equal(response.handled, true);
    assert.deepEqual(JSON.parse(response.rawResponse), {
      id: "req-1",
      result: {
        threadId: "thread-ctx",
        usage: {
          tokensUsed: 42,
          tokenLimit: 1024,
        },
        rolloutPath,
      },
    });
  } finally {
    if (originalCoderoverHome === undefined) {
      delete process.env.CODEROVER_HOME;
    } else {
      process.env.CODEROVER_HOME = originalCoderoverHome;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
