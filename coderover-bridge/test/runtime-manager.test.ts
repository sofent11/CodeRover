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
import { RUNTIME_EXTENSION_METHODS } from "../src/runtime-manager/extension-router";

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
  codexHomeDir: string;
  manager: RuntimeManager;
  messages: RpcMessage[];
  store: RuntimeStore;
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
  const codexHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "coderover-runtime-manager-codex-"));
  const store = createRuntimeStore({ baseDir, codexHomeDir });
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
    codexHomeDir,
    manager,
    messages,
    store,
    cleanup() {
      manager.shutdown();
      fs.rmSync(baseDir, { recursive: true, force: true });
      fs.rmSync(codexHomeDir, { recursive: true, force: true });
    },
  };
}

function createMockAcpSessionManager({
  store,
  sessionRuntimeIndex,
  onPrompt,
  createProviderSessionId,
  onEnsureSessionCacheReady,
  onLoadSession,
  onResumeSession,
  getClientError = null,
  loadSessionError = null,
  resumeSessionError = null,
  listModelsError = null,
}: {
  store: RuntimeStore;
  sessionRuntimeIndex: SessionRuntimeIndex;
  onPrompt?: (params: {
    sessionId: string;
    prompt: unknown[];
    emitUpdate(update: UnknownRecord): void;
  }) => Promise<{ stopReason?: string | null; usage?: unknown }>;
  createProviderSessionId?: (agentId: string) => string;
  onEnsureSessionCacheReady?: (params: { archived?: boolean; force?: boolean }) => Promise<void>;
  onLoadSession?: (params: {
    sessionId: string;
    loadParams: Record<string, unknown>;
    emitUpdate(update: UnknownRecord): void;
  }) => Promise<void>;
  onResumeSession?: (params: {
    sessionId: string;
    resumeParams: Record<string, unknown>;
  }) => Promise<void>;
  getClientError?: Error | null;
  loadSessionError?: Error | null;
  resumeSessionError?: Error | null;
  listModelsError?: Error | null;
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
      if (listModelsError) {
        throw listModelsError;
      }
      return {
        items: [{ id: "sonnet", model: "sonnet", title: "Sonnet" }],
      };
    },
    async loadSession(params: Record<string, unknown>) {
      if (loadSessionError) {
        throw loadSessionError;
      }
      await onLoadSession?.({
        sessionId: String(params.sessionId || ""),
        loadParams: params,
        emitUpdate(update) {
          sessionListeners.forEach((listener) => {
            listener({ sessionId: String(params.sessionId || ""), update });
          });
        },
      });
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
    async resumeSession(params: Record<string, unknown>) {
      if (resumeSessionError) {
        throw resumeSessionError;
      }
      await onResumeSession?.({
        sessionId: String(params.sessionId || ""),
        resumeParams: params,
      });
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
    async ensureSessionCacheReady(params = {}) {
      await onEnsureSessionCacheReady?.(params);
    },
    async getClient() {
      if (getClientError) {
        throw getClientError;
      }
      return client as Awaited<ReturnType<AcpSessionManager["getClient"]>>;
    },
    getSessionMeta(sessionId: string): RuntimeSessionMeta | null {
      return store.getSessionMeta(sessionId);
    },
    listSessions({ archived = false } = {}) {
      return store.listSessionMetas().filter((entry) => Boolean(entry.archived) === archived);
    },
    async refreshSessions(params = {}) {
      await onEnsureSessionCacheReady?.(params);
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

test("session/list waits for ACP cache hydration before returning bridge-backed results", async () => {
  const fixture = createManagerFixture(({ store, sessionRuntimeIndex }) =>
    createMockAcpSessionManager({
      store,
      sessionRuntimeIndex,
      async onEnsureSessionCacheReady() {
        if (store.listSessionMetas().length > 0) {
          return;
        }

        const now = new Date().toISOString();
        store.createSession({
          id: "gemini:hydrated",
          provider: "gemini",
          providerSessionId: "provider-gemini-hydrated",
          title: "Hydrated Gemini Session",
          cwd: "/tmp/hydrated",
          createdAt: now,
          updatedAt: now,
        });
      },
    })
  );

  try {
    const listed = await request(fixture, "acp-session-list-hydrated", "session/list", {});
    const listResponse = responseById(listed, "acp-session-list-hydrated");
    assert.equal(listResponse.result.sessions.length, 1);
    assert.equal(listResponse.result.sessions[0].sessionId, "gemini:hydrated");
    assert.equal(listResponse.result.sessions[0].title, "Hydrated Gemini Session");
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

    const loadStart = fixture.messages.length;
    const loaded = await request(fixture, "acp-load-1", "session/load", { sessionId });
    const loadResponse = responseById(loaded, "acp-load-1");
    assert.equal(loadResponse.result._meta.coderover.agentId, "claude");
    await drainMicrotasks();
    const loadMessages = fixture.messages.slice(loadStart);
    assert.ok(loadMessages.some((message) =>
      message.method === "session/update"
      && message.params?.sessionId === sessionId
      && message.params?.update?.sessionUpdate === "agent_message_chunk"
    ));
  } finally {
    fixture.cleanup();
  }
});

test("session/prompt restores an existing session inside the bridge before sending", async () => {
  let resumeAttempts = 0;
  let loadAttempts = 0;

  const fixture = createManagerFixture(({ store, sessionRuntimeIndex }) =>
    createMockAcpSessionManager({
      store,
      sessionRuntimeIndex,
      async onResumeSession() {
        resumeAttempts += 1;
        throw new Error("Method not found");
      },
      async onLoadSession({ emitUpdate }) {
        loadAttempts += 1;
        emitUpdate({
          sessionUpdate: "session_info_update",
          _meta: {
            coderover: {
              runState: "ready",
            },
          },
        });
      },
      onPrompt: async ({ emitUpdate }) => {
        emitUpdate({
          sessionUpdate: "agent_message_chunk",
          messageId: "assistant-restored",
          content: { type: "text", text: "restored prompt response" },
        });
        return {
          stopReason: "end_turn",
        };
      },
    })
  );

  try {
    const now = new Date().toISOString();
    fixture.store.createSession({
      id: "codex:prompt-restore",
      provider: "codex",
      providerSessionId: "provider-codex-prompt-restore",
      cwd: "/tmp/codex-prompt-restore",
      createdAt: now,
      updatedAt: now,
    });

    const prompted = await request(fixture, "acp-prompt-restore", "session/prompt", {
      sessionId: "codex:prompt-restore",
      messageId: "user-message-restore",
      prompt: [{ type: "text", text: "continue this chat" }],
    });

    assert.equal(resumeAttempts, 1);
    assert.equal(loadAttempts, 1);
    assert.ok(prompted.some((message) =>
      message.method === "session/update"
      && message.params?.sessionId === "codex:prompt-restore"
      && message.params?.update?.sessionUpdate === "user_message_chunk"
    ));
    assert.ok(prompted.some((message) =>
      message.method === "session/update"
      && message.params?.sessionId === "codex:prompt-restore"
      && message.params?.update?.sessionUpdate === "agent_message_chunk"
      && message.params?.update?.content?.text === "restored prompt response"
    ));
  } finally {
    fixture.cleanup();
  }
});

test("session/load forwards provider replay updates and includes ACP-required cwd/mcpServers", async () => {
  let capturedLoadParams: Record<string, unknown> | null = null;
  let capturedResumeParams: Record<string, unknown> | null = null;
  let loadCallCount = 0;

  const fixture = createManagerFixture(({ store, sessionRuntimeIndex }) =>
    createMockAcpSessionManager({
      store,
      sessionRuntimeIndex,
      async onLoadSession({ loadParams, emitUpdate }) {
        loadCallCount += 1;
        capturedLoadParams = loadParams;
        if (loadCallCount === 1) {
          await sleep(10);
          emitUpdate({
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: "hello from provider replay" },
          });
          emitUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "reply from provider replay" },
          });
          return;
        }

        emitUpdate({
          sessionUpdate: "session_info_update",
          title: "Codex Replay Load",
          _meta: {
            coderover: {
              runState: "running",
              turnId: "turn-resume-fallback",
            },
          },
        });
        emitUpdate({
          sessionUpdate: "agent_message_chunk",
          messageId: "assistant-replay-2",
          content: { type: "text", text: "resume should not replay transcript" },
        });
      },
      async onResumeSession({ resumeParams }) {
        capturedResumeParams = resumeParams;
        throw new Error("Method not found");
      },
    })
  );

  try {
    const now = new Date().toISOString();
    fixture.store.createSession({
      id: "codex:replay-load",
      provider: "codex",
      providerSessionId: "provider-codex-replay-load",
      cwd: "/tmp/codex-replay-load",
      title: "Codex Replay Load",
      createdAt: now,
      updatedAt: now,
    });

    const loadStart = fixture.messages.length;
    const loaded = await request(fixture, "acp-load-provider-replay", "session/load", {
      sessionId: "codex:replay-load",
    });
    assert.equal(loaded.filter((message) => message.method === "session/update").length, 0);
    await sleep(20);
    const loadMessages = fixture.messages.slice(loadStart);
    assert.deepEqual(capturedLoadParams, {
      sessionId: "provider-codex-replay-load",
      cwd: "/tmp/codex-replay-load",
      mcpServers: [],
    });
    const loadResponseIndex = loadMessages.findIndex((message) => message.id === "acp-load-provider-replay");
    const firstReplayIndex = loadMessages.findIndex((message) =>
      message.method === "session/update"
      && message.params?.sessionId === "codex:replay-load"
    );
    assert.ok(loadResponseIndex >= 0);
    assert.ok(firstReplayIndex > loadResponseIndex);
    assert.ok(loadMessages.some((message) =>
      message.method === "session/update"
      && message.params?.sessionId === "codex:replay-load"
      && typeof message.params?.update?.messageId === "string"
      && String(message.params?.update?.messageId).startsWith("replay-")
      && message.params?.update?.sessionUpdate === "user_message_chunk"
    ));
    assert.ok(loadMessages.some((message) =>
      message.method === "session/update"
      && message.params?.sessionId === "codex:replay-load"
      && message.params?.update?.sessionUpdate === "agent_message_chunk"
      && typeof message.params?.update?.messageId === "string"
      && String(message.params?.update?.messageId).startsWith("replay-")
      && message.params?.update?.content?.text === "reply from provider replay"
    ));

    const resumed = await request(fixture, "acp-resume-provider-replay", "session/resume", {
      sessionId: "codex:replay-load",
    });
    assert.deepEqual(capturedResumeParams, {
      sessionId: "provider-codex-replay-load",
      cwd: "/tmp/codex-replay-load",
      mcpServers: [],
    });
    assert.equal(loadCallCount, 2);
    assert.equal(responseById(resumed, "acp-resume-provider-replay").error, undefined);
    assert.ok(resumed.some((message) =>
      message.method === "session/update"
      && message.params?.sessionId === "codex:replay-load"
      && message.params?.update?.sessionUpdate === "session_info_update"
    ));
    assert.ok(!resumed.some((message) =>
      message.method === "session/update"
      && message.params?.sessionId === "codex:replay-load"
      && message.params?.update?.sessionUpdate === "agent_message_chunk"
      && message.params?.update?.content?.text === "resume should not replay transcript"
    ));
  } finally {
    fixture.cleanup();
  }
});

test("session/load replays local ACP history when provider load and model lookup fail", async () => {
  const fixture = createManagerFixture(({ store, sessionRuntimeIndex }) =>
    createMockAcpSessionManager({
      store,
      sessionRuntimeIndex,
      loadSessionError: new Error("Invalid params"),
      listModelsError: new Error("model/list unavailable"),
    })
  );

  try {
    const created = await request(fixture, "acp-load-fallback-new", "session/new", {
      cwd: "/tmp/acp-load-fallback-demo",
      _meta: { coderover: { agentId: "claude" } },
    });
    const sessionId = responseById(created, "acp-load-fallback-new").result.sessionId as string;

    fixture.store.saveSessionHistory(sessionId, {
      sessionId,
      turns: [
        {
          id: "turn-fallback",
          createdAt: "2026-03-17T10:00:00.000Z",
          status: "completed",
          items: [
            {
              id: "item-user",
              type: "user_message",
              role: "user",
              text: "legacy prompt",
              content: [{ type: "text", text: "legacy prompt" }],
              createdAt: "2026-03-17T10:00:00.000Z",
            },
            {
              id: "item-assistant",
              type: "agent_message",
              role: "assistant",
              text: "legacy answer",
              content: [{ type: "text", text: "legacy answer" }],
              createdAt: "2026-03-17T10:01:00.000Z",
            },
          ],
        },
      ],
    });

    const loadStart = fixture.messages.length;
    const loaded = await request(fixture, "acp-load-fallback", "session/load", { sessionId });
    const response = responseById(loaded, "acp-load-fallback");
    assert.equal(response.result._meta.coderover.agentId, "claude");
    assert.equal(response.error, undefined);
    assert.equal(response.result.models, undefined);
    await drainMicrotasks();
    const loadMessages = fixture.messages.slice(loadStart);
    assert.ok(loadMessages.some((message) =>
      message.method === "session/update"
      && message.params?.sessionId === sessionId
      && message.params?.update?.sessionUpdate === "user_message_chunk"
    ));
    assert.ok(loadMessages.some((message) =>
      message.method === "session/update"
      && message.params?.sessionId === sessionId
      && message.params?.update?.sessionUpdate === "agent_message_chunk"
    ));
  } finally {
    fixture.cleanup();
  }
});

test("session/load replays local ACP history when the provider client cannot be restored", async () => {
  const fixture = createManagerFixture(({ store, sessionRuntimeIndex }) =>
    createMockAcpSessionManager({
      store,
      sessionRuntimeIndex,
      getClientError: new Error("provider unavailable"),
    })
  );

  try {
    const created = await request(fixture, "acp-load-client-fallback-new", "session/new", {
      cwd: "/tmp/acp-load-client-fallback-demo",
      _meta: { coderover: { agentId: "gemini" } },
    });
    const sessionId = responseById(created, "acp-load-client-fallback-new").result.sessionId as string;

    fixture.store.saveSessionHistory(sessionId, {
      sessionId,
      turns: [
        {
          id: "turn-client-fallback",
          createdAt: "2026-03-17T10:05:00.000Z",
          status: "completed",
          items: [
            {
              id: "item-assistant",
              type: "agent_message",
              role: "assistant",
              text: "offline answer",
              content: [{ type: "text", text: "offline answer" }],
              createdAt: "2026-03-17T10:06:00.000Z",
            },
          ],
        },
      ],
    });

    const loadStart = fixture.messages.length;
    const loaded = await request(fixture, "acp-load-client-fallback", "session/load", { sessionId });
    const response = responseById(loaded, "acp-load-client-fallback");
    assert.equal(response.error, undefined);
    assert.equal(response.result._meta.coderover.agentId, "gemini");
    assert.equal(response.result.models, undefined);
    await drainMicrotasks();
    const loadMessages = fixture.messages.slice(loadStart);
    assert.ok(loadMessages.some((message) =>
      message.method === "session/update"
      && message.params?.sessionId === sessionId
      && message.params?.update?.sessionUpdate === "agent_message_chunk"
    ));
  } finally {
    fixture.cleanup();
  }
});

test("session/load prefers locally imported Codex replay and skips provider load", async () => {
  let loadCallCount = 0;
  const fixture = createManagerFixture(({ store, sessionRuntimeIndex }) =>
    createMockAcpSessionManager({
      store,
      sessionRuntimeIndex,
      onLoadSession: async () => {
        loadCallCount += 1;
      },
    })
  );

  try {
    fs.mkdirSync(path.join(fixture.codexHomeDir, "sessions", "2026", "03", "18"), { recursive: true });
    fs.writeFileSync(
      path.join(fixture.codexHomeDir, "sessions", "2026", "03", "18", "rollout-2026-03-18T18-10-27-019cfb46-7e95-7272-91b4-a4b9686f7ec8.jsonl"),
      [
        JSON.stringify({
          timestamp: "2026-03-18T10:10:00.000Z",
          type: "session_meta",
          payload: {
            id: "019cfb46-7e95-7272-91b4-a4b9686f7ec8",
            cwd: "/Users/me/work/remodex",
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-18T10:10:01.000Z",
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn-1",
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-18T10:10:02.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "Load local Codex history",
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-18T10:10:03.000Z",
          type: "event_msg",
          payload: {
            type: "agent_message",
            message: "Using rollout events for replay.",
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-18T10:10:04.000Z",
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: "turn-1",
          },
        }),
      ].join("\n")
    );

    fixture.store.createSession({
      id: "019cfb46-7e95-7272-91b4-a4b9686f7ec8",
      provider: "codex",
      providerSessionId: "019cfb46-7e95-7272-91b4-a4b9686f7ec8",
      cwd: "/Users/me/work/remodex",
      title: "Codex local replay",
    });

    const loadStart = fixture.messages.length;
    const loaded = await request(fixture, "acp-load-codex-local", "session/load", {
      sessionId: "019cfb46-7e95-7272-91b4-a4b9686f7ec8",
    });
    assert.equal(responseById(loaded, "acp-load-codex-local").error, undefined);
    await drainMicrotasks();
    const loadMessages = fixture.messages.slice(loadStart);
    assert.equal(loadCallCount, 0);
    assert.ok(loadMessages.some((message) =>
      message.method === "session/update"
      && message.params?.sessionId === "019cfb46-7e95-7272-91b4-a4b9686f7ec8"
      && message.params?.update?.sessionUpdate === "user_message_chunk"
    ));
    assert.ok(loadMessages.some((message) =>
      message.method === "session/update"
      && message.params?.sessionId === "019cfb46-7e95-7272-91b4-a4b9686f7ec8"
      && message.params?.update?.sessionUpdate === "agent_message_chunk"
      && message.params?.update?.content?.text === "Using rollout events for replay."
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

test("session/resume falls back to local session state when provider resume fails", async () => {
  const fixture = createManagerFixture(({ store, sessionRuntimeIndex }) =>
    createMockAcpSessionManager({
      store,
      sessionRuntimeIndex,
      resumeSessionError: new Error("Internal error"),
    })
  );

  try {
    const created = await request(fixture, "resume-fallback-new", "session/new", {
      cwd: "/tmp/resume-fallback-demo",
      modelId: "sonnet",
      _meta: { coderover: { agentId: "claude" } },
    });
    const sessionId = responseById(created, "resume-fallback-new").result.sessionId as string;

    fixture.store.saveSessionHistory(sessionId, {
      sessionId,
      turns: [
        {
          id: "turn-resume-fallback",
          createdAt: "2026-03-17T11:00:00.000Z",
          status: "completed",
          items: [],
        },
      ],
    });

    const resumed = await request(fixture, "resume-fallback", "session/resume", { sessionId });
    const response = responseById(resumed, "resume-fallback");
    assert.equal(response.error, undefined);
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

test("unsupported _coderover runtime extensions return explicit method errors", async () => {
  const fixture = createManagerFixture();
  try {
    const skillsResponse = responseById(
      await request(fixture, "skills-list", "_coderover/skills/list", {}),
      "skills-list"
    );
    assert.equal(skillsResponse.error.code, -32601);
    assert.match(skillsResponse.error.message, /Unsupported CodeRover runtime extension/);

    const fuzzyResponse = responseById(
      await request(fixture, "fuzzy-search", "_coderover/fuzzy_file_search", {}),
      "fuzzy-search"
    );
    assert.equal(fuzzyResponse.error.code, -32601);
    assert.match(fuzzyResponse.error.message, /Unsupported CodeRover runtime extension/);
  } finally {
    fixture.cleanup();
  }
});

test("runtime extension inventory covers every currently translated ACP bridge method", () => {
  assert.deepEqual(RUNTIME_EXTENSION_METHODS, [
    "_coderover/agent/list",
    "_coderover/model/list",
    "_coderover/session/set_title",
    "_coderover/session/archive",
    "_coderover/session/unarchive",
    "_coderover/skills/list",
    "_coderover/fuzzy_file_search",
  ]);
});
