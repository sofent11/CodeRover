// FILE: rollout-watch.test.ts
// Purpose: Verifies rollout-backed context-window reads used by the Codex status sheet.

import { test } from "bun:test";
import { strict as assert } from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { readLatestContextWindowUsage } from "../src/rollout-watch";
import { handleContextWindowReadRequest } from "../src/coderover-context-window-handler";

test("readLatestContextWindowUsage returns the newest usage snapshot from a session rollout", () => {
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
    sessionId: "thread-123",
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

test("handleContextWindowReadRequest returns usage payload for _coderover/context_window/read", async () => {
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
    const response = await new Promise<{ handled: boolean; rawResponse: string }>((resolve) => {
      const handled = handleContextWindowReadRequest(
        JSON.stringify({
          id: "req-1",
          method: "_coderover/context_window/read",
          params: { sessionId: "thread-ctx" },
        }),
        (rawResponse) => resolve({ handled, rawResponse })
      );
    });

    assert.equal(response.handled, true);
    assert.deepEqual(JSON.parse(response.rawResponse), {
      id: "req-1",
      result: {
        sessionId: "thread-ctx",
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
