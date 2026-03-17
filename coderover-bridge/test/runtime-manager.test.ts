// FILE: runtime-manager.test.ts
// Purpose: Verifies ACP-native bridge runtime routing and local session journal behavior.

import { test } from "bun:test";
import { strict as assert } from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { createRuntimeManager } from "../src/runtime-manager";
import type { JsonRpcId } from "../src/bridge-types";
import { createRuntimeStore, type RuntimeStore, type RuntimeSessionMeta } from "../src/runtime-store";
import { createSessionRuntimeIndex, type SessionRuntimeIndex } from "../src/runtime-engine/session-runtime-index";
import type { AcpSessionManager } from "../src/acp/session-manager";

type RuntimeManager = ReturnType<typeof createRuntimeManager>;
type UnknownRecord = Record<string, unknown>;

interface RpcMessage {
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, any>;
  result?: any;
  error?: any;
}

interface ManagerFixture {
  baseDir: string;
  manager: RuntimeManager;
  messages: RpcMessage[];
  cleanup(): void;
}

function createManagerFixture(
  acpSessionManagerFactory?: (deps: {
    store: RuntimeStore;
    sessionRuntimeIndex: SessionRuntimeIndex;
  }) => AcpSessionManager
): ManagerFixture {
  const messages: RpcMessage[] = [];
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "coderover-runtime-manager-"));
  const store = createRuntimeStore({ baseDir });
  const sessionRuntimeIndex = createSessionRuntimeIndex({ baseDir });
  const acpSessionManager = (acpSessionManagerFactory || ((deps) => createMockAcpSessionManager(deps)))({
    store,
    sessionRuntimeIndex,
  });
  const manager = createRuntimeManager({
    sendApplicationMessage(message) {
      messages.push(JSON.parse(message) as RpcMessage);
    },
    storeBaseDir: baseDir,
    store,
    sessionRuntimeIndex,
    acpSessionManager,
  });

  return {
    baseDir,
    manager,
    messages,
    cleanup() {
      manager.shutdown();
      fs.rmSync(baseDir, { recursive: true, force: true });
    },
  };
}

function createMockAcpSessionManager({
  store,
  sessionRuntimeIndex,
  onPrompt,
  createProviderSessionId,
}: {
  store: RuntimeStore;
  sessionRuntimeIndex: SessionRuntimeIndex;
  onPrompt?: (params: {
    sessionId: string;
    prompt: unknown[];
    emitUpdate(update: UnknownRecord): void;
  }) => Promise<{ stopReason?: string | null; usage?: unknown }>;
  createProviderSessionId?: (agentId: string) => string;
}): AcpSessionManager {
  const sessionListeners = new Set<(notification: { sessionId: string | null; update: Record<string, unknown> }) => void>();
  const requestListeners = new Set<(request: {
    id: string | number | null;
    method: string;
    params: Record<string, unknown>;
  }) => void>();
  let nextId = 1;

  const promptHandler = onPrompt || (async ({ emitUpdate }) => {
    emitUpdate({
      sessionUpdate: "agent_message_chunk",
      messageId: "assistant-1",
      content: { type: "text", text: "Hello ACP" },
    });
    emitUpdate({
      sessionUpdate: "usage_update",
      usage: { outputTokens: 4 },
    });
    return {
      stopReason: "end_turn",
      usage: { outputTokens: 4 },
    };
  });

  const client = {
    async cancel() {},
    close() {},
    async initialize() {
      return {};
    },
    isRunning() {
      return true;
    },
    async listModels() {
      return {
        items: [{ id: "sonnet", model: "sonnet", title: "Sonnet" }],
      };
    },
    async loadSession() {
      return {};
    },
    async newSession() {
      return {
        sessionId: `provider-session-${nextId++}`,
      };
    },
    onServerRequest(listener: (request: {
      id: string | number | null;
      method: string;
      params: Record<string, unknown>;
    }) => void) {
      requestListeners.add(listener);
      return () => requestListeners.delete(listener);
    },
    onSessionUpdate(listener: (notification: {
      sessionId: string | null;
      update: Record<string, unknown>;
    }) => void) {
      sessionListeners.add(listener);
      return () => sessionListeners.delete(listener);
    },
    async prompt(params: Record<string, unknown>) {
      const sessionId = String(params.sessionId || "");
      return await promptHandler({
        sessionId,
        prompt: Array.isArray(params.prompt) ? params.prompt : [],
        emitUpdate(update) {
          sessionListeners.forEach((listener) => {
            listener({ sessionId, update });
          });
        },
      });
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

  return {
    async createSession({ agentId, cwd = null, modelId = null }) {
      const providerSessionId = createProviderSessionId
        ? createProviderSessionId(agentId)
        : `provider-${agentId}-${nextId++}`;
      const now = new Date().toISOString();
      const threadMeta = store.createSession({
        id: `${agentId}:${nextId++}`,
        provider: agentId,
        providerSessionId,
        cwd,
        model: modelId,
        createdAt: now,
        updatedAt: now,
        metadata: {
          acp: {
            mock: true,
          },
        },
      });
      sessionRuntimeIndex.upsert({
        sessionId: threadMeta.id,
        provider: threadMeta.provider,
        providerSessionId,
        engineSessionId: providerSessionId,
        cwd,
        model: modelId,
        ownerState: "idle",
        activeTurnId: null,
      });
      return threadMeta;
    },
    async getClient() {
      return client as Awaited<ReturnType<AcpSessionManager["getClient"]>>;
    },
    getSessionMeta(sessionId: string): RuntimeSessionMeta | null {
      return store.getSessionMeta(sessionId);
    },
    listSessions({ archived = false } = {}) {
      return store.listSessionMetas().filter((entry) => Boolean(entry.archived) === archived);
    },
    shutdown() {},
  };
}

async function request(
  fixture: ManagerFixture,
  id: JsonRpcId,
  method: string,
  params: Record<string, unknown>
): Promise<RpcMessage[]> {
  const beforeCount = fixture.messages.length;
  await fixture.manager.handleClientMessage(JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    params,
  }));
  return fixture.messages.slice(beforeCount);
}

function responseById(messages: RpcMessage[], id: JsonRpcId): RpcMessage {
  const message = messages.find((entry) => entry.id === id);
  assert.ok(message, `missing response for ${String(id)}`);
  return message!;
}

async function drainMicrotasks() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test("_coderover/agent/list advertises logical ACP agents", async () => {
  const fixture = createManagerFixture();
  try {
    const messages = await request(fixture, "agents-1", "_coderover/agent/list", {});
    const response = responseById(messages, "agents-1");
    assert.deepEqual(
      response.result.agents.map((agent: { id: string }) => agent.id),
      ["codex", "claude", "gemini"]
    );
    assert.equal(response.result.defaultAgentId, "codex");
    assert.equal(response.result.agents[1]._meta.coderover.supports.turnSteer, false);
    assert.equal(response.result.agents[2]._meta.coderover.supports.reasoningOptions, false);
  } finally {
    fixture.cleanup();
  }
});

test("initialize returns ACP protocol handshake metadata", async () => {
  const fixture = createManagerFixture();
  try {
    const messages = await request(fixture, "acp-init-1", "initialize", {
      protocolVersion: 1,
      clientInfo: { name: "test-client" },
    });
    const response = responseById(messages, "acp-init-1");
    assert.equal(response.result.protocolVersion, 1);
    assert.equal(response.result.agentInfo.name, "coderover_bridge");
    assert.equal(response.result.agentCapabilities.loadSession, true);
    assert.equal(response.result.agentCapabilities.promptCapabilities.image, true);
    assert.ok(response.result.agentCapabilities.sessionCapabilities.resume);
  } finally {
    fixture.cleanup();
  }
});

test("session/new and session/list expose ACP session summaries with bound agent ids", async () => {
  const fixture = createManagerFixture();
  try {
    const created = await request(fixture, "acp-session-new", "session/new", {
      cwd: "/tmp/acp-session-demo",
      modelId: "sonnet",
      _meta: { coderover: { agentId: "claude" } },
    });
    const createResponse = responseById(created, "acp-session-new");
    const sessionId = createResponse.result.sessionId;
    assert.match(sessionId, /^claude:/);
    assert.equal(createResponse.result._meta.coderover.agentId, "claude");

    const listed = await request(fixture, "acp-session-list", "session/list", {});
    const listResponse = responseById(listed, "acp-session-list");
    assert.equal(listResponse.result.sessions[0].sessionId, sessionId);
    assert.equal(listResponse.result.sessions[0]._meta.coderover.agentId, "claude");
    assert.equal(listResponse.result.sessions[0].cwd, "/tmp/acp-session-demo");
  } finally {
    fixture.cleanup();
  }
});

test("session/prompt streams ACP updates and session/load replays ACP history", async () => {
  const fixture = createManagerFixture(({ store, sessionRuntimeIndex }) =>
    createMockAcpSessionManager({
      store,
      sessionRuntimeIndex,
      onPrompt: async ({ emitUpdate }) => {
        emitUpdate({
          sessionUpdate: "agent_message_chunk",
          messageId: "assistant-1",
          content: { type: "text", text: "Hello ACP" },
        });
        emitUpdate({
          sessionUpdate: "session_info_update",
          _meta: {
            coderover: {
              preview: "Hello ACP",
            },
          },
        });
        return {
          stopReason: "end_turn",
          usage: { outputTokens: 4 },
        };
      },
    })
  );

  try {
    const created = await request(fixture, "acp-prompt-session-new", "session/new", {
      cwd: "/tmp/acp-prompt-demo",
      _meta: { coderover: { agentId: "claude" } },
    });
    const sessionId = responseById(created, "acp-prompt-session-new").result.sessionId;

    const prompted = await request(fixture, "acp-prompt-1", "session/prompt", {
      sessionId,
      messageId: "user-message-1",
      prompt: [{ type: "text", text: "Say hi" }],
    });
    const promptResponse = responseById(prompted, "acp-prompt-1");
    assert.equal(promptResponse.result.stopReason, "end_turn");
    assert.ok(prompted.some((message) => message.method === "session/update" && message.params?.update?.sessionUpdate === "user_message_chunk"));
    assert.ok(prompted.some((message) => message.method === "session/update" && message.params?.update?.sessionUpdate === "agent_message_chunk"));

    const loaded = await request(fixture, "acp-load-1", "session/load", { sessionId });
    const loadResponse = responseById(loaded, "acp-load-1");
    assert.equal(loadResponse.result._meta.coderover.agentId, "claude");
    assert.ok(loaded.some((message) =>
      message.method === "session/update"
      && message.params?.sessionId === sessionId
      && message.params?.update?.sessionUpdate === "agent_message_chunk"
    ));
  } finally {
    fixture.cleanup();
  }
});

test("_coderover/session/set_title and archive update ACP session listings", async () => {
  const fixture = createManagerFixture();
  try {
    const created = await request(fixture, "session-meta-new", "session/new", {
      cwd: "/tmp/session-meta-demo",
      _meta: { coderover: { agentId: "gemini" } },
    });
    const sessionId = responseById(created, "session-meta-new").result.sessionId;

    const renamed = await request(fixture, "session-set-title", "_coderover/session/set_title", {
      sessionId,
      title: "Renamed Session",
    });
    assert.equal(responseById(renamed, "session-set-title").result.thread.name, "Renamed Session");

    await request(fixture, "session-archive", "_coderover/session/archive", { sessionId });

    const activeList = responseById(await request(fixture, "session-list-active", "session/list", {}), "session-list-active");
    assert.equal(activeList.result.sessions.length, 0);

    const archivedList = responseById(
      await request(fixture, "session-list-archived", "session/list", { archived: true }),
      "session-list-archived"
    );
    assert.equal(archivedList.result.sessions.length, 1);
    assert.equal(archivedList.result.sessions[0].title, "Renamed Session");
    assert.equal(archivedList.result.sessions[0]._meta.coderover.archived, true);
  } finally {
    fixture.cleanup();
  }
});

test("session/resume returns ACP session state for an existing session", async () => {
  const fixture = createManagerFixture();
  try {
    const created = await request(fixture, "resume-session-new", "session/new", {
      cwd: "/tmp/resume-session-demo",
      modelId: "sonnet",
      _meta: { coderover: { agentId: "claude" } },
    });
    const sessionId = responseById(created, "resume-session-new").result.sessionId;

    const resumed = await request(fixture, "resume-session", "session/resume", { sessionId });
    const response = responseById(resumed, "resume-session");
    assert.equal(response.result._meta.coderover.agentId, "claude");
    assert.equal(response.result.models.currentModelId, "sonnet");
    assert.equal(response.result.modes.currentModeId, "default");
  } finally {
    fixture.cleanup();
  }
});

test("session/prompt persists session ownership metadata in the ACP journal", async () => {
  const fixture = createManagerFixture(({ store, sessionRuntimeIndex }) =>
    createMockAcpSessionManager({
      store,
      sessionRuntimeIndex,
      createProviderSessionId() {
        return "claude-session-1";
      },
      onPrompt: async ({ emitUpdate }) => {
        emitUpdate({
          sessionUpdate: "agent_message_chunk",
          messageId: "assistant-1",
          content: { type: "text", text: "Working on it" },
        });
        emitUpdate({
          sessionUpdate: "usage_update",
          usage: { outputTokens: 12 },
        });
        return { usage: { outputTokens: 12 } };
      },
    })
  );

  try {
    const createMessages = await request(fixture, "session-owner-new", "session/new", {
      cwd: "/tmp/session-owner-demo",
      modelId: "sonnet",
      _meta: { coderover: { agentId: "claude" } },
    });
    const sessionId = responseById(createMessages, "session-owner-new").result.sessionId as string;

    await request(fixture, "session-owner-prompt", "session/prompt", {
      sessionId,
      messageId: "user-message-1",
      prompt: [{ type: "text", text: "Investigate the issue" }],
    });
    await drainMicrotasks();

    const sessionIndexPath = path.join(fixture.baseDir, "session-runtime-index.json");
    for (let attempt = 0; attempt < 20 && !fs.existsSync(sessionIndexPath); attempt += 1) {
      await sleep(10);
    }
    const indexPayload = JSON.parse(fs.readFileSync(sessionIndexPath, "utf8")) as {
      sessions: Record<string, {
        provider: string;
        ownerState: string;
      providerSessionId: string | null;
      activeTurnId: string | null;
    }>;
    };
    const record = indexPayload.sessions[sessionId];
    assert.ok(record);
    assert.equal(record.provider, "claude");
    assert.equal(record.providerSessionId, "claude-session-1");
    assert.equal(record.ownerState, "idle");
    assert.equal(record.activeTurnId, null);
  } finally {
    fixture.cleanup();
  }
});
