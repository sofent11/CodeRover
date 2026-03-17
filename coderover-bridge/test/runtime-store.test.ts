// FILE: runtime-store.test.ts
// Purpose: Verifies provider-aware overlay persistence for managed runtime threads.

import { test } from "bun:test";
import { strict as assert } from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { createRuntimeStore, type RuntimeStore } from "../src/runtime-store";

function createTempStore(): { store: RuntimeStore; cleanup(): void } {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "coderover-runtime-store-"));
  const store = createRuntimeStore({ baseDir });
  return {
    store,
    cleanup() {
      store.shutdown();
      fs.rmSync(baseDir, { recursive: true, force: true });
    },
  };
}

test("runtime store persists provider session mappings and session history", () => {
  const fixture = createTempStore();

  try {
    const created = fixture.store.createSession({
      provider: "claude",
      providerSessionId: "session-1",
      title: "Claude thread",
      cwd: "/tmp/project-a",
    });

    assert.match(created.id, /^claude:/);
    assert.equal(fixture.store.findSessionIdByProviderSession("claude", "session-1"), created.id);

    fixture.store.bindProviderSession(created.id, "claude", "session-2");
    assert.equal(fixture.store.findSessionIdByProviderSession("claude", "session-1"), null);
    assert.equal(fixture.store.findSessionIdByProviderSession("claude", "session-2"), created.id);

    fixture.store.saveSessionHistory(created.id, {
      sessionId: created.id,
      turns: [
        {
          id: "turn-1",
          createdAt: "2026-03-13T00:00:00.000Z",
          status: "completed",
          items: [
            {
              id: "item-1",
              type: "agent_message",
              role: "assistant",
              text: "hello",
              content: [{ type: "text", text: "hello" }],
            },
          ],
        },
      ],
    });

    const history = fixture.store.getSessionHistory(created.id);
    assert.equal(history?.turns?.length, 1);
    assert.equal(history?.turns?.[0]?.items?.[0]?.text, "hello");
  } finally {
    fixture.cleanup();
  }
});

test("runtime store keeps archive and name overlays in the session index", () => {
  const fixture = createTempStore();

  try {
    const created = fixture.store.createSession({
      provider: "gemini",
      providerSessionId: "chat-1",
      title: "Gemini thread",
      preview: "draft",
    });

    fixture.store.updateSessionMeta(created.id, (entry) => ({
      ...entry,
      name: "Renamed Gemini thread",
      archived: true,
    }));

    const updated = fixture.store.getSessionMeta(created.id);
    assert.equal(updated?.name, "Renamed Gemini thread");
    assert.equal(updated?.archived, true);

    fixture.store.deleteSession(created.id);
    assert.equal(fixture.store.getSessionMeta(created.id), null);
    assert.equal(fixture.store.findSessionIdByProviderSession("gemini", "chat-1"), null);
  } finally {
    fixture.cleanup();
  }
});

test("runtime store loads legacy snake_case thread metadata and history items", () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "coderover-runtime-store-legacy-"));

  try {
    fs.mkdirSync(path.join(baseDir, "threads"), { recursive: true });
    fs.writeFileSync(path.join(baseDir, "index.json"), JSON.stringify({
      version: 1,
      threads: {
        "claude:legacy-thread": {
          id: "claude:legacy-thread",
          provider: "claude",
          provider_session_id: "session-legacy",
          title: "Legacy Claude thread",
          first_prompt: "Initial prompt",
          cwd: "/tmp/legacy-project",
          created_at: "2026-03-10T00:00:00.000Z",
          updated_at: "2026-03-11T00:00:00.000Z",
          archived: false,
        },
      },
      providerSessions: {},
    }, null, 2));
    fs.writeFileSync(path.join(baseDir, "threads", "claude:legacy-thread.json"), JSON.stringify({
      thread_id: "claude:legacy-thread",
      turns: [
        {
          turn_id: "turn-legacy",
          created_at: "2026-03-11T01:00:00.000Z",
          status: "completed",
          items: [
            {
              item_id: "item-legacy",
              type: "agent_message",
              role: "assistant",
              text: "legacy hello",
              content: [{ type: "text", text: "legacy hello" }],
              explanation: "keep me",
              file_changes: [{ path: "README.md" }],
            },
          ],
        },
      ],
    }, null, 2));

    const store = createRuntimeStore({ baseDir });
    try {
      const thread = store.getSessionMeta("claude:legacy-thread");
      assert.equal(thread?.providerSessionId, "session-legacy");
      assert.equal(thread?.preview, "Initial prompt");
      assert.equal(store.findSessionIdByProviderSession("claude", "session-legacy"), "claude:legacy-thread");

      const history = store.getSessionHistory("claude:legacy-thread");
      assert.equal(history?.sessionId, "claude:legacy-thread");
      assert.equal(history?.turns?.[0]?.id, "turn-legacy");
      assert.equal(history?.turns?.[0]?.items?.[0]?.id, "item-legacy");
      assert.equal(history?.turns?.[0]?.items?.[0]?.text, "legacy hello");
      assert.equal(history?.turns?.[0]?.items?.[0]?.explanation, "keep me");
      assert.deepEqual(history?.turns?.[0]?.items?.[0]?.fileChanges, [{ path: "README.md" }]);
    } finally {
      store.shutdown();
    }
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});
