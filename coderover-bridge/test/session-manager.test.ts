import { test } from "bun:test";
import { strict as assert } from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { createRuntimeStore } from "../src/runtime-store";
import { createSessionRuntimeIndex } from "../src/runtime-engine/session-runtime-index";
import { createAcpSessionManager } from "../src/acp/session-manager";
import type { AcpAgentDefinition, AcpAgentRegistry } from "../src/acp/agent-registry";
import type { AcpProcessClient } from "../src/acp/process-client";

const TEST_AGENT: AcpAgentDefinition = {
  id: "claude",
  name: "Claude",
  command: "mock-claude-acp",
  description: "Mock Claude ACP adapter",
};

function createTestRegistry(): AcpAgentRegistry {
  return {
    defaultAgentId: TEST_AGENT.id,
    get(agentId: unknown) {
      return agentId === TEST_AGENT.id ? { ...TEST_AGENT } : null;
    },
    list() {
      return [{ ...TEST_AGENT }];
    },
  };
}

test("ACP session manager hydrates provider-native session lists and polls from cached cursors", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "coderover-session-manager-"));
  const codexHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "coderover-session-manager-codex-"));
  const store = createRuntimeStore({ baseDir, codexHomeDir });
  const sessionRuntimeIndex = createSessionRuntimeIndex({ baseDir });

  let activeSyncPhase: "bootstrap" | "poll" = "bootstrap";
  const activeCalls: Array<string | null> = [];
  const client: AcpProcessClient = {
    async cancel() {},
    close() {},
    async initialize() {
      return {};
    },
    isRunning() {
      return true;
    },
    async listModels() {
      return { items: [] };
    },
    async listSessions(params: Record<string, unknown> = {}) {
      const archived = Boolean(params.archived);
      const cursor = typeof params.cursor === "string" && params.cursor.trim() ? params.cursor.trim() : null;

      if (archived) {
        return {
          sessions: [],
          nextCursor: null,
        };
      }

      activeCalls.push(cursor);
      if (activeSyncPhase === "bootstrap") {
        if (cursor == null) {
          return {
            sessions: [
              {
                sessionId: "provider-session-1",
                title: "Imported Session 1",
                cwd: "/tmp/project-1",
                updatedAt: "2026-03-17T10:00:00.000Z",
              },
            ],
            nextCursor: "cursor-2",
          };
        }

        return {
          sessions: [
            {
              sessionId: "provider-session-2",
              title: "Imported Session 2",
              cwd: "/tmp/project-2",
              updatedAt: "2026-03-17T09:00:00.000Z",
            },
          ],
          nextCursor: null,
        };
      }

      return {
        sessions: [
          {
            sessionId: "provider-session-3",
            title: "Polled Session 3",
            cwd: "/tmp/project-3",
            updatedAt: "2026-03-17T11:00:00.000Z",
          },
        ],
        nextCursor: null,
      };
    },
    async loadSession() {
      return {};
    },
    async newSession() {
      return { sessionId: "provider-created-session" };
    },
    onServerRequest() {
      return () => false;
    },
    onSessionUpdate() {
      return () => false;
    },
    async prompt() {
      return {};
    },
    async respondError() {},
    async respondSuccess() {},
    async resumeSession() {
      return {};
    },
    async setConfigOption() {
      return {};
    },
    async setMode() {
      return {};
    },
    async setModel() {
      return {};
    },
  };

  const manager = createAcpSessionManager({
    registry: createTestRegistry(),
    store,
    sessionRuntimeIndex,
    clientFactory: () => client,
    pollIntervalMs: 0,
  });

  try {
    await manager.ensureSessionCacheReady({ archived: false });

    const initialSessions = manager.listSessions({ archived: false });
    assert.equal(initialSessions.length, 2);
    assert.equal(initialSessions[0]?.providerSessionId, "provider-session-1");
    assert.equal(initialSessions[1]?.providerSessionId, "provider-session-2");
    assert.deepEqual(activeCalls, [null, "cursor-2"]);

    const activeCursorState = store.getProviderSessionListState("claude", false);
    assert.equal(activeCursorState.nextCursor, null);
    assert.ok(activeCursorState.syncedAt);

    activeSyncPhase = "poll";
    await manager.refreshSessions({ archived: false });

    const polledSessions = manager.listSessions({ archived: false });
    assert.equal(polledSessions.length, 3);
    assert.ok(polledSessions.some((session) => session.providerSessionId === "provider-session-3"));
    assert.equal(activeCalls[activeCalls.length - 1], null);
  } finally {
    manager.shutdown();
    sessionRuntimeIndex.shutdown();
    store.shutdown();
    fs.rmSync(baseDir, { recursive: true, force: true });
    fs.rmSync(codexHomeDir, { recursive: true, force: true });
  }
});
