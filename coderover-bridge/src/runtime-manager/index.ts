export {};

// FILE: runtime-manager.ts
// Purpose: Bridge-owned multi-provider runtime router for Codex, Claude Code, Gemini CLI, and GitHub Copilot.
// Layer: Runtime orchestration
// Exports: createRuntimeManager
// Depends on: crypto, ../runtime-store, ../provider-catalog, ../providers/*

import { randomUUID } from "crypto";
import * as fs from "fs";

import type {
  JsonRpcEnvelope,
  JsonRpcId,
  RuntimeInputItem,
  RuntimeItemShape,
  RuntimeThreadShape,
  RuntimeTurnShape,
} from "../bridge-types";
import {
  createRuntimeStore,
  type RuntimeStore,
  type RuntimeStoreTurn,
  type RuntimeStoreItem,
  type RuntimeThreadMeta,
} from "../runtime-store";
import { debugLog, debugError } from "../debug-log";
import { buildRpcError, buildRpcSuccess } from "../rpc-client";
import {
  getRuntimeProvider,
  listRuntimeProviders,
} from "../provider-catalog";
import { createCodexAdapter, type CodexAdapter } from "../providers/codex-adapter";
import { createClaudeAdapter } from "../providers/claude-adapter";
import { createGeminiAdapter } from "../providers/gemini-adapter";
import { createCopilotAdapter } from "../providers/copilot-adapter";
import {
  projectRuntimeEventToMobileProtocol,
  type ProjectedMobileProtocolMessage,
} from "../runtime-engine/mobile-protocol-projector";
import { createCodexRuntimeEngine } from "../runtime-engine/codex-engine";
import { createManagedProviderRuntimeEngine } from "../runtime-engine/managed-provider-engine";
import {
  createThreadSessionIndex,
  type ThreadSessionIndex,
} from "../runtime-engine/thread-session-index";
import type {
  ProviderRuntimeEngine,
  RuntimeEvent,
  RuntimeSessionSourceKind,
} from "../runtime-engine/types";
import * as historyHelpers from "./codex-history";
import * as routingHelpers from "./client-routing";
import * as observerHelpers from "./codex-observer";
import * as managedRuntimeHelpers from "./managed-provider-runtime";
import * as normalizerHelpers from "./normalizers";
import {
  findRolloutFileForThread,
} from "../rollout-watch";
import {
  CODEX_HISTORY_CACHE_MESSAGE_LIMIT,
  CODEX_HISTORY_CACHE_THREAD_LIMIT,
  CODEX_OBSERVED_THREAD_ERROR_BACKOFF_MS,
  CODEX_OBSERVED_THREAD_IDLE_TTL_MS,
  CODEX_OBSERVED_THREAD_LIMIT,
  CODEX_OBSERVED_THREAD_POLL_INTERVAL_MS,
  DEFAULT_HISTORY_WINDOW_LIMIT,
  DEFAULT_THREAD_LIST_PAGE_SIZE,
  ERROR_INTERNAL,
  ERROR_INVALID_PARAMS,
  ERROR_METHOD_NOT_FOUND,
  ERROR_THREAD_NOT_FOUND,
  EXTERNAL_SYNC_INTERVAL_MS,
  HISTORY_CURSOR_VERSION,
  type ManagedProviderAdapter,
  type ManagedProviderTurnContext,
  type RuntimeErrorShape,
  type RuntimeHistoryCursor,
  type RuntimeHistoryRecord,
  type RuntimeHistoryRequest,
  type RuntimeInitializeParams,
} from "./types";

type UnknownRecord = Record<string, unknown>;
const THREAD_LIST_INITIAL_WINDOW_DAYS = 3;
const THREAD_LIST_INITIAL_PROJECT_CAP = 10;
const THREAD_LIST_CURSOR_VERSION = 1;

interface RuntimeManager {
  attachCodexTransport(transport: unknown): void;
  handleClientMessage(rawMessage: string): Promise<boolean>;
  handleCodexTransportClosed(reason?: unknown): void;
  handleCodexTransportMessage(rawMessage: string): void;
  shutdown(): Promise<void>;
}

interface PendingClientRequest {
  method: string;
  threadId: string | null;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface ActiveRunEntry {
  provider: RuntimeThreadMeta["provider"];
  threadId: string;
  turnId: string;
  stopRequested: boolean;
  interrupt(): void | Promise<void>;
}

interface CodexHistorySnapshot {
  threadId: string;
  threadBase: RuntimeThreadShape;
  records: RuntimeHistoryRecord[];
  hasOlder: boolean;
  hasNewer: boolean;
}

interface ObservedCodexThreadWatcher extends observerHelpers.ObservedCodexThreadWatcher {
  timer: NodeJS.Timeout | null;
  inFlight: boolean;
  lastSnapshot: CodexHistorySnapshot | null;
  lastPollAt: number;
  rolloutPath: string | null;
  lastRolloutSize: number;
  rolloutPartialLine: string;
  rolloutBootstrapped: boolean;
  rolloutState: ObservedCodexRolloutState;
}

interface ObservedCodexRolloutState {
  threadId: string;
  activeTurnId: string | null;
  cwd: string | null;
  callMetadataByID: Map<string, {
    type: "command_execution" | "tool_call";
    toolName: string | null;
    command: string | null;
    cwd: string | null;
  }>;
  reasoningItemIdByTurn: Map<string, string>;
  openReasoningTurnIDs: Set<string>;
  assistantMessageCountByTurn: Map<string, number>;
  userMessageCountByTurn: Map<string, number>;
}

interface HistoryItemMetadata {
  threadId: string;
  turnId: string | null;
  itemId: string | null;
  currentCursor: string | null;
  previousCursor: string | null;
  previousItemId: string | null;
}

interface CodexHistoryChangedPayload extends UnknownRecord {
  provider: "codex";
  reason: "cache-mutated" | "cache-invalidated";
  scope: "thread" | "global";
  threadId?: string;
  turnId?: string | null;
  itemId?: string | null;
  previousItemId?: string | null;
  cursor?: string | null;
  previousCursor?: string | null;
  sourceMethod?: string | null;
  rawMethod?: string | null;
}

interface UpsertHistoryCacheTextItemOptions {
  turnId: unknown;
  itemId: unknown;
  type: string;
  role?: string | null;
  delta: unknown;
  metadata?: UnknownRecord | null;
  changes?: unknown[] | null;
}

interface EnsureHistoryRecordOptions {
  turnId: unknown;
  itemId: unknown;
  type: string;
  role?: string | null;
  defaults?: UnknownRecord;
}

type InterruptHandler = (() => void | Promise<void>) | null;
type SnapshotReader = (threadId: string) => CodexHistorySnapshot | null;

type ManagedHistoryItem = RuntimeStoreItem & {
  cwd?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
  explanation?: string | null;
  changes?: unknown[] | null;
  plan?: unknown;
};

interface ManagedHistoryTurn extends Omit<RuntimeStoreTurn, "items"> {
  items: ManagedHistoryItem[];
}

interface LocalManagedTurnContext extends ManagedProviderTurnContext {
  turnId: string;
  threadId: string;
  threadMeta: RuntimeThreadMeta;
  params: UnknownRecord;
  userTextPreview: string;
  complete(options?: { status?: string; usage?: unknown }): void;
  fail(error: unknown, options?: { status?: string }): void;
  interrupt(): void | Promise<void>;
  updateTokenUsage(usage: unknown): void;
}

interface CreateRuntimeManagerOptions {
  sendApplicationMessage: (rawMessage: string) => void;
  logPrefix?: string;
  storeBaseDir?: string;
  store?: RuntimeStore | null;
  threadSessionIndex?: ThreadSessionIndex | null;
  codexAdapter?: ReturnType<typeof createCodexAdapter> | null;
  claudeAdapter?: ReturnType<typeof createClaudeAdapter> | null;
  geminiAdapter?: ReturnType<typeof createGeminiAdapter> | null;
  copilotAdapter?: ReturnType<typeof createCopilotAdapter> | null;
  codexObservedThreadPollIntervalMs?: number;
  codexObservedThreadIdleTtlMs?: number;
  codexObservedThreadErrorBackoffMs?: number;
  codexObservedThreadLimit?: number;
}

export function createRuntimeManager({
  sendApplicationMessage,
  logPrefix = "[coderover]",
  storeBaseDir,
  store: providedStore = null,
  threadSessionIndex: providedThreadSessionIndex = null,
  codexAdapter: providedCodexAdapter = null,
  claudeAdapter: providedClaudeAdapter = null,
  geminiAdapter: providedGeminiAdapter = null,
  copilotAdapter: providedCopilotAdapter = null,
  codexObservedThreadPollIntervalMs = CODEX_OBSERVED_THREAD_POLL_INTERVAL_MS,
  codexObservedThreadIdleTtlMs = CODEX_OBSERVED_THREAD_IDLE_TTL_MS,
  codexObservedThreadErrorBackoffMs = CODEX_OBSERVED_THREAD_ERROR_BACKOFF_MS,
  codexObservedThreadLimit = CODEX_OBSERVED_THREAD_LIMIT,
}: CreateRuntimeManagerOptions): RuntimeManager {
  if (typeof sendApplicationMessage !== "function") {
    throw new Error("createRuntimeManager requires sendApplicationMessage");
  }

  const store = providedStore || createRuntimeStore(
    storeBaseDir ? { baseDir: storeBaseDir } : {}
  );
  const threadSessionIndex = providedThreadSessionIndex || createThreadSessionIndex({
    baseDir: store.baseDir,
  });
  const pendingClientRequests = new Map<string, PendingClientRequest>();
  const activeRunsByThread = new Map<string, ActiveRunEntry>();
  const codexHistoryCache = new Map<string, CodexHistorySnapshot>();
  const codexObservedThreadWatchers = new Map<string, ObservedCodexThreadWatcher>();

  let codexWarm = false;
  let codexWarmPromise: Promise<void> | null = null;
  let lastExternalSyncAt = 0;

  const codexAdapter: CodexAdapter = providedCodexAdapter || createCodexAdapter({
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
  const copilotAdapter = providedCopilotAdapter || createCopilotAdapter({
    logPrefix,
    store,
  });
  const codexEngine = createCodexRuntimeEngine({
    buildHistoryWindowResponse,
    buildUpstreamCodexHistoryParams,
    buildUpstreamHistoryWindowResponse,
    codexAdapter,
    createHistorySnapshotFromThread,
    createThreadNotFoundError(threadId) {
      return createRuntimeError(ERROR_THREAD_NOT_FOUND, `Thread not found: ${threadId}`);
    },
    defaultThreadListPageSize: DEFAULT_THREAD_LIST_PAGE_SIZE,
    decorateConversationThread,
    ensureCodexWarm,
    extractHistoryWindowFromResult,
    extractThreadFromResult,
    extractThreadArray,
    normalizeModelListResult,
    normalizePositiveInteger,
    observeCodexThread,
    primeCodexHistoryCache,
    readCodexHistoryWindowFromCache,
    sanitizeCodexThreadResult,
    sanitizeThreadHistoryForTransport,
    seedCodexHistoryCacheWithUserInput,
    sendThreadStartedNotification,
    store,
    stripProviderField,
    threadObjectToMeta,
    syncThreadSessionFromMeta,
    updateThreadSessionOwnerState,
    upsertOverlayFromThread,
    writeCodexHistoryCache,
  });
  const claudeEngine = createManagedProviderRuntimeEngine({
    activeRunsByThread,
    adapter: claudeAdapter,
    buildHistoryWindowResponse,
    buildManagedThreadObject,
    buildProviderMetadata,
    createHistorySnapshotFromThread,
    createRuntimeError,
    createTurnContext: createManagedTurnContext,
    firstNonEmptyString,
    normalizeOptionalString,
    providerId: "claude",
    sendThreadStartedNotification,
    store,
    syncThreadSessionFromMeta,
  });
  const geminiEngine = createManagedProviderRuntimeEngine({
    activeRunsByThread,
    adapter: geminiAdapter,
    buildHistoryWindowResponse,
    buildManagedThreadObject,
    buildProviderMetadata,
    createHistorySnapshotFromThread,
    createRuntimeError,
    createTurnContext: createManagedTurnContext,
    firstNonEmptyString,
    normalizeOptionalString,
    providerId: "gemini",
    sendThreadStartedNotification,
    store,
    syncThreadSessionFromMeta,
  });
  const copilotEngine = createManagedProviderRuntimeEngine({
    activeRunsByThread,
    adapter: copilotAdapter,
    buildHistoryWindowResponse,
    buildManagedThreadObject,
    buildProviderMetadata,
    createHistorySnapshotFromThread,
    createRuntimeError,
    createTurnContext: createManagedTurnContext,
    firstNonEmptyString,
    normalizeOptionalString,
    providerId: "copilot",
    sendThreadStartedNotification,
    store,
    syncThreadSessionFromMeta,
  });
  const providerEngines = new Map<string, ProviderRuntimeEngine>([
    [codexEngine.providerId, codexEngine],
    [claudeEngine.providerId, claudeEngine],
    [geminiEngine.providerId, geminiEngine],
    [copilotEngine.providerId, copilotEngine],
  ]);

  async function handleClientMessage(rawMessage: string): Promise<boolean> {
    let parsed: UnknownRecord | null = null;
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
    const requestId = parsed?.id as JsonRpcId | undefined;

    try {
      switch (method) {
        case "initialize":
          await Promise.all(
            Array.from(providerEngines.values(), (engine) => engine.initialize(params))
          );
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
            return getProviderEngine(provider).listModels(params);
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
            const threadId = normalizeOptionalString(params.threadId || params.thread_id);
            const historyRequest = normalizeHistoryRequest(params?.history);
            if (threadId) {
              primeObservedCodexThreadRollout(threadId);
              if (historyRequest) {
                const rolloutResult = readCodexHistoryWindowFromRollout(threadId, historyRequest);
                if (rolloutResult) {
                  observeCodexThread(threadId, { immediate: true, reason: "thread-read" });
                  return decorateThreadResultWithSessionMetadata(threadId, rolloutResult);
                }
              }
            }
            const result = await readThread(stripProviderField(params));
            if (threadId) {
              observeCodexThread(threadId, { immediate: true, reason: "thread-read" });
              return decorateThreadResultWithSessionMetadata(threadId, result);
            }
            return result;
          });

        case "thread/start":
          return await handleRequestWithResponse(requestId, async () => {
            const provider = resolveProviderId(params);
            return getProviderEngine(provider).startThread(params);
          });

        case "thread/resume":
          return await handleRequestWithResponse(requestId, async () => {
            const threadMeta = await requireThreadMeta(params.threadId || params.thread_id);
            const result = await getProviderEngine(threadMeta.provider).resumeThread(threadMeta, params);
            return decorateThreadResultWithSessionMetadata(threadMeta.id, result);
          });

        case "thread/compact/start":
          return await handleRequestWithResponse(requestId, async () => {
            const threadMeta = await requireThreadMeta(params.threadId || params.thread_id);
            const engine = getProviderEngine(threadMeta.provider);
            if (!engine.compactThread) {
              throw createMethodError("thread/compact/start is only available for Codex threads");
            }
            return engine.compactThread(threadMeta, params);
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
            const stableMeta = updatedMeta || threadMeta;

            sendNotification("thread/name/updated", {
              threadId: stableMeta.id,
              name: stableMeta.name,
            });
            return {
              thread: buildManagedThreadObject(stableMeta),
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
            const stableMeta = updatedMeta || threadMeta;
            return {
              thread: buildManagedThreadObject(stableMeta),
            };
          });

        case "turn/start":
          return await handleRequestWithResponse(requestId, async () => {
            const threadMeta = await requireThreadMeta(params.threadId || params.thread_id);
            return getProviderEngine(threadMeta.provider).startTurn(threadMeta, params);
          });

        case "turn/interrupt":
          return await handleRequestWithResponse(requestId, async () => {
            const threadId = normalizeOptionalString(params.threadId || params.thread_id)
              || findThreadIdByTurnId(params.turnId || params.turn_id);
            const threadMeta = await requireThreadMeta(threadId);
            return getProviderEngine(threadMeta.provider).interruptTurn(threadMeta, params);
          });

        case "turn/steer":
          return await handleRequestWithResponse(requestId, async () => {
            const threadMeta = await requireThreadMeta(params.threadId || params.thread_id);
            const engine = getProviderEngine(threadMeta.provider);
            if (!engine.steerTurn) {
              throw createMethodError("turn/steer is only available for Codex threads");
            }
            return engine.steerTurn(threadMeta, params);
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

  function attachCodexTransport(transport: Parameters<CodexAdapter["attachTransport"]>[0]): void {
    codexWarm = false;
    codexWarmPromise = null;
    codexHistoryCache.clear();
    stopAllObservedCodexThreadWatchers("transport-attached");
    codexAdapter.attachTransport(transport);
  }

  function handleCodexTransportMessage(rawMessage: string): void {
    codexAdapter.handleIncomingRaw(rawMessage);
  }

  function handleCodexTransportClosed(reason?: unknown): void {
    codexWarm = false;
    codexWarmPromise = null;
    codexHistoryCache.clear();
    const normalizedReason = normalizeOptionalString(reason) || "transport-closed";
    stopAllObservedCodexThreadWatchers(normalizedReason);
    codexAdapter.handleTransportClosed(normalizedReason);
  }

  async function shutdown(): Promise<void> {
    stopAllObservedCodexThreadWatchers("shutdown");
    for (const engine of providerEngines.values()) {
      await Promise.resolve(engine.shutdown());
    }
    await Promise.resolve(threadSessionIndex.shutdown());
    await Promise.resolve(store.shutdown());
  }

  function forwardCodexTransportMessage(rawMessage: string, parsedMessage: unknown): void {
    logCodexRealtimeEvent("codex-in", parsedMessage);
    const historyChange = handleCodexHistoryCacheEvent(rawMessage);
    const canonicalNotifications = projectCodexTransportNotificationToCanonicalMessages(parsedMessage);
    const suppressRawFallback = shouldSuppressRawCodexRealtimeFallback(parsedMessage);

    if (canonicalNotifications.length > 0) {
      canonicalNotifications.forEach((message) => {
        sendApplicationMessage(message);
        logCodexRealtimeEvent("phone-out", message);
      });
    } else if (!suppressRawFallback) {
      const decoratedMessage = decorateCodexTransportMessage(rawMessage, parsedMessage);
      sendApplicationMessage(decoratedMessage);
      logCodexRealtimeEvent("phone-out", decoratedMessage);
    }

    if (shouldEmitHistoryChangedForCodexChange(historyChange)) {
      emitCodexHistoryChangedNotification(historyChange);
    }
  }

  function shouldEmitHistoryChangedForCodexChange(
    historyChange: CodexHistoryChangedPayload | null
  ): boolean {
    if (!historyChange) {
      return false;
    }
    const sourceKind = historyChange.threadId
      ? threadSessionIndex.get(historyChange.threadId)?.sourceKind
      : null;
    return historyChange.reason === "cache-invalidated"
      || historyChange.sourceMethod === "thread/read"
      || sourceKind === "rollout_observer";
  }

  function projectCodexTransportNotificationToCanonicalMessages(
    parsedMessage: unknown
  ): string[] {
    const parsedRecord = asObject(parsedMessage);
    const method = normalizeOptionalString(parsedRecord.method);
    if (!method || parsedRecord.id != null) {
      return [];
    }

    const params = asObject(parsedRecord.params);
    const normalizedMethod = normalizeCodexHistoryEventMethod(method, params);
    const threadId = extractCodexNotificationThreadId(params);
    const turnId = extractCodexNotificationTurnId(params);

    if (normalizedMethod === "turn/started" && threadId && turnId) {
      return [encodeCanonicalNotification("timeline/turnUpdated", {
        threadId,
        turnId,
        state: "running",
      })];
    }

    if (normalizedMethod === "turn/completed" && threadId && turnId) {
      return [encodeCanonicalNotification("timeline/turnUpdated", {
        threadId,
        turnId,
        state: normalizeOptionalString(params.status) || "completed",
      })];
    }

    const timelinePayload = buildCanonicalTimelineItemPayloadFromCodexNotification(
      normalizedMethod,
      params
    );
    if (!timelinePayload) {
      return [];
    }

    const timelineMethod = normalizedMethod === "item/started"
      ? "timeline/itemStarted"
      : normalizedMethod === "item/completed" || normalizedMethod === "item/toolCall/completed"
        ? "timeline/itemCompleted"
        : "timeline/itemTextUpdated";

    return [encodeCanonicalNotification(timelineMethod, timelinePayload)];
  }

  function shouldSuppressRawCodexRealtimeFallback(parsedMessage: unknown): boolean {
    const parsedRecord = asObject(parsedMessage);
    if (parsedRecord.id != null) {
      return false;
    }
    const params = asObject(parsedRecord.params);
    const normalizedMethod = normalizeCodexHistoryEventMethod(parsedRecord.method, params);
    if (!normalizedMethod) {
      return false;
    }
    return normalizedMethod === "turn/started"
      || normalizedMethod === "turn/completed"
      || normalizedMethod === "turn/plan/updated"
      || normalizedMethod === "item/plan/delta"
      || normalizedMethod.startsWith("item/")
      || normalizedMethod.startsWith("coderover/event/")
      || normalizedMethod.startsWith("codex/event/");
  }

  function encodeCanonicalNotification(method: string, params: UnknownRecord): string {
    return JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
    });
  }

  function createObservedCodexRolloutState(threadId: string): ObservedCodexRolloutState {
    return {
      threadId,
      activeTurnId: null,
      cwd: null,
      callMetadataByID: new Map(),
      reasoningItemIdByTurn: new Map(),
      openReasoningTurnIDs: new Set(),
      assistantMessageCountByTurn: new Map(),
      userMessageCountByTurn: new Map(),
    };
  }

  function resetObservedCodexThreadRolloutState(
    watcher: ObservedCodexThreadWatcher,
    rolloutPath: string | null = watcher.rolloutPath
  ): void {
    watcher.rolloutPath = rolloutPath;
    watcher.lastRolloutSize = 0;
    watcher.rolloutPartialLine = "";
    watcher.rolloutBootstrapped = false;
    watcher.rolloutState = createObservedCodexRolloutState(watcher.threadId);
  }

  function resolveCodexSessionsRoot(): string {
    const codexHome = normalizeOptionalString(process.env.CODEX_HOME)
      || `${process.env.HOME || ""}/.codex`;
    return `${codexHome}/sessions`;
  }

  function observeCodexThread(
    threadId: unknown,
    { immediate = false, reason = "observe" }: { immediate?: boolean; reason?: string } = {}
  ): void {
    const normalizedThreadId = normalizeOptionalString(threadId);
    if (!normalizedThreadId) {
      return;
    }
    const threadMeta = store.getThreadMeta(normalizedThreadId);
    if (threadMeta && threadMeta.provider !== "codex") {
      return;
    }

    evictObservedCodexThreadsIfNeeded(normalizedThreadId);
    const watcher = ensureObservedCodexThreadWatcher(normalizedThreadId);
    scheduleObservedCodexThreadPoll(watcher, immediate ? 0 : codexObservedThreadPollIntervalMs);
    debugLog(
      `${logPrefix} [codex-flow] stage=observe thread=${normalizedThreadId} reason=${reason} immediate=${immediate}`
    );
  }

  function evictObservedCodexThreadsIfNeeded(preserveThreadId: string | null = null): void {
    if (codexObservedThreadWatchers.size < codexObservedThreadLimit) {
      return;
    }

    const evictionCandidates = observerHelpers.sortObservedThreadEvictionCandidates(
      codexObservedThreadWatchers,
      preserveThreadId
    );
    while (codexObservedThreadWatchers.size >= codexObservedThreadLimit && evictionCandidates.length > 0) {
      const evicted = evictionCandidates.shift();
      if (!evicted) {
        break;
      }
      stopObservedCodexThreadWatcher(evicted.threadId, "evicted");
    }
  }

  function scheduleObservedCodexThreadPoll(
    watcher: ObservedCodexThreadWatcher | null | undefined,
    delayMs: number
  ): void {
    if (!watcher || !codexObservedThreadWatchers.has(watcher.threadId)) {
      return;
    }
    if (watcher.timer) {
      clearTimeout(watcher.timer);
    }
    watcher.timer = setTimeout(() => {
      watcher.timer = null;
      void pollObservedCodexThread(watcher.threadId);
    }, Math.max(0, delayMs));
    watcher.timer.unref?.();
  }

  function ensureObservedCodexThreadWatcher(threadId: string): ObservedCodexThreadWatcher {
    const now = Date.now();
    const existing = codexObservedThreadWatchers.get(threadId);
    if (existing) {
      existing.lastObservedAt = now;
      return existing;
    }
    const watcher: ObservedCodexThreadWatcher = {
      threadId,
      lastObservedAt: now,
      timer: null,
      inFlight: false,
      lastSnapshot: null,
      lastPollAt: 0,
      rolloutPath: null,
      lastRolloutSize: 0,
      rolloutPartialLine: "",
      rolloutBootstrapped: false,
      rolloutState: createObservedCodexRolloutState(threadId),
    };
    codexObservedThreadWatchers.set(threadId, watcher);
    return watcher;
  }

  function primeObservedCodexThreadRollout(threadId: string): void {
    const rolloutPath = findRolloutFileForThread(resolveCodexSessionsRoot(), threadId);
    if (!rolloutPath) {
      return;
    }
    evictObservedCodexThreadsIfNeeded(threadId);
    const watcher = ensureObservedCodexThreadWatcher(threadId);
    if (watcher.rolloutPath !== rolloutPath) {
      resetObservedCodexThreadRolloutState(watcher, rolloutPath);
    }
    try {
      observeCodexThreadViaRollout(watcher);
    } catch (error) {
      debugError(`${logPrefix} rollout prime failed thread=${threadId}: ${String(asObject(error).message || error)}`);
    }
  }

  function readCodexHistoryWindowFromRollout(
    threadId: string,
    historyRequest: RuntimeHistoryRequest
  ): unknown {
    const rolloutPath = findRolloutFileForThread(resolveCodexSessionsRoot(), threadId);
    if (!rolloutPath) {
      return null;
    }

    evictObservedCodexThreadsIfNeeded(threadId);
    const watcher = ensureObservedCodexThreadWatcher(threadId);
    resetObservedCodexThreadRolloutState(watcher, rolloutPath);
    observeCodexThreadViaRollout(watcher);
    const snapshot = readCodexHistorySnapshot(threadId);
    if (!snapshot) {
      return null;
    }
    return buildHistoryWindowResponse(snapshot, historyRequest, true);
  }

  async function pollObservedCodexThread(threadId: unknown): Promise<void> {
    const normalizedThreadId = normalizeOptionalString(threadId);
    if (!normalizedThreadId) {
      return;
    }
    const observedThreadId = normalizedThreadId;
    const watcher = codexObservedThreadWatchers.get(observedThreadId) || null;
    if (!watcher || watcher.inFlight) {
      return;
    }

    watcher.inFlight = true;
    watcher.lastPollAt = Date.now();
    try {
      const didProjectRollout = observeCodexThreadViaRollout(watcher);
      if (!didProjectRollout) {
        await pollObservedCodexThreadViaThreadRead(watcher);
      }
    } catch (error) {
      const errorRecord = asObject(error);
      debugError(`${logPrefix} observed thread poll failed thread=${normalizedThreadId}: ${String(errorRecord.message || error)}`);
      if (codexObservedThreadWatchers.has(observedThreadId)) {
        watcher.inFlight = false;
        scheduleObservedCodexThreadPoll(watcher, codexObservedThreadErrorBackoffMs);
      }
      return;
    }

    watcher.inFlight = false;
    if (!codexObservedThreadWatchers.has(observedThreadId)) {
      return;
    }

    const isStillObserved = (Date.now() - watcher.lastObservedAt) < codexObservedThreadIdleTtlMs;
    if (!isStillObserved) {
      stopObservedCodexThreadWatcher(normalizedThreadId, "ttl-expired");
      return;
    }
    scheduleObservedCodexThreadPoll(watcher, codexObservedThreadPollIntervalMs);
  }

  function observeCodexThreadViaRollout(watcher: ObservedCodexThreadWatcher): boolean {
    const sessionRecord = threadSessionIndex.get(watcher.threadId);
    if (sessionRecord?.sourceKind === "managed_runtime") {
      return true;
    }

    const rolloutPath = findRolloutFileForThread(resolveCodexSessionsRoot(), watcher.threadId) || watcher.rolloutPath;
    if (!rolloutPath) {
      return false;
    }

    if (watcher.rolloutPath !== rolloutPath) {
      resetObservedCodexThreadRolloutState(watcher, rolloutPath);
    }

    const stat = fs.statSync(rolloutPath);
    if (stat.size < watcher.lastRolloutSize) {
      resetObservedCodexThreadRolloutState(watcher, rolloutPath);
    }

    upsertThreadSessionRecord({
      threadId: watcher.threadId,
      provider: "codex",
      rolloutPath,
      cwd: watcher.rolloutState.cwd,
      activeTurnId: watcher.rolloutState.activeTurnId,
      ownerState: "idle",
      sourceKind: "rollout_observer",
    });

    if (!watcher.rolloutBootstrapped) {
      const bootstrapChunk = fs.readFileSync(rolloutPath, "utf8");
      const bootstrapSplit = splitObservedCodexRolloutChunk(bootstrapChunk);
      codexHistoryCache.delete(watcher.threadId);
      ensureCodexHistoryCacheEntry(watcher.threadId, {
        cwd: watcher.rolloutState.cwd,
      });
      processCodexRolloutLines(
        watcher.threadId,
        bootstrapSplit.lines,
        watcher.rolloutState,
        false
      );
      watcher.rolloutPartialLine = bootstrapSplit.partialLine;
      watcher.lastRolloutSize = stat.size;
      watcher.rolloutBootstrapped = true;
      watcher.lastSnapshot = readCodexHistorySnapshot(watcher.threadId);
      return true;
    }

    if (stat.size > watcher.lastRolloutSize) {
      const growthChunk = readUtf8FileSlice(rolloutPath, watcher.lastRolloutSize, stat.size);
      const split = splitObservedCodexRolloutChunk(`${watcher.rolloutPartialLine}${growthChunk}`);
      watcher.rolloutPartialLine = split.partialLine;
      watcher.lastRolloutSize = stat.size;
      processCodexRolloutLines(
        watcher.threadId,
        split.lines,
        watcher.rolloutState,
        true
      );
      watcher.lastSnapshot = readCodexHistorySnapshot(watcher.threadId);
    }

    return true;
  }

  async function pollObservedCodexThreadViaThreadRead(
    watcher: ObservedCodexThreadWatcher
  ): Promise<void> {
    await ensureCodexWarm();
    const result = await codexAdapter.readThread({
      threadId: watcher.threadId,
      history: {
        mode: "tail",
        limit: CODEX_HISTORY_CACHE_MESSAGE_LIMIT,
      },
    });
    const threadObject = extractThreadFromResult(result);
    if (!threadObject) {
      stopObservedCodexThreadWatcher(watcher.threadId, "thread-missing");
      return;
    }

    const decoratedThread = decorateConversationThread(threadObject);
    upsertOverlayFromThread(decoratedThread);
    const historyWindow = extractHistoryWindowFromResult(result);
    const observedSnapshot = {
      ...createHistorySnapshotFromThread(decoratedThread),
      hasOlder: Boolean(historyWindow?.hasOlder),
      hasNewer: Boolean(historyWindow?.hasNewer),
    };
    const previousSnapshot = watcher.lastSnapshot || readCodexHistorySnapshot(watcher.threadId);
    const nextSnapshot = reconcileCanonicalTimelineIds(
      previousSnapshot,
      observedSnapshot
    );
    const historyChange = buildHistoryChangedFromSnapshotDiff(previousSnapshot, nextSnapshot);

    writeCodexHistoryCache(watcher.threadId, observedSnapshot);
    watcher.lastSnapshot = nextSnapshot;

    if (historyChange) {
      debugLog(
        `${logPrefix} [codex-flow] stage=observed-diff thread=${watcher.threadId}`
        + ` item=${historyChange.itemId || "none"} cursor=${historyChange.cursor || "none"}`
      );
      emitCodexHistoryChangedNotification(historyChange);
    }
  }

  function splitObservedCodexRolloutChunk(
    chunk: string
  ): { lines: string[]; partialLine: string } {
    if (!chunk) {
      return { lines: [], partialLine: "" };
    }
    const parts = chunk.split("\n");
    const trailingLine = parts.pop() || "";
    let partialLine = trailingLine;
    if (trailingLine.trim()) {
      const parsedTrailingLine = parseObservedCodexRolloutLine(trailingLine);
      if (parsedTrailingLine) {
        parts.push(trailingLine);
        partialLine = "";
      }
    }
    return {
      lines: parts,
      partialLine,
    };
  }

  function readUtf8FileSlice(filePath: string, start: number, endExclusive: number): string {
    const fd = fs.openSync(filePath, "r");
    try {
      const length = Math.max(0, endExclusive - start);
      if (length === 0) {
        return "";
      }
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, start);
      return buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  }

  function processCodexRolloutLines(
    threadId: string,
    lines: string[],
    rolloutState: ObservedCodexRolloutState,
    emitRealtime: boolean
  ): void {
    if (!Array.isArray(lines) || lines.length === 0) {
      return;
    }

    ensureCodexHistoryCacheEntry(threadId, {
      cwd: rolloutState.cwd,
    });
    for (const rawLine of lines) {
      const parsedLine = parseObservedCodexRolloutLine(rawLine);
      if (!parsedLine) {
        continue;
      }
      ensureCodexHistoryCacheEntry(threadId, {
        cwd: rolloutState.cwd,
        updatedAt: normalizeOptionalString(parsedLine.timestamp),
      });

      const notifications = synthesizeCodexNotificationsFromRolloutEntry(parsedLine, rolloutState);
      notifications.forEach((notification) => {
        forwardSyntheticCodexNotification(
          notification,
          emitRealtime
        );
      });
    }
  }

  function parseObservedCodexRolloutLine(rawLine: string): UnknownRecord | null {
    const trimmedLine = rawLine.trim();
    if (!trimmedLine) {
      return null;
    }

    const directParse = parseObservedCodexRolloutEntry(trimmedLine);
    if (directParse) {
      return directParse;
    }

    for (let index = 1; index < trimmedLine.length - 1; index += 1) {
      if (trimmedLine[index] !== "{" || trimmedLine[index + 1] !== "\"") {
        continue;
      }
      const recoveredParse = parseObservedCodexRolloutEntry(trimmedLine.slice(index));
      if (recoveredParse) {
        debugLog(
          `${logPrefix} [codex-flow] stage=rollout-line-recovered `
          + `droppedPrefixBytes=${index}`
        );
        return recoveredParse;
      }
    }

    return null;
  }

  function parseObservedCodexRolloutEntry(rawValue: string): UnknownRecord | null {
    let parsedValue: unknown = null;
    try {
      parsedValue = JSON.parse(rawValue) as unknown;
    } catch {
      return null;
    }

    const parsedRecord = asObject(parsedValue);
    return isObservedCodexRolloutEntry(parsedRecord) ? parsedRecord : null;
  }

  function isObservedCodexRolloutEntry(value: UnknownRecord): boolean {
    const entryType = normalizeOptionalString(value.type);
    if (!entryType) {
      return false;
    }
    const payload = value.payload;
    return Boolean(payload && typeof payload === "object" && !Array.isArray(payload));
  }

  function synthesizeCodexNotificationsFromRolloutEntry(
    entry: UnknownRecord,
    rolloutState: ObservedCodexRolloutState
  ): UnknownRecord[] {
    const entryType = normalizeOptionalString(entry.type);
    const timestamp = normalizeOptionalString(entry.timestamp) || new Date().toISOString();
    const payload = asObject(entry.payload);
    if (entryType === "session_meta") {
      rolloutState.cwd = normalizeOptionalString(payload.cwd) || rolloutState.cwd;
      return [];
    }

    if (entryType === "turn_context") {
      rolloutState.activeTurnId = normalizeOptionalString(payload.turn_id)
        || normalizeOptionalString(payload.turnId)
        || rolloutState.activeTurnId;
      rolloutState.cwd = normalizeOptionalString(payload.cwd) || rolloutState.cwd;
      return [];
    }

    if (entryType === "event_msg") {
      return synthesizeCodexNotificationsFromRolloutEventMsg(
        payload,
        timestamp,
        rolloutState
      );
    }

    if (entryType === "response_item") {
      return synthesizeCodexNotificationsFromRolloutResponseItem(
        payload,
        timestamp,
        rolloutState
      );
    }

    return [];
  }

  function synthesizeCodexNotificationsFromRolloutEventMsg(
    payload: UnknownRecord,
    timestamp: string,
    rolloutState: ObservedCodexRolloutState
  ): UnknownRecord[] {
    const eventType = normalizeOptionalString(payload.type);
    const turnId = normalizeOptionalString(payload.turn_id)
      || normalizeOptionalString(payload.turnId)
      || rolloutState.activeTurnId;
    if (eventType === "task_started" && turnId) {
      rolloutState.activeTurnId = turnId;
      return [createSyntheticCodexNotification("turn/started", {
        threadId: rolloutState.threadId,
        turnId,
        id: turnId,
      })];
    }

    if (eventType === "task_complete" && turnId) {
      rolloutState.activeTurnId = turnId;
      const notifications: UnknownRecord[] = [];
      const reasoningItemId = rolloutState.reasoningItemIdByTurn.get(turnId);
      if (reasoningItemId && rolloutState.openReasoningTurnIDs.has(turnId)) {
        notifications.push(createSyntheticCodexNotification("item/completed", {
          threadId: rolloutState.threadId,
          turnId,
          itemId: reasoningItemId,
          item: {
            id: reasoningItemId,
            type: "reasoning",
            status: "completed",
            createdAt: timestamp,
          },
        }));
      }
      rolloutState.openReasoningTurnIDs.delete(turnId);
      rolloutState.callMetadataByID.clear();
      notifications.push(createSyntheticCodexNotification("turn/completed", {
        threadId: rolloutState.threadId,
        turnId,
        id: turnId,
        status: "completed",
      }));
      return notifications;
    }

    if (eventType === "user_message" && turnId) {
      const itemId = nextObservedCodexMessageItemId(
        rolloutState.userMessageCountByTurn,
        "user",
        rolloutState.threadId,
        turnId
      );
      return [createSyntheticCodexNotification("item/completed", {
        threadId: rolloutState.threadId,
        turnId,
        itemId,
        item: {
          id: itemId,
          type: "user_message",
          role: "user",
          text: firstNonEmptyString([payload.message, payload.text]) || "",
          content: [{
            type: "text",
            text: firstNonEmptyString([payload.message, payload.text]) || "",
          }],
          status: "completed",
          createdAt: timestamp,
        },
      })];
    }

    if (eventType === "agent_reasoning" && turnId) {
      const itemId = ensureObservedCodexReasoningItemId(rolloutState, turnId);
      rolloutState.openReasoningTurnIDs.add(turnId);
      return [createSyntheticCodexNotification("item/reasoning/textDelta", {
        threadId: rolloutState.threadId,
        turnId,
        itemId,
        delta: firstNonEmptyString([payload.text, payload.message, payload.summary]) || "",
      })];
    }

    if (eventType === "agent_message" && turnId) {
      const itemId = nextObservedCodexMessageItemId(
        rolloutState.assistantMessageCountByTurn,
        "assistant",
        rolloutState.threadId,
        turnId
      );
      return [createSyntheticCodexNotification("item/completed", {
        threadId: rolloutState.threadId,
        turnId,
        itemId,
        item: {
          id: itemId,
          type: "agent_message",
          role: "assistant",
          text: firstNonEmptyString([payload.message, payload.text]) || "",
          content: [{
            type: "text",
            text: firstNonEmptyString([payload.message, payload.text]) || "",
          }],
          status: "completed",
          createdAt: timestamp,
        },
      })];
    }

    return [];
  }

  function synthesizeCodexNotificationsFromRolloutResponseItem(
    payload: UnknownRecord,
    timestamp: string,
    rolloutState: ObservedCodexRolloutState
  ): UnknownRecord[] {
    const itemType = normalizeOptionalString(payload.type);
    const turnId = rolloutState.activeTurnId;
    if (!turnId) {
      return [];
    }

    if (itemType === "function_call") {
      const callId = normalizeOptionalString(payload.call_id) || normalizeOptionalString(payload.callId);
      const toolName = normalizeOptionalString(payload.name);
      if (!callId || !toolName) {
        return [];
      }
      const toolArgs = safeParseJsonObject(payload.arguments);
      if (toolName === "exec_command") {
        rolloutState.callMetadataByID.set(callId, {
          type: "command_execution",
          toolName,
          command: firstNonEmptyString([toolArgs.cmd, toolArgs.command]),
          cwd: firstNonEmptyString([toolArgs.workdir, toolArgs.cwd, rolloutState.cwd]),
        });
        return [createSyntheticCodexNotification("item/commandExecution/outputDelta", {
          threadId: rolloutState.threadId,
          turnId,
          itemId: callId,
          command: firstNonEmptyString([toolArgs.cmd, toolArgs.command]),
          cwd: firstNonEmptyString([toolArgs.workdir, toolArgs.cwd, rolloutState.cwd]),
          status: "running",
          item: {
            id: callId,
            type: "command_execution",
            command: firstNonEmptyString([toolArgs.cmd, toolArgs.command]),
            cwd: firstNonEmptyString([toolArgs.workdir, toolArgs.cwd, rolloutState.cwd]),
            status: "running",
            createdAt: timestamp,
            text: "",
          },
        })];
      }

      rolloutState.callMetadataByID.set(callId, {
        type: "tool_call",
        toolName,
        command: null,
        cwd: firstNonEmptyString([toolArgs.workdir, toolArgs.cwd, rolloutState.cwd]),
      });
      return [createSyntheticCodexNotification("item/started", {
        threadId: rolloutState.threadId,
        turnId,
        itemId: callId,
        item: {
          id: callId,
          type: "tool_call",
          metadata: {
            toolName,
          },
          status: "running",
          createdAt: timestamp,
          text: "",
        },
      })];
    }

    if (itemType === "function_call_output") {
      const callId = normalizeOptionalString(payload.call_id) || normalizeOptionalString(payload.callId);
      if (!callId) {
        return [];
      }
      const output = normalizeOptionalString(payload.output) || "";
      const callMetadata = rolloutState.callMetadataByID.get(callId) || null;
      rolloutState.callMetadataByID.delete(callId);
      if (callMetadata?.type === "tool_call") {
        return [
          createSyntheticCodexNotification("item/toolCall/outputDelta", {
            threadId: rolloutState.threadId,
            turnId,
            itemId: callId,
            delta: output,
            toolName: callMetadata.toolName,
          }),
          createSyntheticCodexNotification("item/toolCall/completed", {
            threadId: rolloutState.threadId,
            turnId,
            itemId: callId,
            item: {
              id: callId,
              type: "tool_call",
              metadata: {
                toolName: callMetadata.toolName,
              },
              status: "completed",
              text: output,
              createdAt: timestamp,
            },
          }),
        ];
      }
      return [
        createSyntheticCodexNotification("item/commandExecution/outputDelta", {
          threadId: rolloutState.threadId,
          turnId,
          itemId: callId,
          delta: output,
          command: callMetadata?.command,
          cwd: callMetadata?.cwd,
          status: "completed",
        }),
        createSyntheticCodexNotification("item/completed", {
          threadId: rolloutState.threadId,
          turnId,
          itemId: callId,
          item: {
            id: callId,
            type: "command_execution",
            command: callMetadata?.command,
            cwd: callMetadata?.cwd,
            status: "completed",
            text: output,
            createdAt: timestamp,
          },
        }),
      ];
    }

    if (itemType === "custom_tool_call") {
      const callId = normalizeOptionalString(payload.call_id) || normalizeOptionalString(payload.callId);
      const toolName = normalizeOptionalString(payload.name);
      if (!callId || toolName !== "apply_patch") {
        return [];
      }
      return [createSyntheticCodexNotification("item/completed", {
        threadId: rolloutState.threadId,
        turnId,
        itemId: callId,
        item: {
          id: callId,
          type: "file_change",
          status: normalizeOptionalString(payload.status) || "completed",
          text: summarizeObservedCodexPatchInput(payload.input),
          createdAt: timestamp,
        },
      })];
    }

    return [];
  }

  function createSyntheticCodexNotification(method: string, params: UnknownRecord): UnknownRecord {
    return {
      jsonrpc: "2.0",
      method,
      params,
    };
  }

  function forwardSyntheticCodexNotification(
    parsedMessage: UnknownRecord,
    emitRealtime: boolean
  ): void {
    const rawMessage = JSON.stringify(parsedMessage);
    const historyChange = handleCodexHistoryCacheEvent(rawMessage);
    if (!emitRealtime) {
      return;
    }
    const canonicalNotifications = projectCodexTransportNotificationToCanonicalMessages(parsedMessage);
    canonicalNotifications.forEach((message) => {
      sendApplicationMessage(message);
      logCodexRealtimeEvent("phone-out", message);
    });
    const fallbackHistoryChange = historyChange || buildSyntheticHistoryChangedPayload(parsedMessage);
    if (shouldEmitHistoryChangedForCodexChange(fallbackHistoryChange)) {
      emitCodexHistoryChangedNotification(fallbackHistoryChange);
    }
  }

  function buildSyntheticHistoryChangedPayload(
    parsedMessage: UnknownRecord
  ): CodexHistoryChangedPayload | null {
    const method = normalizeOptionalString(parsedMessage.method);
    const params = asObject(parsedMessage.params);
    if (!method || !method.startsWith("item/")) {
      return null;
    }
    const threadId = extractCodexNotificationThreadId(params);
    const itemId = extractCodexNotificationItemId(params);
    if (!threadId || !itemId) {
      return null;
    }
    const snapshot = readCodexHistorySnapshot(threadId);
    const metadata = historyMetadataForItem(snapshot, itemId);
    return {
      provider: "codex",
      reason: "cache-mutated",
      scope: "thread",
      threadId,
      turnId: metadata?.turnId || extractCodexNotificationTurnId(params) || null,
      itemId: metadata?.itemId || itemId,
      previousItemId: metadata?.previousItemId || null,
      cursor: metadata?.currentCursor || null,
      previousCursor: metadata?.previousCursor || null,
      sourceMethod: method,
      rawMethod: method,
    };
  }

  function nextObservedCodexMessageItemId(
    counterByTurn: Map<string, number>,
    prefix: string,
    threadId: string,
    turnId: string
  ): string {
    const nextCount = (counterByTurn.get(turnId) || 0) + 1;
    counterByTurn.set(turnId, nextCount);
    return `rollout:${prefix}:${threadId}:${turnId}:${nextCount}`;
  }

  function ensureObservedCodexReasoningItemId(
    rolloutState: ObservedCodexRolloutState,
    turnId: string
  ): string {
    const existing = rolloutState.reasoningItemIdByTurn.get(turnId);
    if (existing) {
      return existing;
    }
    const nextItemId = `rollout:reasoning:${rolloutState.threadId}:${turnId}`;
    rolloutState.reasoningItemIdByTurn.set(turnId, nextItemId);
    return nextItemId;
  }

  function summarizeObservedCodexPatchInput(input: unknown): string {
    const rawInput = normalizeOptionalString(input);
    if (!rawInput) {
      return "Applied patch";
    }
    const matchedPath = rawInput.match(/\*\*\* (?:Add|Update|Delete) File: ([^\n]+)/);
    if (matchedPath?.[1]) {
      return `Patched ${matchedPath[1].trim()}`;
    }
    return "Applied patch";
  }

  function safeParseJsonObject(value: unknown): UnknownRecord {
    if (typeof value !== "string" || !value.trim()) {
      return {};
    }
    try {
      const parsed = JSON.parse(value) as unknown;
      return asObject(parsed);
    } catch {
      return {};
    }
  }

  function stopObservedCodexThreadWatcher(threadId: unknown, reason = "stopped"): void {
    const normalizedThreadId = normalizeOptionalString(threadId);
    if (!normalizedThreadId) {
      return;
    }
    const watcher = codexObservedThreadWatchers.get(normalizedThreadId);
    if (!watcher) {
      return;
    }
    if (watcher.timer) {
      clearTimeout(watcher.timer);
    }
    codexObservedThreadWatchers.delete(normalizedThreadId);
    debugLog(`${logPrefix} [codex-flow] stage=unobserve thread=${normalizedThreadId} reason=${reason}`);
  }

  function stopAllObservedCodexThreadWatchers(reason = "reset"): void {
    for (const threadId of [...codexObservedThreadWatchers.keys()]) {
      stopObservedCodexThreadWatcher(threadId, reason);
    }
  }

  function decorateCodexTransportMessage(rawMessage: string, parsedMessage: unknown): string {
    const parsedRecord = asObject(parsedMessage);
    const method = normalizeOptionalString(parsedRecord.method);
    const params = asObject(parsedRecord.params);
    if (!method) {
      return rawMessage;
    }

    const normalizedMethod = parsedRecord.id == null
      ? (normalizeCodexHistoryEventMethod(method, params) || method)
      : method;
    const decoratedParams = params
      ? decorateNotificationWithHistoryMetadata(normalizedMethod, params, (threadId: string) =>
        readCodexHistorySnapshot(threadId)
      )
      : params;
    if (normalizedMethod === method && decoratedParams === params) {
      return rawMessage;
    }

    return JSON.stringify({
      ...parsedRecord,
      method: normalizedMethod,
      params: decoratedParams,
    });
  }

  async function handleClientResponse(rawMessage: string, parsed: UnknownRecord): Promise<boolean> {
    const responseKey = encodeRequestId(parsed.id as JsonRpcId | undefined);
    const pending = pendingClientRequests.get(responseKey);
    if (pending) {
      pendingClientRequests.delete(responseKey);
      if (parsed.error) {
        const errorRecord = asObject(parsed.error);
        pending.reject(new Error(normalizeOptionalString(errorRecord.message) || "Client rejected server request"));
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

  async function handleRequestWithResponse(
    requestId: JsonRpcId | undefined,
    handler: () => Promise<unknown>
  ): Promise<boolean> {
    if (requestId == null) {
      await handler();
      return true;
    }
    const result = await handler();
    sendApplicationMessage(buildRpcSuccess(requestId, result));
    return true;
  }

  async function ensureCodexWarm(initializeParams: RuntimeInitializeParams | UnknownRecord | null = null): Promise<void> {
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

  async function ensureExternalThreadsIndexed(): Promise<void> {
    const now = Date.now();
    if ((now - lastExternalSyncAt) < EXTERNAL_SYNC_INTERVAL_MS) {
      return;
    }
    lastExternalSyncAt = now;
    const syncTasks = Array.from(providerEngines.values())
      .map((engine) => engine.syncImportedThreads?.())
      .filter((task): task is Promise<void> => Boolean(task));
    await Promise.allSettled(syncTasks);
  }

  async function listThreads(params: UnknownRecord): Promise<{
    threads: RuntimeThreadShape[];
    nextCursor: string | number | null;
    hasMore: boolean;
    pageSize: number;
  }> {
    const archived = Boolean(params?.archived);
    const requestedLimit = normalizePositiveInteger(params?.limit) || DEFAULT_THREAD_LIST_PAGE_SIZE;
    const cursor = decodeThreadListCursor(params?.cursor);
    const providerThreads = await Promise.all(
      Array.from(providerEngines.values(), (engine) => engine.listThreads(params))
    );
    const mergedThreads = mergeThreadLists(providerThreads.flat())
      .map((thread) => summarizeThreadForList(thread));
    const page = paginateThreadList(mergedThreads, {
      archived,
      limit: requestedLimit,
      cursor,
    });

    return {
      threads: page.threads,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      pageSize: page.pageSize,
    };
  }

  async function readThread(params: UnknownRecord): Promise<unknown> {
    const threadId = normalizeOptionalString(params.threadId || params.thread_id);
    const threadMeta = await requireThreadMeta(threadId);
    const historyRequest = normalizeHistoryRequest(params?.history);
    return getProviderEngine(threadMeta.provider).readThread(threadMeta, params, historyRequest);
  }

  async function requireThreadMeta(threadId: unknown): Promise<RuntimeThreadMeta> {
    const normalizedThreadId = normalizeOptionalString(threadId);
    if (!normalizedThreadId) {
      throw createRuntimeError(ERROR_INVALID_PARAMS, "threadId is required");
    }

    const storedMeta = store.getThreadMeta(normalizedThreadId);
    if (storedMeta) {
      return storedMeta;
    }

    for (const engine of providerEngines.values()) {
      const resolvedMeta = await engine.lookupThreadMeta?.(normalizedThreadId, store);
      if (resolvedMeta) {
        return resolvedMeta;
      }
    }

    throw createRuntimeError(ERROR_THREAD_NOT_FOUND, `Thread not found: ${normalizedThreadId}`);
  }

  function getProviderEngine(provider: unknown): ProviderRuntimeEngine {
    const normalizedProvider = resolveProviderId(provider);
    const engine = providerEngines.get(normalizedProvider);
    if (engine) {
      return engine;
    }
    throw createMethodError(`Runtime engine unavailable for provider: ${normalizedProvider}`);
  }

  function readCodexHistoryWindowFromCache(
    threadId: string,
    historyRequest: RuntimeHistoryRequest
  ): unknown {
    let cacheEntry = touchCodexHistoryCache(threadId);
    if (!cacheEntry) {
      primeObservedCodexThreadRollout(threadId);
      cacheEntry = touchCodexHistoryCache(threadId);
    }
    if (!cacheEntry) {
      return null;
    }
    if (isCodexHistoryCacheStale(threadId, cacheEntry)) {
      codexHistoryCache.delete(threadId);
      stopObservedCodexThreadWatcher(threadId, "cache-stale");
      debugLog(`${logPrefix} [codex-flow] stage=cache-stale thread=${threadId} source=thread-meta`);
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

  function isCodexHistoryCacheStale(
    threadId: string,
    cacheEntry: CodexHistorySnapshot | null | undefined
  ): boolean {
    if (!cacheEntry) {
      return false;
    }

    const threadMeta = store.getThreadMeta(threadId);
    if (!threadMeta || threadMeta.provider !== "codex") {
      return false;
    }

    const cacheUpdatedAtMs = Date.parse(normalizeOptionalString(cacheEntry.threadBase.updatedAt) || "") || 0;
    const metaUpdatedAtMs = Date.parse(normalizeOptionalString(threadMeta.updatedAt) || "") || 0;
    if (metaUpdatedAtMs > cacheUpdatedAtMs) {
      return true;
    }

    const cacheSessionId = normalizeOptionalString(cacheEntry.threadBase.providerSessionId);
    const metaSessionId = normalizeOptionalString(threadMeta.providerSessionId);
    if (cacheSessionId && metaSessionId && cacheSessionId !== metaSessionId) {
      return true;
    }

    return false;
  }

  function buildHistoryWindowResponse(
    snapshot: CodexHistorySnapshot,
    historyRequest: RuntimeHistoryRequest,
    servedFromCache: boolean
  ): unknown {
    const records = [...snapshot.records].sort(compareHistoryRecord);
    const limit = historyRequest.limit;
    let selected: RuntimeHistoryRecord[] = [];
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
      ? startIndex > 0 || (startIndex === 0 && Boolean(snapshot.hasOlder))
      : records.length > 0
        ? historyRequest.mode !== "tail" || snapshot.hasOlder
        : false;
    const hasNewer = selected.length > 0
      ? endIndexExclusive < records.length || (endIndexExclusive >= records.length && Boolean(snapshot.hasNewer))
      : false;
    const thread = rebuildThreadFromHistoryRecords(snapshot.threadBase, selected);
    const oldestRecord = selected.length > 0 ? selected[0] : null;
    const newestRecord = selected.length > 0 ? selected[selected.length - 1] : null;
    const sessionRecord = threadSessionIndex.get(snapshot.threadId);
    const projectionSource = sessionRecord?.sourceKind || "thread_read_fallback";
    const syncEpoch = Number.isFinite(sessionRecord?.syncEpoch) ? Number(sessionRecord?.syncEpoch) : 1;
    updateThreadSessionProjectionCursor(snapshot.threadId, newestRecord ? historyCursorForRecord(snapshot.threadId, newestRecord) : null);

    return {
      thread,
      historyWindow: {
        mode: historyRequest.mode,
        olderCursor: oldestRecord ? historyCursorForRecord(snapshot.threadId, oldestRecord) : null,
        newerCursor: newestRecord ? historyCursorForRecord(snapshot.threadId, newestRecord) : null,
        oldestAnchor: oldestRecord ? historyRecordAnchor(oldestRecord) : null,
        newestAnchor: newestRecord ? historyRecordAnchor(newestRecord) : null,
        hasOlder,
        hasNewer,
        isPartial: selected.length !== records.length || snapshot.hasOlder || snapshot.hasNewer,
        servedFromCache,
        servedFromProjection: true,
        projectionSource,
        syncEpoch,
        pageSize: selected.length,
      },
    };
  }

  function primeCodexHistoryCache(threadId: string, threadObject: RuntimeThreadShape): void {
    const snapshot = createHistorySnapshotFromThread(threadObject);
    writeCodexHistoryCache(threadId, {
      ...snapshot,
      records: snapshot.records.slice(-CODEX_HISTORY_CACHE_MESSAGE_LIMIT),
      hasOlder: snapshot.records.length > CODEX_HISTORY_CACHE_MESSAGE_LIMIT,
      hasNewer: false,
    });
  }

  function createHistorySnapshotFromThread(threadObject: RuntimeThreadShape): CodexHistorySnapshot {
    const threadId = normalizeOptionalString(threadObject.id) || "";
    const threadBase = cloneThreadBase(threadObject);
    const records = flattenThreadHistory(threadObject);
    return {
      threadId,
      threadBase,
      records,
      hasOlder: false,
      hasNewer: false,
    };
  }

  function ensureCodexHistoryCacheEntry(
    threadId: string,
    {
      cwd = null,
      updatedAt = null,
    }: {
      cwd?: string | null;
      updatedAt?: string | null;
    } = {}
  ): CodexHistorySnapshot {
    const existing = touchCodexHistoryCache(threadId);
    if (existing) {
      let didChange = false;
      if (!existing.threadBase.cwd && cwd) {
        existing.threadBase.cwd = cwd;
        didChange = true;
      }
      if (updatedAt) {
        const existingUpdatedAtMs = Date.parse(existing.threadBase.updatedAt || "") || 0;
        const nextUpdatedAtMs = Date.parse(updatedAt) || 0;
        if (nextUpdatedAtMs >= existingUpdatedAtMs) {
          existing.threadBase.updatedAt = updatedAt;
          didChange = true;
        }
      }
      if (didChange) {
        writeCodexHistoryCache(threadId, existing);
      }
      return touchCodexHistoryCache(threadId) || existing;
    }

    const threadMeta = store.getThreadMeta(threadId);
    const sessionRecord = threadSessionIndex.get(threadId);
    const nowIso = new Date().toISOString();
    const snapshot: CodexHistorySnapshot = {
      threadId,
      threadBase: {
        id: threadId,
        provider: "codex",
        providerSessionId: threadMeta?.providerSessionId || sessionRecord?.providerSessionId || threadId,
        metadata: {
          ...(threadMeta?.metadata || {}),
          ...buildProviderMetadata("codex"),
        },
        title: threadMeta?.title || null,
        name: threadMeta?.name || null,
        preview: threadMeta?.preview || null,
        cwd: cwd || threadMeta?.cwd || sessionRecord?.cwd || null,
        createdAt: threadMeta?.createdAt || sessionRecord?.createdAt || nowIso,
        updatedAt: updatedAt || threadMeta?.updatedAt || sessionRecord?.updatedAt || nowIso,
      },
      records: [],
      hasOlder: false,
      hasNewer: false,
    };
    writeCodexHistoryCache(threadId, snapshot);
    return touchCodexHistoryCache(threadId) || snapshot;
  }

  function touchCodexHistoryCache(threadId: unknown): CodexHistorySnapshot | null {
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

  function findCodexCachedThreadIdByTurnId(turnId: unknown): string | null {
    const normalizedTurnId = normalizeOptionalString(turnId);
    if (!normalizedTurnId) {
      return null;
    }

    for (const [threadId, entry] of codexHistoryCache.entries()) {
      if (!Array.isArray(entry?.records)) {
        continue;
      }
      const match = entry.records.some((record) => {
        const recordTurnId = normalizeOptionalString(record?.turnId)
          || normalizeOptionalString(record?.turnMeta?.id);
        return recordTurnId === normalizedTurnId;
      });
      if (match) {
        return threadId;
      }
    }

    return null;
  }

  function findCodexCachedThreadIdByItemId(itemId: unknown): string | null {
    const normalizedItemId = normalizeOptionalString(itemId);
    if (!normalizedItemId) {
      return null;
    }

    for (const [threadId, entry] of codexHistoryCache.entries()) {
      if (!Array.isArray(entry?.records)) {
        continue;
      }
      const match = entry.records.some((record) =>
        matchesHistoryRecordNotificationItemId(record, normalizedItemId)
      );
      if (match) {
        return threadId;
      }
    }

    return null;
  }

  function readCodexHistorySnapshot(threadId: unknown): CodexHistorySnapshot | null {
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

  function readManagedHistorySnapshot(threadId: unknown): CodexHistorySnapshot | null {
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

  function writeCodexHistoryCache(threadId: unknown, entry: CodexHistorySnapshot): void {
    const normalizedThreadId = normalizeOptionalString(threadId);
    if (!normalizedThreadId) {
      return;
    }
    const previousEntry = codexHistoryCache.get(normalizedThreadId) || null;
    const reconciledEntry = reconcileCanonicalTimelineIds(previousEntry, entry);
    codexHistoryCache.delete(normalizedThreadId);
    codexHistoryCache.set(normalizedThreadId, {
      ...reconciledEntry,
      threadId: normalizedThreadId,
      records: [...reconciledEntry.records]
        .sort(compareHistoryRecord)
        .map((record) => syncCanonicalFieldsOnRecord(record))
        .slice(-CODEX_HISTORY_CACHE_MESSAGE_LIMIT),
    });
    while (codexHistoryCache.size > CODEX_HISTORY_CACHE_THREAD_LIMIT) {
      const oldestKey = codexHistoryCache.keys().next().value as string | undefined;
      if (!oldestKey) {
        break;
      }
      codexHistoryCache.delete(oldestKey);
    }
  }

  function reconcileCanonicalTimelineIds(
    previousEntry: CodexHistorySnapshot | null,
    nextEntry: CodexHistorySnapshot
  ): CodexHistorySnapshot {
    if (!previousEntry || !Array.isArray(previousEntry.records) || previousEntry.records.length === 0) {
      nextEntry.records.forEach((record) => {
        syncCanonicalFieldsOnRecord(record);
      });
      return nextEntry;
    }

    const previousByProviderItemId = new Map<string, RuntimeHistoryRecord>();
    const previousByTimelineItemId = new Map<string, RuntimeHistoryRecord>();
    const previousProvisionalByIdentity = new Map<string, RuntimeHistoryRecord[]>();

    previousEntry.records.forEach((record) => {
      syncCanonicalFieldsOnRecord(record);
      const providerItemId = readHistoryRecordProviderItemId(record);
      const timelineItemId = readHistoryRecordTimelineItemId(record);
      if (providerItemId) {
        previousByProviderItemId.set(providerItemId, record);
      }
      if (timelineItemId) {
        previousByTimelineItemId.set(timelineItemId, record);
      }
      if (!providerItemId) {
        const key = provisionalHistoryIdentityKeyForRecord(record);
        previousProvisionalByIdentity.set(key, [
          ...(previousProvisionalByIdentity.get(key) || []),
          record,
        ]);
      }
    });

    const mergedRecords = new Map<string, RuntimeHistoryRecord>();
    const provisionalRecords: RuntimeHistoryRecord[] = [];

    // Start with all previous records
    previousEntry.records.forEach((record) => {
      const providerItemId = readHistoryRecordProviderItemId(record);
      if (providerItemId) {
        mergedRecords.set(providerItemId, record);
      } else {
        provisionalRecords.push(record);
      }
    });

    nextEntry.records.forEach((record) => {
      syncCanonicalFieldsOnRecord(record);
      const providerItemId = readHistoryRecordProviderItemId(record);
      const provisionalIdentityKey = provisionalHistoryIdentityKeyForRecord(record);
      
      const previousRecord = (providerItemId ? previousByProviderItemId.get(providerItemId) : null)
        || previousProvisionalByIdentity.get(provisionalIdentityKey)?.shift()
        || null;

      const previousTimelineItemId = readHistoryRecordTimelineItemId(previousRecord);
      if (previousTimelineItemId) {
        record.itemObject.id = previousTimelineItemId;
        record.itemObject.timelineItemId = previousTimelineItemId;
      }

      if (providerItemId) {
        mergedRecords.set(providerItemId, record);
        // If we matched a provisional record, remove it from the provisional list
        if (previousRecord && !readHistoryRecordProviderItemId(previousRecord)) {
          const pIndex = provisionalRecords.indexOf(previousRecord);
          if (pIndex >= 0) {
            provisionalRecords.splice(pIndex, 1);
          }
        }
      } else {
        // Next record is provisional. If we matched a previous provisional record,
        // update it in place to avoid duplication.
        if (previousRecord && !readHistoryRecordProviderItemId(previousRecord)) {
          const pIndex = provisionalRecords.indexOf(previousRecord);
          if (pIndex >= 0) {
            provisionalRecords[pIndex] = record;
          } else {
            provisionalRecords.push(record);
          }
        } else {
          provisionalRecords.push(record);
        }
      }
      syncCanonicalFieldsOnRecord(record);
    });

    return {
      ...nextEntry,
      records: [...mergedRecords.values(), ...provisionalRecords],
    };
  }

  function seedCodexHistoryCacheWithUserInput(
    threadId: unknown,
    turnId: unknown,
    params: UnknownRecord
  ): void {
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
    const entry: CodexHistorySnapshot = touchCodexHistoryCache(normalizedThreadId) || {
      threadId: normalizedThreadId,
      threadBase: {
        id: normalizedThreadId,
        provider: "codex",
        providerSessionId: normalizedThreadId,
        metadata: buildProviderMetadata("codex"),
        title: null,
        name: null,
        preview: null,
        cwd: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      records: [],
      hasOlder: false,
      hasNewer: false,
    };
    entry.threadBase = {
      ...entry.threadBase,
      updatedAt: nowIso,
      preview: inputItems
        .map((item) => readTextInput(item))
        .filter(Boolean)
        .join("\n")
        .trim() || entry.threadBase.preview || null,
    };
    entry.records.push({
      turnId: normalizedTurnId,
      createdAt: nowIso,
      turnMeta: {
        id: normalizedTurnId,
        createdAt: nowIso,
        status: "running",
      },
      itemObject: {
        id: `local:${normalizedTurnId}:user`,
        type: "user_message",
        role: "user",
        content: inputItems.map((item) => ({ ...asObject(item) })),
        text: inputItems
          .map((item) => readTextInput(item))
          .filter(Boolean)
          .join("\n")
          .trim() || null,
        createdAt: nowIso,
      },
      ordinal: nextHistoryOrdinal(entry.records),
      createdAtMs: Date.parse(nowIso) || Date.now(),
      turnIndex: 0,
      itemIndex: 0,
    });
    writeCodexHistoryCache(normalizedThreadId, entry);
  }

  function handleCodexHistoryCacheEvent(rawMessage: string): CodexHistoryChangedPayload | null {
    let parsed: UnknownRecord | null = null;
    try {
      parsed = JSON.parse(rawMessage);
    } catch {
      return null;
    }

    const rawMethod = normalizeOptionalString(parsed?.method);
    const params = asObject(parsed?.params);
    if (!rawMethod) {
      return null;
    }
    const method = normalizeCodexHistoryEventMethod(rawMethod, params);

    if (method === "thread/started" && params.thread && typeof params.thread === "object") {
      const decoratedThread = decorateConversationThread(asObject(params.thread) as RuntimeThreadShape);
      const decoratedThreadId = normalizeOptionalString(decoratedThread.id);
      if (decoratedThreadId) {
        primeCodexHistoryCache(decoratedThreadId, decoratedThread);
      }
      return null;
    }

    const threadId = extractCodexNotificationThreadId(params);
    if (!threadId) {
      if (shouldInvalidateCodexHistoryCacheForMethod(method)) {
        debugLog(`${logPrefix} [codex-flow] stage=cache-invalidate scope=global reason=unscoped-event method=${method}`);
        codexHistoryCache.clear();
        stopAllObservedCodexThreadWatchers("cache-invalidated");
        return {
          provider: "codex",
          reason: "cache-invalidated",
          scope: "global",
          sourceMethod: method,
          rawMethod,
        };
      }
      return null;
    }
    const entry = touchCodexHistoryCache(threadId);
    if (!entry) {
      return null;
    }

    if (method === "turn/started") {
      const turnId = extractCodexNotificationTurnId(params);
      if (turnId) {
        ensureHistoryTurn(entry, turnId, {
          id: turnId,
          createdAt: new Date().toISOString(),
          status: "running",
        });
        entry.threadBase.updatedAt = new Date().toISOString();
        writeCodexHistoryCache(threadId, entry);
        const sessionRecord = threadSessionIndex.get(threadId);
        if (sessionRecord?.sourceKind === "rollout_observer") {
          upsertThreadSessionRecord({
            threadId,
            provider: "codex",
            rolloutPath: sessionRecord.rolloutPath,
            cwd: entry.threadBase.cwd,
            ownerState: "idle",
            activeTurnId: turnId,
            sourceKind: "rollout_observer",
          });
        } else {
          updateThreadSessionOwnerState(threadId, "running", {
            activeTurnId: turnId,
          });
        }
      }
      return null;
    }

    if (method === "turn/completed") {
      const turnId = extractCodexNotificationTurnId(params);
      if (turnId) {
        updateHistoryTurnStatus(entry, turnId, normalizeOptionalString(params.status) || "completed");
        entry.threadBase.updatedAt = new Date().toISOString();
        writeCodexHistoryCache(threadId, entry);
        const sessionRecord = threadSessionIndex.get(threadId);
        if (sessionRecord?.sourceKind === "rollout_observer") {
          upsertThreadSessionRecord({
            threadId,
            provider: "codex",
            rolloutPath: sessionRecord.rolloutPath,
            cwd: entry.threadBase.cwd,
            ownerState: "idle",
            activeTurnId: null,
            sourceKind: "rollout_observer",
          });
        } else {
          updateThreadSessionOwnerState(threadId, "idle", {
            activeTurnId: null,
          });
        }
      }
      return null;
    }

    if (method === "item/started" || method === "item/completed") {
      const itemObject = extractCodexIncomingItemObject(params);
      const itemType = inferCodexHistoryItemType(method, params, itemObject);
      if (itemType) {
        const record = ensureHistoryRecord(entry, {
          turnId: extractCodexNotificationTurnId(params) || itemObject.turnId || itemObject.turn_id,
          itemId: extractCodexNotificationItemId(params) || itemObject.id,
          type: normalizeOptionalString(itemObject.type) || itemType,
          role: inferCodexHistoryItemRole(method, params, itemObject, itemType),
          defaults: {
            text: extractCodexTextDelta(params) || "",
          },
        });
        applyCodexItemPayloadToHistoryRecord(record, itemObject, {
          completed: method === "item/completed",
        });
        const nextText = extractCodexTextDelta(params);
        if (nextText) {
          record.itemObject.text = nextText;
        }
        entry.threadBase.updatedAt = new Date().toISOString();
        writeCodexHistoryCache(threadId, entry);
      }
      return null;
    }

    if (method === "item/agentMessage/delta") {
      upsertHistoryCacheTextItem(entry, {
        turnId: extractCodexNotificationTurnId(params),
        itemId: extractCodexNotificationItemId(params),
        type: "agent_message",
        role: "assistant",
        delta: extractCodexTextDelta(params),
      });
      writeCodexHistoryCache(threadId, entry);
      return buildCodexHistoryChangedPayload({
        threadId,
        sourceMethod: method,
        rawMethod,
        params,
      });
    }

    if (method === "item/reasoning/textDelta" || method === "item/reasoning/summaryTextDelta") {
      upsertHistoryCacheTextItem(entry, {
        turnId: extractCodexNotificationTurnId(params),
        itemId: extractCodexNotificationItemId(params),
        type: "reasoning",
        delta: extractCodexTextDelta(params),
      });
      writeCodexHistoryCache(threadId, entry);
      return buildCodexHistoryChangedPayload({
        threadId,
        sourceMethod: method,
        rawMethod,
        params,
      });
    }

    if (method === "item/fileChange/outputDelta") {
      upsertHistoryCacheTextItem(entry, {
        turnId: extractCodexNotificationTurnId(params),
        itemId: extractCodexNotificationItemId(params),
        type: "file_change",
        delta: extractCodexTextDelta(params),
        changes: Array.isArray(params.changes)
          ? (params.changes as unknown[])
          : (Array.isArray(asObject(params.item).changes)
            ? (asObject(params.item).changes as unknown[])
            : []),
      });
      writeCodexHistoryCache(threadId, entry);
      return buildCodexHistoryChangedPayload({
        threadId,
        sourceMethod: method,
        rawMethod,
        params,
      });
    }

    if (method === "item/toolCall/outputDelta" || method === "item/toolCall/completed") {
      upsertHistoryCacheTextItem(entry, {
        turnId: extractCodexNotificationTurnId(params),
        itemId: extractCodexNotificationItemId(params),
        type: "tool_call",
        delta: extractCodexTextDelta(params),
        metadata: normalizeOptionalString(firstNonEmptyString([
          params.toolName,
          params.tool_name,
          asObject(params.item).toolName,
          asObject(params.item).tool_name,
        ])) ? {
          toolName: firstNonEmptyString([
            params.toolName,
            params.tool_name,
            asObject(params.item).toolName,
            asObject(params.item).tool_name,
          ]),
        } : null,
        changes: Array.isArray(params.changes)
          ? (params.changes as unknown[])
          : (Array.isArray(asObject(params.item).changes)
            ? (asObject(params.item).changes as unknown[])
            : []),
      });
      if (method === "item/toolCall/completed") {
        const record = readCodexHistoryRecordForNotification(threadId, extractCodexNotificationItemId(params));
        if (record) {
          record.itemObject.status = "completed";
          syncCanonicalFieldsOnRecord(record);
        }
      }
      writeCodexHistoryCache(threadId, entry);
      return buildCodexHistoryChangedPayload({
        threadId,
        sourceMethod: method,
        rawMethod,
        params,
      });
    }

    if (method === "item/commandExecution/outputDelta") {
      const turnId = extractCodexNotificationTurnId(params);
      const itemId = extractCodexNotificationItemId(params);
      const command = firstNonEmptyString([
        params.command,
        params.cmd,
        asObject(params.item).command,
        asObject(params.item).cmd,
      ]);
      const cwd = firstNonEmptyString([
        params.cwd,
        params.workingDirectory,
        params.working_directory,
        asObject(params.item).cwd,
        asObject(params.item).workingDirectory,
        asObject(params.item).working_directory,
      ]);
      const status = firstNonEmptyString([
        params.status,
        asObject(params.item).status,
      ]);
      const item = ensureHistoryRecord(entry, {
        turnId,
        itemId,
        type: "command_execution",
        defaults: {
          command,
          cwd,
          status: status || "running",
          exitCode: typeof params.exitCode === "number" ? params.exitCode : null,
          durationMs: typeof params.durationMs === "number" ? params.durationMs : null,
          text: extractCodexTextDelta(params) || "",
        },
      });
      item.itemObject.command = command || item.itemObject.command || null;
      item.itemObject.cwd = cwd || item.itemObject.cwd || null;
      item.itemObject.status = status || item.itemObject.status || "running";
      if (typeof params.exitCode === "number") {
        item.itemObject.exitCode = params.exitCode;
      }
      if (typeof params.durationMs === "number") {
        item.itemObject.durationMs = params.durationMs;
      }
      item.itemObject.text = extractCodexTextDelta(params) || item.itemObject.text || "";
      writeCodexHistoryCache(threadId, entry);
      return buildCodexHistoryChangedPayload({
        threadId,
        sourceMethod: method,
        rawMethod,
        params: {
          ...params,
          turnId,
          itemId: readHistoryRecordTimelineItemId(item),
        },
      });
    }

    if (method === "turn/plan/updated" || method === "item/plan/delta") {
      const turnId = extractCodexNotificationTurnId(params);
      const itemId = extractCodexNotificationItemId(params) || `local:${turnId}:plan`;
      const item = ensureHistoryRecord(entry, {
        turnId,
        itemId,
        type: "plan",
        defaults: {
          text: extractCodexTextDelta(params) || normalizeOptionalString(params.explanation) || "Planning...",
          explanation: firstNonEmptyString([params.explanation, asObject(params.item).explanation]),
          summary: firstNonEmptyString([params.summary, asObject(params.item).summary]),
          plan: Array.isArray(params.plan)
            ? params.plan
            : (Array.isArray(asObject(params.item).plan) ? asObject(params.item).plan : []),
        },
      });
      item.itemObject.text = extractCodexTextDelta(params) || item.itemObject.text || "";
      item.itemObject.explanation = firstNonEmptyString([params.explanation, asObject(params.item).explanation])
        || item.itemObject.explanation
        || null;
      item.itemObject.summary = firstNonEmptyString([params.summary, asObject(params.item).summary])
        || item.itemObject.summary
        || null;
      if (Array.isArray(params.plan)) {
        item.itemObject.plan = params.plan;
      } else if (Array.isArray(asObject(params.item).plan)) {
        item.itemObject.plan = asObject(params.item).plan;
      }
      writeCodexHistoryCache(threadId, entry);
      return buildCodexHistoryChangedPayload({
        threadId,
        sourceMethod: method,
        rawMethod,
        params: {
          ...params,
          turnId,
          itemId,
        },
      });
    }

    if (shouldInvalidateCodexHistoryCacheForMethod(method)) {
      codexHistoryCache.delete(threadId);
      stopObservedCodexThreadWatcher(threadId, "cache-invalidated");
      return {
        provider: "codex",
        reason: "cache-invalidated",
        scope: "thread",
        threadId,
        sourceMethod: method,
        rawMethod,
        turnId: extractCodexNotificationTurnId(params),
        itemId: extractCodexNotificationItemId(params),
      };
    }

    return null;
  }

  function buildCodexHistoryChangedPayload({
    threadId,
    sourceMethod,
    rawMethod,
    params,
  }: {
    threadId: string;
    sourceMethod: string;
    rawMethod: string;
    params: UnknownRecord;
  }): CodexHistoryChangedPayload {
    const snapshot = readCodexHistorySnapshot(threadId);
    const itemId = extractCodexNotificationItemId(params);
    const metadata = itemId ? historyMetadataForItem(snapshot, itemId) : null;
    return {
      provider: "codex",
      reason: "cache-mutated",
      scope: "thread",
      threadId,
      turnId: metadata?.turnId || extractCodexNotificationTurnId(params) || null,
      itemId: metadata?.itemId || itemId || null,
      previousItemId: metadata?.previousItemId || null,
      cursor: metadata?.currentCursor || null,
      previousCursor: metadata?.previousCursor || null,
      sourceMethod,
      rawMethod,
    };
  }

  function buildHistoryChangedFromSnapshotDiff(
    previousSnapshot: CodexHistorySnapshot | null,
    nextSnapshot: CodexHistorySnapshot | null
  ): CodexHistoryChangedPayload | null {
    const normalizedThreadId = normalizeOptionalString(nextSnapshot?.threadId);
    if (!normalizedThreadId) {
      return null;
    }

    const previousRecords = Array.isArray(previousSnapshot?.records)
      ? previousSnapshot.records.slice().sort(compareHistoryRecord)
      : [];
    const nextRecords = Array.isArray(nextSnapshot?.records)
      ? nextSnapshot.records.slice().sort(compareHistoryRecord)
      : [];

    if (previousRecords.length === 0 || nextRecords.length === 0) {
      return null;
    }

    const comparisonWindowSize = Math.max(previousRecords.length, CODEX_HISTORY_CACHE_MESSAGE_LIMIT);
    const previousTailRecords = previousRecords.slice(-comparisonWindowSize);
    const nextTailRecords = nextRecords.slice(-comparisonWindowSize);

    const previousByItemId = new Map<string, RuntimeHistoryRecord>();
    previousTailRecords.forEach((record) => {
      const itemId = normalizeOptionalString(record?.itemObject?.id);
      if (itemId) {
        previousByItemId.set(itemId, record);
      }
    });

    let latestChangedRecord: RuntimeHistoryRecord | null = null;
    for (const record of nextTailRecords) {
      const itemId = normalizeOptionalString(record?.itemObject?.id);
      if (!itemId) {
        continue;
      }
      const previousRecord = previousByItemId.get(itemId);
      if (!previousRecord || historyRecordContentSignature(previousRecord) !== historyRecordContentSignature(record)) {
        latestChangedRecord = record;
      }
    }

    if (!latestChangedRecord) {
      return null;
    }

    const itemId = normalizeOptionalString(latestChangedRecord?.itemObject?.id) || null;
    const metadata = itemId ? historyMetadataForItem(nextSnapshot, itemId) : null;
    return {
      provider: "codex",
      reason: "cache-mutated",
      scope: "thread",
      threadId: normalizedThreadId,
      turnId: metadata?.turnId
        || normalizeOptionalString(latestChangedRecord.turnId)
        || normalizeOptionalString(latestChangedRecord?.turnMeta?.id)
        || null,
      itemId: metadata?.itemId || itemId,
      previousItemId: metadata?.previousItemId || null,
      cursor: metadata?.currentCursor || null,
      previousCursor: metadata?.previousCursor || null,
      sourceMethod: "thread/read",
      rawMethod: "thread/read",
    };
  }

  function emitCodexHistoryChangedNotification(change: CodexHistoryChangedPayload | null): void {
    if (!change || typeof change !== "object") {
      return;
    }

    const sessionRecord = change.threadId ? threadSessionIndex.get(change.threadId) : null;
    const decoratedChange = {
      ...change,
      ...(sessionRecord?.sourceKind ? { sourceKind: sessionRecord.sourceKind } : {}),
      ...(sessionRecord?.syncEpoch ? { syncEpoch: sessionRecord.syncEpoch } : {}),
    };
    updateThreadSessionProjectionCursor(change.threadId, change.cursor);

    sendApplicationMessage(JSON.stringify({
      jsonrpc: "2.0",
      method: "thread/history/changed",
      params: decoratedChange,
    }));
    logCodexRealtimeEvent("phone-out", {
      method: "thread/history/changed",
      params: decoratedChange,
    });
  }

  function shouldDecorateNotificationWithPreviousItemId(method: string | null): boolean {
    return method === "item/agentMessage/delta"
      || method === "item/reasoning/textDelta"
      || method === "item/reasoning/summaryTextDelta"
      || method === "item/toolCall/outputDelta"
      || method === "item/toolCall/completed"
      || method === "item/commandExecution/outputDelta"
      || method === "turn/plan/updated"
      || method === "item/completed"
      || method === "timeline/itemStarted"
      || method === "timeline/itemTextUpdated"
      || method === "timeline/itemCompleted";
  }

  function normalizeCodexHistoryEventMethod(rawMethod: unknown, params: UnknownRecord): string | null {
    const normalizedMethod = normalizeOptionalString(rawMethod);
    if (!normalizedMethod) {
      return null;
    }

    if (normalizedMethod === "coderover/event" || normalizedMethod === "codex/event") {
      const nestedEventType = extractCodexLegacyEventType(params);
      if (nestedEventType) {
        return mapCodexLegacyEventTypeToMethod(nestedEventType);
      }
      return "coderover/event";
    }

    if (normalizedMethod.startsWith("coderover/event/") || normalizedMethod.startsWith("codex/event/")) {
      const prefix = normalizedMethod.startsWith("codex/event/") ? "codex/event/" : "coderover/event/";
      const suffix = normalizedMethod.slice(prefix.length);
      return mapCodexLegacyEventTypeToMethod(suffix);
    }

    const methodToken = normalizeCodexMethodToken(normalizedMethod);
    if (!methodToken) {
      return normalizedMethod;
    }

    if (methodToken === "itemplandelta" || methodToken === "turnplanupdated") {
      return methodToken === "itemplandelta" ? "item/plan/delta" : "turn/plan/updated";
    }
    if (methodToken === "itemcompleted") {
      return "item/completed";
    }
    if (methodToken === "itemstarted") {
      return "item/started";
    }
    if (methodToken === "itemagentmessagedelta") {
      return "item/agentMessage/delta";
    }
    if (methodToken === "itemreasoningtextdelta" || methodToken === "itemreasoningsummarytextdelta") {
      return methodToken === "itemreasoningsummarytextdelta"
        ? "item/reasoning/summaryTextDelta"
        : "item/reasoning/textDelta";
    }
    if (methodToken.includes("toolcall")) {
      if (methodToken.includes("delta") || methodToken.includes("partadded")) {
        return "item/toolCall/outputDelta";
      }
      if (methodToken.includes("completed") || methodToken.includes("finished") || methodToken.includes("done")) {
        return "item/toolCall/completed";
      }
      if (methodToken.includes("started")) {
        return "item/started";
      }
    }
    if (methodToken.includes("filechange")) {
      if (methodToken.includes("delta") || methodToken.includes("partadded")) {
        return "item/fileChange/outputDelta";
      }
      if (methodToken.includes("completed") || methodToken.includes("finished") || methodToken.includes("done")) {
        return "item/completed";
      }
      if (methodToken.includes("started")) {
        return "item/started";
      }
    }
    if (methodToken.includes("commandexecution")) {
      if (methodToken.includes("terminalinteraction")) {
        return "item/commandExecution/terminalInteraction";
      }
      if (methodToken.includes("delta") || methodToken.includes("output")) {
        return "item/commandExecution/outputDelta";
      }
      if (methodToken.includes("completed") || methodToken.includes("finished") || methodToken.includes("done")) {
        return "item/completed";
      }
      if (methodToken.includes("started")) {
        return "item/started";
      }
    }
    if (methodToken.includes("turndiff") || methodToken.includes("itemdiff")) {
      return "turn/diff/updated";
    }

    return normalizedMethod;
  }

  function extractCodexLegacyEventType(params: UnknownRecord): string | null {
    const eventObject = extractCodexEnvelopeEvent(params);
    return firstNonEmptyString([
      eventObject.type,
      eventObject.event_type,
      asObject(params.event).type,
      asObject(params.event).event_type,
      params.type,
      params.event_type,
    ]);
  }

  function mapCodexLegacyEventTypeToMethod(eventType: unknown): string {
    const normalizedEventType = normalizeCodexMethodToken(eventType);
    if (!normalizedEventType) {
      return "coderover/event";
    }

    if (normalizedEventType === "agentmessagecontentdelta" || normalizedEventType === "agentmessagedelta") {
      return "item/agentMessage/delta";
    }
    if (normalizedEventType === "itemcompleted" || normalizedEventType === "agentmessage") {
      return "item/completed";
    }
    if (normalizedEventType === "usermessage") {
      return "item/completed";
    }
    if (normalizedEventType === "itemstarted") {
      return "item/started";
    }
    if (normalizedEventType === "execcommandoutputdelta") {
      return "item/commandExecution/outputDelta";
    }
    if (normalizedEventType === "execcommandbegin" || normalizedEventType === "execcommandend") {
      return "item/completed";
    }
    if (normalizedEventType === "turndiffupdated" || normalizedEventType === "turndiff") {
      return "turn/diff/updated";
    }
    if (normalizedEventType === "patchapplybegin" || normalizedEventType === "patchapplyend") {
      return "item/completed";
    }
    return `coderover/event/${eventType}`;
  }

  function inferCodexHistoryItemType(
    method: string | null,
    params: UnknownRecord,
    itemObject: UnknownRecord
  ): string | null {
    const explicitType = normalizeOptionalString(itemObject.type);
    if (explicitType) {
      return explicitType;
    }

    const legacyEventType = normalizeCodexMethodToken(extractCodexLegacyEventType(params));
    if (legacyEventType === "usermessage") {
      return "user_message";
    }
    if (legacyEventType === "agentmessage" || legacyEventType === "agentmessagecontentdelta" || legacyEventType === "agentmessagedelta") {
      return "agent_message";
    }
    if (legacyEventType === "execcommandoutputdelta" || legacyEventType === "execcommandbegin" || legacyEventType === "execcommandend") {
      return "command_execution";
    }
    if (legacyEventType === "patchapplybegin" || legacyEventType === "patchapplyend" || legacyEventType === "turndiffupdated" || legacyEventType === "turndiff") {
      return "file_change";
    }

    if (method === "item/agentMessage/delta") {
      return "agent_message";
    }
    if (method === "item/reasoning/textDelta" || method === "item/reasoning/summaryTextDelta") {
      return "reasoning";
    }
    if (method === "item/fileChange/outputDelta" || method === "turn/diff/updated") {
      return "file_change";
    }
    if (method === "item/commandExecution/outputDelta") {
      return "command_execution";
    }
    if (method === "turn/plan/updated" || method === "item/plan/delta") {
      return "plan";
    }
    if (method === "item/toolCall/outputDelta" || method === "item/toolCall/completed") {
      return "tool_call";
    }
    return null;
  }

  function inferCodexHistoryItemRole(
    method: string | null,
    params: UnknownRecord,
    itemObject: UnknownRecord,
    itemType: string | null
  ): string | null {
    const explicitRole = normalizeOptionalString(itemObject.role);
    if (explicitRole) {
      return explicitRole;
    }
    const normalizedType = normalizeCodexItemType(itemType);
    if (normalizedType === "usermessage") {
      return "user";
    }
    if (normalizedType === "exitedreviewmode") {
      return "assistant";
    }
    if (normalizedType === "agentmessage" || method === "item/agentMessage/delta") {
      return "assistant";
    }
    if (normalizeCodexMethodToken(extractCodexLegacyEventType(params)) === "agentmessage") {
      return "assistant";
    }
    return null;
  }

  function shouldInvalidateCodexHistoryCacheForMethod(method: unknown): boolean {
    const normalizedMethod = normalizeOptionalString(method);
    if (!normalizedMethod) {
      return false;
    }
    if (normalizedMethod === "thread/tokenUsage/updated" || normalizedMethod === "account/rateLimits/updated") {
      return false;
    }
    return normalizedMethod.startsWith("item/")
      || normalizedMethod.startsWith("turn/")
      || normalizedMethod.startsWith("coderover/event");
  }

  function normalizeCodexMethodToken(value: unknown): string | null {
    return normalizeOptionalString(value)
      ?.toLowerCase()
      .replace(/[\/_\-\s]/g, "")
      || null;
  }

  function extractCodexEnvelopeEvent(params: UnknownRecord): UnknownRecord {
    if (!params || typeof params !== "object") {
      return {};
    }
    const messageEnvelope = asObject(params.msg);
    if (Object.keys(messageEnvelope).length > 0) {
      return messageEnvelope;
    }
    return asObject(params.event);
  }

  function extractCodexNotificationThreadId(params: UnknownRecord): string | null {
    const explicitThreadId = extractExplicitCodexNotificationThreadId(params);
    if (explicitThreadId) {
      return explicitThreadId;
    }

    const turnId = extractCodexNotificationTurnId(params);
    if (turnId) {
      const threadIdFromTurn = findCodexCachedThreadIdByTurnId(turnId) || findThreadIdByTurnId(turnId);
      if (threadIdFromTurn) {
        return threadIdFromTurn;
      }
    }

    return findCodexCachedThreadIdByItemId(extractCodexNotificationItemId(params));
  }

  function extractExplicitCodexNotificationThreadId(params: UnknownRecord): string | null {
    const payload = asObject(params);
    const envelopeEvent = extractCodexEnvelopeEvent(payload);
    const nestedEvent = asObject(payload.event);
    return firstNonEmptyString([
      payload.threadId,
      payload.thread_id,
      payload.conversationId,
      payload.conversation_id,
      asObject(payload.thread).id,
      asObject(payload.turn).threadId,
      asObject(payload.turn).thread_id,
      asObject(payload.item).threadId,
      asObject(payload.item).thread_id,
      envelopeEvent.threadId,
      envelopeEvent.thread_id,
      envelopeEvent.conversationId,
      envelopeEvent.conversation_id,
      asObject(envelopeEvent.thread).id,
      asObject(envelopeEvent.turn).threadId,
      asObject(envelopeEvent.turn).thread_id,
      asObject(envelopeEvent.item).threadId,
      asObject(envelopeEvent.item).thread_id,
      nestedEvent.threadId,
      nestedEvent.thread_id,
      nestedEvent.conversationId,
      nestedEvent.conversation_id,
      asObject(nestedEvent.thread).id,
      asObject(nestedEvent.turn).threadId,
      asObject(nestedEvent.turn).thread_id,
      asObject(nestedEvent.item).threadId,
      asObject(nestedEvent.item).thread_id,
    ]);
  }

  function extractCodexNotificationTurnId(params: UnknownRecord): string | null {
    const payload = asObject(params);
    const envelopeEvent = extractCodexEnvelopeEvent(payload);
    const nestedEvent = asObject(payload.event);
    return firstNonEmptyString([
      asObject(payload.turn).id,
      payload.turnId,
      payload.turn_id,
      asObject(payload.item).turnId,
      asObject(payload.item).turn_id,
      envelopeEvent.turnId,
      envelopeEvent.turn_id,
      asObject(envelopeEvent.turn).id,
      asObject(envelopeEvent.item).turnId,
      asObject(envelopeEvent.item).turn_id,
      nestedEvent.turnId,
      nestedEvent.turn_id,
      asObject(nestedEvent.turn).id,
      asObject(nestedEvent.item).turnId,
      asObject(nestedEvent.item).turn_id,
    ]);
  }

  function extractCodexNotificationItemId(params: UnknownRecord): string | null {
    const payload = asObject(params);
    const envelopeEvent = extractCodexEnvelopeEvent(payload);
    const nestedEvent = asObject(payload.event);
    return firstNonEmptyString([
      payload.itemId,
      payload.item_id,
      payload.id,
      asObject(payload.item).id,
      payload.callId,
      payload.call_id,
      envelopeEvent.itemId,
      envelopeEvent.item_id,
      envelopeEvent.id,
      asObject(envelopeEvent.item).id,
      nestedEvent.itemId,
      nestedEvent.item_id,
      nestedEvent.id,
      asObject(nestedEvent.item).id,
    ]);
  }

  function extractCodexIncomingItemObject(params: UnknownRecord): UnknownRecord {
    const payload = asObject(params);
    const envelopeEvent = extractCodexEnvelopeEvent(payload);
    const nestedEvent = asObject(payload.event);
    const candidates = [
      asObject(payload.item),
      asObject(envelopeEvent.item),
      asObject(nestedEvent.item),
    ];
    return candidates.find((candidate) => Object.keys(candidate).length > 0) || {};
  }

  function extractCodexTextDelta(params: UnknownRecord): string | null {
    const payload = asObject(params);
    const envelopeEvent = extractCodexEnvelopeEvent(payload);
    const nestedEvent = asObject(payload.event);
    return firstNonEmptyString([
      payload.delta,
      payload.text,
      payload.message,
      asObject(payload.item).delta,
      asObject(payload.item).text,
      asObject(payload.item).message,
      envelopeEvent.delta,
      envelopeEvent.text,
      envelopeEvent.message,
      asObject(envelopeEvent.item).delta,
      asObject(envelopeEvent.item).text,
      asObject(envelopeEvent.item).message,
      nestedEvent.delta,
      nestedEvent.text,
      nestedEvent.message,
      asObject(nestedEvent.item).delta,
      asObject(nestedEvent.item).text,
      asObject(nestedEvent.item).message,
    ]);
  }

  function applyCodexItemPayloadToHistoryRecord(
    record: RuntimeHistoryRecord,
    itemObject: UnknownRecord,
    { completed = false }: { completed?: boolean } = {}
  ): void {
    const nextType = normalizeOptionalString(itemObject.type);
    if (nextType) {
      record.itemObject.type = nextType;
    }
    const nextRole = normalizeOptionalString(itemObject.role);
    if (nextRole) {
      record.itemObject.role = nextRole;
    }
    const nextProviderItemId = normalizeOptionalString(itemObject.providerItemId || itemObject.provider_item_id)
      || normalizeOptionalString(itemObject.id);
    if (nextProviderItemId) {
      record.itemObject.providerItemId = nextProviderItemId;
    }
    if (Array.isArray(itemObject.content)) {
      record.itemObject.content = JSON.parse(JSON.stringify(itemObject.content));
    }
    const nextText = normalizeOptionalString(itemObject.text || itemObject.message);
    if (nextText) {
      record.itemObject.text = nextText;
    }
    if (Array.isArray(itemObject.changes)) {
      record.itemObject.changes = itemObject.changes;
    }
    if (Array.isArray(itemObject.questions)) {
      record.itemObject.questions = itemObject.questions;
    }
    if (Array.isArray(itemObject.plan)) {
      record.itemObject.plan = itemObject.plan;
    }
    if (Array.isArray(itemObject.receiverThreadIds)) {
      record.itemObject.receiverThreadIds = itemObject.receiverThreadIds;
    } else if (Array.isArray(itemObject.receiver_thread_ids)) {
      record.itemObject.receiver_thread_ids = itemObject.receiver_thread_ids;
    }
    if (Array.isArray(itemObject.receiverAgents)) {
      record.itemObject.receiverAgents = itemObject.receiverAgents;
    } else if (Array.isArray(itemObject.receiver_agents)) {
      record.itemObject.receiver_agents = itemObject.receiver_agents;
    }
    if (itemObject.agentStates && typeof itemObject.agentStates === "object") {
      record.itemObject.agentStates = itemObject.agentStates;
    } else if (itemObject.agent_states && typeof itemObject.agent_states === "object") {
      record.itemObject.agent_states = itemObject.agent_states;
    }
    const explanation = normalizeOptionalString(itemObject.explanation);
    if (explanation) {
      record.itemObject.explanation = explanation;
    }
    const review = normalizeOptionalString(itemObject.review);
    if (review) {
      record.itemObject.review = review;
    }
    const summary = normalizeOptionalString(itemObject.summary);
    if (summary) {
      record.itemObject.summary = summary;
    }
    const tool = normalizeOptionalString(itemObject.tool);
    if (tool) {
      record.itemObject.tool = tool;
    }
    const name = normalizeOptionalString(itemObject.name);
    if (name) {
      record.itemObject.name = name;
    }
    const prompt = normalizeOptionalString(itemObject.prompt);
    if (prompt) {
      record.itemObject.prompt = prompt;
    }
    const model = normalizeOptionalString(itemObject.model);
    if (model) {
      record.itemObject.model = model;
    }
    const status = normalizeOptionalString(itemObject.status)
      || (completed ? "completed" : null);
    if (status) {
      record.itemObject.status = status;
    }
    syncCanonicalFieldsOnRecord(record);
  }

  function extractNotificationThreadId(params: UnknownRecord): string | null {
    return extractCodexNotificationThreadId(params);
  }

  function extractNotificationItemId(params: UnknownRecord): string | null {
    const timelineItemId = normalizeOptionalString(
      params.timelineItemId
      || params.timeline_item_id
    );
    if (timelineItemId) {
      return timelineItemId;
    }
    return extractCodexNotificationItemId(params);
  }

  function previousCodexHistoryItemId(threadId: unknown, itemId: unknown): string | null {
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
      .filter((itemId): itemId is string => Boolean(itemId));
    if (orderedItemIds.length === 0) {
      return null;
    }

    const existingIndex = orderedItemIds.lastIndexOf(normalizedItemId);
    if (existingIndex > 0) {
      return orderedItemIds[existingIndex - 1] ?? null;
    }
    if (existingIndex === -1) {
      return orderedItemIds[orderedItemIds.length - 1] || null;
    }
    return null;
  }

  function decorateNotificationWithHistoryMetadata(
    method: string | null,
    params: UnknownRecord,
    readSnapshot: SnapshotReader
  ): UnknownRecord {
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
    if (metadata.threadId && nextParams.threadId == null && nextParams.thread_id == null) {
      nextParams.threadId = metadata.threadId;
      didChange = true;
    }
    if (metadata.turnId && nextParams.turnId == null && nextParams.turn_id == null) {
      nextParams.turnId = metadata.turnId;
      didChange = true;
    }
    if (metadata.itemId && nextParams.itemId == null && nextParams.item_id == null) {
      nextParams.itemId = metadata.itemId;
      didChange = true;
    }
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
    if (didChange) {
      debugLog(
        `${logPrefix} [codex-flow] stage=decorate method=${method}`
        + ` thread=${metadata.threadId || "none"}`
        + ` turn=${metadata.turnId || "none"}`
        + ` item=${metadata.itemId || "none"}`
        + ` previousItem=${metadata.previousItemId || "none"}`
        + ` cursor=${metadata.currentCursor || "none"}`
        + ` previousCursor=${metadata.previousCursor || "none"}`
      );
    }
    return didChange ? nextParams : params;
  }

  function decorateNotificationWithSessionMetadata(params: UnknownRecord): UnknownRecord {
    const threadId = extractNotificationThreadId(params);
    if (!threadId) {
      return params;
    }

    const sessionRecord = threadSessionIndex.get(threadId);
    if (!sessionRecord) {
      return params;
    }

    let didChange = false;
    const nextParams = { ...params };
    if (nextParams.sourceKind == null) {
      nextParams.sourceKind = sessionRecord.sourceKind;
      didChange = true;
    }
    if (nextParams.syncEpoch == null) {
      nextParams.syncEpoch = sessionRecord.syncEpoch;
      didChange = true;
    }
    if (nextParams.rolloutPath == null && sessionRecord.rolloutPath) {
      nextParams.rolloutPath = sessionRecord.rolloutPath;
      didChange = true;
    }
    return didChange ? nextParams : params;
  }

  function logCodexRealtimeEvent(stage: string, messageLike: unknown): void {
    const summary = summarizeCodexRealtimeMessage(messageLike);
    if (!summary) {
      return;
    }
    debugLog(`${logPrefix} [codex-flow] stage=${stage} ${summary}`);
  }

  function summarizeCodexRealtimeMessage(messageLike: unknown): string | null {
    let parsed: UnknownRecord | null = null;
    if (typeof messageLike === "string") {
      try {
        parsed = JSON.parse(messageLike);
      } catch {
        return `non-json bytes=${messageLike.length}`;
      }
    } else if (messageLike && typeof messageLike === "object") {
      parsed = asObject(messageLike);
    } else {
      return null;
    }

    const method = normalizeOptionalString(parsed?.method);
    const id = parsed?.id;
    const params = asObject(parsed?.params);
    const parts: string[] = [];
    if (method) {
      parts.push(`method=${method}`);
    } else if (id != null) {
      parts.push(`response=${String(id)}`);
    } else {
      parts.push("message=unknown");
    }
    if (params && Object.keys(params).length > 0) {
      const threadId = extractCodexNotificationThreadId(params);
      const turnId = extractCodexNotificationTurnId(params);
      const itemId = extractCodexNotificationItemId(params);
      if (threadId) {
        parts.push(`thread=${threadId}`);
      }
      if (turnId) {
        parts.push(`turn=${turnId}`);
      }
      if (itemId) {
        parts.push(`item=${itemId}`);
      }
      if (normalizeOptionalString(params.cursor)) {
        parts.push(`cursor=${normalizeOptionalString(params.cursor)}`);
      }
      if (normalizeOptionalString(params.previousCursor || params.previous_cursor)) {
        parts.push(`previousCursor=${normalizeOptionalString(params.previousCursor || params.previous_cursor)}`);
      }
    }
    const errorRecord = asObject(parsed?.error);
    if (errorRecord.message) {
      parts.push(`error=${JSON.stringify(errorRecord.message)}`);
    }
    return parts.join(" ");
  }

  function historyMetadataForItem(
    snapshot: CodexHistorySnapshot | null,
    itemId: unknown
  ): HistoryItemMetadata | null {
    if (!snapshot) {
      return null;
    }
    const normalizedThreadId = normalizeOptionalString(snapshot.threadId);
    const normalizedItemId = normalizeOptionalString(itemId);
    if (!normalizedThreadId || !normalizedItemId) {
      return null;
    }
    const records = Array.isArray(snapshot.records)
      ? snapshot.records.slice().sort(compareHistoryRecord)
      : [];
    const currentIndex = records.findIndex((record) =>
      matchesHistoryRecordNotificationItemId(record, normalizedItemId)
    );
    if (currentIndex < 0) {
      return null;
    }
    const currentRecord = records[currentIndex];
    if (!currentRecord) {
      return null;
    }
    const previousRecord = currentIndex > 0 ? records[currentIndex - 1] : null;
    return {
      threadId: normalizedThreadId,
      turnId: normalizeOptionalString(currentRecord?.turnId)
        || normalizeOptionalString(currentRecord?.turnMeta?.id)
        || null,
      itemId: normalizeOptionalString(currentRecord?.itemObject?.id) || null,
      currentCursor: historyCursorForRecord(normalizedThreadId, currentRecord),
      previousCursor: previousRecord
        ? historyCursorForRecord(normalizedThreadId, previousRecord)
        : null,
      previousItemId: normalizeOptionalString(previousRecord?.itemObject?.id) || null,
    };
  }

  function matchesHistoryRecordNotificationItemId(
    record: RuntimeHistoryRecord | null | undefined,
    itemId: unknown
  ): boolean {
    const normalizedItemId = normalizeOptionalString(itemId);
    if (!record || !normalizedItemId) {
      return false;
    }
    return readHistoryRecordTimelineItemId(record) === normalizedItemId
      || readHistoryRecordProviderItemId(record) === normalizedItemId;
  }

  function readHistoryRecordTimelineItemId(
    record: RuntimeHistoryRecord | null | undefined
  ): string | null {
    return normalizeOptionalString(
      record?.itemObject?.timelineItemId
      || record?.itemObject?.timeline_item_id
      || record?.itemObject?.id
    );
  }

  function readHistoryRecordProviderItemId(
    record: RuntimeHistoryRecord | null | undefined
  ): string | null {
    return normalizeOptionalString(
      record?.itemObject?.providerItemId
      || record?.itemObject?.provider_item_id
    );
  }

  function canonicalKindForHistoryRecord(
    record: RuntimeHistoryRecord | null | undefined
  ): string {
    const normalizedType = normalizeCodexItemType(record?.itemObject?.type);
    switch (normalizedType) {
      case "agentmessage":
      case "assistantmessage":
      case "message":
      case "exitedreviewmode":
      case "usermessage":
        return "chat";
      case "reasoning":
        return "thinking";
      case "filechange":
      case "diff":
        return "fileChange";
      case "toolcall": {
        const itemObject = asObject(record?.itemObject);
        const directPatch = normalizeOptionalString(
          itemObject.diff
          || itemObject.unified_diff
          || itemObject.unifiedDiff
          || itemObject.patch
        );
        const text = normalizeOptionalString(itemObject.text || itemObject.message);
        const hasFileChangeSignal = (Array.isArray(itemObject.changes) && itemObject.changes.length > 0)
          || Boolean(directPatch)
          || Boolean(text && (/diff --git |\n@@ |\n\+\+\+ |\n--- /.test(text)));
        return hasFileChangeSignal ? "fileChange" : "toolActivity";
      }
      case "commandexecution":
      case "enteredreviewmode":
      case "contextcompaction":
        return "commandExecution";
      case "collabagenttoolcall":
      case "collabtoolcall":
      case "subagentaction":
        return "subagentAction";
      case "plan":
        return "plan";
      case "userinputprompt":
        return "userInputPrompt";
      default:
        if (normalizedType.startsWith("collabagentspawn")
          || normalizedType.startsWith("collabwaiting")
          || normalizedType.startsWith("collabclose")
          || normalizedType.startsWith("collabresume")
          || normalizedType.startsWith("collabagentinteraction")) {
          return "subagentAction";
        }
        return "chat";
    }
  }

  function canonicalRoleForHistoryRecord(
    record: RuntimeHistoryRecord | null | undefined
  ): string {
    const explicitRole = normalizeOptionalString(record?.itemObject?.role)?.toLowerCase();
    if (explicitRole === "user") {
      return "user";
    }
    if (explicitRole === "assistant" || explicitRole === "agent") {
      return "assistant";
    }

    const normalizedType = normalizeCodexItemType(record?.itemObject?.type);
    if (normalizedType === "usermessage") {
      return "user";
    }
    if (normalizedType === "exitedreviewmode") {
      return "assistant";
    }
    if (normalizedType === "agentmessage" || normalizedType === "assistantmessage") {
      return "assistant";
    }
    if (normalizedType === "message") {
      return explicitRole === "user" ? "user" : "assistant";
    }
    return "system";
  }

  function canonicalStatusForHistoryRecord(
    record: RuntimeHistoryRecord | null | undefined
  ): string {
    const itemStatus = normalizeOptionalString(record?.itemObject?.status)?.toLowerCase();
    if (itemStatus) {
      return itemStatus;
    }
    const turnStatus = normalizeOptionalString(record?.turnMeta?.status)?.toLowerCase();
    if (turnStatus === "completed" || turnStatus === "failed" || turnStatus === "stopped") {
      return turnStatus;
    }
    return "streaming";
  }

  function provisionalHistoryIdentityDetail(
    kind: string,
    itemObject: UnknownRecord | null | undefined
  ): string {
    const normalizedItemObject = asObject(itemObject);
    switch (kind) {
      case "commandExecution":
        return normalizeOptionalString(
          normalizedItemObject.command
          || normalizedItemObject.cmd
          || normalizedItemObject.text
        ) || "command";
      case "toolActivity":
        return normalizeOptionalString(
          normalizedItemObject.toolName
          || normalizedItemObject.tool_name
          || asObject(normalizedItemObject.metadata).toolName
          || asObject(normalizedItemObject.metadata).tool_name
          || normalizedItemObject.text
        ) || "tool";
      case "fileChange":
        return normalizeOptionalString(normalizedItemObject.text) || "file-change";
      case "plan":
        return normalizeOptionalString(
          normalizedItemObject.explanation
          || normalizedItemObject.summary
          || normalizedItemObject.text
        ) || "plan";
      case "subagentAction":
        return normalizeOptionalString(normalizedItemObject.text) || "subagent";
      default:
        return kind;
    }
  }

  function provisionalHistoryIdentityKeyForRecord(
    record: RuntimeHistoryRecord | null | undefined
  ): string {
    const turnId = normalizeOptionalString(record?.turnId) || "unknown-turn";
    const kind = canonicalKindForHistoryRecord(record);
    const detail = provisionalHistoryIdentityDetail(kind, asObject(record?.itemObject));
    return `${turnId}|${kind}|${detail}`;
  }

  function provisionalHistoryIdentityKeyForInput({
    turnId,
    type,
    defaults = {},
  }: {
    turnId: string;
    type: string;
    defaults?: Record<string, unknown>;
  }): string {
    const kind = canonicalKindForHistoryRecord({
      turnId,
      itemObject: { type, ...defaults },
    } as RuntimeHistoryRecord);
    const detail = provisionalHistoryIdentityDetail(kind, defaults);
    return `${turnId}|${kind}|${detail}`;
  }

  function canonicalTextForHistoryRecord(
    record: RuntimeHistoryRecord | null | undefined
  ): string {
    const itemObject = asObject(record?.itemObject);
    const normalizedType = normalizeCodexItemType(itemObject.type);
    if (normalizedType === "enteredreviewmode") {
      const reviewLabel = normalizeOptionalString(itemObject.review) || "changes";
      return `Reviewing ${reviewLabel}...`;
    }
    if (normalizedType === "contextcompaction") {
      const status = canonicalStatusForHistoryRecord(record);
      return status === "completed" || status === "failed" || status === "stopped"
        ? "Context compacted"
        : "Compacting context...";
    }
    if (normalizedType === "exitedreviewmode") {
      const reviewText = normalizeOptionalString(itemObject.review);
      if (reviewText) {
        return reviewText;
      }
    }
    const directText = normalizeOptionalString(itemObject.text || itemObject.message);
    if (directText) {
      return directText;
    }
    const content = Array.isArray(itemObject.content) ? itemObject.content : [];
    const textParts = content
      .map((entry) => asObject(entry))
      .filter((entry) => normalizeCodexItemType(entry.type) === "text")
      .map((entry) => normalizeOptionalString(entry.text))
      .filter(Boolean) as string[];
    return textParts.join("\n");
  }

  function syncCanonicalFieldsOnRecord(record: RuntimeHistoryRecord): RuntimeHistoryRecord {
    const explicitTimelineItemId = normalizeOptionalString(
      record?.itemObject?.timelineItemId
      || record?.itemObject?.timeline_item_id
    );
    const explicitProviderItemId = normalizeOptionalString(
      record?.itemObject?.providerItemId
      || record?.itemObject?.provider_item_id
    );
    const legacyItemId = normalizeOptionalString(record?.itemObject?.id);
    const providerItemId = explicitProviderItemId
      || (explicitTimelineItemId ? null : legacyItemId)
      || null;
    const timelineItemId = explicitTimelineItemId
      || legacyItemId
      || providerItemId
      || randomUUID();
    record.itemObject.id = timelineItemId;
    record.itemObject.timelineItemId = timelineItemId;
    record.itemObject.providerItemId = providerItemId;
    record.itemObject.kind = canonicalKindForHistoryRecord(record);
    record.itemObject.role = canonicalRoleForHistoryRecord(record);
    record.itemObject.status = canonicalStatusForHistoryRecord(record);
    record.itemObject.ordinal = Number.isFinite(record.ordinal) ? record.ordinal : 0;
    const text = canonicalTextForHistoryRecord(record);
    if (text) {
      record.itemObject.text = text;
    }
    return record;
  }

  function readCodexHistoryRecordForNotification(
    threadId: unknown,
    itemId: unknown
  ): RuntimeHistoryRecord | null {
    const normalizedThreadId = normalizeOptionalString(threadId);
    const normalizedItemId = normalizeOptionalString(itemId);
    if (!normalizedThreadId || !normalizedItemId) {
      return null;
    }
    const snapshot = readCodexHistorySnapshot(normalizedThreadId);
    if (!snapshot || !Array.isArray(snapshot.records)) {
      return null;
    }
    return snapshot.records.find((record) => matchesHistoryRecordNotificationItemId(record, normalizedItemId)) || null;
  }

  function buildCanonicalTimelineItemPayloadFromCodexNotification(
    method: string | null,
    params: UnknownRecord
  ): UnknownRecord | null {
    const threadId = extractCodexNotificationThreadId(params);
    const notificationItemId = extractCodexNotificationItemId(params);
    const turnId = extractCodexNotificationTurnId(params);
    if (!threadId) {
      return null;
    }

    const snapshot = readCodexHistorySnapshot(threadId);
    const record = readCodexHistoryRecordForNotification(threadId, notificationItemId);
    if (!record) {
      return null;
    }

    const timelineItemId = readHistoryRecordTimelineItemId(record);
    if (!timelineItemId) {
      return null;
    }

    const payload: UnknownRecord = {
      threadId,
      turnId: normalizeOptionalString(turnId) || normalizeOptionalString(record.turnId) || null,
      timelineItemId,
      providerItemId: readHistoryRecordProviderItemId(record),
      kind: canonicalKindForHistoryRecord(record),
      role: canonicalRoleForHistoryRecord(record),
      ordinal: Number.isFinite(record.ordinal) ? record.ordinal : 0,
      status: method === "item/completed" || method === "item/toolCall/completed"
        ? "completed"
        : canonicalStatusForHistoryRecord(record),
      text: canonicalTextForHistoryRecord(record),
      textMode: "replace",
    };
    const metadata = historyMetadataForItem(
      snapshot,
      notificationItemId || timelineItemId
    );
    if (metadata?.currentCursor) {
      payload.cursor = metadata.currentCursor;
      updateThreadSessionProjectionCursor(threadId, metadata.currentCursor);
    }
    if (metadata?.previousCursor) {
      payload.previousCursor = metadata.previousCursor;
    }
    if (metadata?.previousItemId) {
      payload.previousItemId = metadata.previousItemId;
    }
    const sessionRecord = threadSessionIndex.get(threadId);
    if (sessionRecord?.sourceKind) {
      payload.sourceKind = sessionRecord.sourceKind;
    }
    if (sessionRecord?.syncEpoch) {
      payload.syncEpoch = sessionRecord.syncEpoch;
    }

    if (Array.isArray(record.itemObject.changes) && record.itemObject.changes.length > 0) {
      payload.changes = record.itemObject.changes;
    }
    if (normalizeOptionalString(record.itemObject.command)) {
      payload.command = normalizeOptionalString(record.itemObject.command);
    }
    if (normalizeOptionalString(record.itemObject.cwd)) {
      payload.cwd = normalizeOptionalString(record.itemObject.cwd);
    }
    if (typeof record.itemObject.exitCode === "number") {
      payload.exitCode = record.itemObject.exitCode;
    }
    if (typeof record.itemObject.durationMs === "number") {
      payload.durationMs = record.itemObject.durationMs;
    }
    if (Array.isArray(record.itemObject.plan) || normalizeOptionalString(record.itemObject.explanation)) {
      payload.planState = {
        explanation: normalizeOptionalString(record.itemObject.explanation) || null,
        steps: Array.isArray(record.itemObject.plan) ? record.itemObject.plan : [],
      };
    }
    if (Array.isArray(record.itemObject.questions) && record.itemObject.questions.length > 0) {
      payload.questions = record.itemObject.questions;
    }
    if (normalizeOptionalString(record.itemObject.tool)) {
      payload.tool = normalizeOptionalString(record.itemObject.tool);
    }
    if (normalizeOptionalString(record.itemObject.name) && !normalizeOptionalString(record.itemObject.tool)) {
      payload.name = normalizeOptionalString(record.itemObject.name);
    }
    if (normalizeOptionalString(record.itemObject.prompt)) {
      payload.prompt = normalizeOptionalString(record.itemObject.prompt);
    }
    if (normalizeOptionalString(record.itemObject.model)) {
      payload.model = normalizeOptionalString(record.itemObject.model);
    }
    if (Array.isArray(record.itemObject.receiverThreadIds)) {
      payload.receiverThreadIds = record.itemObject.receiverThreadIds;
    } else if (Array.isArray(record.itemObject.receiver_thread_ids)) {
      payload.receiverThreadIds = record.itemObject.receiver_thread_ids;
    }
    if (Array.isArray(record.itemObject.receiverAgents)) {
      payload.receiverAgents = record.itemObject.receiverAgents;
    } else if (Array.isArray(record.itemObject.receiver_agents)) {
      payload.receiverAgents = record.itemObject.receiver_agents;
    }
    if (record.itemObject.agentStates && typeof record.itemObject.agentStates === "object") {
      payload.agentStates = record.itemObject.agentStates;
    } else if (record.itemObject.agent_states && typeof record.itemObject.agent_states === "object") {
      payload.agentStates = record.itemObject.agent_states;
    }
    return payload;
  }

  function historyRecordContentSignature(record: RuntimeHistoryRecord | null | undefined): string {
    if (!record || typeof record !== "object") {
      return "";
    }
    return JSON.stringify({
      turnId: normalizeOptionalString(record.turnId) || normalizeOptionalString(record?.turnMeta?.id) || null,
      itemId: normalizeOptionalString(record?.itemObject?.id) || null,
      type: normalizeOptionalString(record?.itemObject?.type) || null,
      role: normalizeOptionalString(record?.itemObject?.role) || null,
      text: normalizeOptionalString(record?.itemObject?.text) || "",
      content: Array.isArray(record?.itemObject?.content) ? record.itemObject.content : [],
      status: normalizeOptionalString(record?.itemObject?.status) || null,
      changes: Array.isArray(record?.itemObject?.changes) ? record.itemObject.changes : [],
      plan: Array.isArray(record?.itemObject?.plan) ? record.itemObject.plan : [],
      explanation: normalizeOptionalString(record?.itemObject?.explanation) || null,
      summary: normalizeOptionalString(record?.itemObject?.summary) || null,
      metadata: asObject(record?.itemObject?.metadata),
    });
  }

  function ensureHistoryTurn(
    entry: CodexHistorySnapshot,
    turnId: unknown,
    turnMeta: RuntimeTurnShape & { id: string; createdAt: string }
  ): RuntimeTurnShape & { id: string; createdAt: string } | null {
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

  function updateHistoryTurnStatus(entry: CodexHistorySnapshot, turnId: unknown, status: unknown): void {
    const normalizedTurnId = normalizeOptionalString(turnId);
    if (!normalizedTurnId) {
      return;
    }
    entry.records.forEach((record) => {
      if (record.turnId === normalizedTurnId) {
        record.turnMeta = {
          ...record.turnMeta,
          status: normalizeOptionalString(status),
        };
      }
    });
  }

  function upsertHistoryCacheTextItem(
    entry: CodexHistorySnapshot,
    {
      turnId,
      itemId,
      type,
      role = null,
      delta,
      metadata = null,
      changes = null,
    }: UpsertHistoryCacheTextItemOptions
  ): void {
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
        const firstText = record.itemObject.content.find((contentItem: RuntimeItemShape) => contentItem.type === "text");
        if (firstText) {
          firstText.text = mergeTimelineText(firstText.text, normalizedDelta);
        } else {
          record.itemObject.content.push({ type: "text", text: normalizedDelta });
        }
      }
      record.itemObject.text = mergeTimelineText(record.itemObject.text, normalizedDelta);
    }
    if (metadata) {
      record.itemObject.metadata = {
        ...asObject(record.itemObject.metadata),
        ...metadata,
      };
    }
    if (changes) {
      record.itemObject.changes = changes;
    }
    record.itemObject.status = "streaming";
    syncCanonicalFieldsOnRecord(record);
  }

  function ensureHistoryRecord(
    entry: CodexHistorySnapshot,
    { turnId, itemId, type, role = null, defaults = {} }: EnsureHistoryRecordOptions
  ): RuntimeHistoryRecord {
    const normalizedTurnId = normalizeOptionalString(turnId) || "unknown-turn";
    const normalizedProviderItemId = normalizeOptionalString(itemId);
    const provisionalIdentityKey = provisionalHistoryIdentityKeyForInput({
      turnId: normalizedTurnId,
      type,
      defaults,
    });
    const existing = entry.records.find((record) =>
      normalizedProviderItemId ? matchesHistoryRecordNotificationItemId(record, normalizedProviderItemId) : false
    ) || (
      normalizedProviderItemId
        ? null
        : entry.records
          .slice()
          .sort(compareHistoryRecord)
          .reverse()
          .find((record) =>
            record.turnId === normalizedTurnId
            && provisionalHistoryIdentityKeyForRecord(record) === provisionalIdentityKey
            && !readHistoryRecordProviderItemId(record)
          )
    );
    if (existing) {
      if (normalizedProviderItemId && !readHistoryRecordProviderItemId(existing)) {
        existing.itemObject.providerItemId = normalizedProviderItemId;
      }
      syncCanonicalFieldsOnRecord(existing);
      return existing;
    }
    const nowIso = new Date().toISOString();
    const turnMeta = ensureHistoryTurn(entry, normalizedTurnId, {
      id: normalizedTurnId,
      createdAt: nowIso,
      status: "running",
    });
    const timelineItemId = normalizedProviderItemId || randomUUID();
    const record: RuntimeHistoryRecord = {
      turnId: normalizedTurnId,
      createdAt: nowIso,
      turnMeta: turnMeta || {
        id: normalizedTurnId,
        createdAt: nowIso,
        status: "running",
      },
      itemObject: {
        id: timelineItemId,
        timelineItemId,
        providerItemId: normalizedProviderItemId,
        type,
        ...(role ? { role } : {}),
        createdAt: nowIso,
        ...defaults,
      },
      ordinal: nextHistoryOrdinal(entry.records),
      createdAtMs: Date.parse(nowIso) || Date.now(),
      turnIndex: 0,
      itemIndex: entry.records.length,
    };
    entry.records.push(syncCanonicalFieldsOnRecord(record));
    return record;
  }

  function createManagedTurnContext(
    threadMeta: RuntimeThreadMeta,
    params: UnknownRecord
  ): LocalManagedTurnContext {
    const providerDefinition = getRuntimeProvider(threadMeta.provider);
    const abortController = new AbortController();
    const nowIso = new Date().toISOString();
    const threadHistory = (store.getThreadHistory(threadMeta.id) || {
      threadId: threadMeta.id,
      turns: [],
    }) as {
      threadId: string;
      turns: ManagedHistoryTurn[];
    };
    const turnId = randomUUID();
    const turnRecord: ManagedHistoryTurn = {
      id: turnId,
      createdAt: nowIso,
      status: "running",
      items: [],
    };
    threadHistory.turns.push(turnRecord);

    const inputItems = normalizeInputItems(params.input);
    const userTextPreview = inputItems
      .map((entry) => readTextInput(entry))
      .filter(Boolean)
      .join("\n")
      .trim();

    if (inputItems.length > 0) {
      turnRecord.items.push({
        id: randomUUID(),
        type: "user_message",
        role: "user",
        content: inputItems.map((item) => ({ ...asObject(item) })),
        text: userTextPreview || null,
        createdAt: nowIso,
      } as ManagedHistoryItem);
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

    syncThreadSessionFromMeta(threadMeta, {
      engineSessionId: threadMeta.providerSessionId || threadMeta.id,
    });
    updateThreadSessionOwnerState(threadMeta.id, "running", {
      activeTurnId: turnId,
    });

    emitRuntimeEvent({
      kind: "turn_started",
      threadId: threadMeta.id,
      turnId,
    });

    let interruptHandler: InterruptHandler = null;

    function ensureItem({
      itemId,
      type,
      role = null,
      content = null,
      defaults = {},
    }: {
      itemId?: string;
      type: string;
      role?: string | null;
      content?: RuntimeItemShape[] | null;
      defaults?: Record<string, unknown>;
    }): ManagedHistoryItem {
      const normalizedItemId = normalizeOptionalString(itemId) || randomUUID();
      let item = turnRecord.items.find((entry) => entry.id === normalizedItemId);
      if (!item) {
        item = {
          id: normalizedItemId,
          type,
          role,
          text: null,
          message: null,
          status: null,
          command: null,
          metadata: null,
          plan: null,
          summary: null,
          fileChanges: [],
          content: content ? [...content] : [],
          createdAt: new Date().toISOString(),
          ...defaults,
        } as ManagedHistoryItem;
        turnRecord.items.push(item);
      }
      return item;
    }

    function persistThreadHistory(): void {
      store.saveThreadHistory(threadMeta.id, threadHistory);
      store.updateThreadMeta(threadMeta.id, (entry) => ({
        ...entry,
        updatedAt: new Date().toISOString(),
      }));
    }

    function appendAgentDelta(delta: unknown, { itemId }: { itemId?: string } = {}): void {
      const normalizedDelta = normalizeOptionalString(delta);
      if (!normalizedDelta) {
        return;
      }
      const item = ensureItem({
        type: "agent_message",
        role: "assistant",
        content: [{ type: "text", text: "" }],
        ...(itemId ? { itemId } : {}),
      });
      const firstText = item.content.find((entry) => entry.type === "text") as RuntimeItemShape | undefined;
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
      emitRuntimeEvent({
        kind: "assistant_delta",
        threadId: threadMeta.id,
        turnId,
        itemId: item.id,
        delta: normalizedDelta,
      });
    }

    function appendReasoningDelta(delta: unknown, { itemId }: { itemId?: string } = {}): void {
      const normalizedDelta = normalizeOptionalString(delta);
      if (!normalizedDelta) {
        return;
      }
      const item = ensureItem({
        type: "reasoning",
        defaults: { text: "" },
        ...(itemId ? { itemId } : {}),
      });
      item.text = `${item.text || ""}${normalizedDelta}`;
      persistThreadHistory();
      emitRuntimeEvent({
        kind: "reasoning_delta",
        threadId: threadMeta.id,
        turnId,
        itemId: item.id,
        delta: normalizedDelta,
      });
    }

    function appendToolCallDelta(
      delta: unknown,
      {
        itemId,
        toolName,
        fileChanges,
        completed = false,
      }: {
        itemId?: string;
        toolName?: string;
        fileChanges?: unknown[];
        completed?: boolean;
      } = {}
    ): void {
      const normalizedDelta = normalizeOptionalString(delta);
      const item = ensureItem({
        type: "tool_call",
        defaults: {
          text: "",
          metadata: {},
          changes: [],
        },
        ...(itemId ? { itemId } : {}),
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
      emitRuntimeEvent({
        kind: "tool_delta",
        threadId: threadMeta.id,
        turnId,
        itemId: item.id,
        delta: normalizedDelta || "",
        toolName: normalizeOptionalString(toolName),
        changes: Array.isArray(item.changes) ? item.changes : [],
        completed,
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
    }: {
      itemId?: string;
      command?: unknown;
      cwd?: unknown;
      status?: unknown;
      exitCode?: unknown;
      durationMs?: unknown;
      outputDelta?: unknown;
    }): void {
      const item = ensureItem({
        type: "command_execution",
        defaults: {
          command: null,
          status: "running",
          cwd: null,
          exitCode: null,
          durationMs: null,
          text: "",
        },
        ...(itemId ? { itemId } : {}),
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
      emitRuntimeEvent({
        kind: "command_delta",
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

    function upsertPlan(
      planState: unknown,
      { itemId, deltaText }: { itemId?: string; deltaText?: string } = {}
    ): void {
      const item = ensureItem({
        type: "plan",
        defaults: {
          explanation: null,
          summary: null,
          plan: [],
          text: "",
        },
        ...(itemId ? { itemId } : {}),
      });
      const normalizedPlan = normalizePlanState(planState);
      item.explanation = normalizedPlan.explanation;
      item.summary = normalizedPlan.explanation;
      item.plan = normalizedPlan.steps.map((step) => ({ ...step }));
      item.text = normalizeOptionalString(deltaText)
        || normalizedPlan.explanation
        || item.text
        || "Planning...";
      persistThreadHistory();
      emitRuntimeEvent({
        kind: "plan_update",
        threadId: threadMeta.id,
        turnId,
        itemId: item.id,
        explanation: item.explanation,
        summary: item.summary,
        plan: item.plan,
        delta: normalizeOptionalString(deltaText) || item.text,
      });
    }

    function bindProviderSession(sessionId: unknown): void {
      if (!sessionId) {
        return;
      }
      store.bindProviderSession(threadMeta.id, threadMeta.provider, sessionId);
      updateThreadSessionOwnerState(threadMeta.id, "running", {
        activeTurnId: turnId,
        providerSessionId: normalizeOptionalString(sessionId),
        engineSessionId: normalizeOptionalString(sessionId),
      });
    }

    function updateTokenUsage(usage: unknown): void {
      if (!usage || typeof usage !== "object") {
        return;
      }
      emitRuntimeEvent({
        kind: "token_usage",
        threadId: threadMeta.id,
        usage: usage as Record<string, unknown>,
      });
    }

    function updatePreview(preview: unknown): void {
      const normalizedPreview = normalizeOptionalString(preview);
      if (!normalizedPreview) {
        return;
      }
      store.updateThreadMeta(threadMeta.id, (entry) => ({
        ...entry,
        preview: normalizedPreview,
      }));
    }

    function requestApproval(request: UnknownRecord): Promise<unknown> {
      updateThreadSessionOwnerState(threadMeta.id, "waiting_for_client", {
        activeTurnId: turnId,
      });
      return requestFromRuntimeEvent({
        kind: "approval_request",
        threadId: threadMeta.id,
        turnId,
        itemId: normalizeOptionalString(request.itemId) || randomUUID(),
        method: normalizeOptionalString(request.method) || "item/tool/requestApproval",
        command: normalizeOptionalString(request.command),
        reason: normalizeOptionalString(request.reason),
        toolName: normalizeOptionalString(request.toolName),
      }).finally(() => {
        updateThreadSessionOwnerState(threadMeta.id, "running", {
          activeTurnId: turnId,
        });
      });
    }

    function requestStructuredInput(request: UnknownRecord): Promise<unknown> {
      updateThreadSessionOwnerState(threadMeta.id, "waiting_for_client", {
        activeTurnId: turnId,
      });
      return requestFromRuntimeEvent({
        kind: "user_input_request",
        threadId: threadMeta.id,
        turnId,
        itemId: normalizeOptionalString(request.itemId) || randomUUID(),
        questions: request.questions,
      }).finally(() => {
        updateThreadSessionOwnerState(threadMeta.id, "running", {
          activeTurnId: turnId,
        });
      });
    }

    function setInterruptHandler(handler: unknown): void {
      interruptHandler = typeof handler === "function"
        ? (handler as () => void | Promise<void>)
        : null;
    }

    function complete({ status = "completed", usage = null }: { status?: string; usage?: unknown } = {}): void {
      turnRecord.status = status;
      persistThreadHistory();
      if (usage) {
        updateTokenUsage(usage);
      }
      updateThreadSessionOwnerState(threadMeta.id, "idle", {
        activeTurnId: null,
      });
      emitRuntimeEvent({
        kind: "turn_completed",
        threadId: threadMeta.id,
        turnId,
        status,
      });
    }

    function fail(error: unknown, { status = "failed" }: { status?: string } = {}): void {
      const message = normalizeOptionalString(asObject(error).message) || "Runtime error";
      emitRuntimeEvent({
        kind: "runtime_error",
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

  function requestFromClient({
    method,
    params,
    threadId,
  }: {
    method: string;
    params: UnknownRecord;
    threadId: string | null;
  }): Promise<unknown> {
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

  function projectRuntimeEvent(event: RuntimeEvent): ProjectedMobileProtocolMessage {
    return projectRuntimeEventToMobileProtocol(event);
  }

  function emitRuntimeEvent(event: RuntimeEvent): void {
    const projected = projectRuntimeEvent(event);
    if (projected.kind !== "notification") {
      throw new Error(`Runtime event ${event.kind} requires a request handler`);
    }
    sendNotification(projected.method, projected.params);
  }

  function requestFromRuntimeEvent(event: RuntimeEvent): Promise<unknown> {
    const projected = projectRuntimeEvent(event);
    if (projected.kind !== "request") {
      throw new Error(`Runtime event ${event.kind} does not project to a client request`);
    }
    return requestFromClient({
      method: projected.method,
      params: projected.params,
      threadId: readRuntimeEventThreadId(event),
    });
  }

  function readRuntimeEventThreadId(event: RuntimeEvent): string | null {
    return "threadId" in event
      ? normalizeOptionalString(event.threadId)
      : normalizeOptionalString(event.thread?.id);
  }

  function resolveThreadSessionSourceKind({
    provider,
    ownerState,
    rolloutPath,
    existingSourceKind = null,
  }: {
    provider: string;
    ownerState: "idle" | "running" | "waiting_for_client" | "closed";
    rolloutPath?: string | null;
    existingSourceKind?: RuntimeSessionSourceKind | null;
  }): RuntimeSessionSourceKind {
    if (provider !== "codex") {
      return "managed_runtime";
    }
    if (ownerState === "running" || ownerState === "waiting_for_client") {
      return "managed_runtime";
    }
    if (normalizeOptionalString(rolloutPath)) {
      return "rollout_observer";
    }
    return existingSourceKind === "rollout_observer"
      ? "rollout_observer"
      : "thread_read_fallback";
  }

  function nextThreadSessionSyncEpoch({
    existing,
    sourceKind,
    providerSessionId,
  }: {
    existing: ReturnType<ThreadSessionIndex["get"]>;
    sourceKind: RuntimeSessionSourceKind;
    providerSessionId: string | null;
  }): number {
    const currentEpoch = Number.isFinite(existing?.syncEpoch) ? Number(existing?.syncEpoch) : 1;
    if (!existing) {
      return 1;
    }
    if (existing.sourceKind !== sourceKind) {
      return currentEpoch + 1;
    }
    if ((existing.providerSessionId || null) !== (providerSessionId || null)) {
      return currentEpoch + 1;
    }
    return Math.max(1, currentEpoch);
  }

  function updateThreadSessionProjectionCursor(threadId: unknown, cursor: unknown): void {
    const normalizedThreadId = normalizeOptionalString(threadId);
    const normalizedCursor = normalizeOptionalString(cursor);
    if (!normalizedThreadId || !normalizedCursor) {
      return;
    }
    threadSessionIndex.update(normalizedThreadId, (record) => ({
      ...record,
      lastProjectedCursor: normalizedCursor,
      updatedAt: new Date().toISOString(),
    }));
  }

  function upsertThreadSessionRecord({
    threadId,
    provider,
    engineSessionId = null,
    providerSessionId = null,
    cwd = null,
    mode = null,
    model = null,
    ownerState = "idle",
    activeTurnId = null,
    sourceKind = null,
    rolloutPath = null,
    lastProjectedCursor = null,
    takeoverWatermark = null,
  }: {
    threadId: string;
    provider: string;
    engineSessionId?: string | null;
    providerSessionId?: string | null;
    cwd?: string | null;
    mode?: string | null;
    model?: string | null;
    ownerState?: "idle" | "running" | "waiting_for_client" | "closed";
    activeTurnId?: string | null;
    sourceKind?: RuntimeSessionSourceKind | null;
    rolloutPath?: string | null;
    lastProjectedCursor?: string | null;
    takeoverWatermark?: string | null;
  }): void {
    if (!threadId) {
      return;
    }
    const existing = threadSessionIndex.get(threadId);
    const resolvedSourceKind = sourceKind || resolveThreadSessionSourceKind({
      provider,
      ownerState,
      rolloutPath,
      existingSourceKind: existing?.sourceKind || null,
    });
    const resolvedProviderSessionId = providerSessionId ?? existing?.providerSessionId ?? null;
    const syncEpoch = nextThreadSessionSyncEpoch({
      existing,
      sourceKind: resolvedSourceKind,
      providerSessionId: resolvedProviderSessionId,
    });
    const resolvedLastProjectedCursor = normalizeOptionalString(lastProjectedCursor)
      || existing?.lastProjectedCursor
      || null;
    const resolvedTakeoverWatermark = normalizeOptionalString(takeoverWatermark)
      || (
        existing?.sourceKind !== "managed_runtime"
        && resolvedSourceKind === "managed_runtime"
        ? resolvedLastProjectedCursor || existing?.takeoverWatermark || null
        : existing?.takeoverWatermark || null
      );
    threadSessionIndex.upsert({
      threadId,
      provider,
      engineSessionId,
      providerSessionId: resolvedProviderSessionId,
      cwd,
      mode,
      model,
      ownerState,
      activeTurnId,
      sourceKind: resolvedSourceKind,
      syncEpoch,
      rolloutPath: normalizeOptionalString(rolloutPath) || existing?.rolloutPath || null,
      lastProjectedCursor: resolvedLastProjectedCursor,
      takeoverWatermark: resolvedTakeoverWatermark,
    });
  }

  function syncThreadSessionFromMeta(
    threadMeta: RuntimeThreadMeta,
    overrides: {
      engineSessionId?: string | null;
      ownerState?: "idle" | "running" | "waiting_for_client" | "closed";
      activeTurnId?: string | null;
      mode?: string | null;
    } = {}
  ): void {
    if (!threadMeta?.id) {
      return;
    }
    upsertThreadSessionRecord({
      threadId: threadMeta.id,
      provider: threadMeta.provider,
      engineSessionId: overrides.engineSessionId ?? threadMeta.providerSessionId ?? threadMeta.id,
      providerSessionId: threadMeta.providerSessionId,
      cwd: threadMeta.cwd,
      model: threadMeta.model,
      mode: overrides.mode ?? null,
      ownerState: overrides.ownerState ?? "idle",
      activeTurnId: overrides.activeTurnId ?? null,
      sourceKind: resolveThreadSessionSourceKind({
        provider: threadMeta.provider,
        ownerState: overrides.ownerState ?? "idle",
      }),
    });
  }

  function syncThreadSessionFromThreadObject(threadObject: RuntimeThreadShape): void {
    const threadId = normalizeOptionalString(threadObject.id);
    if (!threadId) {
      return;
    }
    const provider = normalizeOptionalString(threadObject.provider) || "codex";
    upsertThreadSessionRecord({
      threadId,
      provider,
      engineSessionId: normalizeOptionalString(threadObject.providerSessionId)
        || normalizeOptionalString(threadObject.id),
      providerSessionId: normalizeOptionalString(threadObject.providerSessionId)
        || normalizeOptionalString(threadObject.id),
      cwd: firstNonEmptyString([
        threadObject.cwd,
        threadObject.current_working_directory,
        threadObject.working_directory,
      ]),
      model: normalizeOptionalString(threadObject.model),
      ownerState: "idle",
      sourceKind: resolveThreadSessionSourceKind({
        provider,
        ownerState: "idle",
      }),
    });
  }

  function updateThreadSessionOwnerState(
    threadId: unknown,
    ownerState: "idle" | "running" | "waiting_for_client" | "closed",
    options: {
      activeTurnId?: string | null;
      providerSessionId?: string | null;
      engineSessionId?: string | null;
    } = {}
  ): void {
    const normalizedThreadId = normalizeOptionalString(threadId);
    if (!normalizedThreadId) {
      return;
    }
    const existing = threadSessionIndex.get(normalizedThreadId);
    if (!existing) {
      return;
    }
    threadSessionIndex.upsert({
      ...existing,
      ownerState,
      activeTurnId: options.activeTurnId !== undefined ? options.activeTurnId : existing.activeTurnId,
      providerSessionId: options.providerSessionId !== undefined ? options.providerSessionId : existing.providerSessionId,
      engineSessionId: options.engineSessionId !== undefined ? options.engineSessionId : existing.engineSessionId,
      sourceKind: resolveThreadSessionSourceKind({
        provider: existing.provider,
        ownerState,
        rolloutPath: existing.rolloutPath,
        existingSourceKind: existing.sourceKind,
      }),
      syncEpoch: nextThreadSessionSyncEpoch({
        existing,
        sourceKind: resolveThreadSessionSourceKind({
          provider: existing.provider,
          ownerState,
          rolloutPath: existing.rolloutPath,
          existingSourceKind: existing.sourceKind,
        }),
        providerSessionId: options.providerSessionId !== undefined
          ? (options.providerSessionId || null)
          : existing.providerSessionId,
      }),
      takeoverWatermark: existing.sourceKind !== "managed_runtime"
        && resolveThreadSessionSourceKind({
          provider: existing.provider,
          ownerState,
          rolloutPath: existing.rolloutPath,
          existingSourceKind: existing.sourceKind,
        }) === "managed_runtime"
        ? existing.lastProjectedCursor || existing.takeoverWatermark || null
        : existing.takeoverWatermark,
      updatedAt: new Date().toISOString(),
    });
  }

  function sendThreadStartedNotification(threadObject: RuntimeThreadShape): void {
    emitRuntimeEvent({
      kind: "thread_started",
      thread: threadObject,
    });
  }

  function decorateThreadResultWithSessionMetadata(threadId: string, result: unknown): unknown {
    const sessionRecord = threadSessionIndex.get(threadId);
    const resultObject = asObject(result);
    if (!sessionRecord || Object.keys(resultObject).length === 0) {
      return result;
    }
    return {
      ...resultObject,
      sourceKind: sessionRecord.sourceKind,
      syncEpoch: sessionRecord.syncEpoch,
    };
  }

  function sendNotification(method: string, params: UnknownRecord): void {
    const historyDecoratedParams = decorateNotificationWithHistoryMetadata(method, params, (threadId: string) =>
      readManagedHistorySnapshot(threadId)
    );
    const decoratedParams = decorateNotificationWithSessionMetadata(historyDecoratedParams);
    sendApplicationMessage(JSON.stringify({
      jsonrpc: "2.0",
      method,
      params: decoratedParams,
    }));
  }

  function decorateConversationThread(threadObject: RuntimeThreadShape): RuntimeThreadShape {
    const overlay = store.getThreadMeta(threadObject.id) || null;
    const providerDefinition = getRuntimeProvider("codex");
    const upstreamCreatedAt = normalizeTimestampString(threadObject.createdAt)
      || normalizeTimestampString(threadObject.created_at)
      || null;
    const upstreamUpdatedAt = normalizeTimestampString(threadObject.updatedAt)
      || normalizeTimestampString(threadObject.updated_at)
      || null;
    return {
      ...threadObject,
      provider: "codex",
      providerSessionId: overlay?.providerSessionId ?? threadObject.id ?? null,
      capabilities: providerDefinition.supports,
      metadata: {
        ...(asObject(threadObject.metadata) || {}),
        ...(overlay?.metadata || {}),
        providerTitle: providerDefinition.title,
      },
      title: overlay?.title || threadObject.title || null,
      name: overlay?.name || threadObject.name || null,
      preview: managedRuntimeHelpers.truncateThreadPreview(
        threadObject.preview || overlay?.preview || null
      ),
      cwd: overlay?.cwd || threadObject.cwd || threadObject.current_working_directory || threadObject.working_directory || null,
      createdAt: upstreamCreatedAt
        || overlay?.createdAt
        || new Date().toISOString(),
      updatedAt: upstreamUpdatedAt
        || overlay?.updatedAt
        || new Date().toISOString(),
    };
  }

  function upsertOverlayFromThread(threadObject: RuntimeThreadShape): void {
    store.upsertThreadMeta(threadObjectToMeta(threadObject));
    syncThreadSessionFromThreadObject(threadObject);
  }

  function buildManagedThreadObject(
    threadMeta: RuntimeThreadMeta,
    turns: RuntimeTurnShape[] | RuntimeStoreTurn[] | null = null
  ): RuntimeThreadShape {
    return managedRuntimeHelpers.buildManagedThreadObject(
      threadMeta,
      turns,
      getRuntimeProvider
    );
  }

  function buildThreadListResult(payload: RuntimeThreadShape[] | {
    threads: RuntimeThreadShape[];
    nextCursor?: string | number | null;
    hasMore?: boolean;
    pageSize?: number | null;
  }): unknown {
    return managedRuntimeHelpers.buildThreadListResult(payload, normalizePositiveInteger);
  }

  function threadObjectToMeta(threadObject: UnknownRecord): RuntimeThreadMeta {
    return managedRuntimeHelpers.threadObjectToMeta(threadObject, {
      asObject,
      firstNonEmptyString,
      getRuntimeProvider,
      normalizeOptionalString,
      normalizePositiveInteger,
      normalizeTimestampString,
      resolveProviderId,
    });
  }

  function normalizeModelListResult(result: unknown): { items: unknown[] } {
    const items = extractArray(result, ["items", "data", "models"]);
    return {
      items,
    };
  }

  function normalizeSkillsResult(result: unknown): unknown {
    const skills = extractArray(result, ["skills", "result.skills", "result.data"]);
    return {
      skills,
      data: Array.isArray(skills) ? skills : [],
    };
  }

  function normalizeFuzzyFileResult(result: unknown): { files: unknown[] } {
    const files = extractArray(result, ["files", "result.files"]);
    return {
      files,
    };
  }

  function findThreadIdByTurnId(turnId: unknown): string | null {
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

function extractThreadArray(result: unknown): RuntimeThreadShape[] {
  return historyHelpers.extractThreadArray(result, extractArray) as RuntimeThreadShape[];
}

function extractThreadFromResult(result: unknown): RuntimeThreadShape | null {
  return historyHelpers.extractThreadFromResult(result);
}

function extractHistoryWindowFromResult(result: unknown): UnknownRecord | null {
  return historyHelpers.extractHistoryWindowFromResult(result);
}

function buildUpstreamCodexHistoryParams(
  params: UnknownRecord,
  historyRequest: RuntimeHistoryRequest | null
): UnknownRecord {
  return historyHelpers.buildUpstreamCodexHistoryParams(params, historyRequest, stripProviderField);
}

function buildUpstreamHistoryWindowResponse(
  snapshot: CodexHistorySnapshot,
  historyRequest: RuntimeHistoryRequest,
  upstreamHistoryWindow: UnknownRecord | null,
  thread: RuntimeThreadShape | null
): unknown {
  return historyHelpers.buildUpstreamHistoryWindowResponse(
    snapshot,
    historyRequest,
    upstreamHistoryWindow,
    sanitizeThreadHistoryForTransport(thread),
    {
      compareHistoryRecord,
      historyCursorForRecord,
      historyRecordAnchor(record) {
        return {
          threadId: snapshot.threadId,
          ...historyRecordAnchor(record),
        };
      },
    }
  );
}

function summarizeThreadForList(thread: RuntimeThreadShape): RuntimeThreadShape {
  const cwd = firstNonEmptyThreadPath([
    thread.cwd,
    thread.current_working_directory,
    thread.working_directory,
  ]);
  return {
    id: normalizeOptionalString(thread.id) || undefined,
    provider: normalizeOptionalString(thread.provider) || "codex",
    providerSessionId: normalizeOptionalString(thread.providerSessionId),
    title: normalizeOptionalString(thread.title),
    name: normalizeOptionalString(thread.name),
    preview: managedRuntimeHelpers.truncateThreadPreview(thread.preview),
    cwd,
    createdAt: normalizeTimestampString(thread.createdAt) || null,
    updatedAt: normalizeTimestampString(thread.updatedAt) || null,
    capabilities: asObject(thread.capabilities),
    metadata: summarizeThreadMetadata(thread.metadata),
  };
}

function summarizeThreadMetadata(metadata: unknown): UnknownRecord | null {
  const record = asObject(metadata);
  const providerTitle = normalizeOptionalString(record?.providerTitle);
  return providerTitle ? { providerTitle } : null;
}

function paginateThreadList(
  threads: RuntimeThreadShape[],
  {
    archived,
    limit,
    cursor,
  }: {
    archived: boolean;
    limit: number;
    cursor: { offset: number } | null;
  }
): {
  threads: RuntimeThreadShape[];
  nextCursor: string | null;
  hasMore: boolean;
  pageSize: number;
} {
  const initialVisibleIds = archived ? new Set<string>() : buildInitialVisibleThreadIds(threads);
  const remainingThreads = archived
    ? threads
    : threads.filter((thread) => !initialVisibleIds.has(normalizeOptionalString(thread.id) || ""));
  const sourceThreads = cursor
    ? threads.filter((thread) => !initialVisibleIds.has(normalizeOptionalString(thread.id) || ""))
    : archived
      ? threads
      : threads.filter((thread) => initialVisibleIds.has(normalizeOptionalString(thread.id) || ""));
  const offset = Math.max(0, cursor?.offset || 0);
  const pageThreads = sourceThreads.slice(offset, offset + limit);
  const nextOffset = offset + pageThreads.length;
  const hasMore = cursor
    ? nextOffset < sourceThreads.length
    : remainingThreads.length > 0 || nextOffset < sourceThreads.length;

  return {
    threads: pageThreads,
    nextCursor: hasMore ? encodeThreadListCursor(cursor ? nextOffset : 0) : null,
    hasMore,
    pageSize: pageThreads.length,
  };
}

function buildInitialVisibleThreadIds(threads: RuntimeThreadShape[]): Set<string> {
  const cutoffMs = Date.now() - (THREAD_LIST_INITIAL_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const visibleIds = new Set<string>();
  collectInitialVisibleThreadIds(threads, visibleIds, (thread) => {
    const updatedAt = Date.parse(normalizeTimestampString(thread.updatedAt) || "") || 0;
    return updatedAt >= cutoffMs;
  });

  if (visibleIds.size > 0) {
    return visibleIds;
  }

  collectInitialVisibleThreadIds(threads, visibleIds, () => true);
  return visibleIds;
}

function collectInitialVisibleThreadIds(
  threads: RuntimeThreadShape[],
  visibleIds: Set<string>,
  predicate: (thread: RuntimeThreadShape) => boolean
): void {
  const countsByProject = new Map<string, number>();

  for (const thread of threads) {
    const threadId = normalizeOptionalString(thread.id);
    if (!threadId) {
      continue;
    }
    if (!predicate(thread)) {
      continue;
    }
    const projectKey = threadProjectKey(thread);
    const currentCount = countsByProject.get(projectKey) || 0;
    if (currentCount >= THREAD_LIST_INITIAL_PROJECT_CAP) {
      continue;
    }
    countsByProject.set(projectKey, currentCount + 1);
    visibleIds.add(threadId);
  }
}

function threadProjectKey(thread: RuntimeThreadShape): string {
  return firstNonEmptyThreadPath([
    thread.cwd,
    thread.current_working_directory,
    thread.working_directory,
  ]) || "__no_project__";
}

function firstNonEmptyThreadPath(values: unknown[]): string | null {
  return firstNonEmptyString(values);
}

function encodeThreadListCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ v: THREAD_LIST_CURSOR_VERSION, offset }), "utf8").toString("base64url");
}

function decodeThreadListCursor(value: unknown): { offset: number } | null {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(normalized, "base64url").toString("utf8")) as UnknownRecord;
    const version = Number(parsed.v);
    const offset = Number(parsed.offset);
    if (version !== THREAD_LIST_CURSOR_VERSION || !Number.isInteger(offset) || offset < 0) {
      return null;
    }
    return { offset };
  } catch {
    return null;
  }
}

function sanitizeThreadHistoryForTransport(thread: RuntimeThreadShape | null): RuntimeThreadShape | null {
  return historyHelpers.sanitizeThreadHistoryForTransport(thread);
}

function sanitizeCodexThreadResult(result: unknown): unknown {
  return historyHelpers.sanitizeThreadResultForTransport(result, extractThreadFromResult);
}

function extractArray(value: unknown, candidatePaths: string[]): unknown[] {
  return historyHelpers.extractArray(value, candidatePaths, readPath);
}

function readPath(root: unknown, path: string): unknown {
  return historyHelpers.readPath(root, path);
}

function mergeThreadLists(threads: RuntimeThreadShape[]): RuntimeThreadShape[] {
  return historyHelpers.mergeThreadLists(threads);
}

function extractThreadListCursor(result: unknown): string | number | null {
  return historyHelpers.extractThreadListCursor(result, normalizeOptionalString);
}

function normalizeHistoryRequest(history: unknown): RuntimeHistoryRequest | null {
  if (!history || typeof history !== "object" || Array.isArray(history)) {
    return null;
  }
  const historyRecord = asObject(history);
  const mode = normalizeOptionalString(historyRecord.mode)?.toLowerCase();
  if (mode !== "tail" && mode !== "before" && mode !== "after") {
    return null;
  }
  const limit = normalizePositiveInteger(historyRecord.limit) || DEFAULT_HISTORY_WINDOW_LIMIT;
  const cursor = normalizeHistoryCursor(
    historyRecord.cursor,
    historyRecord.anchor && typeof historyRecord.anchor === "object"
      ? asObject(historyRecord.anchor)
      : null
  );
  if ((mode === "before" || mode === "after") && !cursor) {
    throw createRuntimeError(ERROR_INVALID_PARAMS, "history.cursor is required for before/after windows");
  }
  return {
    mode,
    limit,
    cursor,
    rawCursor: normalizeOptionalString(historyRecord.cursor),
  };
}

function normalizeHistoryCursor(
  rawCursor: unknown,
  legacyAnchor: UnknownRecord | null = null
): RuntimeHistoryCursor | null {
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

function normalizeHistoryAnchor(anchor: UnknownRecord): RuntimeHistoryCursor | null {
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

function normalizeTimestampString(value: unknown): string | null {
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

function normalizePositiveInteger(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return null;
  }
  return numeric;
}

function cloneThreadBase(threadObject: RuntimeThreadShape): RuntimeThreadShape {
  const clone = JSON.parse(JSON.stringify(threadObject || {})) as RuntimeThreadShape;
  delete clone.turns;
  return clone;
}

function flattenThreadHistory(threadObject: RuntimeThreadShape): RuntimeHistoryRecord[] {
  const threadBase = cloneThreadBase(threadObject);
  const turns = Array.isArray(threadObject?.turns) ? threadObject.turns : [];
  const records: RuntimeHistoryRecord[] = [];
  let ordinal = 0;

  turns.forEach((turnObject: RuntimeTurnShape, turnIndex: number) => {
    if (!turnObject || typeof turnObject !== "object") {
      return;
    }
    const turnId = normalizeOptionalString(turnObject.id)
      || normalizeOptionalString(turnObject.turnId)
      || normalizeOptionalString(turnObject.turn_id)
      || `turn-${turnIndex}`;
    const turnMeta = cloneTurnMeta(turnObject, turnId);
    const items = Array.isArray(turnObject.items) ? turnObject.items : [];
    items.forEach((itemObject: RuntimeItemShape, itemIndex: number) => {
      if (!itemObject || typeof itemObject !== "object") {
        return;
      }
      const itemClone = JSON.parse(JSON.stringify(itemObject)) as RuntimeItemShape & Record<string, unknown>;
      const createdAt = normalizeTimestampString(itemClone.createdAt || itemClone.created_at || turnMeta.createdAt || threadBase.createdAt || new Date().toISOString())
        || new Date().toISOString();
      itemClone.createdAt = createdAt;
      const record = {
        turnId,
        turnMeta,
        itemObject: itemClone,
        createdAt,
        createdAtMs: Date.parse(createdAt) || 0,
        ordinal,
        turnIndex,
        itemIndex,
      } satisfies RuntimeHistoryRecord;
      records.push(record);
      ordinal += 1;
    });
  });

  return records.sort(compareHistoryRecord);
}

function cloneTurnMeta(
  turnObject: RuntimeTurnShape | UnknownRecord,
  turnId: string
): RuntimeTurnShape & { id: string; createdAt: string } {
  const clone = JSON.parse(JSON.stringify(turnObject || {})) as RuntimeTurnShape & { id: string; createdAt: string };
  delete clone.items;
  clone.id = turnId;
  clone.createdAt = normalizeTimestampString(clone.createdAt || clone.created_at || new Date().toISOString()) || new Date().toISOString();
  return clone;
}

function normalizeCodexItemType(value: unknown): string {
  return normalizeOptionalString(value)
    ?.toLowerCase()
    .replace(/[\/_\-\s]/g, "")
    || "";
}

function mergeTimelineText(existingValue: unknown, incomingValue: unknown): string {
  const existingText = normalizeOptionalString(existingValue) || "";
  const incomingText = normalizeOptionalString(incomingValue) || "";
  if (!existingText) {
    return incomingText;
  }
  if (!incomingText || incomingText === existingText || existingText.endsWith(incomingText)) {
    return existingText;
  }
  if (incomingText.length > existingText.length && incomingText.startsWith(existingText)) {
    return incomingText;
  }
  if (existingText.length > incomingText.length && existingText.startsWith(incomingText)) {
    return existingText;
  }

  const maxOverlap = Math.min(existingText.length, incomingText.length);
  for (let overlap = maxOverlap; overlap >= 1; overlap -= 1) {
    if (existingText.slice(-overlap) === incomingText.slice(0, overlap)) {
      return `${existingText}${incomingText.slice(overlap)}`;
    }
  }

  return `${existingText}${incomingText}`;
}

function compareHistoryRecord(left: RuntimeHistoryRecord, right: RuntimeHistoryRecord): number {
  const leftTimestamp = Number.isFinite(left?.createdAtMs) ? left.createdAtMs : (Date.parse(left?.createdAt || "") || 0);
  const rightTimestamp = Number.isFinite(right?.createdAtMs) ? right.createdAtMs : (Date.parse(right?.createdAt || "") || 0);
  if (leftTimestamp !== rightTimestamp) {
    return leftTimestamp - rightTimestamp;
  }
  return (left?.ordinal || 0) - (right?.ordinal || 0);
}

function historyRecordAnchor(record: RuntimeHistoryRecord): RuntimeHistoryCursor {
  return {
    ...(normalizeOptionalString(record?.itemObject?.id) ? { itemId: normalizeOptionalString(record.itemObject.id) } : {}),
    createdAt: record?.createdAt || normalizeTimestampString(record?.itemObject?.createdAt) || new Date().toISOString(),
    ...(normalizeOptionalString(record?.turnId) ? { turnId: normalizeOptionalString(record.turnId) } : {}),
  };
}

function historyCursorForRecord(threadId: string, record: RuntimeHistoryRecord): string | null {
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

function encodeHistoryCursor(payload: UnknownRecord): string | null {
  try {
    return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  } catch {
    return null;
  }
}

function decodeHistoryCursor(cursor: string): RuntimeHistoryCursor | null {
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

function historyCursorMatchesRecord(
  record: RuntimeHistoryRecord,
  cursor: RuntimeHistoryCursor,
  threadId: string | null | undefined
): boolean {
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
  if (cursor.turnId && recordTurnId) {
    return cursor.turnId === recordTurnId;
  }
  return !cursor.itemId && !cursor.turnId;
}

function findHistoryRecordIndexByCursor(
  records: RuntimeHistoryRecord[],
  cursor: RuntimeHistoryCursor | null,
  threadId: string
): number {
  if (!cursor) {
    return -1;
  }
  return records.findIndex((record) => historyCursorMatchesRecord(record, cursor, threadId));
}

function rebuildThreadFromHistoryRecords(
  threadBase: RuntimeThreadShape,
  records: RuntimeHistoryRecord[]
): RuntimeThreadShape {
  const normalizedRecords = [...records].sort(compareHistoryRecord);
  const turnsById = new Map<string, RuntimeTurnShape & { items: RuntimeItemShape[] }>();
  const turnOrder: string[] = [];

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
    turnsById.get(turnId)!.items.push(historyHelpers.sanitizeHistoryItemForTransport(record.itemObject));
  });

  return {
    ...JSON.parse(JSON.stringify(threadBase || {})),
    turns: turnOrder.map((turnId) => turnsById.get(turnId)),
  };
}

function nextHistoryOrdinal(records: RuntimeHistoryRecord[]): number {
  return records.reduce((maxValue, record) => Math.max(maxValue, Number(record?.ordinal) || 0), -1) + 1;
}

function normalizeInputItems(input: unknown): RuntimeInputItem[] {
  return normalizerHelpers.normalizeInputItems(input);
}

function normalizeInputItem(entry: unknown): RuntimeInputItem | null {
  return normalizerHelpers.normalizeInputItem(entry);
}

function normalizeInputType(value: unknown): string {
  return normalizerHelpers.normalizeInputType(value);
}

function normalizePlanState(planState: unknown) {
  return normalizerHelpers.normalizePlanState(planState);
}

function buildCommandPreview(command: unknown, status: unknown, exitCode: unknown): string {
  return normalizerHelpers.buildCommandPreview(command, status, exitCode);
}

function buildProviderMetadata(provider: unknown): { providerTitle: string } {
  return managedRuntimeHelpers.buildProviderMetadata(
    provider,
    getRuntimeProvider
  );
}

function resolveProviderId(value: unknown): string {
  return managedRuntimeHelpers.resolveProviderId(value, normalizeOptionalString);
}

function stripProviderField<TValue>(params: TValue): Omit<TValue, "provider"> | TValue {
  return managedRuntimeHelpers.stripProviderField(params);
}

function defaultInitializeParams(): RuntimeInitializeParams {
  return routingHelpers.defaultInitializeParams();
}

function createMethodError(message: string): RuntimeErrorShape {
  return routingHelpers.createMethodError(ERROR_METHOD_NOT_FOUND, message);
}

function createRuntimeError(code: number, message: string): RuntimeErrorShape {
  return routingHelpers.createRuntimeError(code, message);
}

function encodeRequestId(value: JsonRpcId | undefined): string {
  return routingHelpers.encodeRequestId(value);
}

function normalizeOptionalString(value: unknown): string | null {
  return normalizerHelpers.normalizeOptionalString(value);
}

function normalizeNonEmptyString(value: unknown): string {
  return normalizerHelpers.normalizeNonEmptyString(value);
}

function firstNonEmptyString(values: unknown[]): string | null {
  return normalizerHelpers.firstNonEmptyString(values);
}

function asObject(value: unknown): UnknownRecord {
  return normalizerHelpers.asObject(value);
}

function readTextInput(item: RuntimeInputItem | RuntimeItemShape | UnknownRecord): string | null {
  if (!item || item.type !== "text") {
    return null;
  }
  const text = typeof item.text === "string" ? item.text : "";
  return normalizeOptionalString(text);
}
