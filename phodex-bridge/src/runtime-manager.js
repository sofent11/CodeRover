// FILE: runtime-manager.js
// Purpose: Bridge-owned multi-provider runtime router for Codex, Claude Code, and Gemini CLI.
// Layer: Runtime orchestration
// Exports: createRuntimeManager
// Depends on: crypto, ./runtime-store, ./provider-catalog, ./providers/*

const { randomUUID } = require("crypto");
const { createRuntimeStore } = require("./runtime-store");
const {
  getRuntimeProvider,
  listRuntimeProviders,
  listStaticModelsForProvider,
} = require("./provider-catalog");
const { buildRpcError, buildRpcSuccess } = require("./rpc-client");
const { createCodexAdapter } = require("./providers/codex-adapter");
const { createClaudeAdapter } = require("./providers/claude-adapter");
const { createGeminiAdapter } = require("./providers/gemini-adapter");

const ERROR_METHOD_NOT_FOUND = -32601;
const ERROR_INVALID_PARAMS = -32602;
const ERROR_INTERNAL = -32603;
const ERROR_THREAD_NOT_FOUND = -32004;
const EXTERNAL_SYNC_INTERVAL_MS = 10_000;

function createRuntimeManager({
  sendApplicationMessage,
  logPrefix = "[remodex]",
  storeBaseDir,
  store: providedStore = null,
  codexAdapter: providedCodexAdapter = null,
  claudeAdapter: providedClaudeAdapter = null,
  geminiAdapter: providedGeminiAdapter = null,
} = {}) {
  if (typeof sendApplicationMessage !== "function") {
    throw new Error("createRuntimeManager requires sendApplicationMessage");
  }

  const store = providedStore || createRuntimeStore({ baseDir: storeBaseDir });
  const pendingClientRequests = new Map();
  const activeRunsByThread = new Map();

  let codexWarm = false;
  let codexWarmPromise = null;
  let lastExternalSyncAt = 0;

  const codexAdapter = providedCodexAdapter || createCodexAdapter({
    logPrefix,
    sendToClient(rawMessage) {
      sendApplicationMessage(rawMessage);
    },
  });

  const claudeAdapter = providedClaudeAdapter || createClaudeAdapter({
    logPrefix,
    store,
  });
  const geminiAdapter = providedGeminiAdapter || createGeminiAdapter({
    logPrefix,
    store,
  });

  async function handleClientMessage(rawMessage) {
    let parsed = null;
    try {
      parsed = JSON.parse(rawMessage);
    } catch {
      return false;
    }

    if (parsed?.method == null && parsed?.id != null) {
      return handleClientResponse(rawMessage, parsed);
    }

    const method = normalizeNonEmptyString(parsed?.method);
    if (!method) {
      return false;
    }

    const params = asObject(parsed?.params);
    const requestId = parsed?.id;

    try {
      switch (method) {
        case "initialize":
          await ensureCodexWarm(params);
          if (requestId != null) {
            sendApplicationMessage(buildRpcSuccess(requestId, { bridgeManaged: true }));
          }
          return true;

        case "initialized":
          return true;

        case "runtime/provider/list":
          if (requestId != null) {
            sendApplicationMessage(buildRpcSuccess(requestId, {
              providers: listRuntimeProviders(),
            }));
          }
          return true;

        case "model/list":
          return await handleRequestWithResponse(requestId, async () => {
            await ensureExternalThreadsIndexed();
            const provider = resolveProviderId(params);
            if (provider === "codex") {
              await ensureCodexWarm();
              const result = await codexAdapter.listModels(stripProviderField(params));
              return normalizeModelListResult(result);
            }
            return {
              items: listStaticModelsForProvider(provider),
            };
          });

        case "collaborationMode/list":
          return await handleRequestWithResponse(requestId, async () => ({
            modes: [
              { id: "default", title: "Default" },
              { id: "plan", title: "Plan" },
            ],
          }));

        case "thread/list":
          return await handleRequestWithResponse(requestId, async () => {
            await ensureExternalThreadsIndexed();
            return buildThreadListResult(await listThreads(params));
          });

        case "thread/read":
          return await handleRequestWithResponse(requestId, async () => {
            await ensureExternalThreadsIndexed();
            return readThread(stripProviderField(params));
          });

        case "thread/start":
          return await handleRequestWithResponse(requestId, async () => {
            const provider = resolveProviderId(params);
            if (provider === "codex") {
              await ensureCodexWarm();
              const result = await codexAdapter.startThread(stripProviderField(params));
              const thread = extractThreadFromResult(result);
              if (thread) {
                const decorated = decorateCodexThread(thread);
                upsertOverlayFromThread(decorated);
                sendThreadStartedNotification(decorated);
                return { thread: decorated };
              }
              return result || {};
            }

            const threadMeta = store.createThread({
              provider,
              cwd: firstNonEmptyString([params.cwd, params.current_working_directory, params.working_directory]),
              model: normalizeOptionalString(params.model),
              title: null,
              name: null,
              preview: null,
              metadata: buildProviderMetadata(provider),
              capabilities: getRuntimeProvider(provider).supports,
            });
            const threadObject = buildManagedThreadObject(threadMeta);
            sendThreadStartedNotification(threadObject);
            return { thread: threadObject };
          });

        case "thread/resume":
          return await handleRequestWithResponse(requestId, async () => {
            const threadMeta = await requireThreadMeta(params.threadId || params.thread_id);
            if (threadMeta.provider === "codex") {
              await ensureCodexWarm();
              return codexAdapter.resumeThread(stripProviderField(params));
            }
            return {
              threadId: threadMeta.id,
              resumed: true,
            };
          });

        case "thread/compact/start":
          return await handleRequestWithResponse(requestId, async () => {
            const threadMeta = await requireThreadMeta(params.threadId || params.thread_id);
            if (threadMeta.provider !== "codex") {
              throw createMethodError("thread/compact/start is only available for Codex threads");
            }
            await ensureCodexWarm();
            return codexAdapter.compactThread(stripProviderField(params));
          });

        case "thread/name/set":
          return await handleRequestWithResponse(requestId, async () => {
            const threadMeta = await requireThreadMeta(params.threadId || params.thread_id);
            const nextName = normalizeOptionalString(params.name);
            const updatedMeta = store.updateThreadMeta(threadMeta.id, (entry) => ({
              ...entry,
              name: nextName,
              updatedAt: new Date().toISOString(),
            }));

            sendNotification("thread/name/updated", {
              threadId: updatedMeta.id,
              name: updatedMeta.name,
            });
            return {
              thread: buildManagedThreadObject(updatedMeta),
            };
          });

        case "thread/archive":
        case "thread/unarchive":
          return await handleRequestWithResponse(requestId, async () => {
            const threadMeta = await requireThreadMeta(params.threadId || params.thread_id);
            const archived = method === "thread/archive";
            const updatedMeta = store.updateThreadMeta(threadMeta.id, (entry) => ({
              ...entry,
              archived,
              updatedAt: new Date().toISOString(),
            }));
            return {
              thread: buildManagedThreadObject(updatedMeta),
            };
          });

        case "turn/start":
          return await handleRequestWithResponse(requestId, async () => {
            const threadMeta = await requireThreadMeta(params.threadId || params.thread_id);
            if (threadMeta.provider === "codex") {
              await ensureCodexWarm();
              return codexAdapter.startTurn(stripProviderField(params));
            }

            if (activeRunsByThread.has(threadMeta.id)) {
              throw createRuntimeError(ERROR_INVALID_PARAMS, "A turn is already running for this thread");
            }

            const turnContext = createManagedTurnContext(threadMeta, params);
            const adapter = getManagedProviderAdapter(threadMeta.provider);
            const runEntry = {
              provider: threadMeta.provider,
              threadId: threadMeta.id,
              turnId: turnContext.turnId,
              stopRequested: false,
              interrupt() {
                turnContext.interrupt();
              },
            };
            activeRunsByThread.set(threadMeta.id, runEntry);

            Promise.resolve()
              .then(() => adapter.startTurn({
                params,
                threadMeta,
                turnContext,
              }))
              .then((result) => {
                if (!activeRunsByThread.has(threadMeta.id)) {
                  return;
                }
                turnContext.complete({
                  status: runEntry.stopRequested ? "stopped" : "completed",
                  usage: result?.usage || null,
                });
              })
              .catch((error) => {
                if (!activeRunsByThread.has(threadMeta.id)) {
                  return;
                }
                const aborted = turnContext.abortController.signal.aborted || runEntry.stopRequested;
                turnContext.fail(error, {
                  status: aborted ? "stopped" : "failed",
                });
              })
              .finally(() => {
                activeRunsByThread.delete(threadMeta.id);
              });

            return {
              threadId: threadMeta.id,
              turnId: turnContext.turnId,
            };
          });

        case "turn/interrupt":
          return await handleRequestWithResponse(requestId, async () => {
            const threadId = normalizeOptionalString(params.threadId || params.thread_id)
              || findThreadIdByTurnId(params.turnId || params.turn_id);
            const threadMeta = await requireThreadMeta(threadId);
            if (threadMeta.provider === "codex") {
              await ensureCodexWarm();
              return codexAdapter.interruptTurn(stripProviderField(params));
            }

            const activeRun = activeRunsByThread.get(threadMeta.id);
            if (!activeRun) {
              return {};
            }

            activeRun.stopRequested = true;
            activeRun.interrupt();
            return {};
          });

        case "turn/steer":
          return await handleRequestWithResponse(requestId, async () => {
            const threadMeta = await requireThreadMeta(params.threadId || params.thread_id);
            if (threadMeta.provider !== "codex") {
              throw createMethodError("turn/steer is only available for Codex threads");
            }
            await ensureCodexWarm();
            return codexAdapter.steerTurn(stripProviderField(params));
          });

        case "skills/list":
          return await handleRequestWithResponse(requestId, async () => {
            await ensureCodexWarm();
            const result = await codexAdapter.listSkills(params || {});
            return normalizeSkillsResult(result);
          });

        case "fuzzyFileSearch":
          return await handleRequestWithResponse(requestId, async () => {
            await ensureCodexWarm();
            const result = await codexAdapter.fuzzyFileSearch(params || {});
            return normalizeFuzzyFileResult(result);
          });

        default:
          if (requestId != null) {
            sendApplicationMessage(buildRpcError(requestId, ERROR_METHOD_NOT_FOUND, `Unsupported method: ${method}`));
            return true;
          }
          return false;
      }
    } catch (error) {
      if (requestId == null) {
        console.error(`${logPrefix} ${error.message}`);
        return true;
      }

      const code = Number.isInteger(error.code) ? error.code : ERROR_INTERNAL;
      sendApplicationMessage(buildRpcError(requestId, code, error.message || "Internal runtime error"));
      return true;
    }
  }

  function attachCodexTransport(transport) {
    codexWarm = false;
    codexWarmPromise = null;
    codexAdapter.attachTransport(transport);
  }

  function handleCodexTransportMessage(rawMessage) {
    codexAdapter.handleIncomingRaw(rawMessage);
  }

  function handleCodexTransportClosed(reason) {
    codexWarm = false;
    codexWarmPromise = null;
    codexAdapter.handleTransportClosed(reason);
  }

  function shutdown() {
    store.shutdown();
  }

  async function handleClientResponse(rawMessage, parsed) {
    const responseKey = encodeRequestId(parsed.id);
    const pending = pendingClientRequests.get(responseKey);
    if (pending) {
      pendingClientRequests.delete(responseKey);
      if (parsed.error) {
        pending.reject(new Error(parsed.error.message || "Client rejected server request"));
      } else {
        pending.resolve(parsed.result);
      }

      if (pending.method === "item/tool/requestUserInput") {
        sendNotification("serverRequest/resolved", {
          requestId: parsed.id,
          threadId: pending.threadId,
        });
      }
      return true;
    }

    if (codexAdapter.isAvailable()) {
      codexAdapter.sendRaw(rawMessage);
      return true;
    }

    return false;
  }

  async function handleRequestWithResponse(requestId, handler) {
    if (requestId == null) {
      await handler();
      return true;
    }
    const result = await handler();
    sendApplicationMessage(buildRpcSuccess(requestId, result));
    return true;
  }

  async function ensureCodexWarm(initializeParams = null) {
    if (codexWarm) {
      return;
    }
    if (!codexAdapter.isAvailable()) {
      return;
    }
    if (codexWarmPromise) {
      return codexWarmPromise;
    }

    codexWarmPromise = (async () => {
      try {
        await codexAdapter.request("initialize", initializeParams || defaultInitializeParams());
      } catch (error) {
        const message = String(error?.message || "").toLowerCase();
        if (!message.includes("already initialized")) {
          throw error;
        }
      }

      try {
        codexAdapter.notify("initialized", {});
      } catch {
        // Best-effort only.
      }
      codexWarm = true;
    })();

    try {
      await codexWarmPromise;
    } finally {
      if (!codexWarm) {
        codexWarmPromise = null;
      }
    }
  }

  async function ensureExternalThreadsIndexed() {
    const now = Date.now();
    if ((now - lastExternalSyncAt) < EXTERNAL_SYNC_INTERVAL_MS) {
      return;
    }
    lastExternalSyncAt = now;
    await Promise.allSettled([
      claudeAdapter.syncImportedThreads(),
      geminiAdapter.syncImportedThreads(),
    ]);
  }

  async function listThreads(params) {
    const archived = Boolean(params?.archived);
    const codexThreads = await listCodexThreads(params, archived);
    const managedThreads = store.listThreadMetas()
      .filter((entry) => entry.provider !== "codex")
      .filter((entry) => Boolean(entry.archived) === archived)
      .map((entry) => buildManagedThreadObject(entry));

    return mergeThreadLists([...codexThreads, ...managedThreads]);
  }

  async function listCodexThreads(params, archived) {
    if (!codexAdapter.isAvailable()) {
      return [];
    }

    await ensureCodexWarm();
    const result = await codexAdapter.listThreads(stripProviderField(params || {}));
    const threads = extractThreadArray(result).map((thread) => decorateCodexThread(thread));
    return threads.filter((thread) => {
      const overlay = store.getThreadMeta(thread.id);
      const overlayArchived = overlay?.archived;
      if (overlayArchived != null) {
        return Boolean(overlayArchived) === archived;
      }
      return archived === Boolean(params?.archived);
    });
  }

  async function readThread(params) {
    const threadId = normalizeOptionalString(params.threadId || params.thread_id);
    const threadMeta = await requireThreadMeta(threadId);

    if (threadMeta.provider === "codex") {
      await ensureCodexWarm();
      const result = await codexAdapter.readThread(params);
      const threadObject = extractThreadFromResult(result);
      if (!threadObject) {
        throw createRuntimeError(ERROR_THREAD_NOT_FOUND, `Thread not found: ${threadId}`);
      }

      const decoratedThread = decorateCodexThread(threadObject);
      upsertOverlayFromThread(decoratedThread);
      return {
        thread: decoratedThread,
      };
    }

    await getManagedProviderAdapter(threadMeta.provider).hydrateThread(threadMeta);
    const refreshedMeta = store.getThreadMeta(threadMeta.id) || threadMeta;
    const history = store.getThreadHistory(threadMeta.id);
    return {
      thread: buildManagedThreadObject(refreshedMeta, history?.turns || []),
    };
  }

  async function requireThreadMeta(threadId) {
    const normalizedThreadId = normalizeOptionalString(threadId);
    if (!normalizedThreadId) {
      throw createRuntimeError(ERROR_INVALID_PARAMS, "threadId is required");
    }

    const storedMeta = store.getThreadMeta(normalizedThreadId);
    if (storedMeta) {
      return storedMeta;
    }

    if (!normalizedThreadId.startsWith("claude:") && !normalizedThreadId.startsWith("gemini:")) {
      const codexThread = await readCodexThreadMeta(normalizedThreadId);
      if (codexThread) {
        return codexThread;
      }
    }

    throw createRuntimeError(ERROR_THREAD_NOT_FOUND, `Thread not found: ${normalizedThreadId}`);
  }

  async function readCodexThreadMeta(threadId) {
    if (!codexAdapter.isAvailable()) {
      return null;
    }
    try {
      await ensureCodexWarm();
      const result = await codexAdapter.readThread({
        threadId,
        includeTurns: false,
      });
      const threadObject = extractThreadFromResult(result);
      if (!threadObject) {
        return null;
      }
      const decorated = decorateCodexThread(threadObject);
      upsertOverlayFromThread(decorated);
      return store.getThreadMeta(threadId) || threadObjectToMeta(decorated);
    } catch {
      return null;
    }
  }

  function getManagedProviderAdapter(provider) {
    if (provider === "claude") {
      return claudeAdapter;
    }
    if (provider === "gemini") {
      return geminiAdapter;
    }
    throw createMethodError(`Managed adapter unavailable for provider: ${provider}`);
  }

  function createManagedTurnContext(threadMeta, params) {
    const providerDefinition = getRuntimeProvider(threadMeta.provider);
    const abortController = new AbortController();
    const nowIso = new Date().toISOString();
    const threadHistory = store.getThreadHistory(threadMeta.id) || { threadId: threadMeta.id, turns: [] };
    const turnId = randomUUID();
    const turnRecord = {
      id: turnId,
      createdAt: nowIso,
      status: "running",
      items: [],
    };
    threadHistory.turns.push(turnRecord);

    const inputItems = normalizeInputItems(params.input);
    const userTextPreview = inputItems
      .filter((entry) => entry.type === "text" && entry.text)
      .map((entry) => entry.text)
      .join("\n")
      .trim();

    if (inputItems.length > 0) {
      turnRecord.items.push({
        id: randomUUID(),
        type: "user_message",
        role: "user",
        content: inputItems,
        text: userTextPreview || null,
        createdAt: nowIso,
      });
    }

    store.saveThreadHistory(threadMeta.id, threadHistory);
    store.updateThreadMeta(threadMeta.id, (entry) => ({
      ...entry,
      preview: userTextPreview || entry.preview,
      updatedAt: nowIso,
      model: normalizeOptionalString(params.model) || entry.model,
      metadata: {
        ...(entry.metadata || {}),
        providerTitle: providerDefinition.title,
      },
      capabilities: providerDefinition.supports,
    }));

    sendNotification("turn/started", {
      threadId: threadMeta.id,
      turnId,
    });

    let interruptHandler = null;

    function ensureItem({ itemId, type, role = null, content = null, defaults = {} }) {
      const normalizedItemId = normalizeOptionalString(itemId) || randomUUID();
      let item = turnRecord.items.find((entry) => entry.id === normalizedItemId);
      if (!item) {
        item = {
          id: normalizedItemId,
          type,
          role,
          content: content ? [...content] : [],
          createdAt: new Date().toISOString(),
          ...defaults,
        };
        turnRecord.items.push(item);
      }
      return item;
    }

    function persistThreadHistory() {
      store.saveThreadHistory(threadMeta.id, threadHistory);
      store.updateThreadMeta(threadMeta.id, (entry) => ({
        ...entry,
        updatedAt: new Date().toISOString(),
      }));
    }

    function appendAgentDelta(delta, { itemId } = {}) {
      const normalizedDelta = normalizeOptionalString(delta);
      if (!normalizedDelta) {
        return;
      }
      const item = ensureItem({
        itemId,
        type: "agent_message",
        role: "assistant",
        content: [{ type: "text", text: "" }],
      });
      const firstText = item.content.find((entry) => entry.type === "text");
      if (firstText) {
        firstText.text = `${firstText.text || ""}${normalizedDelta}`;
      } else {
        item.content.push({ type: "text", text: normalizedDelta });
      }
      item.text = item.content
        .filter((entry) => entry.type === "text")
        .map((entry) => entry.text || "")
        .join("");
      persistThreadHistory();
      sendNotification("item/agentMessage/delta", {
        threadId: threadMeta.id,
        turnId,
        itemId: item.id,
        delta: normalizedDelta,
      });
    }

    function appendReasoningDelta(delta, { itemId } = {}) {
      const normalizedDelta = normalizeOptionalString(delta);
      if (!normalizedDelta) {
        return;
      }
      const item = ensureItem({
        itemId,
        type: "reasoning",
        defaults: { text: "" },
      });
      item.text = `${item.text || ""}${normalizedDelta}`;
      persistThreadHistory();
      sendNotification("item/reasoning/textDelta", {
        threadId: threadMeta.id,
        turnId,
        itemId: item.id,
        delta: normalizedDelta,
      });
    }

    function appendToolCallDelta(delta, { itemId, toolName, fileChanges, completed = false } = {}) {
      const normalizedDelta = normalizeOptionalString(delta);
      const item = ensureItem({
        itemId,
        type: "tool_call",
        defaults: {
          text: "",
          metadata: {},
          changes: [],
        },
      });
      if (normalizedDelta) {
        item.text = `${item.text || ""}${normalizedDelta}`;
      }
      if (toolName) {
        item.metadata = {
          ...(item.metadata || {}),
          toolName,
        };
      }
      if (Array.isArray(fileChanges) && fileChanges.length > 0) {
        item.changes = fileChanges;
      }
      persistThreadHistory();
      sendNotification(completed ? "item/toolCall/completed" : "item/toolCall/outputDelta", {
        threadId: threadMeta.id,
        turnId,
        itemId: item.id,
        delta: normalizedDelta || "",
        toolName,
        changes: item.changes,
      });
    }

    function updateCommandExecution({
      itemId,
      command,
      cwd,
      status,
      exitCode,
      durationMs,
      outputDelta,
    }) {
      const item = ensureItem({
        itemId,
        type: "command_execution",
        defaults: {
          command: null,
          status: "running",
          cwd: null,
          exitCode: null,
          durationMs: null,
          text: "",
        },
      });
      item.command = normalizeOptionalString(command) || item.command || null;
      item.cwd = normalizeOptionalString(cwd) || item.cwd || null;
      item.status = normalizeOptionalString(status) || item.status || "running";
      if (typeof exitCode === "number") {
        item.exitCode = exitCode;
      }
      if (typeof durationMs === "number") {
        item.durationMs = durationMs;
      }
      if (outputDelta != null) {
        item.text = buildCommandPreview(item.command, item.status, item.exitCode);
      }
      persistThreadHistory();
      sendNotification("item/commandExecution/outputDelta", {
        threadId: threadMeta.id,
        turnId,
        itemId: item.id,
        command: item.command,
        cwd: item.cwd,
        status: item.status,
        exitCode: item.exitCode,
        durationMs: item.durationMs,
        delta: item.text || "",
      });
    }

    function upsertPlan(planState, { itemId, deltaText } = {}) {
      const item = ensureItem({
        itemId,
        type: "plan",
        defaults: {
          explanation: null,
          summary: null,
          plan: [],
          text: "",
        },
      });
      const normalizedPlan = normalizePlanState(planState);
      item.explanation = normalizedPlan.explanation;
      item.summary = normalizedPlan.explanation;
      item.plan = normalizedPlan.steps;
      item.text = normalizeOptionalString(deltaText)
        || normalizedPlan.explanation
        || item.text
        || "Planning...";
      persistThreadHistory();
      sendNotification("turn/plan/updated", {
        threadId: threadMeta.id,
        turnId,
        itemId: item.id,
        explanation: item.explanation,
        summary: item.summary,
        plan: item.plan,
        delta: normalizeOptionalString(deltaText) || item.text,
      });
    }

    function bindProviderSession(sessionId) {
      if (!sessionId) {
        return;
      }
      store.bindProviderSession(threadMeta.id, threadMeta.provider, sessionId);
    }

    function updateTokenUsage(usage) {
      if (!usage || typeof usage !== "object") {
        return;
      }
      sendNotification("thread/tokenUsage/updated", {
        threadId: threadMeta.id,
        usage,
      });
    }

    function updatePreview(preview) {
      const normalizedPreview = normalizeOptionalString(preview);
      if (!normalizedPreview) {
        return;
      }
      store.updateThreadMeta(threadMeta.id, (entry) => ({
        ...entry,
        preview: normalizedPreview,
      }));
    }

    function requestApproval(request) {
      return requestFromClient({
        method: request.method || "item/tool/requestApproval",
        params: {
          threadId: threadMeta.id,
          turnId,
          itemId: request.itemId || randomUUID(),
          command: normalizeOptionalString(request.command),
          reason: normalizeOptionalString(request.reason),
          toolName: normalizeOptionalString(request.toolName),
        },
        threadId: threadMeta.id,
      });
    }

    function requestStructuredInput(request) {
      return requestFromClient({
        method: "item/tool/requestUserInput",
        params: {
          threadId: threadMeta.id,
          turnId,
          itemId: request.itemId || randomUUID(),
          questions: request.questions,
        },
        threadId: threadMeta.id,
      });
    }

    function setInterruptHandler(handler) {
      interruptHandler = typeof handler === "function" ? handler : null;
    }

    function complete({ status = "completed", usage = null } = {}) {
      turnRecord.status = status;
      persistThreadHistory();
      if (usage) {
        updateTokenUsage(usage);
      }
      sendNotification("turn/completed", {
        threadId: threadMeta.id,
        turnId,
        status,
      });
    }

    function fail(error, { status = "failed" } = {}) {
      const message = normalizeOptionalString(error?.message) || "Runtime error";
      sendNotification("error", {
        threadId: threadMeta.id,
        turnId,
        message,
      });
      complete({ status });
    }

    return {
      abortController,
      appendAgentDelta,
      appendReasoningDelta,
      appendToolCallDelta,
      bindProviderSession,
      complete,
      fail,
      inputItems,
      params,
      requestApproval,
      requestStructuredInput,
      setInterruptHandler,
      threadId: threadMeta.id,
      threadMeta,
      turnId,
      updateCommandExecution,
      updatePreview,
      updateTokenUsage,
      upsertPlan,
      userTextPreview,
      interrupt() {
        if (interruptHandler) {
          return interruptHandler();
        }
        return abortController.abort(new Error("Interrupted by user"));
      },
    };
  }

  function requestFromClient({ method, params, threadId }) {
    const requestId = randomUUID();
    const requestKey = encodeRequestId(requestId);
    return new Promise((resolve, reject) => {
      pendingClientRequests.set(requestKey, {
        method,
        threadId,
        resolve,
        reject,
      });
      sendApplicationMessage(JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method,
        params,
      }));
    });
  }

  function sendThreadStartedNotification(threadObject) {
    sendNotification("thread/started", {
      thread: threadObject,
    });
  }

  function sendNotification(method, params) {
    sendApplicationMessage(JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
    }));
  }

  function decorateCodexThread(threadObject) {
    const overlay = store.getThreadMeta(threadObject.id) || null;
    const providerDefinition = getRuntimeProvider("codex");
    return {
      ...threadObject,
      provider: "codex",
      providerSessionId: overlay?.providerSessionId || threadObject.id,
      capabilities: providerDefinition.supports,
      metadata: {
        ...(asObject(threadObject.metadata) || {}),
        ...(overlay?.metadata || {}),
        providerTitle: providerDefinition.title,
      },
      title: overlay?.title || threadObject.title || null,
      name: overlay?.name || threadObject.name || null,
      preview: overlay?.preview || threadObject.preview || null,
      cwd: overlay?.cwd || threadObject.cwd || threadObject.current_working_directory || threadObject.working_directory || null,
      createdAt: overlay?.createdAt || threadObject.createdAt || threadObject.created_at || null,
      updatedAt: overlay?.updatedAt || threadObject.updatedAt || threadObject.updated_at || null,
    };
  }

  function upsertOverlayFromThread(threadObject) {
    store.upsertThreadMeta(threadObjectToMeta(threadObject));
  }

  function buildManagedThreadObject(threadMeta, turns = null) {
    const providerDefinition = getRuntimeProvider(threadMeta.provider);
    return {
      id: threadMeta.id,
      title: threadMeta.title,
      name: threadMeta.name,
      preview: threadMeta.preview,
      createdAt: threadMeta.createdAt,
      updatedAt: threadMeta.updatedAt,
      cwd: threadMeta.cwd,
      provider: threadMeta.provider,
      providerSessionId: threadMeta.providerSessionId,
      capabilities: threadMeta.capabilities || providerDefinition.supports,
      metadata: {
        ...(threadMeta.metadata || {}),
        providerTitle: providerDefinition.title,
      },
      ...(turns == null ? {} : { turns }),
    };
  }

  function buildThreadListResult(threads) {
    return {
      data: threads,
      items: threads,
      threads,
    };
  }

  function threadObjectToMeta(threadObject) {
    return {
      id: normalizeOptionalString(threadObject.id),
      provider: resolveProviderId(threadObject),
      providerSessionId: normalizeOptionalString(threadObject.providerSessionId) || normalizeOptionalString(threadObject.id),
      title: normalizeOptionalString(threadObject.title),
      name: normalizeOptionalString(threadObject.name),
      preview: normalizeOptionalString(threadObject.preview),
      cwd: firstNonEmptyString([
        threadObject.cwd,
        threadObject.current_working_directory,
        threadObject.working_directory,
      ]),
      metadata: {
        ...(asObject(threadObject.metadata) || {}),
        providerTitle: getRuntimeProvider(resolveProviderId(threadObject)).title,
      },
      capabilities: threadObject.capabilities || getRuntimeProvider(resolveProviderId(threadObject)).supports,
      createdAt: threadObject.createdAt || threadObject.created_at || new Date().toISOString(),
      updatedAt: threadObject.updatedAt || threadObject.updated_at || new Date().toISOString(),
      archived: Boolean(threadObject.archived),
    };
  }

  function normalizeModelListResult(result) {
    const items = extractArray(result, ["items", "data", "models"]);
    return {
      items,
    };
  }

  function normalizeSkillsResult(result) {
    const skills = extractArray(result, ["skills", "result.skills", "result.data"]);
    return {
      skills,
      data: Array.isArray(skills) ? skills : [],
    };
  }

  function normalizeFuzzyFileResult(result) {
    const files = extractArray(result, ["files", "result.files"]);
    return {
      files,
    };
  }

  function findThreadIdByTurnId(turnId) {
    const normalizedTurnId = normalizeOptionalString(turnId);
    if (!normalizedTurnId) {
      return null;
    }
    for (const [threadId, runEntry] of activeRunsByThread.entries()) {
      if (runEntry.turnId === normalizedTurnId) {
        return threadId;
      }
    }
    return null;
  }

  return {
    attachCodexTransport,
    handleClientMessage,
    handleCodexTransportClosed,
    handleCodexTransportMessage,
    shutdown,
  };
}

function extractThreadArray(result) {
  return extractArray(result, ["data", "items", "threads"]);
}

function extractThreadFromResult(result) {
  if (!result || typeof result !== "object") {
    return null;
  }
  if (result.thread && typeof result.thread === "object") {
    return result.thread;
  }
  return null;
}

function extractArray(value, candidatePaths) {
  if (!value) {
    return [];
  }

  for (const candidatePath of candidatePaths) {
    const candidateValue = readPath(value, candidatePath);
    if (Array.isArray(candidateValue)) {
      return candidateValue;
    }
  }

  return [];
}

function readPath(root, path) {
  const parts = path.split(".");
  let current = root;
  for (const part of parts) {
    if (!current || typeof current !== "object") {
      return null;
    }
    current = current[part];
  }
  return current;
}

function mergeThreadLists(threads) {
  const seen = new Map();
  for (const thread of threads) {
    if (!thread || typeof thread !== "object" || !thread.id) {
      continue;
    }
    const previous = seen.get(thread.id);
    if (!previous) {
      seen.set(thread.id, thread);
      continue;
    }
    const previousUpdated = Date.parse(previous.updatedAt || 0) || 0;
    const nextUpdated = Date.parse(thread.updatedAt || 0) || 0;
    if (nextUpdated >= previousUpdated) {
      seen.set(thread.id, thread);
    }
  }

  return [...seen.values()].sort((left, right) => {
    const leftUpdated = Date.parse(left.updatedAt || 0) || 0;
    const rightUpdated = Date.parse(right.updatedAt || 0) || 0;
    if (leftUpdated !== rightUpdated) {
      return rightUpdated - leftUpdated;
    }
    return String(left.id).localeCompare(String(right.id));
  });
}

function normalizeInputItems(input) {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map((entry) => normalizeInputItem(entry))
    .filter(Boolean);
}

function normalizeInputItem(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const type = normalizeInputType(entry.type);
  if (type === "text") {
    const text = normalizeOptionalString(entry.text || entry.message || entry.content);
    return text ? { type: "text", text } : null;
  }

  if (type === "image") {
    const url = normalizeOptionalString(entry.image_url || entry.url || entry.path);
    if (!url) {
      return null;
    }
    return {
      type: entry.path ? "local_image" : "image",
      ...(entry.path ? { path: entry.path } : { image_url: url }),
      ...(entry.path ? {} : { url }),
    };
  }

  if (type === "skill") {
    const id = normalizeOptionalString(entry.id);
    if (!id) {
      return null;
    }
    return {
      type: "skill",
      id,
      ...(normalizeOptionalString(entry.name) ? { name: entry.name.trim() } : {}),
      ...(normalizeOptionalString(entry.path) ? { path: entry.path.trim() } : {}),
    };
  }

  return {
    type,
    ...entry,
  };
}

function normalizeInputType(value) {
  const normalized = normalizeNonEmptyString(value).toLowerCase().replace(/[_-]/g, "");
  if (normalized === "image" || normalized === "localimage" || normalized === "inputimage") {
    return "image";
  }
  if (normalized === "skill") {
    return "skill";
  }
  return "text";
}

function normalizePlanState(planState) {
  if (!planState || typeof planState !== "object") {
    return {
      explanation: null,
      steps: [],
    };
  }

  const explanation = normalizeOptionalString(planState.explanation || planState.summary);
  const steps = Array.isArray(planState.steps)
    ? planState.steps
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return null;
        }
        const step = normalizeOptionalString(entry.step);
        const status = normalizeOptionalString(entry.status);
        if (!step || !status) {
          return null;
        }
        return { step, status };
      })
      .filter(Boolean)
    : [];
  return {
    explanation,
    steps,
  };
}

function buildCommandPreview(command, status, exitCode) {
  const shortCommand = normalizeOptionalString(command) || "command";
  const normalizedStatus = normalizeOptionalString(status) || "running";
  const label = normalizedStatus === "completed"
    ? "Completed"
    : normalizedStatus === "failed"
      ? "Failed"
      : normalizedStatus === "stopped"
        ? "Stopped"
        : "Running";
  if (typeof exitCode === "number") {
    return `${label} ${shortCommand} (exit ${exitCode})`;
  }
  return `${label} ${shortCommand}`;
}

function buildProviderMetadata(provider) {
  return {
    providerTitle: getRuntimeProvider(provider).title,
  };
}

function resolveProviderId(value) {
  const candidate = normalizeOptionalString(
    typeof value === "object" && value
      ? value.provider || value.id
      : value
  );
  if (candidate === "claude" || candidate === "gemini" || candidate === "codex") {
    return candidate;
  }
  return "codex";
}

function stripProviderField(params) {
  if (!params || typeof params !== "object") {
    return params;
  }
  const { provider, ...rest } = params;
  return rest;
}

function defaultInitializeParams() {
  return {
    clientInfo: {
      name: "remodex_bridge",
      title: "Remodex Bridge",
      version: "1.0.0",
    },
    capabilities: {
      experimentalApi: true,
    },
  };
}

function createMethodError(message) {
  return createRuntimeError(ERROR_METHOD_NOT_FOUND, message);
}

function createRuntimeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function encodeRequestId(value) {
  if (value == null) {
    return "";
  }
  return JSON.stringify(value);
}

function normalizeOptionalString(value) {
  const normalized = normalizeNonEmptyString(value);
  return normalized || null;
}

function normalizeNonEmptyString(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function firstNonEmptyString(values) {
  for (const value of values) {
    const normalized = normalizeOptionalString(value);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function asObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value;
}

module.exports = {
  createRuntimeManager,
};
