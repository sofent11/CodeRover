// FILE: runtime-manager.test.js
// Purpose: Verifies bridge-managed multi-provider routing for non-CodeRover threads.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, fs, os, path, ../src/runtime-manager

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createRuntimeManager } = require("../src/runtime-manager");

function createManagerFixture() {
  return createManagerFixtureWithOptions({});
}

function createManagerFixtureWithOptions({
  codexAdapter: providedCodexAdapter = null,
  claudeAdapter: providedClaudeAdapter = null,
  geminiAdapter: providedGeminiAdapter = null,
  useDefaultCodexAdapter = false,
} = {}) {
  const messages = [];
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "coderover-runtime-manager-"));
  const noopAsync = async () => {};
  const codexAdapter = providedCodexAdapter || (useDefaultCodexAdapter ? null : {
    attachTransport() {},
    handleIncomingRaw() {},
    handleTransportClosed() {},
    isAvailable() {
      return false;
    },
  });
  const claudeAdapter = providedClaudeAdapter || {
    syncImportedThreads: noopAsync,
    hydrateThread: noopAsync,
    startTurn: noopAsync,
  };
  const geminiAdapter = providedGeminiAdapter || {
    syncImportedThreads: noopAsync,
    hydrateThread: noopAsync,
    startTurn: noopAsync,
  };
  const manager = createRuntimeManager({
    sendApplicationMessage(message) {
      messages.push(JSON.parse(message));
    },
    storeBaseDir: baseDir,
    codexAdapter,
    claudeAdapter,
    geminiAdapter,
  });

  return {
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

async function request(fixture, id, method, params) {
  const beforeCount = fixture.messages.length;
  await fixture.manager.handleClientMessage(JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    params,
  }));
  return fixture.messages.slice(beforeCount);
}

function responseById(messages, id) {
  return messages.find((message) => message.id === id);
}

test("runtime/provider/list advertises Codex, Claude, and Gemini capabilities", async () => {
  const fixture = createManagerFixture();

  try {
    const messages = await request(fixture, "providers-1", "runtime/provider/list", {});
    const response = responseById(messages, "providers-1");
    assert.ok(response);
    assert.deepEqual(
      response.result.providers.map((provider) => provider.id),
      ["codex", "claude", "gemini"]
    );
    assert.equal(response.result.providers[1].supports.turnSteer, false);
    assert.equal(response.result.providers[2].supports.reasoningOptions, false);
  } finally {
    fixture.cleanup();
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
    assert.ok(startMessages.some((message) => message.method === "thread/started"));

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

function createCodexAdapterFixture({
  threads = [],
} = {}) {
  const readCountsByThread = new Map();
  let attachedTransport = null;

  function findThread(threadId) {
    return threads.find((thread) => thread.id === threadId) || null;
  }

  return {
    adapter: {
      attachTransport(transport) {
        attachedTransport = transport;
      },
      handleIncomingRaw() {},
      handleTransportClosed() {
        attachedTransport = null;
      },
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
      async readThread(params) {
        const threadId = params.threadId;
        readCountsByThread.set(threadId, (readCountsByThread.get(threadId) || 0) + 1);
        const thread = findThread(threadId);
        if (!thread) {
          return {};
        }
        return {
          thread: JSON.parse(JSON.stringify(thread)),
        };
      },
      async startTurn(params) {
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
} = {}) {
  const createdAtBase = Date.parse("2026-03-14T00:00:00.000Z");
  const items = [];
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

test("thread/list forwards Codex cursor metadata while merging thread arrays", async () => {
  const codexFixture = createCodexAdapterFixture({
    threads: [buildCodexThread({ threadId: "codex-thread-list", messageCount: 4 })],
  });
  const fixture = createManagerFixtureWithOptions({
    codexAdapter: codexFixture.adapter,
  });

  try {
    const messages = await request(fixture, "thread-list-cursor", "thread/list", {});
    const response = responseById(messages, "thread-list-cursor");
    assert.ok(response);
    assert.equal(response.result.nextCursor, "cursor-2");
    assert.equal(response.result.hasMore, true);
    assert.equal(response.result.pageSize, 1);
    assert.equal(response.result.items.length, 1);
    assert.equal(response.result.items[0].provider, "codex");
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
    assert.equal(tailResponse.result.historyWindow.servedFromCache, false);
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
    assert.equal(forwarded.method, "item/agentMessage/delta");
    assert.ok(forwarded.params.cursor);
    assert.ok(forwarded.params.previousCursor);
    assert.equal(forwarded.params.previousItemId, "item-3");
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
    assert.equal(beforeResponse.result.historyWindow.servedFromCache, false);
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
    async startTurn({ turnContext }) {
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
    assert.equal(tailResponse.result.historyWindow.hasOlder, true);
    assert.equal(tailResponse.result.historyWindow.hasNewer, false);
    assert.ok(tailResponse.result.historyWindow.olderCursor);
    assert.ok(tailResponse.result.historyWindow.newerCursor);
    assert.deepEqual(
      tailResponse.result.thread.turns[0].items.map((item) => item.id),
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
      beforeResponse.result.thread.turns[0].items.map((item) => item.id),
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
      afterResponse.result.thread.turns[0].items.map((item) => item.id),
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
    async startTurn({ turnContext }) {
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
      .filter((message) => message.method === "item/agentMessage/delta");
    assert.equal(itemNotifications.length, 2);
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
    assert.equal(rereadResponse.result.historyWindow.servedFromCache, false);
    assert.equal(codexFixture.readCountsByThread.get("codex-thread-1"), 3);
  } finally {
    fixture.cleanup();
  }
});
