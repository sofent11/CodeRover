// FILE: runtime-manager.test.ts
// Purpose: Verifies bridge-managed multi-provider routing for non-CodeRover threads.
// Layer: Unit test
// Exports: bun:test suite
// Depends on: bun:test, node:assert/strict, fs, os, path, ../src/runtime-manager

import { test } from "bun:test";
import { strict as assert } from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { createRuntimeManager } from "../src/runtime-manager";
import type { JsonRpcId, RuntimeThreadShape } from "../src/bridge-types";
import type { CodexAdapter } from "../src/providers/codex-adapter";
import { createRuntimeStore } from "../src/runtime-store";
import { createThreadSessionIndex } from "../src/runtime-engine/thread-session-index";
import type {
  ManagedProviderAdapter,
  ManagedProviderTurnContext,
} from "../src/runtime-manager/types";

type RuntimeManager = ReturnType<typeof createRuntimeManager>;
type UnknownRecord = Record<string, unknown>;

interface HistoryAnchorLike {
  itemId?: string;
  item_id?: string;
  createdAt?: string;
  created_at?: string;
}

interface HistoryRequestLike {
  mode?: string;
  limit?: number;
  anchor?: HistoryAnchorLike;
  cursor?: string;
}

interface ThreadReadParams extends UnknownRecord {
  threadId?: string;
  includeTurns?: boolean;
  history?: HistoryRequestLike;
}

interface ThreadActionParams extends UnknownRecord {
  threadId?: string;
}

interface RpcMessage {
  id?: JsonRpcId;
  method?: string;
  params: Record<string, any>;
  result?: any;
  error?: any;
  [key: string]: any;
}

type CodexThreadItem = Record<string, unknown> & {
  id: string;
  type: string;
  role: string;
  text: string;
  content: Array<{ type: "text"; text: string }>;
  createdAt: string;
};

type CodexThreadTurn = Record<string, unknown> & {
  id: string;
  createdAt: string;
  status: string;
  items: CodexThreadItem[];
};

type CodexThread = RuntimeThreadShape & {
  id: string;
  title: string;
  preview: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  turns: CodexThreadTurn[];
};

type MutableThreadRef = { current: CodexThread | null };

interface ManagerFixture {
  baseDir: string;
  manager: RuntimeManager;
  messages: RpcMessage[];
  cleanup(): void;
}

interface ManagerFixtureOptions {
  codexAdapter?: CodexAdapter | null;
  claudeAdapter?: ManagedProviderAdapter | null;
  geminiAdapter?: ManagedProviderAdapter | null;
  copilotAdapter?: ManagedProviderAdapter | null;
  useDefaultCodexAdapter?: boolean;
  runtimeOptions?: Partial<Parameters<typeof createRuntimeManager>[0]>;
}

function createUnavailableCodexAdapter(): CodexAdapter {
  const unavailable = async (): Promise<unknown> => {
    throw new Error("Codex transport is not available");
  };

  return {
    attachTransport() {},
    collaborationModes: unavailable,
    compactThread: unavailable,
    fuzzyFileSearch: unavailable,
    handleIncomingRaw() {},
    handleTransportClosed() {},
    interruptTurn: unavailable,
    isAvailable() {
      return false;
    },
    listModels: unavailable,
    listSkills: unavailable,
    listThreads: unavailable,
    notify() {},
    readThread: unavailable,
    request: unavailable,
    resumeThread: unavailable,
    sendRaw() {},
    startThread: unavailable,
    startTurn: unavailable,
    steerTurn: unavailable,
  };
}

function createManagedAdapterStub(): ManagedProviderAdapter {
  const noopAsync = async (): Promise<void> => {};
  return {
    syncImportedThreads: noopAsync,
    hydrateThread: noopAsync,
    startTurn: noopAsync,
  };
}

function createCodexAdapterStub(overrides: Partial<CodexAdapter>): CodexAdapter {
  return {
    ...createUnavailableCodexAdapter(),
    isAvailable() {
      return true;
    },
    ...overrides,
  };
}

function createManagerFixture(): ManagerFixture {
  return createManagerFixtureWithOptions({});
}

function createManagerFixtureWithOptions({
  codexAdapter: providedCodexAdapter = null,
  claudeAdapter: providedClaudeAdapter = null,
  geminiAdapter: providedGeminiAdapter = null,
  copilotAdapter: providedCopilotAdapter = null,
  useDefaultCodexAdapter = false,
  runtimeOptions = {},
}: ManagerFixtureOptions = {}): ManagerFixture {
  const messages: RpcMessage[] = [];
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "coderover-runtime-manager-"));
  const codexAdapter = providedCodexAdapter || (useDefaultCodexAdapter ? null : createUnavailableCodexAdapter());
  const claudeAdapter = providedClaudeAdapter || createManagedAdapterStub();
  const geminiAdapter = providedGeminiAdapter || createManagedAdapterStub();
  const copilotAdapter = providedCopilotAdapter || createManagedAdapterStub();
  const manager = createRuntimeManager({
    sendApplicationMessage(message) {
      messages.push(JSON.parse(message) as RpcMessage);
    },
    storeBaseDir: baseDir,
    codexAdapter,
    claudeAdapter,
    geminiAdapter,
    copilotAdapter,
    ...runtimeOptions,
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

async function drainMicrotasks() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
  const response = messages.find((message) => message.id === id);
  assert.ok(response, `expected response for id ${String(id)}`);
  return response;
}

test("runtime/provider/list advertises Codex, Claude, Gemini, and Copilot capabilities", async () => {
  const fixture = createManagerFixture();

  try {
    const messages = await request(fixture, "providers-1", "runtime/provider/list", {});
    const response = responseById(messages, "providers-1");
    assert.ok(response);
    assert.deepEqual(
      response.result.providers.map((provider: { id: string }) => provider.id),
      ["codex", "claude", "gemini", "copilot"]
    );
    assert.equal(response.result.providers[1].supports.turnSteer, false);
    assert.equal(response.result.providers[2].supports.reasoningOptions, false);
    assert.equal(response.result.providers[3].supports.planMode, true);
    assert.equal(response.result.providers[3].supports.desktopRestart, false);
  } finally {
    fixture.cleanup();
  }
});

test("managed provider turns persist thread session ownership metadata", async () => {
  const claudeAdapter: ManagedProviderAdapter = {
    async hydrateThread() {},
    async syncImportedThreads() {},
    async startTurn({ turnContext }) {
      turnContext.bindProviderSession("claude-session-1");
      turnContext.appendAgentDelta("Working on it");
      turnContext.updatePreview("Working on it");
      return {
        usage: { outputTokens: 12 },
      };
    },
  };
  const fixture = createManagerFixtureWithOptions({
    claudeAdapter,
  });

  try {
    const startMessages = await request(fixture, "managed-thread-start", "thread/start", {
      provider: "claude",
      cwd: "/tmp/session-owner-demo",
      model: "sonnet",
    });
    const startResponse = responseById(startMessages, "managed-thread-start");
    const threadId = startResponse.result.thread.id as string;

    await request(fixture, "managed-turn-start", "turn/start", {
      threadId,
      input: [{ type: "text", text: "Investigate the issue" }],
    });
    await drainMicrotasks();

    const sessionIndexPath = path.join(fixture.baseDir, "thread-session-index.json");
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
    const record = indexPayload.sessions[threadId];
    assert.ok(record, "expected persisted session index record");
    assert.equal(record.provider, "claude");
    assert.equal(record.providerSessionId, "claude-session-1");
    assert.equal(record.ownerState, "idle");
    assert.equal(record.activeTurnId, null);
  } finally {
    fixture.cleanup();
  }
});

test("turn/interrupt resolves a managed provider thread from turnId only", async () => {
  let interrupted = false;
  let releaseTurn: (() => void) | null = null;
  const claudeAdapter: ManagedProviderAdapter = {
    async hydrateThread() {},
    async syncImportedThreads() {},
    async startTurn({ turnContext }) {
      await new Promise<void>((resolve) => {
        releaseTurn = resolve;
        turnContext.setInterruptHandler(() => {
          interrupted = true;
          resolve();
        });
      });
    },
  };
  const fixture = createManagerFixtureWithOptions({
    claudeAdapter,
  });

  try {
    const startMessages = await request(fixture, "managed-interrupt-thread-start", "thread/start", {
      provider: "claude",
      cwd: "/tmp/session-interrupt-demo",
    });
    const threadId = responseById(startMessages, "managed-interrupt-thread-start").result.thread.id as string;
    const turnMessages = await request(fixture, "managed-interrupt-turn-start", "turn/start", {
      threadId,
      input: [{ type: "text", text: "Wait here" }],
    });
    const turnId = responseById(turnMessages, "managed-interrupt-turn-start").result.turnId as string;
    await drainMicrotasks();

    const interruptMessages = await request(fixture, "managed-interrupt", "turn/interrupt", {
      turnId,
    });

    assert.deepEqual(responseById(interruptMessages, "managed-interrupt").result, {});
    assert.equal(interrupted, true);
  } finally {
    releaseTurn?.();
    fixture.cleanup();
  }
});

test("turn/interrupt resolves a Codex thread from the persisted active turn id", async () => {
  const codexFixture = createCodexAdapterFixture({
    threads: [buildCodexThread({
      threadId: "codex-interrupt-thread",
      messageCount: 1,
      turnId: "turn-started",
    })],
  });
  let interruptParams: Record<string, unknown> | null = null;
  const codexAdapter = {
    ...codexFixture.adapter,
    async interruptTurn(params: Record<string, unknown> = {}) {
      interruptParams = params;
      return { interrupted: true };
    },
  } as CodexAdapter;
  const fixture = createManagerFixtureWithOptions({
    codexAdapter,
  });

  try {
    await request(fixture, "codex-interrupt-turn-start", "turn/start", {
      threadId: "codex-interrupt-thread",
      input: [{ type: "text", text: "Stop me later" }],
    });

    const interruptMessages = await request(fixture, "codex-interrupt", "turn/interrupt", {
      turnId: "turn-started",
    });

    assert.deepEqual(responseById(interruptMessages, "codex-interrupt").result, { interrupted: true });
    assert.equal(interruptParams?.turnId, "turn-started");
  } finally {
    fixture.cleanup();
  }
});

test("turn/interrupt can recover a Codex turn id by refreshing likely running sessions", async () => {
  const thread = buildCodexThread({
    threadId: "codex-interrupt-read-fallback",
    messageCount: 1,
    turnId: "turn-from-thread-read",
  });
  const codexFixture = createCodexAdapterFixture({
    threads: [thread],
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "coderover-runtime-interrupt-"));
  const store = createRuntimeStore({ baseDir });
  const threadSessionIndex = createThreadSessionIndex({ baseDir });
  let interruptParams: Record<string, unknown> | null = null;
  const codexAdapter = {
    ...codexFixture.adapter,
    async interruptTurn(params: Record<string, unknown> = {}) {
      interruptParams = params;
      return { interrupted: true };
    },
  } as CodexAdapter;
  store.createThread({
    id: thread.id,
    provider: "codex",
    title: thread.title,
    preview: thread.preview,
    cwd: thread.cwd,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  });
  threadSessionIndex.upsert({
    threadId: thread.id,
    provider: "codex",
    engineSessionId: thread.id,
    providerSessionId: thread.id,
    ownerState: "running",
    activeTurnId: null,
  });
  const fixture = createManagerFixtureWithOptions({
    codexAdapter,
    runtimeOptions: {
      store,
      threadSessionIndex,
    },
  });

  try {
    const interruptMessages = await request(fixture, "codex-interrupt-read-fallback", "turn/interrupt", {
      turnId: "turn-from-thread-read",
    });

    assert.deepEqual(responseById(interruptMessages, "codex-interrupt-read-fallback").result, { interrupted: true });
    assert.equal(interruptParams?.turnId, "turn-from-thread-read");
    assert.equal(codexFixture.readCountsByThread.get(thread.id), 1);
  } finally {
    fixture.cleanup();
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test("thread/start creates and lists managed Claude threads with provider metadata", async () => {
  const fixture = createManagerFixture();

  try {
    const startMessages = await request(fixture, "thread-start-1", "thread/start", {
      provider: "claude",
      cwd: "/tmp/demo-project",
      model: "sonnet",
    });
    const startResponse = responseById(startMessages, "thread-start-1");
    assert.ok(startResponse);
    const startedThread = startResponse.result.thread;
    assert.match(startedThread.id, /^claude:/);
    assert.equal(startedThread.provider, "claude");
    assert.equal(startedThread.capabilities.turnSteer, false);
    assert.equal(startedThread.metadata.providerTitle, "Claude Code");
    assert.ok(startMessages.some((message: RpcMessage) => message.method === "thread/started"));

    const listMessages = await request(fixture, "thread-list-1", "thread/list", {});
    const listResponse = responseById(listMessages, "thread-list-1");
    assert.ok(listResponse);
    assert.equal(listResponse.result.items.length, 1);
    assert.equal(listResponse.result.items[0].provider, "claude");
    assert.equal(listResponse.result.items[0].cwd, "/tmp/demo-project");
  } finally {
    fixture.cleanup();
  }
});

test("thread archive overlays and turn/steer capability gating work for managed runtimes", async () => {
  const fixture = createManagerFixture();

  try {
    const startMessages = await request(fixture, "thread-start-2", "thread/start", {
      provider: "gemini",
      cwd: "/tmp/gemini-project",
    });
    const threadId = responseById(startMessages, "thread-start-2").result.thread.id;

    const archiveMessages = await request(fixture, "thread-archive-1", "thread/archive", {
      threadId,
    });
    const archiveResponse = responseById(archiveMessages, "thread-archive-1");
    assert.ok(archiveResponse);

    const activeListMessages = await request(fixture, "thread-list-active", "thread/list", {});
    const activeListResponse = responseById(activeListMessages, "thread-list-active");
    assert.equal(activeListResponse.result.items.length, 0);

    const archivedListMessages = await request(fixture, "thread-list-archived", "thread/list", {
      archived: true,
    });
    const archivedListResponse = responseById(archivedListMessages, "thread-list-archived");
    assert.equal(archivedListResponse.result.items.length, 1);
    assert.equal(archivedListResponse.result.items[0].provider, "gemini");

    const steerMessages = await request(fixture, "turn-steer-1", "turn/steer", {
      threadId,
      turnId: "turn-1",
      input: [{ type: "text", text: "continue" }],
    });
    const steerResponse = responseById(steerMessages, "turn-steer-1");
    assert.ok(steerResponse?.error);
    assert.equal(steerResponse.error.code, -32601);
    assert.match(steerResponse.error.message, /only available for Codex threads/i);
  } finally {
    fixture.cleanup();
  }
});

test("thread/resume returns a managed thread snapshot for Claude threads", async () => {
  const fixture = createManagerFixture();

  try {
    const startMessages = await request(fixture, "thread-start-resume-managed", "thread/start", {
      provider: "claude",
      cwd: "/tmp/claude-project",
    });
    const threadId = responseById(startMessages, "thread-start-resume-managed").result.thread.id;

    const resumeMessages = await request(fixture, "thread-resume-managed", "thread/resume", {
      threadId,
    });
    const resumeResponse = responseById(resumeMessages, "thread-resume-managed");
    assert.ok(resumeResponse);
    assert.equal(resumeResponse.result.threadId, threadId);
    assert.equal(resumeResponse.result.resumed, true);
    assert.equal(resumeResponse.result.thread.id, threadId);
    assert.equal(resumeResponse.result.thread.provider, "claude");
    assert.ok(Array.isArray(resumeResponse.result.thread.turns));
  } finally {
    fixture.cleanup();
  }
});

function createCodexAdapterFixture({
  threads = [],
}: {
  threads?: CodexThread[];
} = {}): {
  adapter: CodexAdapter;
  readCountsByThread: Map<string, number>;
} {
  const readCountsByThread = new Map<string, number>();
  let attachedTransport: { send(message: string): void } | null = null;

  function findThread(threadId: string): CodexThread | null {
    return threads.find((thread) => thread.id === threadId) || null;
  }

  return {
    adapter: {
      ...createUnavailableCodexAdapter(),
      attachTransport(transport) {
        attachedTransport = transport || null;
      },
      handleIncomingRaw() {},
      handleTransportClosed() {
        attachedTransport = null;
      },
      isAvailable() {
        return true;
      },
      async request(method: string) {
        if (method === "initialize") {
          return { ok: true };
        }
        throw new Error(`unexpected request: ${method}`);
      },
      notify() {},
      sendRaw() {},
      async listThreads() {
        return {
          threads: threads.map((thread) => ({
            id: thread.id,
            title: thread.title,
            preview: thread.preview,
            createdAt: thread.createdAt,
            updatedAt: thread.updatedAt,
            cwd: thread.cwd,
          })),
          nextCursor: "cursor-2",
        };
      },
      async readThread(params: ThreadReadParams = {}) {
        const threadId = String(params.threadId || "");
        readCountsByThread.set(threadId, (readCountsByThread.get(threadId) || 0) + 1);
        const thread = findThread(threadId);
        if (!thread) {
          return {};
        }
        if (params.includeTurns === false) {
          const metaThread = JSON.parse(JSON.stringify(thread));
          delete metaThread.turns;
          return { thread: metaThread };
        }
        if (params.history) {
          return buildCodexHistoryResult(thread, params.history);
        }
        return {
          thread: JSON.parse(JSON.stringify(thread)),
        };
      },
      async startTurn(params: ThreadActionParams = {}) {
        return {
          threadId: params.threadId,
          turnId: "turn-started",
        };
      },
    },
    readCountsByThread,
  };
}

function buildCodexThread({
  threadId = "codex-thread-1",
  messageCount = 180,
  turnId = "turn-1",
}: {
  threadId?: string;
  messageCount?: number;
  turnId?: string;
} = {}): CodexThread {
  const createdAtBase = Date.parse("2026-03-14T00:00:00.000Z");
  const items: CodexThreadItem[] = [];
  for (let index = 1; index <= messageCount; index += 1) {
    items.push({
      id: `item-${index}`,
      type: index % 2 === 0 ? "agent_message" : "user_message",
      role: index % 2 === 0 ? "assistant" : "user",
      text: `message-${index}`,
      content: [{ type: "text", text: `message-${index}` }],
      createdAt: new Date(createdAtBase + (index * 1000)).toISOString(),
    });
  }
  return {
    id: threadId,
    title: "Codex Thread",
    preview: `message-${messageCount}`,
    cwd: "/tmp/codex-project",
    createdAt: new Date(createdAtBase).toISOString(),
    updatedAt: new Date(createdAtBase + (messageCount * 1000)).toISOString(),
    turns: [
      {
        id: turnId,
        createdAt: new Date(createdAtBase).toISOString(),
        status: "completed",
        items,
      },
    ],
  };
}

function buildCodexHistoryResult(
  thread: CodexThread,
  history: HistoryRequestLike | null | undefined
): Record<string, unknown> {
  const snapshot = JSON.parse(JSON.stringify(thread)) as CodexThread;
  const turns = Array.isArray(snapshot.turns) ? snapshot.turns : [];
  const turn: CodexThreadTurn = turns[0] || {
    id: "turn-1",
    createdAt: snapshot.createdAt,
    status: "completed",
    items: [],
  };
  const items = Array.isArray(turn.items) ? turn.items : [];
  const mode = history?.mode || "tail";
  const limit = Math.max(Number(history?.limit) || items.length || 0, 1);
  const anchorItemId = history?.anchor?.itemId || history?.anchor?.item_id || history?.cursor || null;
  const anchorCreatedAt = history?.anchor?.createdAt || history?.anchor?.created_at || null;
  let startIndex = 0;
  let endIndexExclusive = 0;

  if (mode === "tail") {
    startIndex = Math.max(items.length - limit, 0);
    endIndexExclusive = items.length;
  } else {
    const anchorIndex = items.findIndex((item: CodexThreadItem) => (
      (anchorItemId && item.id === anchorItemId)
      || (!anchorItemId && anchorCreatedAt && item.createdAt === anchorCreatedAt)
    ));
    if (anchorIndex < 0) {
      return {
        thread: {
          ...snapshot,
          turns: [{ ...turn, items: [] }],
        },
        historyWindow: {
          mode,
          olderCursor: null,
          newerCursor: null,
          hasOlder: false,
          hasNewer: false,
          pageSize: 0,
        },
      };
    }
    if (mode === "before") {
      startIndex = Math.max(anchorIndex - limit, 0);
      endIndexExclusive = anchorIndex;
    } else {
      startIndex = anchorIndex + 1;
      endIndexExclusive = Math.min(anchorIndex + 1 + limit, items.length);
    }
  }

  const selected = items.slice(startIndex, endIndexExclusive);
  return {
    thread: {
      ...snapshot,
      turns: [{ ...turn, items: selected }],
    },
    historyWindow: {
      mode,
      olderCursor: selected[0]?.id || null,
      newerCursor: selected.at(-1)?.id || null,
      hasOlder: startIndex > 0,
      hasNewer: endIndexExclusive < items.length,
      pageSize: selected.length,
    },
  };
}

function createDefaultCodexTransportFixture(manager: RuntimeManager, {
  threadRef,
}: { threadRef?: MutableThreadRef } = {}) {
  const readCountsByThread = new Map<string, number>();
  const sentMethods: string[] = [];

  const transport = {
    send(message: string) {
      const parsed = JSON.parse(message) as RpcMessage;
      sentMethods.push(parsed.method || "response");

      setImmediate(() => {
        if (parsed.method === "initialize") {
          manager.handleCodexTransportMessage(JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id,
            result: { ok: true },
          }));
          return;
        }

        if (parsed.method === "thread/read") {
          const threadId = String(parsed.params?.threadId || "");
          readCountsByThread.set(threadId, (readCountsByThread.get(threadId) || 0) + 1);
          const thread = threadRef?.current && threadRef.current.id === threadId
            ? JSON.parse(JSON.stringify(threadRef.current))
            : null;
          let result = {};
          if (thread) {
            if (parsed.params?.includeTurns === false) {
              delete thread.turns;
              result = { thread };
            } else if (parsed.params?.history) {
              result = buildCodexHistoryResult(thread, parsed.params.history);
            } else {
              result = { thread };
            }
          }
          manager.handleCodexTransportMessage(JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id,
            result,
          }));
          return;
        }

        manager.handleCodexTransportMessage(JSON.stringify({
          jsonrpc: "2.0",
          id: parsed.id,
          result: {},
        }));
      });
    },
  };

  return {
    readCountsByThread,
    sentMethods,
    transport,
  };
}

test("thread/list returns bridge-managed pagination metadata while merging thread arrays", async () => {
  const codexFixture = createCodexAdapterFixture({
    threads: [
      buildCodexThread({ threadId: "codex-thread-list-1", messageCount: 4 }),
      buildCodexThread({ threadId: "codex-thread-list-2", messageCount: 4 }),
    ],
  });
  const fixture = createManagerFixtureWithOptions({
    codexAdapter: codexFixture.adapter,
  });

  try {
    const messages = await request(fixture, "thread-list-cursor", "thread/list", { limit: 1 });
    const response = responseById(messages, "thread-list-cursor");
    assert.ok(response);
    assert.equal(typeof response.result.nextCursor, "string");
    assert.equal(response.result.hasMore, true);
    assert.equal(response.result.pageSize, 1);
    assert.equal(response.result.items.length, 1);
    assert.equal(response.result.items[0].provider, "codex");
  } finally {
    fixture.cleanup();
  }
});

test("thread/list truncates oversized previews from Codex and managed overlays", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "coderover-runtime-manager-"));
  const store = createRuntimeStore({ baseDir });
  const giantPreview = "A".repeat(8_000);
  store.createThread({
    id: "gemini:preview-heavy",
    provider: "gemini",
    preview: giantPreview,
    name: "preview-heavy",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  store.shutdown();

  const fixture = createManagerFixtureWithOptions({
    runtimeOptions: { storeBaseDir: baseDir },
    codexAdapter: createCodexAdapterStub({
      async request() {
        return {};
      },
      notify() {},
      async listThreads() {
        return {
          threads: [
            {
              id: "codex-preview-heavy",
              title: "Codex preview heavy",
              preview: giantPreview,
              createdAt: "2026-01-02T00:00:00.000Z",
              updatedAt: "2026-01-02T00:00:00.000Z",
              cwd: "/tmp",
            },
          ],
        };
      },
    }),
  });

  try {
    const messages = await request(fixture, "thread-list-preview-cap", "thread/list", {});
    const response = responseById(messages, "thread-list-preview-cap");
    const threads = response.result.items as Array<Record<string, unknown>>;
    const codexThread = threads.find((thread) => thread.id === "codex-preview-heavy");
    const managedThread = threads.find((thread) => thread.id === "gemini:preview-heavy");

    assert.equal(typeof codexThread?.preview, "string");
    assert.equal(typeof managedThread?.preview, "string");
    assert.ok(String(codexThread?.preview).length <= 600);
    assert.ok(String(managedThread?.preview).length <= 600);
    assert.ok(String(codexThread?.preview).endsWith("…"));
    assert.ok(String(managedThread?.preview).endsWith("…"));
  } finally {
    fixture.cleanup();
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test("thread/list returns summarized thread entries without heavy history fields", async () => {
  const fixture = createManagerFixtureWithOptions({
    codexAdapter: createCodexAdapterStub({
      async request() {
        return {};
      },
      notify() {},
      async listThreads() {
        return {
          threads: [
            {
              id: "codex-summary-thread",
              title: "Summary Thread",
              preview: "hello",
              createdAt: "2026-01-02T00:00:00.000Z",
              updatedAt: "2026-01-02T00:00:00.000Z",
              cwd: "/tmp/project",
              turns: [{ id: "turn-1", items: [{ id: "item-1" }] }],
              gitInfo: { branch: "main" },
              status: "completed",
              path: "/tmp/project",
              cliVersion: "1.0.0",
            },
          ],
        };
      },
    }),
  });

  try {
    const messages = await request(fixture, "thread-list-summary", "thread/list", {});
    const response = responseById(messages, "thread-list-summary");
    const thread = response.result.items[0] as Record<string, unknown>;

    assert.deepEqual(
      Object.keys(thread).sort(),
      [
        "capabilities",
        "createdAt",
        "cwd",
        "id",
        "metadata",
        "name",
        "preview",
        "provider",
        "providerSessionId",
        "title",
        "updatedAt",
      ].sort()
    );
    assert.equal(thread.id, "codex-summary-thread");
    assert.equal(thread.cwd, "/tmp/project");
  } finally {
    fixture.cleanup();
  }
});

test("thread/list initial page keeps only recent threads with a per-project cap and paginates the rest", async () => {
  const now = Date.now();
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  const codexThreads = [
    ...Array.from({ length: 12 }, (_, index) => ({
      id: `codex-recent-${index}`,
      title: `Recent ${index}`,
      preview: `recent-${index}`,
      createdAt: iso(1_000 + index),
      updatedAt: iso(1_000 + index),
      cwd: "/tmp/project-a",
    })),
    {
      id: "codex-old-0",
      title: "Old 0",
      preview: "old-0",
      createdAt: iso(5 * 24 * 60 * 60 * 1000),
      updatedAt: iso(5 * 24 * 60 * 60 * 1000),
      cwd: "/tmp/project-a",
    },
    {
      id: "codex-recent-other-project",
      title: "Recent Other",
      preview: "recent-other",
      createdAt: iso(2_000),
      updatedAt: iso(2_000),
      cwd: "/tmp/project-b",
    },
  ];

  const fixture = createManagerFixtureWithOptions({
    codexAdapter: createCodexAdapterStub({
      async request() {
        return {};
      },
      notify() {},
      async listThreads() {
        return { threads: codexThreads };
      },
    }),
  });

  try {
    const firstMessages = await request(fixture, "thread-list-page-1", "thread/list", { limit: 50 });
    const firstResponse = responseById(firstMessages, "thread-list-page-1");
    const firstPage = firstResponse.result.items as Array<Record<string, unknown>>;

    assert.equal(firstPage.filter((thread) => thread.cwd === "/tmp/project-a").length, 10);
    assert.ok(firstPage.some((thread) => thread.id === "codex-recent-other-project"));
    assert.ok(!firstPage.some((thread) => thread.id === "codex-old-0"));
    assert.equal(typeof firstResponse.result.nextCursor, "string");

    const secondMessages = await request(fixture, "thread-list-page-2", "thread/list", {
      limit: 50,
      cursor: firstResponse.result.nextCursor,
    });
    const secondResponse = responseById(secondMessages, "thread-list-page-2");
    const secondPage = secondResponse.result.items as Array<Record<string, unknown>>;

    assert.ok(secondPage.some((thread) => thread.id === "codex-recent-10"));
    assert.ok(secondPage.some((thread) => thread.id === "codex-recent-11"));
    assert.ok(secondPage.some((thread) => thread.id === "codex-old-0"));
  } finally {
    fixture.cleanup();
  }
});

test("thread/read history tail and after windows reuse the Codex cache", async () => {
  const thread = buildCodexThread();
  const codexFixture = createCodexAdapterFixture({ threads: [thread] });
  const fixture = createManagerFixtureWithOptions({
    codexAdapter: codexFixture.adapter,
  });

  try {
    const tailMessages = await request(fixture, "thread-read-tail", "thread/read", {
      threadId: thread.id,
      history: {
        mode: "tail",
        limit: 50,
      },
    });
    const tailResponse = responseById(tailMessages, "thread-read-tail");
    assert.ok(tailResponse);
    assert.equal(tailResponse.result.historyWindow.mode, "tail");
    assert.equal(tailResponse.result.historyWindow.servedFromCache, true);
    assert.equal(tailResponse.result.historyWindow.servedFromProjection, true);
    assert.equal(tailResponse.result.historyWindow.projectionSource, "thread_read_fallback");
    assert.equal(tailResponse.result.historyWindow.syncEpoch, 1);
    assert.equal(tailResponse.result.historyWindow.hasOlder, true);
    assert.equal(tailResponse.result.historyWindow.pageSize, 50);
    assert.ok(tailResponse.result.historyWindow.olderCursor);
    assert.ok(tailResponse.result.historyWindow.newerCursor);
    assert.equal(tailResponse.result.thread.turns[0].items.length, 50);
    assert.equal(tailResponse.result.thread.turns[0].items[0].id, "item-131");

    const cachedTailMessages = await request(fixture, "thread-read-tail-cached", "thread/read", {
      threadId: thread.id,
      history: {
        mode: "tail",
        limit: 50,
      },
    });
    const cachedTailResponse = responseById(cachedTailMessages, "thread-read-tail-cached");
    assert.equal(cachedTailResponse.result.historyWindow.servedFromCache, true);

    const afterMessages = await request(fixture, "thread-read-after", "thread/read", {
      threadId: thread.id,
      history: {
        mode: "after",
        limit: 5,
        cursor: tailResponse.result.historyWindow.olderCursor,
      },
    });
    const afterResponse = responseById(afterMessages, "thread-read-after");
    assert.equal(afterResponse.result.historyWindow.servedFromCache, true);
    assert.equal(afterResponse.result.thread.turns[0].items.length, 5);
    assert.equal(afterResponse.result.thread.turns[0].items[0].id, "item-132");
  } finally {
    fixture.cleanup();
  }
});

test("thread/read forwards uncached Codex history windows upstream before falling back to full snapshots", async () => {
  const thread = buildCodexThread({
    threadId: "codex-thread-upstream-history",
    messageCount: 5,
  });
  const readParams: ThreadReadParams[] = [];
  const codexAdapter = createCodexAdapterStub({
    async request(method: string) {
      if (method === "initialize") {
        return { ok: true };
      }
      throw new Error(`unexpected request: ${method}`);
    },
    async listThreads() {
      return {
        threads: [{
          id: thread.id,
          title: thread.title,
          preview: thread.preview,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          cwd: thread.cwd,
        }],
      };
    },
    async readThread(params: ThreadReadParams = {}) {
      readParams.push(JSON.parse(JSON.stringify(params)));
      if (params.includeTurns === false) {
        const metaThread = JSON.parse(JSON.stringify(thread));
        delete metaThread.turns;
        return { thread: metaThread };
      }
      if (!params.history) {
        throw new Error("expected upstream history request on uncached Codex read");
      }
      const partialThread = JSON.parse(JSON.stringify(thread));
      partialThread.turns[0].items = partialThread.turns[0].items.slice(-3);
      return {
        thread: partialThread,
        historyWindow: {
          mode: "tail",
          olderCursor: "cursor-item-3",
          newerCursor: "cursor-item-5",
          hasOlder: true,
          hasNewer: false,
          pageSize: 3,
        },
      };
    },
    async startTurn(params: ThreadActionParams = {}) {
      return {
        threadId: params.threadId,
        turnId: "turn-started",
      };
    },
  });
  const fixture = createManagerFixtureWithOptions({ codexAdapter });

  try {
    const tailMessages = await request(fixture, "thread-read-upstream-tail", "thread/read", {
      threadId: thread.id,
      history: {
        mode: "tail",
        limit: 3,
      },
    });
    const tailResponse = responseById(tailMessages, "thread-read-upstream-tail");
    assert.ok(tailResponse);
    assert.equal(tailResponse.result.historyWindow.mode, "tail");
    assert.equal(tailResponse.result.historyWindow.pageSize, 3);
    assert.equal(tailResponse.result.thread.turns[0].items.length, 3);
    assert.deepEqual(
      tailResponse.result.thread.turns[0].items.map((item: { id: string }) => item.id),
      ["item-3", "item-4", "item-5"]
    );
    assert.equal(readParams.length, 2);
    assert.ok(readParams[0]);
    assert.ok(readParams[1]);
    assert.equal(readParams[0].includeTurns, false);
    assert.deepEqual(readParams[1].history, {
      mode: "tail",
      limit: 3,
    });
    assert.equal(readParams[1].includeTurns, undefined);
  } finally {
    fixture.cleanup();
  }
});

test("thread/read history windows strip oversized inline image payloads from Codex items", async () => {
  const largeInlineImage = `data:image/png;base64,${"A".repeat(200_000)}`;
  const thread = buildCodexThread({
    threadId: "codex-thread-inline-image",
    messageCount: 4,
  });
  thread.turns[0].items[0] = {
    id: "item-1",
    type: "user_message",
    role: "user",
    text: "message-1",
    content: [
      { type: "text", text: "message-1" },
      { type: "image", url: largeInlineImage } as unknown as CodexThreadItem["content"][number],
    ] as CodexThreadItem["content"],
    createdAt: thread.turns[0].items[0].createdAt,
  };

  const codexFixture = createCodexAdapterFixture({ threads: [thread] });
  const fixture = createManagerFixtureWithOptions({
    codexAdapter: codexFixture.adapter,
  });

  try {
    const tailMessages = await request(fixture, "thread-read-inline-image", "thread/read", {
      threadId: thread.id,
      history: {
        mode: "tail",
        limit: 4,
      },
    });
    const tailResponse = responseById(tailMessages, "thread-read-inline-image");
    assert.ok(tailResponse);
    const firstItem = tailResponse.result.thread.turns[0].items[0];
    assert.equal(firstItem.id, "item-1");
    assert.equal(firstItem.content[1].type, "image");
    assert.equal(firstItem.content[1].url, undefined);
    assert.equal(firstItem.content[1].omittedLargeInlineImage, true);
  } finally {
    fixture.cleanup();
  }
});

test("thread/resume strips oversized inline image payloads from Codex items", async () => {
  const largeInlineImage = `data:image/png;base64,${"A".repeat(200_000)}`;
  const thread = buildCodexThread({
    threadId: "codex-thread-resume-inline-image",
    messageCount: 2,
  });
  thread.turns[0].items[0] = {
    id: "item-1",
    type: "user_message",
    role: "user",
    text: "message-1",
    content: [
      { type: "text", text: "message-1" },
      { type: "image", url: largeInlineImage } as unknown as CodexThreadItem["content"][number],
    ] as CodexThreadItem["content"],
    createdAt: thread.turns[0].items[0].createdAt,
  };

  const codexAdapter = createCodexAdapterStub({
    async request(method: string) {
      if (method === "initialize") {
        return { ok: true };
      }
      throw new Error(`unexpected request: ${method}`);
    },
    async listThreads() {
      return { threads: [thread] };
    },
    async readThread() {
      return { thread };
    },
    async resumeThread() {
      return { thread };
    },
  });
  const fixture = createManagerFixtureWithOptions({ codexAdapter });

  try {
    const messages = await request(fixture, "codex-thread-resume", "thread/resume", {
      threadId: thread.id,
    });
    const response = responseById(messages, "codex-thread-resume");
    assert.ok(response);
    const firstItem = response.result.thread.turns[0].items[0];
    assert.equal(firstItem.content[1].url, undefined);
    assert.equal(firstItem.content[1].omittedLargeInlineImage, true);
  } finally {
    fixture.cleanup();
  }
});

test("forwarded Codex turn lifecycle notifications include session metadata", async () => {
  const fixture = createManagerFixtureWithOptions({
    useDefaultCodexAdapter: true,
  });

  try {
    const thread = buildCodexThread({ messageCount: 0 });
    fixture.manager.attachCodexTransport({ send() {} });
    fixture.manager.handleCodexTransportMessage(JSON.stringify({
      jsonrpc: "2.0",
      method: "thread/started",
      params: {
        thread,
      },
    }));

    const beforeStartedCount = fixture.messages.length;
    fixture.manager.handleCodexTransportMessage(JSON.stringify({
      jsonrpc: "2.0",
      method: "turn/started",
      params: {
        threadId: thread.id,
        turnId: "turn-metadata",
      },
    }));

    const started = fixture.messages[beforeStartedCount];
    assert.ok(started);
    assert.equal(started.method, "timeline/turnUpdated");
    assert.equal(started.params.threadId, thread.id);
    assert.equal(started.params.turnId, "turn-metadata");
    assert.equal(started.params.state, "running");
    assert.equal(started.params.sourceKind, "managed_runtime");
    assert.equal(started.params.syncEpoch, 2);

    const beforeCompletedCount = fixture.messages.length;
    fixture.manager.handleCodexTransportMessage(JSON.stringify({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        threadId: thread.id,
        turnId: "turn-metadata",
        status: "completed",
      },
    }));

    const completed = fixture.messages[beforeCompletedCount];
    assert.ok(completed);
    assert.equal(completed.method, "timeline/turnUpdated");
    assert.equal(completed.params.threadId, thread.id);
    assert.equal(completed.params.turnId, "turn-metadata");
    assert.equal(completed.params.state, "completed");
    assert.equal(completed.params.sourceKind, "thread_read_fallback");
    assert.equal(completed.params.syncEpoch, 3);
  } finally {
    fixture.cleanup();
  }
});

test("forwarded Codex item delta notifications include cursor metadata when cache context exists", async () => {
  const fixture = createManagerFixtureWithOptions({
    useDefaultCodexAdapter: true,
  });

  try {
    const thread = buildCodexThread({ messageCount: 0 });
    fixture.manager.attachCodexTransport({ send() {} });
    fixture.manager.handleCodexTransportMessage(JSON.stringify({
      jsonrpc: "2.0",
      method: "thread/started",
      params: {
        thread,
      },
    }));
    fixture.manager.handleCodexTransportMessage(JSON.stringify({
      jsonrpc: "2.0",
      method: "turn/started",
      params: {
        threadId: thread.id,
        turnId: "turn-1",
      },
    }));
    for (let index = 1; index <= 3; index += 1) {
      fixture.manager.handleCodexTransportMessage(JSON.stringify({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: {
          threadId: thread.id,
          turnId: "turn-1",
          itemId: `item-${index}`,
          delta: `message-${index}`,
        },
      }));
    }

    const beforeCount = fixture.messages.length;
    fixture.manager.handleCodexTransportMessage(JSON.stringify({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: {
        threadId: thread.id,
        turnId: "turn-1",
        itemId: "item-4",
        delta: "message-4",
      },
    }));

    const forwarded = fixture.messages[beforeCount];
    assert.ok(forwarded);
    assert.equal(forwarded.method, "timeline/itemTextUpdated");
    assert.equal(forwarded.params.timelineItemId, "item-4");
    assert.equal(forwarded.params.providerItemId, "item-4");
    assert.equal(forwarded.params.text, "message-4");
    assert.ok(forwarded.params.cursor);
    assert.ok(forwarded.params.previousCursor);
    assert.equal(forwarded.params.previousItemId, "item-3");
    assert.equal(fixture.messages[beforeCount + 1], undefined);
  } finally {
    fixture.cleanup();
  }
});

test("forwarded Codex snake_case delta notifications are normalized before reaching the app", async () => {
  const fixture = createManagerFixtureWithOptions({
    useDefaultCodexAdapter: true,
  });

  try {
    const thread = buildCodexThread({ messageCount: 0 });
    fixture.manager.attachCodexTransport({ send() {} });
    fixture.manager.handleCodexTransportMessage(JSON.stringify({
      jsonrpc: "2.0",
      method: "thread/started",
      params: {
        thread,
      },
    }));
    fixture.manager.handleCodexTransportMessage(JSON.stringify({
      jsonrpc: "2.0",
      method: "turn/started",
      params: {
        threadId: thread.id,
        turnId: "turn-snake",
      },
    }));

    const beforeCount = fixture.messages.length;
    fixture.manager.handleCodexTransportMessage(JSON.stringify({
      jsonrpc: "2.0",
      method: "item/agent_message/delta",
      params: {
        threadId: thread.id,
        turnId: "turn-snake",
        itemId: "item-snake",
        delta: "hello",
      },
    }));

    const forwarded = fixture.messages[beforeCount];
    assert.ok(forwarded);
    assert.equal(forwarded.method, "timeline/itemTextUpdated");
    assert.equal(forwarded.params.threadId, thread.id);
    assert.equal(forwarded.params.turnId, "turn-snake");
    assert.equal(forwarded.params.timelineItemId, "item-snake");
    assert.ok(forwarded.params.cursor);
  } finally {
    fixture.cleanup();
  }
});

test("forwarded codex/event legacy delta notifications are normalized before reaching the app", async () => {
  const fixture = createManagerFixtureWithOptions({
    useDefaultCodexAdapter: true,
  });

  try {
    const thread = buildCodexThread({ messageCount: 0 });
    fixture.manager.attachCodexTransport({ send() {} });
    fixture.manager.handleCodexTransportMessage(JSON.stringify({
      jsonrpc: "2.0",
      method: "thread/started",
      params: {
        thread,
      },
    }));
    fixture.manager.handleCodexTransportMessage(JSON.stringify({
      jsonrpc: "2.0",
      method: "turn/started",
      params: {
        threadId: thread.id,
        turnId: "turn-legacy-forward",
      },
    }));

    const beforeCount = fixture.messages.length;
    fixture.manager.handleCodexTransportMessage(JSON.stringify({
      jsonrpc: "2.0",
      method: "codex/event/agent_message_content_delta",
      params: {
        conversationId: thread.id,
        event: {
          item: {
            id: "item-legacy-forward",
            turnId: "turn-legacy-forward",
          },
          delta: "hello",
        },
      },
    }));

    const forwarded = fixture.messages[beforeCount];
    assert.ok(forwarded);
    assert.equal(forwarded.method, "timeline/itemTextUpdated");
    assert.equal(forwarded.params.threadId, thread.id);
    assert.ok(forwarded.params.cursor);
  } finally {
    fixture.cleanup();
  }
});

test("legacy Codex event notifications are normalized into canonical timeline cache updates", async () => {
  const fixture = createManagerFixtureWithOptions({
    useDefaultCodexAdapter: true,
  });

  try {
    const threadRef = {
      current: buildCodexThread({
        threadId: "codex-legacy-event-thread",
        messageCount: 3,
        turnId: "turn-legacy",
      }),
    };
    const transportFixture = createDefaultCodexTransportFixture(fixture.manager, { threadRef });
    fixture.manager.attachCodexTransport(transportFixture.transport);

    const tailMessages = await request(fixture, "legacy-tail", "thread/read", {
      threadId: threadRef.current.id,
      history: {
        mode: "tail",
        limit: 3,
      },
    });
    const tailResponse = responseById(tailMessages, "legacy-tail");
    assert.ok(tailResponse);
    assert.equal(tailResponse.result.historyWindow.servedFromCache, true);
    assert.deepEqual(
      tailResponse.result.thread.turns[0].items.map((item: { id: string }) => item.id),
      ["item-1", "item-2", "item-3"]
    );

    const nextThread = buildCodexThread({
      threadId: threadRef.current.id,
      messageCount: 4,
      turnId: "turn-legacy",
    });
    threadRef.current = nextThread;

    fixture.manager.handleCodexTransportMessage(JSON.stringify({
      jsonrpc: "2.0",
      method: "coderover/event",
      params: {
        conversationId: nextThread.id,
        event: {
          type: "agent_message",
          item: {
            id: "item-4",
            turnId: "turn-legacy",
          },
          message: "message-4",
        },
      },
    }));
    const liveUpdate = fixture.messages.at(-1);
    assert.ok(liveUpdate);
    assert.equal(liveUpdate.method, "timeline/itemCompleted");
    assert.equal(liveUpdate.params.threadId, nextThread.id);
    assert.equal(liveUpdate.params.timelineItemId, "item-4");

    const afterMessages = await request(fixture, "legacy-after", "thread/read", {
      threadId: threadRef.current.id,
      history: {
        mode: "after",
        limit: 3,
        cursor: tailResponse.result.historyWindow.newerCursor,
      },
    });
    const afterResponse = responseById(afterMessages, "legacy-after");
    assert.ok(afterResponse);
    assert.equal(afterResponse.result.historyWindow.servedFromCache, true);
    assert.deepEqual(
      afterResponse.result.thread.turns[0].items.map((item: { id: string }) => item.id),
      ["item-4"]
    );
    assert.equal(transportFixture.readCountsByThread.get(threadRef.current.id), 2);
  } finally {
    fixture.cleanup();
  }
});

test("codex/event legacy notifications are normalized into canonical timeline cache updates", async () => {
  const fixture = createManagerFixtureWithOptions({
    useDefaultCodexAdapter: true,
  });

  try {
    const threadRef = {
      current: buildCodexThread({
        threadId: "codex-legacy-prefix-thread",
        messageCount: 3,
        turnId: "turn-legacy-prefix",
      }),
    };
    const transportFixture = createDefaultCodexTransportFixture(fixture.manager, { threadRef });
    fixture.manager.attachCodexTransport(transportFixture.transport);

    const tailMessages = await request(fixture, "legacy-prefix-tail", "thread/read", {
      threadId: threadRef.current.id,
      history: {
        mode: "tail",
        limit: 3,
      },
    });
    const tailResponse = responseById(tailMessages, "legacy-prefix-tail");
    assert.ok(tailResponse);
    assert.equal(tailResponse.result.historyWindow.servedFromCache, true);

    threadRef.current = buildCodexThread({
      threadId: threadRef.current.id,
      messageCount: 4,
      turnId: "turn-legacy-prefix",
    });

    fixture.manager.handleCodexTransportMessage(JSON.stringify({
      jsonrpc: "2.0",
      method: "codex/event",
      params: {
        conversationId: threadRef.current.id,
        event: {
          type: "agent_message",
          item: {
            id: "item-4",
            turnId: "turn-legacy-prefix",
          },
          message: "message-4",
        },
      },
    }));
    const liveUpdate = fixture.messages.at(-1);
    assert.ok(liveUpdate);
    assert.equal(liveUpdate.method, "timeline/itemCompleted");
    assert.equal(liveUpdate.params.threadId, threadRef.current.id);
    assert.equal(liveUpdate.params.timelineItemId, "item-4");

    const afterMessages = await request(fixture, "legacy-prefix-after", "thread/read", {
      threadId: threadRef.current.id,
      history: {
        mode: "after",
        limit: 3,
        cursor: tailResponse.result.historyWindow.newerCursor,
      },
    });
    const afterResponse = responseById(afterMessages, "legacy-prefix-after");
    assert.ok(afterResponse);
    assert.equal(afterResponse.result.historyWindow.servedFromCache, true);
    assert.deepEqual(
      afterResponse.result.thread.turns[0].items.map((item: { id: string }) => item.id),
      ["item-4"]
    );
    assert.equal(transportFixture.readCountsByThread.get(threadRef.current.id), 2);
  } finally {
    fixture.cleanup();
  }
});

test("entered review mode items are forwarded as canonical command-execution rows", async () => {
  const fixture = createManagerFixtureWithOptions({
    useDefaultCodexAdapter: true,
  });

  try {
    const thread = buildCodexThread({ messageCount: 0 });
    fixture.manager.attachCodexTransport({ send() {} });
    fixture.manager.handleCodexTransportMessage(JSON.stringify({
      jsonrpc: "2.0",
      method: "thread/started",
      params: { thread },
    }));
    fixture.manager.handleCodexTransportMessage(JSON.stringify({
      jsonrpc: "2.0",
      method: "turn/started",
      params: {
        threadId: thread.id,
        turnId: "turn-review-enter",
      },
    }));

    fixture.manager.handleCodexTransportMessage(JSON.stringify({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: thread.id,
        turnId: "turn-review-enter",
        item: {
          id: "review-enter-item",
          type: "entered_review_mode",
          review: "current changes",
        },
      },
    }));

    const forwarded = fixture.messages.at(-1);
    assert.ok(forwarded);
    assert.equal(forwarded.method, "timeline/itemCompleted");
    assert.equal(forwarded.params.kind, "commandExecution");
    assert.equal(forwarded.params.role, "system");
    assert.equal(forwarded.params.text, "Reviewing current changes...");
  } finally {
    fixture.cleanup();
  }
});

test("exited review mode items are forwarded as canonical assistant rows", async () => {
  const fixture = createManagerFixtureWithOptions({
    useDefaultCodexAdapter: true,
  });

  try {
    const thread = buildCodexThread({ messageCount: 0 });
    fixture.manager.attachCodexTransport({ send() {} });
    fixture.manager.handleCodexTransportMessage(JSON.stringify({
      jsonrpc: "2.0",
      method: "thread/started",
      params: { thread },
    }));
    fixture.manager.handleCodexTransportMessage(JSON.stringify({
      jsonrpc: "2.0",
      method: "turn/started",
      params: {
        threadId: thread.id,
        turnId: "turn-review-exit",
      },
    }));

    fixture.manager.handleCodexTransportMessage(JSON.stringify({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: thread.id,
        turnId: "turn-review-exit",
        item: {
          id: "review-exit-item",
          type: "exited_review_mode",
          review: "P1: tighten the nil checks before merging.",
        },
      },
    }));

    const forwarded = fixture.messages.at(-1);
    assert.ok(forwarded);
    assert.equal(forwarded.method, "timeline/itemCompleted");
    assert.equal(forwarded.params.kind, "chat");
    assert.equal(forwarded.params.role, "assistant");
    assert.equal(forwarded.params.text, "P1: tighten the nil checks before merging.");
  } finally {
    fixture.cleanup();
  }
});

test("legacy collab spawn item aliases are forwarded as canonical subagent rows", async () => {
  const fixture = createManagerFixtureWithOptions({
    useDefaultCodexAdapter: true,
  });

  try {
    const thread = buildCodexThread({ messageCount: 0 });
    fixture.manager.attachCodexTransport({ send() {} });
    fixture.manager.handleCodexTransportMessage(JSON.stringify({
      jsonrpc: "2.0",
      method: "thread/started",
      params: { thread },
    }));
    fixture.manager.handleCodexTransportMessage(JSON.stringify({
      jsonrpc: "2.0",
      method: "turn/started",
      params: {
        threadId: thread.id,
        turnId: "turn-collab-alias",
      },
    }));

    fixture.manager.handleCodexTransportMessage(JSON.stringify({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: thread.id,
        turnId: "turn-collab-alias",
        item: {
          id: "collab-item",
          type: "collab_agent_spawn_worker",
          tool: "spawnAgent",
          status: "completed",
          receiver_thread_ids: ["child-thread-1"],
        },
      },
    }));

    const forwarded = fixture.messages.at(-1);
    assert.ok(forwarded);
    assert.equal(forwarded.method, "timeline/itemCompleted");
    assert.equal(forwarded.params.kind, "subagentAction");
    assert.deepEqual(forwarded.params.receiverThreadIds, ["child-thread-1"]);
  } finally {
    fixture.cleanup();
  }
});

test("Codex delta notifications without threadId still advance cache windows via turn context", async () => {
  const fixture = createManagerFixtureWithOptions({
    useDefaultCodexAdapter: true,
  });

  try {
    const threadRef = {
      current: buildCodexThread({
        threadId: "codex-turn-context-thread",
        messageCount: 3,
        turnId: "turn-context",
      }),
    };
    const transportFixture = createDefaultCodexTransportFixture(fixture.manager, { threadRef });
    fixture.manager.attachCodexTransport(transportFixture.transport);

    const tailMessages = await request(fixture, "turn-context-tail", "thread/read", {
      threadId: threadRef.current.id,
      history: {
        mode: "tail",
        limit: 3,
      },
    });
    const tailResponse = responseById(tailMessages, "turn-context-tail");
    assert.ok(tailResponse);
    assert.equal(tailResponse.result.historyWindow.servedFromCache, true);

    const beforeCount = fixture.messages.length;
    fixture.manager.handleCodexTransportMessage(JSON.stringify({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: {
        turnId: "turn-context",
        itemId: "item-4",
        delta: "message-4",
      },
    }));

    const forwarded = fixture.messages[beforeCount];
    assert.ok(forwarded);
    assert.equal(forwarded.method, "timeline/itemTextUpdated");

    const afterMessages = await request(fixture, "turn-context-after", "thread/read", {
      threadId: threadRef.current.id,
      history: {
        mode: "after",
        limit: 3,
        cursor: tailResponse.result.historyWindow.newerCursor,
      },
    });
    const afterResponse = responseById(afterMessages, "turn-context-after");
    assert.ok(afterResponse);
    assert.equal(afterResponse.result.historyWindow.servedFromCache, true);
    assert.deepEqual(
      afterResponse.result.thread.turns[0].items.map((item: { id: string }) => item.id),
      ["item-4"]
    );
  } finally {
    fixture.cleanup();
  }
});

test("forwarded Codex item delta notifications backfill thread and turn identity from cache", async () => {
  const fixture = createManagerFixtureWithOptions({
    useDefaultCodexAdapter: true,
  });

  try {
    const thread = buildCodexThread({ messageCount: 0 });
    fixture.manager.attachCodexTransport({ send() {} });
    fixture.manager.handleCodexTransportMessage(JSON.stringify({
      jsonrpc: "2.0",
      method: "thread/started",
      params: {
        thread,
      },
    }));
    fixture.manager.handleCodexTransportMessage(JSON.stringify({
      jsonrpc: "2.0",
      method: "turn/started",
      params: {
        threadId: thread.id,
        turnId: "turn-identity",
      },
    }));

    fixture.manager.handleCodexTransportMessage(JSON.stringify({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: {
        threadId: thread.id,
        turnId: "turn-identity",
        itemId: "item-identity",
        delta: "hello",
      },
    }));

    const beforeCount = fixture.messages.length;
    fixture.manager.handleCodexTransportMessage(JSON.stringify({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: {
        itemId: "item-identity",
        delta: " world",
      },
    }));

    const forwarded = fixture.messages[beforeCount];
    assert.ok(forwarded);
    assert.equal(forwarded.method, "timeline/itemTextUpdated");
    assert.equal(forwarded.params.threadId, thread.id);
    assert.equal(forwarded.params.turnId, "turn-identity");
    assert.equal(forwarded.params.timelineItemId, "item-identity");
  } finally {
    fixture.cleanup();
  }
});

test("Codex command deltas without item ids get distinct timeline items per command", async () => {
  const fixture = createManagerFixtureWithOptions({
    useDefaultCodexAdapter: true,
  });

  try {
    const threadRef = {
      current: buildCodexThread({
        threadId: "codex-command-provisional-thread",
        messageCount: 0,
        turnId: "turn-command-provisional",
      }),
    };
    const transportFixture = createDefaultCodexTransportFixture(fixture.manager, { threadRef });
    fixture.manager.attachCodexTransport(transportFixture.transport);

    await request(fixture, "command-provisional-tail", "thread/read", {
      threadId: threadRef.current.id,
      history: {
        mode: "tail",
        limit: 10,
      },
    });

    fixture.manager.handleCodexTransportMessage(JSON.stringify({
      jsonrpc: "2.0",
      method: "item/commandExecution/outputDelta",
      params: {
        threadId: threadRef.current.id,
        turnId: "turn-command-provisional",
        command: "sed -n '1,10p' file-a.ts",
        status: "running",
        delta: "sed -n '1,10p' file-a.ts",
      },
    }));

    fixture.manager.handleCodexTransportMessage(JSON.stringify({
      jsonrpc: "2.0",
      method: "item/commandExecution/outputDelta",
      params: {
        threadId: threadRef.current.id,
        turnId: "turn-command-provisional",
        command: "sed -n '11,20p' file-b.ts",
        status: "running",
        delta: "sed -n '11,20p' file-b.ts",
      },
    }));

    const tailMessages = await request(fixture, "command-provisional-tail-2", "thread/read", {
      threadId: threadRef.current.id,
      history: {
        mode: "tail",
        limit: 10,
      },
    });
    const tailResponse = responseById(tailMessages, "command-provisional-tail-2");
    assert.equal(tailResponse.result.thread.turns[0].items.length, 2);
    assert.deepEqual(
      tailResponse.result.thread.turns[0].items.map((item: { text?: string }) => item.text),
      [
        "sed -n '1,10p' file-a.ts",
        "sed -n '11,20p' file-b.ts",
      ]
    );
  } finally {
    fixture.cleanup();
  }
});

test("unscoped Codex history events invalidate cache so reopen fetches upstream", async () => {
  const fixture = createManagerFixtureWithOptions({
    useDefaultCodexAdapter: true,
  });

  try {
    const threadRef = {
      current: buildCodexThread({
        threadId: "codex-unscoped-history-thread",
        messageCount: 3,
        turnId: "turn-unscoped",
      }),
    };
    const transportFixture = createDefaultCodexTransportFixture(fixture.manager, { threadRef });
    fixture.manager.attachCodexTransport(transportFixture.transport);

    const tailMessages = await request(fixture, "unscoped-tail", "thread/read", {
      threadId: threadRef.current.id,
      history: {
        mode: "tail",
        limit: 3,
      },
    });
    const tailResponse = responseById(tailMessages, "unscoped-tail");
    assert.ok(tailResponse);
    assert.equal(tailResponse.result.historyWindow.servedFromCache, true);

    const nextThread = buildCodexThread({
      threadId: threadRef.current.id,
      messageCount: 4,
      turnId: "turn-unscoped",
    });
    threadRef.current = nextThread;

    fixture.manager.handleCodexTransportMessage(JSON.stringify({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: {
        itemId: "item-4",
        delta: "message-4",
      },
    }));

    const afterMessages = await request(fixture, "unscoped-after", "thread/read", {
      threadId: threadRef.current.id,
      history: {
        mode: "after",
        limit: 3,
        cursor: tailResponse.result.historyWindow.newerCursor,
      },
    });
    const afterResponse = responseById(afterMessages, "unscoped-after");
    assert.ok(afterResponse);
    assert.equal(afterResponse.result.historyWindow.servedFromCache, false);
    assert.deepEqual(
      afterResponse.result.thread.turns[0].items.map((item: { id: string }) => item.id),
      ["item-4"]
    );
  } finally {
    fixture.cleanup();
  }
});

test("Codex tail history cache is bypassed after thread list reports a newer updatedAt", async () => {
  const threadRef = {
    current: buildCodexThread({
      threadId: "codex-stale-tail-cache-thread",
      messageCount: 3,
      turnId: "turn-stale-tail",
    }),
  };
  const readParams: ThreadReadParams[] = [];
  const codexAdapter = createCodexAdapterStub({
    async request(method: string) {
      if (method === "initialize") {
        return { ok: true };
      }
      throw new Error(`unexpected request: ${method}`);
    },
    async listThreads() {
      return {
        threads: threadRef.current ? [{
          id: threadRef.current.id,
          title: threadRef.current.title,
          preview: threadRef.current.preview,
          createdAt: threadRef.current.createdAt,
          updatedAt: threadRef.current.updatedAt,
          cwd: threadRef.current.cwd,
        }] : [],
      };
    },
    async readThread(params: ThreadReadParams = {}) {
      readParams.push(JSON.parse(JSON.stringify(params)));
      const thread = threadRef.current;
      assert.ok(thread);
      if (params.includeTurns === false) {
        const metaThread = JSON.parse(JSON.stringify(thread));
        delete metaThread.turns;
        return { thread: metaThread };
      }
      if (params.history) {
        return buildCodexHistoryResult(thread, params.history);
      }
      return { thread };
    },
  });
  const fixture = createManagerFixtureWithOptions({ codexAdapter });

  try {
    const initialListMessages = await request(fixture, "codex-stale-list-1", "thread/list", {});
    const initialListResponse = responseById(initialListMessages, "codex-stale-list-1");
    assert.ok(initialListResponse);

    const initialTailMessages = await request(fixture, "codex-stale-tail-1", "thread/read", {
      threadId: threadRef.current.id,
      history: {
        mode: "tail",
        limit: 3,
      },
    });
    const initialTailResponse = responseById(initialTailMessages, "codex-stale-tail-1");
    assert.deepEqual(
      initialTailResponse.result.thread.turns[0].items.map((item: { id: string }) => item.id),
      ["item-1", "item-2", "item-3"]
    );
    const readCountAfterInitialTail = readParams.length;

    threadRef.current = buildCodexThread({
      threadId: "codex-stale-tail-cache-thread",
      messageCount: 4,
      turnId: "turn-stale-tail",
    });

    const refreshedListMessages = await request(fixture, "codex-stale-list-2", "thread/list", {});
    const refreshedListResponse = responseById(refreshedListMessages, "codex-stale-list-2");
    assert.ok(refreshedListResponse);

    const refreshedTailMessages = await request(fixture, "codex-stale-tail-2", "thread/read", {
      threadId: threadRef.current.id,
      history: {
        mode: "tail",
        limit: 4,
      },
    });
    const refreshedTailResponse = responseById(refreshedTailMessages, "codex-stale-tail-2");
    assert.deepEqual(
      refreshedTailResponse.result.thread.turns[0].items.map((item: { id: string }) => item.id),
      ["item-1", "item-2", "item-3", "item-4"]
    );
    assert.ok(readParams.length > readCountAfterInitialTail);
  } finally {
    fixture.cleanup();
  }
});

test("thread/read history before window falls back to upstream when the cache boundary has a gap", async () => {
  const thread = buildCodexThread();
  const codexFixture = createCodexAdapterFixture({ threads: [thread] });
  const fixture = createManagerFixtureWithOptions({
    codexAdapter: codexFixture.adapter,
  });

  try {
    const tailMessages = await request(fixture, "thread-read-tail", "thread/read", {
      threadId: thread.id,
      history: {
        mode: "tail",
        limit: 50,
      },
    });
    const tailResponse = responseById(tailMessages, "thread-read-tail");
    assert.equal(codexFixture.readCountsByThread.get(thread.id), 2);

    const beforeMessages = await request(fixture, "thread-read-before", "thread/read", {
      threadId: thread.id,
      history: {
        mode: "before",
        limit: 50,
        cursor: tailResponse.result.historyWindow.olderCursor,
      },
    });
    const beforeResponse = responseById(beforeMessages, "thread-read-before");
    assert.equal(beforeResponse.result.historyWindow.servedFromCache, true);
    assert.equal(beforeResponse.result.thread.turns[0].items[0].id, "item-81");
    assert.equal(beforeResponse.result.thread.turns[0].items.length, 50);
    assert.equal(codexFixture.readCountsByThread.get(thread.id), 3);
  } finally {
    fixture.cleanup();
  }
});

test("managed thread/read history windows expose the same cursor shape as Codex", async () => {
  const claudeAdapter = {
    syncImportedThreads: async () => {},
    hydrateThread: async () => {},
    async startTurn({ turnContext }: { turnContext: ManagedProviderTurnContext }) {
      turnContext.appendAgentDelta("message-1", { itemId: "item-1" });
      turnContext.appendAgentDelta("message-2", { itemId: "item-2" });
      turnContext.appendAgentDelta("message-3", { itemId: "item-3" });
      return {};
    },
  };
  const fixture = createManagerFixtureWithOptions({ claudeAdapter });

  try {
    const started = await request(fixture, "managed-thread-start", "thread/start", {
      provider: "claude",
      cwd: "/tmp/managed-project",
    });
    const threadId = responseById(started, "managed-thread-start").result.thread.id;

    await request(fixture, "managed-turn-start", "turn/start", {
      threadId,
      input: [],
    });
    await drainMicrotasks();

    const tailMessages = await request(fixture, "managed-thread-tail", "thread/read", {
      threadId,
      history: {
        mode: "tail",
        limit: 2,
      },
    });
    const tailResponse = responseById(tailMessages, "managed-thread-tail");
    assert.equal(tailResponse.result.historyWindow.pageSize, 2);
    assert.equal(tailResponse.result.historyWindow.servedFromProjection, true);
    assert.equal(tailResponse.result.historyWindow.projectionSource, "managed_runtime");
    assert.equal(tailResponse.result.historyWindow.syncEpoch, 1);
    assert.equal(tailResponse.result.historyWindow.hasOlder, true);
    assert.equal(tailResponse.result.historyWindow.hasNewer, false);
    assert.ok(tailResponse.result.historyWindow.olderCursor);
    assert.ok(tailResponse.result.historyWindow.newerCursor);
    assert.deepEqual(
      tailResponse.result.thread.turns[0].items.map((item: { id: string }) => item.id),
      ["item-2", "item-3"]
    );

    const beforeMessages = await request(fixture, "managed-thread-before", "thread/read", {
      threadId,
      history: {
        mode: "before",
        limit: 1,
        cursor: tailResponse.result.historyWindow.olderCursor,
      },
    });
    const beforeResponse = responseById(beforeMessages, "managed-thread-before");
    assert.deepEqual(
      beforeResponse.result.thread.turns[0].items.map((item: { id: string }) => item.id),
      ["item-1"]
    );
    assert.equal(beforeResponse.result.historyWindow.hasOlder, false);
    assert.equal(beforeResponse.result.historyWindow.hasNewer, true);

    const afterMessages = await request(fixture, "managed-thread-after", "thread/read", {
      threadId,
      history: {
        mode: "after",
        limit: 1,
        cursor: tailResponse.result.historyWindow.olderCursor,
      },
    });
    const afterResponse = responseById(afterMessages, "managed-thread-after");
    assert.deepEqual(
      afterResponse.result.thread.turns[0].items.map((item: { id: string }) => item.id),
      ["item-3"]
    );
    assert.equal(afterResponse.result.historyWindow.hasOlder, true);
    assert.equal(afterResponse.result.historyWindow.hasNewer, false);
  } finally {
    fixture.cleanup();
  }
});

test("managed realtime notifications include cursor and previousCursor metadata", async () => {
  const geminiAdapter = {
    syncImportedThreads: async () => {},
    hydrateThread: async () => {},
    async startTurn({ turnContext }: { turnContext: ManagedProviderTurnContext }) {
      turnContext.appendAgentDelta("message-1", { itemId: "item-1" });
      turnContext.appendAgentDelta("message-2", { itemId: "item-2" });
      return {};
    },
  };
  const fixture = createManagerFixtureWithOptions({ geminiAdapter });

  try {
    const started = await request(fixture, "managed-gemini-thread", "thread/start", {
      provider: "gemini",
      cwd: "/tmp/gemini-project",
    });
    const threadId = responseById(started, "managed-gemini-thread").result.thread.id;

    const beforeCount = fixture.messages.length;
    await request(fixture, "managed-gemini-turn", "turn/start", {
      threadId,
      input: [],
    });
    await drainMicrotasks();

    const itemNotifications = fixture.messages
      .slice(beforeCount)
      .filter((message: RpcMessage) => message.method === "timeline/itemTextUpdated");
    assert.equal(itemNotifications.length, 2);
    assert.ok(itemNotifications[0]);
    assert.ok(itemNotifications[1]);
    assert.ok(itemNotifications[0].params.cursor);
    assert.equal(itemNotifications[0].params.previousCursor, undefined);
    assert.ok(itemNotifications[1].params.cursor);
    assert.equal(itemNotifications[1].params.previousItemId, "item-1");
    assert.equal(itemNotifications[1].params.previousCursor, itemNotifications[0].params.cursor);
  } finally {
    fixture.cleanup();
  }
});

test("thread/read rejects malformed history.cursor", async () => {
  const codexFixture = createCodexAdapterFixture({
    threads: [buildCodexThread({ threadId: "codex-invalid-cursor", messageCount: 4 })],
  });
  const fixture = createManagerFixtureWithOptions({
    codexAdapter: codexFixture.adapter,
  });

  try {
    const messages = await request(fixture, "thread-read-invalid-cursor", "thread/read", {
      threadId: "codex-invalid-cursor",
      history: {
        mode: "after",
        limit: 5,
        cursor: "not-a-valid-cursor",
      },
    });
    const response = responseById(messages, "thread-read-invalid-cursor");
    assert.equal(response.error.code, -32602);
    assert.match(response.error.message, /history\.cursor is invalid/i);
  } finally {
    fixture.cleanup();
  }
});

test("Codex history cache evicts the least recently used thread after twenty entries", async () => {
  const threads = Array.from({ length: 21 }, (_, index) =>
    buildCodexThread({
      threadId: `codex-thread-${index + 1}`,
      messageCount: 60,
      turnId: `turn-${index + 1}`,
    })
  );
  const codexFixture = createCodexAdapterFixture({ threads });
  const fixture = createManagerFixtureWithOptions({
    codexAdapter: codexFixture.adapter,
  });

  try {
    for (const thread of threads) {
      await request(fixture, `tail-${thread.id}`, "thread/read", {
        threadId: thread.id,
        history: {
          mode: "tail",
          limit: 50,
        },
      });
    }

    assert.equal(codexFixture.readCountsByThread.get("codex-thread-1"), 2);

    const rereadMessages = await request(fixture, "tail-codex-thread-1-reread", "thread/read", {
      threadId: "codex-thread-1",
      history: {
        mode: "tail",
        limit: 50,
      },
    });
    const rereadResponse = responseById(rereadMessages, "tail-codex-thread-1-reread");
    assert.equal(rereadResponse.result.historyWindow.servedFromCache, true);
    assert.equal(codexFixture.readCountsByThread.get("codex-thread-1"), 3);
  } finally {
    fixture.cleanup();
  }
});

test("Codex thread/resume seeds history cache with the resumed snapshot", async () => {
  const resumedThread = buildCodexThread({
    threadId: "codex-resume-cache-thread",
    messageCount: 6,
    turnId: "turn-resume-cache",
  });
  const staleHistoryThread = buildCodexThread({
    threadId: "codex-resume-cache-thread",
    messageCount: 3,
    turnId: "turn-resume-cache",
  });
  const readParams: ThreadReadParams[] = [];
  const codexAdapter = createCodexAdapterStub({
    async request(method: string) {
      if (method === "initialize") {
        return { ok: true };
      }
      throw new Error(`unexpected request: ${method}`);
    },
    async listThreads() {
      return {
        threads: [{
          id: resumedThread.id,
          title: resumedThread.title,
          preview: resumedThread.preview,
          createdAt: resumedThread.createdAt,
          updatedAt: resumedThread.updatedAt,
          cwd: resumedThread.cwd,
        }],
      };
    },
    async readThread(params: ThreadReadParams = {}) {
      readParams.push(JSON.parse(JSON.stringify(params)));
      if (params.history) {
        return buildCodexHistoryResult(staleHistoryThread, params.history);
      }
      return { thread: staleHistoryThread };
    },
    async resumeThread() {
      return {
        threadId: resumedThread.id,
        resumed: true,
        thread: JSON.parse(JSON.stringify(resumedThread)),
      };
    },
  });
  const fixture = createManagerFixtureWithOptions({ codexAdapter });

  try {
    await request(fixture, "codex-resume-cache-list", "thread/list", {});

    const resumeMessages = await request(fixture, "codex-resume-cache-resume", "thread/resume", {
      threadId: resumedThread.id,
    });
    const resumeResponse = responseById(resumeMessages, "codex-resume-cache-resume");
    assert.ok(resumeResponse);
    assert.equal(resumeResponse.result.thread.turns[0].items.length, 6);

    const tailMessages = await request(fixture, "codex-resume-cache-tail", "thread/read", {
      threadId: resumedThread.id,
      history: {
        mode: "tail",
        limit: 3,
      },
    });
    const tailResponse = responseById(tailMessages, "codex-resume-cache-tail");
    assert.ok(tailResponse);
    assert.equal(tailResponse.result.historyWindow.servedFromCache, true);
    assert.deepEqual(
      tailResponse.result.thread.turns[0].items.map((item: { id: string }) => item.id),
      ["item-4", "item-5", "item-6"]
    );
    assert.equal(readParams.filter((params) => Boolean(params.history)).length, 0);
  } finally {
    fixture.cleanup();
  }
});

test("sparse Codex thread/read snapshots do not clobber seeded history cache", async () => {
  const thread = buildCodexThread({
    threadId: "codex-sparse-read-cache-thread",
    messageCount: 5,
    turnId: "turn-sparse-read-cache",
  });
  let sparseReads = 0;
  const codexAdapter = createCodexAdapterStub({
    async request(method: string) {
      if (method === "initialize") {
        return { ok: true };
      }
      throw new Error(`unexpected request: ${method}`);
    },
    async listThreads() {
      return {
        threads: [{
          id: thread.id,
          title: thread.title,
          preview: thread.preview,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          cwd: thread.cwd,
        }],
      };
    },
    async readThread(params: ThreadReadParams = {}) {
      if (params.history) {
        return buildCodexHistoryResult(thread, params.history);
      }
      sparseReads += 1;
      return {
        thread: {
          id: thread.id,
          title: thread.title,
          preview: thread.preview,
          cwd: thread.cwd,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          turns: [{
            id: "turn-sparse-read-cache",
            createdAt: thread.createdAt,
            status: "running",
            items: [],
          }],
        },
      };
    },
    async resumeThread() {
      return {
        threadId: thread.id,
        resumed: true,
        thread: JSON.parse(JSON.stringify(thread)),
      };
    },
  });
  const fixture = createManagerFixtureWithOptions({ codexAdapter });

  try {
    await request(fixture, "codex-sparse-read-cache-list", "thread/list", {});
    await request(fixture, "codex-sparse-read-cache-resume", "thread/resume", {
      threadId: thread.id,
    });

    const sparseReadMessages = await request(fixture, "codex-sparse-read-cache-read", "thread/read", {
      threadId: thread.id,
      includeTurns: true,
    });
    const sparseReadResponse = responseById(sparseReadMessages, "codex-sparse-read-cache-read");
    assert.ok(sparseReadResponse);
    assert.equal(sparseReadResponse.result.thread.turns[0].items.length, 0);

    const tailMessages = await request(fixture, "codex-sparse-read-cache-tail", "thread/read", {
      threadId: thread.id,
      history: {
        mode: "tail",
        limit: 2,
      },
    });
    const tailResponse = responseById(tailMessages, "codex-sparse-read-cache-tail");
    assert.ok(tailResponse);
    assert.equal(tailResponse.result.historyWindow.servedFromCache, true);
    assert.deepEqual(
      tailResponse.result.thread.turns[0].items.map((item: { id: string }) => item.id),
      ["item-4", "item-5"]
    );
    assert.equal(sparseReads, 1);
  } finally {
    fixture.cleanup();
  }
});

test("observed Codex threads emit thread/history/changed after bridge-side thread/read polling detects new history", async () => {
  const threadRef = {
    current: buildCodexThread({
      threadId: "codex-observed-thread",
      messageCount: 2,
      turnId: "turn-observed",
    }),
  };
  const readCountsByThread = new Map<string, number>();
  const codexAdapter = createCodexAdapterStub({
    async request(method: string) {
      if (method === "initialize") {
        return { ok: true };
      }
      throw new Error(`unexpected request: ${method}`);
    },
    async listThreads() {
      return {
        threads: [{
          id: threadRef.current.id,
          title: threadRef.current.title,
          preview: threadRef.current.preview,
          createdAt: threadRef.current.createdAt,
          updatedAt: threadRef.current.updatedAt,
          cwd: threadRef.current.cwd,
        }],
      };
    },
    async readThread(params: ThreadReadParams = {}) {
      const threadId = String(params.threadId || "");
      readCountsByThread.set(threadId, (readCountsByThread.get(threadId) || 0) + 1);
      return {
        thread: JSON.parse(JSON.stringify(threadRef.current)),
      };
    },
    async resumeThread(params: ThreadActionParams = {}) {
      return {
        threadId: params.threadId,
        resumed: true,
      };
    },
  });
  const fixture = createManagerFixtureWithOptions({
    codexAdapter,
    runtimeOptions: {
      codexObservedThreadPollIntervalMs: 20,
      codexObservedThreadIdleTtlMs: 500,
      codexObservedThreadErrorBackoffMs: 20,
    },
  });

  try {
    await request(fixture, "observed-tail", "thread/read", {
      threadId: threadRef.current.id,
      history: {
        mode: "tail",
        limit: 10,
      },
    });

    const beforeCount = fixture.messages.length;
    threadRef.current = buildCodexThread({
      threadId: threadRef.current.id,
      messageCount: 3,
      turnId: "turn-observed",
    });

    await sleep(80);

    const newMessages = fixture.messages.slice(beforeCount);
    const historyChanged = newMessages.find((message: RpcMessage) => message.method === "thread/history/changed");
    assert.ok(historyChanged);
    assert.equal(historyChanged.params.threadId, threadRef.current.id);
    assert.equal(historyChanged.params.sourceMethod, "thread/read");
    assert.equal(historyChanged.params.rawMethod, "thread/read");
    assert.equal(historyChanged.params.itemId, "item-3");
    assert.ok(historyChanged.params.cursor);
    assert.ok((readCountsByThread.get(threadRef.current.id) || 0) >= 2);
  } finally {
    fixture.cleanup();
  }
});

test("observed non-managed Codex threads project rollout history and realtime updates without upstream history polling", async () => {
  const previousCodexHome = process.env.CODEX_HOME;
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "coderover-rollout-home-"));
  process.env.CODEX_HOME = codexHome;

  const threadId = "codex-rollout-thread-1";
  const turnId = "rollout-turn-1";
  const rolloutDir = path.join(codexHome, "sessions", "2026", "04", "21");
  const rolloutPath = path.join(rolloutDir, `rollout-2026-04-21T10-00-00-${threadId}.jsonl`);
  fs.mkdirSync(rolloutDir, { recursive: true });
  fs.writeFileSync(rolloutPath, [
    JSON.stringify({
      timestamp: "2026-04-21T10:00:00.000Z",
      type: "session_meta",
      payload: {
        id: threadId,
        cwd: "/tmp/codex-rollout-project",
        originator: "Codex Desktop",
        source: "vscode",
      },
    }),
    JSON.stringify({
      timestamp: "2026-04-21T10:00:01.000Z",
      type: "event_msg",
      payload: {
        type: "task_started",
        turn_id: turnId,
      },
    }),
    JSON.stringify({
      timestamp: "2026-04-21T10:00:02.000Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "Inspect the rollout observer",
      },
    }),
    JSON.stringify({
      timestamp: "2026-04-21T10:00:03.000Z",
      type: "event_msg",
      payload: {
        type: "agent_reasoning",
        text: "Thinking through the rollout stream",
      },
    }),
    JSON.stringify({
      timestamp: "2026-04-21T10:00:04.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        arguments: "{\"cmd\":\"ls -la\",\"workdir\":\"/tmp/codex-rollout-project\"}",
        call_id: "call-rollout-1",
      },
    }),
    JSON.stringify({
      timestamp: "2026-04-21T10:00:05.000Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call-rollout-1",
        output: "file-a\\nfile-b",
      },
    }),
    JSON.stringify({
      timestamp: "2026-04-21T10:00:06.000Z",
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "Rollout projection is live.",
      },
    }),
    JSON.stringify({
      timestamp: "2026-04-21T10:00:07.000Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: turnId,
      },
    }),
    "",
  ].join("\n"));

  const readParams: ThreadReadParams[] = [];
  const codexAdapter = createCodexAdapterStub({
    async request(method: string) {
      if (method === "initialize") {
        return { ok: true };
      }
      throw new Error(`unexpected request: ${method}`);
    },
    notify() {},
    async readThread(params: ThreadReadParams = {}) {
      readParams.push(JSON.parse(JSON.stringify(params)));
      if (params.includeTurns === false) {
        return {
          thread: {
            id: threadId,
            title: "Rollout Thread",
            preview: "Rollout projection is live.",
            cwd: "/tmp/codex-rollout-project",
            createdAt: "2026-04-21T10:00:00.000Z",
            updatedAt: "2026-04-21T10:00:07.000Z",
          },
        };
      }
      throw new Error("unexpected upstream history read");
    },
    async resumeThread() {
      return {
        thread: {
          id: threadId,
          title: "Rollout Thread",
          preview: "Rollout projection is live.",
          cwd: "/tmp/codex-rollout-project",
          createdAt: "2026-04-21T10:00:00.000Z",
          updatedAt: "2026-04-21T10:00:07.000Z",
        },
      };
    },
  });

  const fixture = createManagerFixtureWithOptions({
    codexAdapter,
    runtimeOptions: {
      codexObservedThreadPollIntervalMs: 20,
      codexObservedThreadIdleTtlMs: 2_000,
    },
  });
  const readSessionRecord = async () => {
    const indexPath = path.join(fixture.baseDir, "thread-session-index.json");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (fs.existsSync(indexPath)) {
        const indexPayload = JSON.parse(fs.readFileSync(indexPath, "utf8")) as {
          sessions: Record<string, {
            activeTurnId: string | null;
            ownerState: string;
            sourceKind: string;
          }>;
        };
        const record = indexPayload.sessions[threadId];
        if (record) {
          return record;
        }
      }
      await sleep(10);
    }
    throw new Error("expected rollout session record to be persisted");
  };

  try {
    const initialMessages = await request(fixture, "rollout-tail-read", "thread/read", {
      threadId,
      history: {
        mode: "tail",
        limit: 50,
      },
    });
    const initialResponse = responseById(initialMessages, "rollout-tail-read");
    assert.equal(initialResponse.result.historyWindow.servedFromProjection, true);
    assert.equal(initialResponse.result.historyWindow.projectionSource, "rollout_observer");
    assert.ok(initialResponse.result.historyWindow.syncEpoch >= 1);
    assert.deepEqual(
      initialResponse.result.thread.turns[0].items.map((item: { type: string }) => item.type),
      ["user_message", "reasoning", "command_execution", "agent_message"]
    );
    assert.equal(readParams.filter((params) => Boolean(params.history)).length, 0);
    assert.equal(readParams.filter((params) => params.includeTurns === false).length, 0);
    let sessionRecord = await readSessionRecord();
    assert.equal(sessionRecord.ownerState, "idle");
    assert.equal(sessionRecord.sourceKind, "rollout_observer");
    assert.equal(sessionRecord.activeTurnId, null);

    const rereadMessages = await request(fixture, "rollout-tail-reread", "thread/read", {
      threadId,
      history: {
        mode: "tail",
        limit: 50,
      },
    });
    const rereadResponse = responseById(rereadMessages, "rollout-tail-reread");
    assert.equal(
      rereadResponse.result.historyWindow.newerCursor,
      initialResponse.result.historyWindow.newerCursor
    );
    assert.equal(
      rereadResponse.result.historyWindow.newestAnchor.createdAt,
      "2026-04-21T10:00:06.000Z"
    );
    sessionRecord = await readSessionRecord();
    assert.equal(sessionRecord.activeTurnId, null);

    const resumeMessages = await request(fixture, "rollout-resume", "thread/resume", {
      threadId,
    });
    const resumeResponse = responseById(resumeMessages, "rollout-resume");
    assert.equal(resumeResponse.result.sourceKind, "rollout_observer");
    assert.equal(resumeResponse.result.syncEpoch, initialResponse.result.historyWindow.syncEpoch);

    const messageCountBeforeGrowth = fixture.messages.length;
    fs.appendFileSync(rolloutPath, [
      JSON.stringify({
        timestamp: "2026-04-21T10:00:08.000Z",
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: "rollout-turn-2",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-21T10:00:09.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Resume from mobile takeover seed",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-21T10:00:10.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "Realtime rollout delta arrived.",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-21T10:00:11.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "rollout-turn-2",
        },
      }),
      "",
    ].join("\n"));

    await sleep(120);

    const growthMessages = fixture.messages.slice(messageCountBeforeGrowth);
    assert.ok(
      growthMessages.some((message: RpcMessage) =>
        message.method === "timeline/itemCompleted"
        && message.params?.text === "Realtime rollout delta arrived."
        && message.params?.sourceKind === "rollout_observer"
      )
    );
    assert.ok(
      growthMessages.some((message: RpcMessage) =>
        message.method === "thread/history/changed"
        && message.params?.sourceKind === "rollout_observer"
      )
    );
    assert.equal(readParams.filter((params) => Boolean(params.history)).length, 0);
    sessionRecord = await readSessionRecord();
    assert.equal(sessionRecord.ownerState, "idle");
    assert.equal(sessionRecord.activeTurnId, null);
  } finally {
    fixture.cleanup();
    fs.rmSync(codexHome, { recursive: true, force: true });
    if (previousCodexHome == null) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
  }
});

test("observed Codex rollout recovery keeps later turn history after a truncated tail line", async () => {
  const previousCodexHome = process.env.CODEX_HOME;
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "coderover-rollout-recovery-home-"));
  process.env.CODEX_HOME = codexHome;

  const threadId = "codex-rollout-recovery-thread";
  const rolloutDir = path.join(codexHome, "sessions", "2026", "04", "22");
  const rolloutPath = path.join(rolloutDir, `rollout-2026-04-22T10-00-00-${threadId}.jsonl`);
  fs.mkdirSync(rolloutDir, { recursive: true });
  fs.writeFileSync(rolloutPath, [
    JSON.stringify({
      timestamp: "2026-04-22T10:00:00.000Z",
      type: "session_meta",
      payload: {
        id: threadId,
        cwd: "/tmp/codex-rollout-recovery",
        originator: "Codex Desktop",
        source: "vscode",
      },
    }),
    "{\"timestamp\":\"2026-04-22T10:00:01.000Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\"",
  ].join("\n"));

  const readParams: ThreadReadParams[] = [];
  const codexAdapter = createCodexAdapterStub({
    async request(method: string) {
      if (method === "initialize") {
        return { ok: true };
      }
      throw new Error(`unexpected request: ${method}`);
    },
    notify() {},
    async readThread(params: ThreadReadParams = {}) {
      readParams.push(JSON.parse(JSON.stringify(params)));
      if (params.includeTurns === false) {
        return {
          thread: {
            id: threadId,
            title: "Recovered Rollout Thread",
            preview: "Later rollout events should survive truncation.",
            cwd: "/tmp/codex-rollout-recovery",
            createdAt: "2026-04-22T10:00:00.000Z",
            updatedAt: "2026-04-22T10:00:01.000Z",
          },
        };
      }
      throw new Error("unexpected upstream history read");
    },
  });

  const fixture = createManagerFixtureWithOptions({
    codexAdapter,
    runtimeOptions: {
      codexObservedThreadPollIntervalMs: 20,
      codexObservedThreadIdleTtlMs: 2_000,
    },
  });

  try {
    const initialMessages = await request(fixture, "rollout-recovery-tail-read", "thread/read", {
      threadId,
      history: {
        mode: "tail",
        limit: 50,
      },
    });
    const initialResponse = responseById(initialMessages, "rollout-recovery-tail-read");
    assert.equal(initialResponse.result.historyWindow.servedFromProjection, true);
    assert.equal(initialResponse.result.historyWindow.projectionSource, "rollout_observer");

    const messageCountBeforeGrowth = fixture.messages.length;
    fs.appendFileSync(rolloutPath, [
      JSON.stringify({
        timestamp: "2026-04-22T10:00:02.000Z",
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: "rollout-turn-recovered",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-22T10:00:03.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Continue after manual stop",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-22T10:00:04.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "Recovered after truncated rollout tail.",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-22T10:00:05.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "rollout-turn-recovered",
        },
      }),
      "",
    ].join("\n"));

    await sleep(120);

    const growthMessages = fixture.messages.slice(messageCountBeforeGrowth);
    assert.ok(
      growthMessages.some((message: RpcMessage) =>
        message.method === "timeline/itemCompleted"
        && message.params?.text === "Recovered after truncated rollout tail."
        && message.params?.sourceKind === "rollout_observer"
      )
    );
    assert.ok(
      growthMessages.some((message: RpcMessage) =>
        message.method === "thread/history/changed"
        && message.params?.sourceKind === "rollout_observer"
      )
    );

    const refreshedMessages = await request(fixture, "rollout-recovery-tail-reread", "thread/read", {
      threadId,
      history: {
        mode: "tail",
        limit: 50,
      },
    });
    const refreshedResponse = responseById(refreshedMessages, "rollout-recovery-tail-reread");
    const recoveredTurn = refreshedResponse.result.thread.turns.find(
      (turn: { id: string }) => turn.id === "rollout-turn-recovered"
    );
    assert.ok(recoveredTurn);
    assert.deepEqual(
      recoveredTurn.items.map((item: { type: string; text?: string }) => ({
        type: item.type,
        text: item.text || "",
      })),
      [
        {
          type: "user_message",
          text: "Continue after manual stop",
        },
        {
          type: "agent_message",
          text: "Recovered after truncated rollout tail.",
        },
      ]
    );
    assert.equal(readParams.filter((params) => Boolean(params.history)).length, 0);
  } finally {
    fixture.cleanup();
    fs.rmSync(codexHome, { recursive: true, force: true });
    if (previousCodexHome == null) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
  }
});

test("observed Codex threads do not emit repeated thread/history/changed for unchanged long histories", async () => {
  const threadRef = {
    current: buildCodexThread({
      threadId: "codex-observed-stable-thread",
      messageCount: 180,
      turnId: "turn-observed-stable",
    }),
  };
  const codexAdapter = createCodexAdapterStub({
    async request(method: string) {
      if (method === "initialize") {
        return { ok: true };
      }
      throw new Error(`unexpected request: ${method}`);
    },
    async listThreads() {
      return {
        threads: [{
          id: threadRef.current.id,
          title: threadRef.current.title,
          preview: threadRef.current.preview,
          createdAt: threadRef.current.createdAt,
          updatedAt: threadRef.current.updatedAt,
          cwd: threadRef.current.cwd,
        }],
      };
    },
    async readThread() {
      return {
        thread: JSON.parse(JSON.stringify(threadRef.current)),
      };
    },
  });
  const fixture = createManagerFixtureWithOptions({
    codexAdapter,
    runtimeOptions: {
      codexObservedThreadPollIntervalMs: 20,
      codexObservedThreadIdleTtlMs: 500,
      codexObservedThreadErrorBackoffMs: 20,
    },
  });

  try {
    await request(fixture, "observed-stable-tail", "thread/read", {
      threadId: threadRef.current.id,
      history: {
        mode: "tail",
        limit: 50,
      },
    });

    const beforeCount = fixture.messages.length;
    await sleep(80);

    const newMessages = fixture.messages.slice(beforeCount);
    const historyChangedMessages = newMessages.filter((message: RpcMessage) => message.method === "thread/history/changed");
    assert.equal(historyChangedMessages.length, 0);
  } finally {
    fixture.cleanup();
  }
});

test("Codex overlays keep local naming while refreshing upstream preview and updatedAt", async () => {
  const threadRef = {
    current: buildCodexThread({
      threadId: "codex-overlay-thread",
      messageCount: 2,
      turnId: "turn-overlay",
    }),
  };
  const codexAdapter: any = {
    attachTransport() {},
    handleIncomingRaw() {},
    handleTransportClosed() {},
    isAvailable() {
      return true;
    },
    async request(method) {
      if (method === "initialize") {
        return { ok: true };
      }
      throw new Error(`unexpected request: ${method}`);
    },
    notify() {},
    sendRaw() {},
    async collaborationModes() {
      return {};
    },
    async compactThread() {
      return {};
    },
    async fuzzyFileSearch() {
      return {};
    },
    async interruptTurn() {
      return {};
    },
    async listThreads() {
      return {
        threads: [{
          id: threadRef.current.id,
          title: threadRef.current.title,
          preview: threadRef.current.preview,
          createdAt: threadRef.current.createdAt,
          updatedAt: threadRef.current.updatedAt,
          cwd: threadRef.current.cwd,
        }],
      };
    },
    async readThread() {
      return {
        thread: JSON.parse(JSON.stringify(threadRef.current)),
      };
    },
    async listModels() {
      return { items: [] };
    },
    async listSkills() {
      return { skills: [] };
    },
    async resumeThread(params) {
      return { threadId: params.threadId, resumed: true };
    },
    async startThread() {
      return {};
    },
    async startTurn() {
      return {};
    },
    async steerTurn() {
      return {};
    },
  };
  const fixture = createManagerFixtureWithOptions({
    codexAdapter,
  });

  try {
    const initialRead = await request(fixture, "codex-overlay-read-1", "thread/read", {
      threadId: threadRef.current.id,
      includeTurns: true,
    });
    const initialResponse = responseById(initialRead, "codex-overlay-read-1");
    assert.ok(initialResponse);
    assert.equal(initialResponse.result.thread.preview, "message-2");

    const renameMessages = await request(fixture, "codex-overlay-rename", "thread/name/set", {
      threadId: threadRef.current.id,
      name: "Pinned Codex Name",
    });
    const renameResponse = responseById(renameMessages, "codex-overlay-rename");
    assert.ok(renameResponse);
    assert.equal(renameResponse.result.thread.name, "Pinned Codex Name");

    threadRef.current = buildCodexThread({
      threadId: "codex-overlay-thread",
      messageCount: 3,
      turnId: "turn-overlay",
    });

    const refreshedRead = await request(fixture, "codex-overlay-read-2", "thread/read", {
      threadId: threadRef.current.id,
      includeTurns: true,
    });
    const refreshedResponse = responseById(refreshedRead, "codex-overlay-read-2");
    assert.ok(refreshedResponse);
    assert.equal(refreshedResponse.result.thread.name, "Pinned Codex Name");
    assert.equal(refreshedResponse.result.thread.preview, "message-3");
    assert.equal(refreshedResponse.result.thread.updatedAt, threadRef.current.updatedAt);

    const listMessages = await request(fixture, "codex-overlay-list", "thread/list", {});
    const listResponse = responseById(listMessages, "codex-overlay-list");
    assert.ok(listResponse);
    assert.equal(listResponse.result.items[0].name, "Pinned Codex Name");
    assert.equal(listResponse.result.items[0].preview, "message-3");
    assert.equal(listResponse.result.items[0].updatedAt, threadRef.current.updatedAt);
  } finally {
    fixture.cleanup();
  }
});
