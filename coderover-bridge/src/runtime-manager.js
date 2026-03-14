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
const DEFAULT_HISTORY_WINDOW_LIMIT = 50;
const DEFAULT_THREAD_LIST_PAGE_SIZE = 60;
const CODEX_HISTORY_CACHE_THREAD_LIMIT = 20;
const CODEX_HISTORY_CACHE_MESSAGE_LIMIT = 50;
const HISTORY_CURSOR_VERSION = 1;

function createRuntimeManager({
  sendApplicationMessage,
  logPrefix = "[coderover]",
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
  const codexHistoryCache = new Map();

  let codexWarm = false;
  let codexWarmPromise = null;
  let lastExternalSyncAt = 0;

  const codexAdapter = providedCodexAdapter || createCodexAdapter({
    logPrefix,
    sendToClient(rawMessage, parsedMessage) {
      forwardCodexTransportMessage(rawMessage, parsedMessage);
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
                const decorated = decorateConversationThread(thread);
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
              const result = await codexAdapter.startTurn(stripProviderField(params));
              seedCodexHistoryCacheWithUserInput(
                threadMeta.id,
                normalizeOptionalString(result?.turnId || result?.turn_id),
                params
              );
              return result;
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
    codexHistoryCache.clear();
    codexAdapter.attachTransport(transport);
  }

  function handleCodexTransportMessage(rawMessage) {
    codexAdapter.handleIncomingRaw(rawMessage);
  }

  function handleCodexTransportClosed(reason) {
    codexWarm = false;
    codexWarmPromise = null;
    codexHistoryCache.clear();
    codexAdapter.handleTransportClosed(reason);
  }

  function shutdown() {
    store.shutdown();
  }

  function forwardCodexTransportMessage(rawMessage, parsedMessage) {
    handleCodexHistoryCacheEvent(rawMessage);
    sendApplicationMessage(decorateCodexTransportMessage(rawMessage, parsedMessage));
  }

  function decorateCodexTransportMessage(rawMessage, parsedMessage) {
    const method = normalizeOptionalString(parsedMessage?.method);
    const params = asObject(parsedMessage?.params);
    if (!method || !params) {
      return rawMessage;
    }

    const decoratedParams = decorateNotificationWithHistoryMetadata(method, params, (threadId) =>
      readCodexHistorySnapshot(threadId)
    );
    if (decoratedParams === params) {
      return rawMessage;
    }

    return JSON.stringify({
      ...parsedMessage,
      params: decoratedParams,
    });
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
    const coderoverPage = await listConversationThreads(params, archived);
    const managedThreads = store.listThreadMetas()
      .filter((entry) => entry.provider !== "codex")
      .filter((entry) => Boolean(entry.archived) === archived)
      .map((entry) => buildManagedThreadObject(entry));

    return {
      threads: mergeThreadLists([...coderoverPage.threads, ...managedThreads]),
      nextCursor: coderoverPage.nextCursor,
      hasMore: coderoverPage.hasMore,
      pageSize: coderoverPage.pageSize,
    };
  }

  async function listConversationThreads(params, archived) {
    if (!codexAdapter.isAvailable()) {
      return {
        threads: [],
        nextCursor: null,
        hasMore: false,
        pageSize: normalizePositiveInteger(params?.limit) || DEFAULT_THREAD_LIST_PAGE_SIZE,
      };
    }

    await ensureCodexWarm();
    const normalizedParams = {
      ...stripProviderField(params || {}),
    };
    if (normalizePositiveInteger(normalizedParams.limit) == null) {
      normalizedParams.limit = DEFAULT_THREAD_LIST_PAGE_SIZE;
    }
    const result = await codexAdapter.listThreads(normalizedParams);
    const threads = extractThreadArray(result).map((thread) => decorateConversationThread(thread));
    const filteredThreads = threads.filter((thread) => {
      const overlay = store.getThreadMeta(thread.id);
      const overlayArchived = overlay?.archived;
      if (overlayArchived != null) {
        return Boolean(overlayArchived) === archived;
      }
      return archived === Boolean(params?.archived);
    });
    const nextCursor = extractThreadListCursor(result);
    return {
      threads: filteredThreads,
      nextCursor,
      hasMore: nextCursor != null,
      pageSize: threads.length,
    };
  }

  async function readThread(params) {
    const threadId = normalizeOptionalString(params.threadId || params.thread_id);
    const threadMeta = await requireThreadMeta(threadId);
    const historyRequest = normalizeHistoryRequest(params?.history);

    if (threadMeta.provider === "codex") {
      return readCodexThread(threadId, params, historyRequest);
    }

    return readManagedThread(threadMeta, params, historyRequest);
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
      const coderoverThread = await readConversationThreadMeta(normalizedThreadId);
      if (coderoverThread) {
        return coderoverThread;
      }
    }

    throw createRuntimeError(ERROR_THREAD_NOT_FOUND, `Thread not found: ${normalizedThreadId}`);
  }

  async function readConversationThreadMeta(threadId) {
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
      const decorated = decorateConversationThread(threadObject);
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

  async function readManagedThread(threadMeta, params, historyRequest) {
    await getManagedProviderAdapter(threadMeta.provider).hydrateThread(threadMeta);
    const refreshedMeta = store.getThreadMeta(threadMeta.id) || threadMeta;
    const history = store.getThreadHistory(threadMeta.id);
    const thread = buildManagedThreadObject(refreshedMeta, history?.turns || []);
    if (!historyRequest) {
      return { thread };
    }
    return buildHistoryWindowResponse(
      createHistorySnapshotFromThread(thread),
      historyRequest,
      false
    );
  }

  async function readCodexThread(threadId, params, historyRequest = null) {
    await ensureCodexWarm();

    if (!historyRequest) {
      const result = await codexAdapter.readThread(stripProviderField(params));
      const threadObject = extractThreadFromResult(result);
      if (!threadObject) {
        throw createRuntimeError(ERROR_THREAD_NOT_FOUND, `Thread not found: ${threadId}`);
      }

      const decoratedThread = decorateConversationThread(threadObject);
      upsertOverlayFromThread(decoratedThread);
      primeCodexHistoryCache(threadId, decoratedThread);
      return {
        thread: decoratedThread,
      };
    }

    const cachedWindow = readCodexHistoryWindowFromCache(threadId, historyRequest);
    if (cachedWindow) {
      return cachedWindow;
    }

    const fullSnapshot = await fetchFullCodexThreadSnapshot(threadId, params);
    return buildHistoryWindowResponse(fullSnapshot, historyRequest, false);
  }

  async function fetchFullCodexThreadSnapshot(threadId, params) {
    const upstreamParams = {
      ...stripProviderField(params || {}),
      threadId,
      includeTurns: true,
    };
    delete upstreamParams.history;

    const result = await codexAdapter.readThread(upstreamParams);
    const threadObject = extractThreadFromResult(result);
    if (!threadObject) {
      throw createRuntimeError(ERROR_THREAD_NOT_FOUND, `Thread not found: ${threadId}`);
    }

    const decoratedThread = decorateConversationThread(threadObject);
    upsertOverlayFromThread(decoratedThread);
    primeCodexHistoryCache(threadId, decoratedThread);
    return createHistorySnapshotFromThread(decoratedThread);
  }

  function readCodexHistoryWindowFromCache(threadId, historyRequest) {
    const cacheEntry = touchCodexHistoryCache(threadId);
    if (!cacheEntry) {
      return null;
    }
    const anchorIndex = historyRequest.cursor
      ? findHistoryRecordIndexByCursor(cacheEntry.records, historyRequest.cursor, threadId)
      : -1;
    const canServe = historyRequest.mode === "tail"
      || (
        historyRequest.mode === "before"
          ? anchorIndex >= 0 && (anchorIndex > 0 || cacheEntry.hasOlder === false)
          : anchorIndex >= 0 && (anchorIndex < (cacheEntry.records.length - 1) || cacheEntry.hasNewer === false)
      );
    if (!canServe) {
      return null;
    }
    return buildHistoryWindowResponse(cacheEntry, historyRequest, true);
  }

  function buildHistoryWindowResponse(snapshot, historyRequest, servedFromCache) {
    const records = [...snapshot.records].sort(compareHistoryRecord);
    const limit = historyRequest.limit;
    let selected = [];
    let anchorIndex = -1;
    let startIndex = 0;
    let endIndexExclusive = 0;

    if (historyRequest.mode === "tail") {
      startIndex = Math.max(records.length - limit, 0);
      endIndexExclusive = records.length;
      selected = records.slice(startIndex, endIndexExclusive);
    } else {
      anchorIndex = findHistoryRecordIndexByCursor(records, historyRequest.cursor, snapshot.threadId);
      if (anchorIndex < 0) {
        throw createRuntimeError(ERROR_INVALID_PARAMS, "history.cursor is invalid");
      }
      if (historyRequest.mode === "before") {
        startIndex = Math.max(anchorIndex - limit, 0);
        endIndexExclusive = anchorIndex;
        selected = records.slice(startIndex, endIndexExclusive);
      } else {
        startIndex = anchorIndex + 1;
        endIndexExclusive = anchorIndex + 1 + limit;
        selected = records.slice(startIndex, endIndexExclusive);
      }
    }

    const hasOlder = selected.length > 0
      ? startIndex > 0
      : records.length > 0
        ? historyRequest.mode !== "tail" || snapshot.hasOlder
        : false;
    const hasNewer = selected.length > 0
      ? endIndexExclusive < records.length
      : false;
    const thread = rebuildThreadFromHistoryRecords(snapshot.threadBase, selected);
    const oldestRecord = selected.length > 0 ? selected[0] : null;
    const newestRecord = selected.length > 0 ? selected[selected.length - 1] : null;

    return {
      thread,
      historyWindow: {
        mode: historyRequest.mode,
        olderCursor: oldestRecord ? historyCursorForRecord(snapshot.threadId, oldestRecord) : null,
        newerCursor: newestRecord ? historyCursorForRecord(snapshot.threadId, newestRecord) : null,
        oldestAnchor: oldestRecord ? historyRecordAnchor(oldestRecord) : null,
        newestAnchor: newestRecord ? historyRecordAnchor(newestRecord) : null,
        hasOlder: hasOlder || (selected.length === 0 && snapshot.hasOlder),
        hasNewer: hasNewer || (selected.length === 0 && snapshot.hasNewer),
        isPartial: selected.length !== records.length || snapshot.hasOlder || snapshot.hasNewer,
        servedFromCache,
        pageSize: selected.length,
      },
    };
  }

  function primeCodexHistoryCache(threadId, threadObject) {
    const snapshot = createHistorySnapshotFromThread(threadObject);
    writeCodexHistoryCache(threadId, {
      ...snapshot,
      records: snapshot.records.slice(-CODEX_HISTORY_CACHE_MESSAGE_LIMIT),
      hasOlder: snapshot.records.length > CODEX_HISTORY_CACHE_MESSAGE_LIMIT,
      hasNewer: false,
    });
  }

  function createHistorySnapshotFromThread(threadObject) {
    const threadBase = cloneThreadBase(threadObject);
    const records = flattenThreadHistory(threadObject);
    return {
      threadId: threadObject.id,
      threadBase,
      records,
      hasOlder: false,
      hasNewer: false,
    };
  }

  function touchCodexHistoryCache(threadId) {
    const normalizedThreadId = normalizeOptionalString(threadId);
    if (!normalizedThreadId) {
      return null;
    }
    const entry = codexHistoryCache.get(normalizedThreadId) || null;
    if (!entry) {
      return null;
    }
    codexHistoryCache.delete(normalizedThreadId);
    codexHistoryCache.set(normalizedThreadId, entry);
    return entry;
  }

  function readCodexHistorySnapshot(threadId) {
    const normalizedThreadId = normalizeOptionalString(threadId);
    if (!normalizedThreadId) {
      return null;
    }
    const entry = codexHistoryCache.get(normalizedThreadId);
    if (!entry) {
      return null;
    }
    return {
      threadId: normalizedThreadId,
      threadBase: entry.threadBase,
      records: [...entry.records],
      hasOlder: entry.hasOlder,
      hasNewer: entry.hasNewer,
    };
  }

  function readManagedHistorySnapshot(threadId) {
    const normalizedThreadId = normalizeOptionalString(threadId);
    if (!normalizedThreadId) {
      return null;
    }
    const threadMeta = store.getThreadMeta(normalizedThreadId);
    const history = store.getThreadHistory(normalizedThreadId);
    if (!threadMeta || !history) {
      return null;
    }
    return createHistorySnapshotFromThread(
      buildManagedThreadObject(threadMeta, history.turns || [])
    );
  }

  function writeCodexHistoryCache(threadId, entry) {
    const normalizedThreadId = normalizeOptionalString(threadId);
    if (!normalizedThreadId) {
      return;
    }
    codexHistoryCache.delete(normalizedThreadId);
    codexHistoryCache.set(normalizedThreadId, {
      ...entry,
      threadId: normalizedThreadId,
      records: [...entry.records]
        .sort(compareHistoryRecord)
        .slice(-CODEX_HISTORY_CACHE_MESSAGE_LIMIT),
    });
    while (codexHistoryCache.size > CODEX_HISTORY_CACHE_THREAD_LIMIT) {
      const oldestKey = codexHistoryCache.keys().next().value;
      codexHistoryCache.delete(oldestKey);
    }
  }

  function seedCodexHistoryCacheWithUserInput(threadId, turnId, params) {
    const normalizedThreadId = normalizeOptionalString(threadId);
    const normalizedTurnId = normalizeOptionalString(turnId);
    if (!normalizedThreadId || !normalizedTurnId) {
      return;
    }

    const inputItems = normalizeInputItems(params?.input);
    if (inputItems.length === 0) {
      return;
    }

    const nowIso = new Date().toISOString();
    const entry = touchCodexHistoryCache(normalizedThreadId) || {
      threadId: normalizedThreadId,
      threadBase: {
        id: normalizedThreadId,
        provider: "codex",
        providerSessionId: normalizedThreadId,
        metadata: buildProviderMetadata("codex"),
      },
      records: [],
      hasOlder: false,
      hasNewer: false,
    };
    entry.threadBase = {
      ...entry.threadBase,
      updatedAt: nowIso,
      preview: inputItems
        .filter((item) => item.type === "text" && normalizeOptionalString(item.text))
        .map((item) => item.text)
        .join("\n")
        .trim() || entry.threadBase.preview || null,
    };
    entry.records.push({
      turnId: normalizedTurnId,
      turnMeta: {
        id: normalizedTurnId,
        createdAt: nowIso,
        status: "running",
      },
      itemObject: {
        id: `local:${normalizedTurnId}:user`,
        type: "user_message",
        role: "user",
        content: inputItems,
        text: inputItems
          .filter((item) => item.type === "text" && normalizeOptionalString(item.text))
          .map((item) => item.text)
          .join("\n")
          .trim() || null,
        createdAt: nowIso,
      },
      ordinal: nextHistoryOrdinal(entry.records),
    });
    writeCodexHistoryCache(normalizedThreadId, entry);
  }

  function handleCodexHistoryCacheEvent(rawMessage) {
    let parsed = null;
    try {
      parsed = JSON.parse(rawMessage);
    } catch {
      return;
    }

    const method = normalizeOptionalString(parsed?.method);
    const params = asObject(parsed?.params);
    if (!method) {
      return;
    }

    if (method === "thread/started" && params.thread && typeof params.thread === "object") {
      const decoratedThread = decorateConversationThread(params.thread);
      primeCodexHistoryCache(decoratedThread.id, decoratedThread);
      return;
    }

    const threadId = normalizeOptionalString(
      params.threadId || params.thread_id || params.conversationId
    );
    if (!threadId) {
      return;
    }
    const entry = touchCodexHistoryCache(threadId);
    if (!entry) {
      return;
    }

    if (method === "turn/started") {
      const turnId = normalizeOptionalString(params.turnId || params.turn_id);
      if (turnId) {
        ensureHistoryTurn(entry, turnId, {
          id: turnId,
          createdAt: new Date().toISOString(),
          status: "running",
        });
        entry.threadBase.updatedAt = new Date().toISOString();
        writeCodexHistoryCache(threadId, entry);
      }
      return;
    }

    if (method === "turn/completed") {
      const turnId = normalizeOptionalString(params.turnId || params.turn_id);
      if (turnId) {
        updateHistoryTurnStatus(entry, turnId, normalizeOptionalString(params.status) || "completed");
        entry.threadBase.updatedAt = new Date().toISOString();
        writeCodexHistoryCache(threadId, entry);
      }
      return;
    }

    if (method === "item/agentMessage/delta") {
      upsertHistoryCacheTextItem(entry, {
        turnId: params.turnId || params.turn_id,
        itemId: params.itemId || params.item_id,
        type: "agent_message",
        role: "assistant",
        delta: params.delta,
      });
      writeCodexHistoryCache(threadId, entry);
      return;
    }

    if (method === "item/reasoning/textDelta" || method === "item/reasoning/summaryTextDelta") {
      upsertHistoryCacheTextItem(entry, {
        turnId: params.turnId || params.turn_id,
        itemId: params.itemId || params.item_id,
        type: "reasoning",
        delta: params.delta,
      });
      writeCodexHistoryCache(threadId, entry);
      return;
    }

    if (method === "item/toolCall/outputDelta" || method === "item/toolCall/completed") {
      upsertHistoryCacheTextItem(entry, {
        turnId: params.turnId || params.turn_id,
        itemId: params.itemId || params.item_id,
        type: "tool_call",
        delta: params.delta,
        metadata: normalizeOptionalString(params.toolName) ? { toolName: params.toolName } : null,
        changes: Array.isArray(params.changes) ? params.changes : [],
      });
      writeCodexHistoryCache(threadId, entry);
      return;
    }

    if (method === "item/commandExecution/outputDelta") {
      const turnId = normalizeOptionalString(params.turnId || params.turn_id);
      const itemId = normalizeOptionalString(params.itemId || params.item_id) || `local:${turnId}:command`;
      const item = ensureHistoryRecord(entry, {
        turnId,
        itemId,
        type: "command_execution",
        defaults: {
          command: normalizeOptionalString(params.command),
          cwd: normalizeOptionalString(params.cwd),
          status: normalizeOptionalString(params.status) || "running",
          exitCode: typeof params.exitCode === "number" ? params.exitCode : null,
          durationMs: typeof params.durationMs === "number" ? params.durationMs : null,
          text: normalizeOptionalString(params.delta) || "",
        },
      });
      item.itemObject.command = normalizeOptionalString(params.command) || item.itemObject.command || null;
      item.itemObject.cwd = normalizeOptionalString(params.cwd) || item.itemObject.cwd || null;
      item.itemObject.status = normalizeOptionalString(params.status) || item.itemObject.status || "running";
      if (typeof params.exitCode === "number") {
        item.itemObject.exitCode = params.exitCode;
      }
      if (typeof params.durationMs === "number") {
        item.itemObject.durationMs = params.durationMs;
      }
      item.itemObject.text = normalizeOptionalString(params.delta) || item.itemObject.text || "";
      writeCodexHistoryCache(threadId, entry);
      return;
    }

    if (method === "turn/plan/updated") {
      const turnId = normalizeOptionalString(params.turnId || params.turn_id);
      const itemId = normalizeOptionalString(params.itemId || params.item_id) || `local:${turnId}:plan`;
      const item = ensureHistoryRecord(entry, {
        turnId,
        itemId,
        type: "plan",
        defaults: {
          text: normalizeOptionalString(params.delta) || normalizeOptionalString(params.explanation) || "Planning...",
          explanation: normalizeOptionalString(params.explanation),
          summary: normalizeOptionalString(params.summary),
          plan: Array.isArray(params.plan) ? params.plan : [],
        },
      });
      item.itemObject.text = normalizeOptionalString(params.delta) || item.itemObject.text || "";
      item.itemObject.explanation = normalizeOptionalString(params.explanation) || item.itemObject.explanation || null;
      item.itemObject.summary = normalizeOptionalString(params.summary) || item.itemObject.summary || null;
      if (Array.isArray(params.plan)) {
        item.itemObject.plan = params.plan;
      }
      writeCodexHistoryCache(threadId, entry);
    }
  }

  function shouldDecorateNotificationWithPreviousItemId(method) {
    return method === "item/agentMessage/delta"
      || method === "item/reasoning/textDelta"
      || method === "item/reasoning/summaryTextDelta"
      || method === "item/toolCall/outputDelta"
      || method === "item/toolCall/completed"
      || method === "item/commandExecution/outputDelta"
      || method === "turn/plan/updated"
      || method === "item/completed";
  }

  function extractNotificationThreadId(params) {
    return normalizeOptionalString(
      params.threadId
      || params.thread_id
      || params.conversationId
      || asObject(params.thread)?.id
      || asObject(params.item)?.threadId
      || asObject(params.item)?.thread_id
    );
  }

  function extractNotificationItemId(params) {
    return normalizeOptionalString(
      params.itemId
      || params.item_id
      || params.id
      || asObject(params.item)?.id
      || params.callId
      || params.call_id
    );
  }

  function previousCodexHistoryItemId(threadId, itemId) {
    const normalizedThreadId = normalizeOptionalString(threadId);
    const normalizedItemId = normalizeOptionalString(itemId);
    if (!normalizedThreadId || !normalizedItemId) {
      return null;
    }

    const entry = codexHistoryCache.get(normalizedThreadId);
    if (!entry || !Array.isArray(entry.records) || entry.records.length === 0) {
      return null;
    }

    const orderedItemIds = entry.records
      .slice()
      .sort((left, right) => (left.ordinal || 0) - (right.ordinal || 0))
      .map((record) => normalizeOptionalString(record?.itemObject?.id))
      .filter(Boolean);
    if (orderedItemIds.length === 0) {
      return null;
    }

    const existingIndex = orderedItemIds.lastIndexOf(normalizedItemId);
    if (existingIndex > 0) {
      return orderedItemIds[existingIndex - 1];
    }
    if (existingIndex === -1) {
      return orderedItemIds[orderedItemIds.length - 1] || null;
    }
    return null;
  }

  function decorateNotificationWithHistoryMetadata(method, params, readSnapshot) {
    if (!shouldDecorateNotificationWithPreviousItemId(method) || !params) {
      return params;
    }

    const threadId = extractNotificationThreadId(params);
    const itemId = extractNotificationItemId(params);
    if (!threadId || !itemId) {
      return params;
    }

    const snapshot = typeof readSnapshot === "function" ? readSnapshot(threadId) : null;
    const metadata = snapshot ? historyMetadataForItem(snapshot, itemId) : null;
    if (!metadata) {
      return params;
    }

    let didChange = false;
    const nextParams = { ...params };
    if (metadata.currentCursor && nextParams.cursor == null) {
      nextParams.cursor = metadata.currentCursor;
      didChange = true;
    }
    if (metadata.previousCursor && nextParams.previousCursor == null && nextParams.previous_cursor == null) {
      nextParams.previousCursor = metadata.previousCursor;
      didChange = true;
    }
    if (metadata.previousItemId && nextParams.previousItemId == null && nextParams.previous_item_id == null) {
      nextParams.previousItemId = metadata.previousItemId;
      didChange = true;
    }
    return didChange ? nextParams : params;
  }

  function historyMetadataForItem(snapshot, itemId) {
    const normalizedThreadId = normalizeOptionalString(snapshot?.threadId);
    const normalizedItemId = normalizeOptionalString(itemId);
    if (!normalizedThreadId || !normalizedItemId) {
      return null;
    }
    const records = Array.isArray(snapshot.records)
      ? snapshot.records.slice().sort(compareHistoryRecord)
      : [];
    const currentIndex = records.findIndex((record) =>
      normalizeOptionalString(record?.itemObject?.id) === normalizedItemId
    );
    if (currentIndex < 0) {
      return null;
    }
    const currentRecord = records[currentIndex];
    const previousRecord = currentIndex > 0 ? records[currentIndex - 1] : null;
    return {
      currentCursor: historyCursorForRecord(normalizedThreadId, currentRecord),
      previousCursor: previousRecord
        ? historyCursorForRecord(normalizedThreadId, previousRecord)
        : null,
      previousItemId: normalizeOptionalString(previousRecord?.itemObject?.id) || null,
    };
  }

  function ensureHistoryTurn(entry, turnId, turnMeta) {
    const normalizedTurnId = normalizeOptionalString(turnId);
    if (!normalizedTurnId) {
      return null;
    }
    const existing = entry.records.find((record) => record.turnId === normalizedTurnId);
    if (existing) {
      existing.turnMeta = {
        ...existing.turnMeta,
        ...turnMeta,
      };
      return existing.turnMeta;
    }
    return {
      ...turnMeta,
      id: normalizedTurnId,
      createdAt: turnMeta.createdAt || new Date().toISOString(),
    };
  }

  function updateHistoryTurnStatus(entry, turnId, status) {
    const normalizedTurnId = normalizeOptionalString(turnId);
    if (!normalizedTurnId) {
      return;
    }
    entry.records.forEach((record) => {
      if (record.turnId === normalizedTurnId) {
        record.turnMeta = {
          ...record.turnMeta,
          status,
        };
      }
    });
  }

  function upsertHistoryCacheTextItem(entry, { turnId, itemId, type, role = null, delta, metadata = null, changes = null }) {
    const record = ensureHistoryRecord(entry, {
      turnId,
      itemId,
      type,
      role,
      defaults: type === "agent_message"
        ? { content: [{ type: "text", text: "" }], text: "" }
        : { text: "" },
    });
    const normalizedDelta = normalizeOptionalString(delta);
    if (normalizedDelta) {
      if (Array.isArray(record.itemObject.content)) {
        const firstText = record.itemObject.content.find((contentItem) => contentItem.type === "text");
        if (firstText) {
          firstText.text = `${firstText.text || ""}${normalizedDelta}`;
        } else {
          record.itemObject.content.push({ type: "text", text: normalizedDelta });
        }
      }
      record.itemObject.text = `${record.itemObject.text || ""}${normalizedDelta}`;
    }
    if (metadata) {
      record.itemObject.metadata = {
        ...(record.itemObject.metadata || {}),
        ...metadata,
      };
    }
    if (changes) {
      record.itemObject.changes = changes;
    }
  }

  function ensureHistoryRecord(entry, { turnId, itemId, type, role = null, defaults = {} }) {
    const normalizedTurnId = normalizeOptionalString(turnId) || "unknown-turn";
    const normalizedItemId = normalizeOptionalString(itemId) || `local:${normalizedTurnId}:${type}`;
    const existing = entry.records.find((record) => normalizeOptionalString(record.itemObject.id) === normalizedItemId);
    if (existing) {
      return existing;
    }
    const nowIso = new Date().toISOString();
    const turnMeta = ensureHistoryTurn(entry, normalizedTurnId, {
      id: normalizedTurnId,
      createdAt: nowIso,
      status: "running",
    });
    const record = {
      turnId: normalizedTurnId,
      turnMeta,
      itemObject: {
        id: normalizedItemId,
        type,
        ...(role ? { role } : {}),
        createdAt: nowIso,
        ...defaults,
      },
      ordinal: nextHistoryOrdinal(entry.records),
    };
    entry.records.push(record);
    return record;
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
    const decoratedParams = decorateNotificationWithHistoryMetadata(method, params, (threadId) =>
      readManagedHistorySnapshot(threadId)
    );
    sendApplicationMessage(JSON.stringify({
      jsonrpc: "2.0",
      method,
      params: decoratedParams,
    }));
  }

  function decorateConversationThread(threadObject) {
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

  function buildThreadListResult(payload) {
    const threads = Array.isArray(payload) ? payload : payload?.threads || [];
    return {
      data: threads,
      items: threads,
      threads,
      ...(Array.isArray(payload)
        ? {}
        : {
          nextCursor: payload?.nextCursor ?? null,
          hasMore: Boolean(payload?.hasMore),
          pageSize: normalizePositiveInteger(payload?.pageSize) || threads.length,
        }),
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

function extractThreadListCursor(result) {
  const cursor = result?.nextCursor ?? result?.next_cursor ?? null;
  if (cursor == null) {
    return null;
  }
  if (typeof cursor === "string") {
    const normalized = normalizeOptionalString(cursor);
    return normalized || null;
  }
  return cursor;
}

function normalizeHistoryRequest(history) {
  if (!history || typeof history !== "object" || Array.isArray(history)) {
    return null;
  }
  const mode = normalizeOptionalString(history.mode)?.toLowerCase();
  if (mode !== "tail" && mode !== "before" && mode !== "after") {
    return null;
  }
  const limit = normalizePositiveInteger(history.limit) || DEFAULT_HISTORY_WINDOW_LIMIT;
  const cursor = normalizeHistoryCursor(
    history.cursor,
    history.anchor && typeof history.anchor === "object" ? history.anchor : null
  );
  if ((mode === "before" || mode === "after") && !cursor) {
    throw createRuntimeError(ERROR_INVALID_PARAMS, "history.cursor is required for before/after windows");
  }
  return {
    mode,
    limit,
    cursor,
  };
}

function normalizeHistoryCursor(rawCursor, legacyAnchor = null) {
  const normalizedCursor = normalizeOptionalString(rawCursor);
  if (normalizedCursor) {
    const decoded = decodeHistoryCursor(normalizedCursor);
    if (!decoded) {
      throw createRuntimeError(ERROR_INVALID_PARAMS, "history.cursor is invalid");
    }
    return decoded;
  }
  if (legacyAnchor && typeof legacyAnchor === "object") {
    return normalizeHistoryAnchor(legacyAnchor);
  }
  return null;
}

function normalizeHistoryAnchor(anchor) {
  const createdAt = normalizeTimestampString(anchor.createdAt || anchor.created_at);
  const itemId = normalizeOptionalString(anchor.itemId || anchor.item_id);
  const turnId = normalizeOptionalString(anchor.turnId || anchor.turn_id);
  if (!createdAt) {
    return null;
  }
  return {
    ...(itemId ? { itemId } : {}),
    createdAt,
    ...(turnId ? { turnId } : {}),
  };
}

function normalizeTimestampString(value) {
  if (value == null) {
    return null;
  }
  if (typeof value === "number") {
    return new Date(value > 10_000_000_000 ? value : value * 1000).toISOString();
  }
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  const asNumber = Number(normalized);
  if (Number.isFinite(asNumber)) {
    return normalizeTimestampString(asNumber);
  }
  const parsed = Date.parse(normalized);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return new Date(parsed).toISOString();
}

function normalizePositiveInteger(value) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return null;
  }
  return numeric;
}

function cloneThreadBase(threadObject) {
  const clone = JSON.parse(JSON.stringify(threadObject || {}));
  delete clone.turns;
  return clone;
}

function flattenThreadHistory(threadObject) {
  const threadBase = cloneThreadBase(threadObject);
  const turns = Array.isArray(threadObject?.turns) ? threadObject.turns : [];
  const records = [];
  let ordinal = 0;

  turns.forEach((turnObject, turnIndex) => {
    if (!turnObject || typeof turnObject !== "object") {
      return;
    }
    const turnId = normalizeOptionalString(turnObject.id)
      || normalizeOptionalString(turnObject.turnId)
      || normalizeOptionalString(turnObject.turn_id)
      || `turn-${turnIndex}`;
    const turnMeta = cloneTurnMeta(turnObject, turnId);
    const items = Array.isArray(turnObject.items) ? turnObject.items : [];
    items.forEach((itemObject, itemIndex) => {
      if (!itemObject || typeof itemObject !== "object") {
        return;
      }
      const itemClone = JSON.parse(JSON.stringify(itemObject));
      const createdAt = normalizeTimestampString(itemClone.createdAt || itemClone.created_at || turnMeta.createdAt || threadBase.createdAt || new Date().toISOString())
        || new Date().toISOString();
      itemClone.createdAt = createdAt;
      records.push({
        turnId,
        turnMeta,
        itemObject: itemClone,
        createdAt,
        createdAtMs: Date.parse(createdAt) || 0,
        ordinal,
        turnIndex,
        itemIndex,
      });
      ordinal += 1;
    });
  });

  return records.sort(compareHistoryRecord);
}

function cloneTurnMeta(turnObject, turnId) {
  const clone = JSON.parse(JSON.stringify(turnObject || {}));
  delete clone.items;
  clone.id = turnId;
  clone.createdAt = normalizeTimestampString(clone.createdAt || clone.created_at || new Date().toISOString()) || new Date().toISOString();
  return clone;
}

function compareHistoryRecord(left, right) {
  const leftTimestamp = Number.isFinite(left?.createdAtMs) ? left.createdAtMs : (Date.parse(left?.createdAt || 0) || 0);
  const rightTimestamp = Number.isFinite(right?.createdAtMs) ? right.createdAtMs : (Date.parse(right?.createdAt || 0) || 0);
  if (leftTimestamp !== rightTimestamp) {
    return leftTimestamp - rightTimestamp;
  }
  return (left?.ordinal || 0) - (right?.ordinal || 0);
}

function historyRecordAnchor(record) {
  return {
    ...(normalizeOptionalString(record?.itemObject?.id) ? { itemId: normalizeOptionalString(record.itemObject.id) } : {}),
    createdAt: record?.createdAt || normalizeTimestampString(record?.itemObject?.createdAt) || new Date().toISOString(),
    ...(normalizeOptionalString(record?.turnId) ? { turnId: normalizeOptionalString(record.turnId) } : {}),
  };
}

function historyCursorForRecord(threadId, record) {
  const normalizedThreadId = normalizeOptionalString(threadId);
  if (!normalizedThreadId || !record) {
    return null;
  }
  const payload = {
    v: HISTORY_CURSOR_VERSION,
    threadId: normalizedThreadId,
    itemId: normalizeOptionalString(record?.itemObject?.id) || null,
    turnId: normalizeOptionalString(record?.turnId) || null,
    createdAt: normalizeTimestampString(record?.createdAt || record?.itemObject?.createdAt) || null,
    ordinal: Number.isFinite(record?.ordinal) ? Number(record.ordinal) : null,
  };
  return encodeHistoryCursor(payload);
}

function encodeHistoryCursor(payload) {
  try {
    return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  } catch {
    return null;
  }
}

function decodeHistoryCursor(cursor) {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!decoded || typeof decoded !== "object") {
      return null;
    }
    const createdAt = normalizeTimestampString(decoded.createdAt || decoded.created_at);
    const itemId = normalizeOptionalString(decoded.itemId || decoded.item_id);
    const turnId = normalizeOptionalString(decoded.turnId || decoded.turn_id);
    const threadId = normalizeOptionalString(decoded.threadId || decoded.thread_id);
    const ordinal = Number.isFinite(decoded.ordinal) ? Number(decoded.ordinal) : null;
    if (!createdAt || !threadId) {
      return null;
    }
    return {
      createdAt,
      threadId,
      ...(itemId ? { itemId } : {}),
      ...(turnId ? { turnId } : {}),
      ...(ordinal != null ? { ordinal } : {}),
    };
  } catch {
    return null;
  }
}

function historyCursorMatchesRecord(record, cursor, threadId) {
  if (!record || !cursor) {
    return false;
  }
  const normalizedThreadId = normalizeOptionalString(threadId);
  if (cursor.threadId && normalizedThreadId && cursor.threadId !== normalizedThreadId) {
    return false;
  }
  if (Number.isFinite(cursor.ordinal) && Number(cursor.ordinal) !== Number(record?.ordinal)) {
    return false;
  }
  const recordCreatedAt = normalizeTimestampString(record.createdAt || record.itemObject?.createdAt);
  if (recordCreatedAt !== cursor.createdAt) {
    return false;
  }
  const recordItemId = normalizeOptionalString(record.itemObject?.id);
  if (cursor.itemId && recordItemId) {
    return cursor.itemId === recordItemId;
  }
  const recordTurnId = normalizeOptionalString(record.turnId);
  return Boolean(cursor.turnId && recordTurnId && cursor.turnId === recordTurnId);
}

function findHistoryRecordIndexByCursor(records, cursor, threadId) {
  if (!cursor) {
    return -1;
  }
  return records.findIndex((record) => historyCursorMatchesRecord(record, cursor, threadId));
}

function rebuildThreadFromHistoryRecords(threadBase, records) {
  const normalizedRecords = [...records].sort(compareHistoryRecord);
  const turnsById = new Map();
  const turnOrder = [];

  normalizedRecords.forEach((record) => {
    const turnId = normalizeOptionalString(record.turnId) || "unknown-turn";
    if (!turnsById.has(turnId)) {
      turnsById.set(turnId, {
        ...JSON.parse(JSON.stringify(record.turnMeta || { id: turnId })),
        id: turnId,
        createdAt: normalizeTimestampString(record.turnMeta?.createdAt || record.createdAt) || record.createdAt,
        items: [],
      });
      turnOrder.push(turnId);
    }
    turnsById.get(turnId).items.push(JSON.parse(JSON.stringify(record.itemObject)));
  });

  return {
    ...JSON.parse(JSON.stringify(threadBase || {})),
    turns: turnOrder.map((turnId) => turnsById.get(turnId)),
  };
}

function nextHistoryOrdinal(records) {
  return records.reduce((maxValue, record) => Math.max(maxValue, Number(record?.ordinal) || 0), -1) + 1;
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
      name: "coderover_bridge",
      title: "Codex Bridge",
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
