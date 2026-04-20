// FILE: copilot-adapter.test.ts
// Purpose: Verifies GitHub Copilot session import and local history hydration.
// Layer: Unit test
// Exports: bun:test suite
// Depends on: bun:test, node:assert/strict, fs, os, path, ../src/providers/copilot-adapter, ../src/runtime-store

import { test } from "bun:test";
import { strict as assert } from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { createCopilotAdapter } from "../src/providers/copilot-adapter";
import { createRuntimeStore } from "../src/runtime-store";

function writeCopilotSession(
  homeDir: string,
  sessionId: string,
  workspaceYaml: string,
  events: unknown[]
): void {
  const sessionDir = path.join(homeDir, ".copilot", "session-state", sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "workspace.yaml"), workspaceYaml);
  fs.writeFileSync(
    path.join(sessionDir, "events.jsonl"),
    `${events.map((entry) => JSON.stringify(entry)).join("\n")}\n`
  );
}

test("syncImportedThreads builds Copilot thread metadata from workspace.yaml", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "coderover-copilot-store-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "coderover-copilot-home-"));
  const store = createRuntimeStore({ baseDir });
  const adapter = createCopilotAdapter({ store, homeDir });

  try {
    writeCopilotSession(
      homeDir,
      "session-1",
      [
        "id: session-1",
        "cwd: /tmp/copilot-project",
        "summary: Investigate failing tests",
        "created_at: 2026-04-19T10:00:00.000Z",
        "updated_at: 2026-04-19T10:05:00.000Z",
      ].join("\n"),
      []
    );

    await adapter.syncImportedThreads();

    const threads = store.listThreadMetas();
    assert.equal(threads.length, 1);
    assert.equal(threads[0]?.id, "copilot:session-1");
    assert.equal(threads[0]?.provider, "copilot");
    assert.equal(threads[0]?.providerSessionId, "session-1");
    assert.equal(threads[0]?.cwd, "/tmp/copilot-project");
    assert.equal(threads[0]?.title, "Investigate failing tests");
    assert.equal(threads[0]?.metadata?.providerTitle, "GitHub Copilot");
  } finally {
    store.shutdown();
    fs.rmSync(baseDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("hydrateThread restores Copilot user, assistant, and tool history from events.jsonl", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "coderover-copilot-store-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "coderover-copilot-home-"));
  const store = createRuntimeStore({ baseDir });
  const adapter = createCopilotAdapter({ store, homeDir });

  try {
    writeCopilotSession(
      homeDir,
      "session-2",
      [
        "id: session-2",
        "cwd: /tmp/copilot-history",
        "summary: Restore Copilot session",
        "created_at: 2026-04-19T11:00:00.000Z",
        "updated_at: 2026-04-19T11:10:00.000Z",
      ].join("\n"),
      [
        {
          id: "evt-user",
          type: "user.message",
          timestamp: "2026-04-19T11:00:01.000Z",
          data: {
            interactionId: "turn-1",
            content: "Check the working directory",
          },
        },
        {
          id: "evt-start",
          type: "assistant.turn_start",
          timestamp: "2026-04-19T11:00:02.000Z",
          data: {
            interactionId: "turn-1",
          },
        },
        {
          id: "evt-tool-start",
          type: "tool.execution_start",
          timestamp: "2026-04-19T11:00:03.000Z",
          data: {
            interactionId: "turn-1",
            toolCallId: "tool-1",
            toolName: "Print working directory",
            arguments: {
              command: "pwd",
            },
          },
        },
        {
          id: "evt-tool-end",
          type: "tool.execution_complete",
          timestamp: "2026-04-19T11:00:04.000Z",
          data: {
            interactionId: "turn-1",
            toolCallId: "tool-1",
            toolName: "Print working directory",
            arguments: {
              command: "pwd",
            },
            result: "/tmp/copilot-history",
            success: true,
          },
        },
        {
          id: "evt-assistant",
          type: "assistant.message",
          timestamp: "2026-04-19T11:00:05.000Z",
          data: {
            interactionId: "turn-1",
            content: "The working directory is /tmp/copilot-history",
          },
        },
        {
          id: "evt-end",
          type: "assistant.turn_end",
          timestamp: "2026-04-19T11:00:06.000Z",
          data: {
            interactionId: "turn-1",
          },
        },
      ]
    );

    const threadMeta = store.createThread({
      id: "copilot:session-2",
      provider: "copilot",
      providerSessionId: "session-2",
      title: "Restore Copilot session",
      preview: "Restore Copilot session",
      cwd: "/tmp/copilot-history",
      createdAt: "2026-04-19T11:00:00.000Z",
      updatedAt: "2026-04-19T11:10:00.000Z",
    });

    await adapter.hydrateThread(threadMeta);

    const history = store.getThreadHistory("copilot:session-2");
    const refreshedMeta = store.getThreadMeta("copilot:session-2");
    assert.ok(history);
    assert.equal(history?.turns.length, 1);
    assert.equal(history?.turns[0]?.status, "completed");
    assert.deepEqual(history?.turns[0]?.items.map((item) => item.type), [
      "user_message",
      "command_execution",
      "agent_message",
    ]);
    assert.equal(history?.turns[0]?.items[0]?.text, "Check the working directory");
    assert.equal(history?.turns[0]?.items[1]?.command, "pwd");
    assert.equal(history?.turns[0]?.items[1]?.status, "completed");
    assert.equal(history?.turns[0]?.items[1]?.text, "/tmp/copilot-history");
    assert.equal(
      history?.turns[0]?.items[2]?.text,
      "The working directory is /tmp/copilot-history"
    );
    assert.equal(refreshedMeta?.preview, "Check the working directory");
    assert.equal(refreshedMeta?.metadata?.copilotSessionUpdatedAt, "2026-04-19T11:10:00.000Z");
    assert.equal(typeof refreshedMeta?.metadata?.copilotHistorySyncedAt, "string");
    assert.equal(typeof refreshedMeta?.metadata?.copilotHistoryFingerprint, "string");
  } finally {
    store.shutdown();
    fs.rmSync(baseDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("hydrateThread refreshes Copilot history when session-state files change", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "coderover-copilot-store-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "coderover-copilot-home-"));
  const store = createRuntimeStore({ baseDir });
  const adapter = createCopilotAdapter({ store, homeDir });

  try {
    writeCopilotSession(
      homeDir,
      "session-3",
      [
        "id: session-3",
        "cwd: /tmp/copilot-refresh",
        "summary: Refresh Copilot session",
        "created_at: 2026-04-19T12:00:00.000Z",
        "updated_at: 2026-04-19T12:01:00.000Z",
      ].join("\n"),
      [
        {
          id: "evt-user",
          type: "user.message",
          timestamp: "2026-04-19T12:00:01.000Z",
          data: {
            interactionId: "turn-1",
            content: "Show status",
          },
        },
        {
          id: "evt-assistant",
          type: "assistant.message",
          timestamp: "2026-04-19T12:00:02.000Z",
          data: {
            interactionId: "turn-1",
            content: "Working on it",
          },
        },
      ]
    );

    const threadMeta = store.createThread({
      id: "copilot:session-3",
      provider: "copilot",
      providerSessionId: "session-3",
      title: "Refresh Copilot session",
      preview: "Refresh Copilot session",
      cwd: "/tmp/copilot-refresh",
      createdAt: "2026-04-19T12:00:00.000Z",
      updatedAt: "2026-04-19T12:01:00.000Z",
    });

    await adapter.hydrateThread(threadMeta);

    const sessionDir = path.join(homeDir, ".copilot", "session-state", "session-3");
    fs.writeFileSync(
      path.join(sessionDir, "workspace.yaml"),
      [
        "id: session-3",
        "cwd: /tmp/copilot-refresh",
        "summary: Refresh Copilot session",
        "created_at: 2026-04-19T12:00:00.000Z",
        "updated_at: 2026-04-19T12:02:00.000Z",
      ].join("\n")
    );
    fs.appendFileSync(
      path.join(sessionDir, "events.jsonl"),
      `${JSON.stringify({
        id: "evt-assistant-2",
        type: "assistant.message",
        timestamp: "2026-04-19T12:00:03.000Z",
        data: {
          interactionId: "turn-1",
          content: "Status is green",
        },
      })}\n`
    );

    await adapter.hydrateThread(threadMeta);

    const refreshedHistory = store.getThreadHistory("copilot:session-3");
    const refreshedMeta = store.getThreadMeta("copilot:session-3");
    assert.deepEqual(
      refreshedHistory?.turns[0]?.items.map((item) => item.text),
      ["Show status", "Working on it", "Status is green"]
    );
    assert.equal(refreshedMeta?.updatedAt, "2026-04-19T12:02:00.000Z");
  } finally {
    store.shutdown();
    fs.rmSync(baseDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
