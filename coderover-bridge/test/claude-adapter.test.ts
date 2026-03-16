// FILE: claude-adapter.test.ts
// Purpose: Verifies Claude session imports refresh cached history when the SDK reports newer data.
// Layer: Unit test

import { test } from "bun:test";
import { strict as assert } from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { createClaudeAdapter } from "../src/providers/claude-adapter";
import { createRuntimeStore } from "../src/runtime-store";

function createSdkStub(messagesBySessionId: Record<string, unknown[]>) {
  return {
    listSessions: async () => [
      {
        sessionId: "session-1",
        customTitle: "Claude thread",
        summary: "latest summary",
        firstPrompt: "latest prompt",
        cwd: "/tmp/project",
        lastModified: "2026-03-15T10:16:00.000Z",
      },
    ],
    getSessionMessages: async (sessionId: string) => messagesBySessionId[sessionId] || [],
    query() {
      throw new Error("query should not be called in this test");
    },
  };
}

test("hydrateThread refreshes cached Claude history when session lastModified advances", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "coderover-claude-adapter-"));
  const store = createRuntimeStore({ baseDir });

  try {
    const adapter = createClaudeAdapter({
      store,
      sdkLoader: async () => createSdkStub({
        "session-1": [
          {
            uuid: "user-1",
            type: "user",
            message: { content: [{ type: "text", text: "new user prompt" }] },
          },
          {
            uuid: "assistant-1",
            type: "assistant",
            message: { content: [{ type: "text", text: "latest assistant reply" }] },
          },
        ],
      }),
    });

    const thread = store.createThread({
      id: "claude:thread-1",
      provider: "claude",
      providerSessionId: "session-1",
      title: "Claude thread",
      updatedAt: "2026-03-15T10:10:00.000Z",
      metadata: {
        providerTitle: "Claude Code",
        claudeSessionLastModified: "2026-03-15T10:16:00.000Z",
        claudeHistorySyncedAt: "2026-03-15T10:10:00.000Z",
      },
    });

    store.saveThreadHistory(thread.id, {
      threadId: thread.id,
      turns: [
        {
          id: "old-turn",
          createdAt: "2026-03-15T10:10:00.000Z",
          status: "completed",
          items: [
            {
              id: "old-user",
              type: "user_message",
              role: "user",
              createdAt: "2026-03-15T10:10:00.000Z",
              content: [{ type: "text", text: "stale prompt" }],
              text: "stale prompt",
            },
          ],
        },
      ],
    });

    await adapter.hydrateThread(thread);

    const refreshedHistory = store.getThreadHistory(thread.id);
    assert.equal(refreshedHistory?.turns.length, 1);
    assert.equal(refreshedHistory?.turns[0]?.items.length, 2);
    assert.equal(refreshedHistory?.turns[0]?.items[0]?.text, "new user prompt");
    assert.equal(refreshedHistory?.turns[0]?.items[1]?.text, "latest assistant reply");

    const refreshedThread = store.getThreadMeta(thread.id);
    assert.equal(
      refreshedThread?.metadata?.claudeHistorySyncedAt,
      "2026-03-15T10:16:00.000Z"
    );
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test("hydrateThread excludes Claude tool result payloads from visible assistant text", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "coderover-claude-adapter-"));
  const store = createRuntimeStore({ baseDir });

  try {
    const adapter = createClaudeAdapter({
      store,
      sdkLoader: async () => createSdkStub({
        "session-1": [
          {
            uuid: "assistant-1",
            type: "assistant",
            message: {
              content: [
                { type: "tool_result", content: "1→// FILE: TurnComposerView.swift" },
                { type: "text", text: "我来检查 iOS 和 Android 的差异。" },
              ],
            },
          },
        ],
      }),
    });

    const thread = store.createThread({
      id: "claude:thread-2",
      provider: "claude",
      providerSessionId: "session-1",
      title: "Claude thread",
      updatedAt: "2026-03-15T10:10:00.000Z",
      metadata: {
        providerTitle: "Claude Code",
        claudeSessionLastModified: "2026-03-15T10:16:00.000Z",
      },
    });

    await adapter.hydrateThread(thread);

    const refreshedHistory = store.getThreadHistory(thread.id);
    assert.equal(refreshedHistory?.turns.length, 1);
    assert.equal(refreshedHistory?.turns[0]?.items.length, 1);
    assert.equal(
      refreshedHistory?.turns[0]?.items[0]?.text,
      "我来检查 iOS 和 Android 的差异。"
    );
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test("hydrateThread preserves Claude thinking blocks as reasoning items", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "coderover-claude-adapter-"));
  const store = createRuntimeStore({ baseDir });

  try {
    const adapter = createClaudeAdapter({
      store,
      sdkLoader: async () => createSdkStub({
        "session-1": [
          {
            uuid: "assistant-thinking-1",
            type: "assistant",
            message: {
              content: [
                { type: "thinking", thinking: "先检查历史同步逻辑。" },
                { type: "text", text: "我先排查会话刷新问题。" },
              ],
            },
          },
        ],
      }),
    });

    const thread = store.createThread({
      id: "claude:thread-3",
      provider: "claude",
      providerSessionId: "session-1",
      title: "Claude thread",
      updatedAt: "2026-03-15T10:10:00.000Z",
      metadata: {
        providerTitle: "Claude Code",
        claudeSessionLastModified: "2026-03-15T10:16:00.000Z",
      },
    });

    await adapter.hydrateThread(thread);

    const refreshedHistory = store.getThreadHistory(thread.id);
    assert.equal(refreshedHistory?.turns.length, 1);
    assert.equal(refreshedHistory?.turns[0]?.items.length, 2);
    assert.equal(refreshedHistory?.turns[0]?.items[0]?.type, "reasoning");
    assert.equal(refreshedHistory?.turns[0]?.items[0]?.text, "先检查历史同步逻辑。");
    assert.equal(refreshedHistory?.turns[0]?.items[1]?.type, "agent_message");
    assert.equal(refreshedHistory?.turns[0]?.items[1]?.text, "我先排查会话刷新问题。");
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});
