// FILE: runtime-engine/codex-engine.ts
// Purpose: Wraps the existing Codex app-server transport behind the bridge runtime engine interface.

import type { RuntimeThreadShape } from "../bridge-types";
import type { CodexAdapter } from "../providers/codex-adapter";
import type { RuntimeStore, RuntimeThreadMeta } from "../runtime-store";
import type { RuntimeHistoryRecord, RuntimeHistoryRequest } from "../runtime-manager/types";
import type { ProviderRuntimeEngine, RuntimeSessionHandle } from "./types";

type UnknownRecord = Record<string, unknown>;

interface CodexHistorySnapshotLike {
  threadId: string;
  threadBase: RuntimeThreadShape;
  records: RuntimeHistoryRecord[];
  hasOlder: boolean;
  hasNewer: boolean;
}

interface CreateCodexRuntimeEngineOptions {
  buildHistoryWindowResponse(
    snapshot: CodexHistorySnapshotLike,
    historyRequest: RuntimeHistoryRequest,
    servedFromCache: boolean
  ): unknown;
  buildUpstreamCodexHistoryParams(
    params: UnknownRecord,
    historyRequest: RuntimeHistoryRequest | null
  ): UnknownRecord;
  buildUpstreamHistoryWindowResponse(
    snapshot: CodexHistorySnapshotLike,
    historyRequest: RuntimeHistoryRequest,
    upstreamHistoryWindow: UnknownRecord | null,
    thread: RuntimeThreadShape | null
  ): unknown;
  codexAdapter: CodexAdapter;
  createHistorySnapshotFromThread(threadObject: RuntimeThreadShape): CodexHistorySnapshotLike;
  createThreadNotFoundError(threadId: string): Error;
  defaultThreadListPageSize: number;
  decorateConversationThread(threadObject: RuntimeThreadShape): RuntimeThreadShape;
  ensureCodexWarm(initializeParams?: Record<string, unknown> | null): Promise<void>;
  extractHistoryWindowFromResult(result: unknown): UnknownRecord | null;
  extractThreadFromResult(result: unknown): RuntimeThreadShape | null;
  extractThreadArray(result: unknown): RuntimeThreadShape[];
  normalizeModelListResult(result: unknown): { items: unknown[] };
  normalizePositiveInteger(value: unknown): number | null;
  observeCodexThread(
    threadId: unknown,
    options?: { immediate?: boolean; reason?: string }
  ): void;
  primeCodexHistoryCache(threadId: string, threadObject: RuntimeThreadShape): void;
  readCodexHistoryWindowFromCache(
    threadId: string,
    historyRequest: RuntimeHistoryRequest
  ): unknown;
  sanitizeCodexThreadResult(result: unknown): unknown;
  sanitizeThreadHistoryForTransport(thread: RuntimeThreadShape | null): RuntimeThreadShape | null;
  seedCodexHistoryCacheWithUserInput(
    threadId: string,
    turnId: string | null,
    params: UnknownRecord
  ): void;
  sendThreadStartedNotification(threadObject: RuntimeThreadShape): void;
  store: RuntimeStore;
  stripProviderField<TValue>(params: TValue): Omit<TValue, "provider"> | TValue;
  threadObjectToMeta(threadObject: RuntimeThreadShape): RuntimeThreadMeta;
  syncThreadSessionFromMeta(
    threadMeta: RuntimeThreadMeta,
    overrides?: {
      engineSessionId?: string | null;
      ownerState?: "idle" | "running" | "waiting_for_client" | "closed";
      activeTurnId?: string | null;
      mode?: string | null;
    }
  ): void;
  updateThreadSessionOwnerState(
    threadId: unknown,
    ownerState: "idle" | "running" | "waiting_for_client" | "closed",
    options?: {
      activeTurnId?: string | null;
      providerSessionId?: string | null;
      engineSessionId?: string | null;
    }
  ): void;
  upsertOverlayFromThread(threadObject: RuntimeThreadShape): void;
  writeCodexHistoryCache(threadId: string, entry: CodexHistorySnapshotLike): void;
}

export function createCodexRuntimeEngine({
  buildHistoryWindowResponse,
  buildUpstreamCodexHistoryParams,
  buildUpstreamHistoryWindowResponse,
  codexAdapter,
  createHistorySnapshotFromThread,
  createThreadNotFoundError,
  defaultThreadListPageSize,
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
}: CreateCodexRuntimeEngineOptions): ProviderRuntimeEngine {
  async function ensureSession(
    threadMeta: RuntimeThreadMeta,
    _params: UnknownRecord = {}
  ): Promise<RuntimeSessionHandle> {
    await ensureCodexWarm();
    syncThreadSessionFromMeta(threadMeta, {
      engineSessionId: threadMeta.providerSessionId || threadMeta.id,
      ownerState: "idle",
      activeTurnId: null,
    });
    return {
      threadId: threadMeta.id,
      provider: threadMeta.provider,
      engineSessionId: threadMeta.providerSessionId || threadMeta.id,
      providerSessionId: threadMeta.providerSessionId || threadMeta.id,
      cwd: threadMeta.cwd,
      mode: null,
      model: threadMeta.model,
      ownerState: "idle",
      activeTurnId: null,
      createdAt: threadMeta.createdAt,
      updatedAt: threadMeta.updatedAt,
    };
  }

  return {
    providerId: "codex",
    async compactThread(threadMeta, params = {}) {
      await ensureSession(threadMeta, params);
      return codexAdapter.compactThread(stripProviderField(params));
    },
    ensureSession,
    async initialize(clientCaps) {
      await ensureCodexWarm(clientCaps || null);
    },
    async interruptTurn(threadMeta, params = {}) {
      await ensureSession(threadMeta, params);
      return codexAdapter.interruptTurn(stripProviderField(params));
    },
    async listModels(params = {}) {
      await ensureCodexWarm();
      const result = await codexAdapter.listModels(stripProviderField(params));
      return normalizeModelListResult(result);
    },
    async listThreads(params = {}) {
      if (!codexAdapter.isAvailable()) {
        return [];
      }

      await ensureCodexWarm();
      const normalizedParams = {
        ...stripProviderField(params || {}),
      };
      delete normalizedParams.cursor;
      normalizedParams.limit = Math.max(
        normalizePositiveInteger(normalizedParams.limit) || defaultThreadListPageSize,
        500
      );
      const result = await codexAdapter.listThreads(normalizedParams);
      const threads = extractThreadArray(result).map((thread) =>
        decorateConversationThread(asObject(thread) as RuntimeThreadShape)
      );
      return threads.filter((thread) => {
        const overlay = store.getThreadMeta(thread.id);
        const overlayArchived = overlay?.archived;
        if (overlayArchived != null) {
          return Boolean(overlayArchived) === Boolean(params.archived);
        }
        return Boolean(thread.archived) === Boolean(params.archived);
      });
    },
    async lookupThreadMeta(threadId, store: RuntimeStore) {
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
    },
    async readThread(threadMeta, params = {}, historyRequest = null) {
      await ensureCodexWarm();
      if (!historyRequest) {
        const result = await codexAdapter.readThread(stripProviderField(params));
        const threadObject = extractThreadFromResult(result);
        if (!threadObject) {
          throw createThreadNotFoundError(threadMeta.id);
        }

        const decoratedThread = decorateConversationThread(threadObject);
        upsertOverlayFromThread(decoratedThread);
        primeCodexHistoryCache(threadMeta.id, decoratedThread);
        return {
          thread: sanitizeThreadHistoryForTransport(decoratedThread),
        };
      }

      const normalizedHistoryRequest = historyRequest as RuntimeHistoryRequest;
      const cachedWindow = readCodexHistoryWindowFromCache(threadMeta.id, normalizedHistoryRequest);
      if (cachedWindow) {
        return cachedWindow;
      }

      const upstreamHistoryResult = await codexAdapter.readThread(
        buildUpstreamCodexHistoryParams(params, normalizedHistoryRequest)
      );
      const upstreamThreadObject = extractThreadFromResult(upstreamHistoryResult);
      if (upstreamThreadObject) {
        const decoratedThread = decorateConversationThread(upstreamThreadObject);
        upsertOverlayFromThread(decoratedThread);
        const historyWindow = extractHistoryWindowFromResult(upstreamHistoryResult);
        if (historyWindow) {
          const partialSnapshot = {
            ...createHistorySnapshotFromThread(decoratedThread),
            hasOlder: Boolean(historyWindow.hasOlder),
            hasNewer: Boolean(historyWindow.hasNewer),
          } satisfies CodexHistorySnapshotLike;
          writeCodexHistoryCache(threadMeta.id, partialSnapshot);
          return buildUpstreamHistoryWindowResponse(
            partialSnapshot,
            normalizedHistoryRequest,
            historyWindow,
            decoratedThread
          );
        }
      }

      const fullSnapshot = await fetchFullCodexThreadSnapshot(threadMeta.id, params);
      return buildHistoryWindowResponse(fullSnapshot, normalizedHistoryRequest, false);
    },
    async resumeThread(threadMeta, params = {}) {
      await ensureSession(threadMeta, params);
      const result = await codexAdapter.resumeThread(stripProviderField(params));
      observeCodexThread(threadMeta.id, { immediate: false, reason: "thread-resume" });
      return sanitizeCodexThreadResult(result);
    },
    shutdown() {},
    async startThread(params = {}) {
      await ensureCodexWarm();
      const result = await codexAdapter.startThread(stripProviderField(params));
      const thread = extractThreadFromResult(result);
      if (!thread) {
        return result || {};
      }
      const decorated = decorateConversationThread(thread);
      upsertOverlayFromThread(decorated);
      sendThreadStartedNotification(decorated);
      return { thread: decorated };
    },
    async startTurn(threadMeta, params = {}) {
      await ensureSession(threadMeta, params);
      const result = await codexAdapter.startTurn(stripProviderField(params));
      const turnResult = asObject(result);
      const turnId = normalizeOptionalString(turnResult.turnId || turnResult.turn_id);
      updateThreadSessionOwnerState(threadMeta.id, "running", {
        activeTurnId: turnId,
      });
      seedCodexHistoryCacheWithUserInput(threadMeta.id, turnId, params);
      observeCodexThread(threadMeta.id, { immediate: true, reason: "turn-start" });
      return result;
    },
    async steerTurn(threadMeta, params = {}) {
      await ensureSession(threadMeta, params);
      return codexAdapter.steerTurn(stripProviderField(params));
    },
    async syncImportedThreads() {},
  };

  async function fetchFullCodexThreadSnapshot(
    threadId: string,
    params: UnknownRecord
  ): Promise<CodexHistorySnapshotLike> {
    const upstreamParams: UnknownRecord = {
      ...stripProviderField(params || {}),
      threadId,
      includeTurns: true,
    };
    delete upstreamParams.history;

    const result = await codexAdapter.readThread(upstreamParams);
    const threadObject = extractThreadFromResult(result);
    if (!threadObject) {
      throw createThreadNotFoundError(threadId);
    }

    const decoratedThread = decorateConversationThread(threadObject);
    upsertOverlayFromThread(decoratedThread);
    primeCodexHistoryCache(threadId, decoratedThread);
    return createHistorySnapshotFromThread(decoratedThread);
  }
}

function asObject(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
