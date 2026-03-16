// FILE: runtime-engine/managed-provider-engine.ts
// Purpose: Wraps managed local providers such as Claude and Gemini behind the shared provider runtime engine interface.

import { getRuntimeProvider, listStaticModelsForProvider } from "../provider-catalog";
import type { RuntimeThreadShape } from "../bridge-types";
import type { RuntimeStore, RuntimeThreadMeta } from "../runtime-store";
import type {
  ManagedProviderAdapter,
  ManagedProviderTurnContext,
  ManagedProviderTurnResult,
} from "../runtime-manager/types";
import { ERROR_INVALID_PARAMS } from "../runtime-manager/types";
import type { ProviderRuntimeEngine, RuntimeSessionHandle } from "./types";

type UnknownRecord = Record<string, unknown>;

interface ActiveRunEntry {
  provider: RuntimeThreadMeta["provider"];
  threadId: string;
  turnId: string;
  stopRequested: boolean;
  interrupt(): void | Promise<void>;
}

interface ManagedTurnRuntimeContext extends ManagedProviderTurnContext {
  turnId: string;
  threadId: string;
  complete(options?: { status?: string; usage?: unknown }): void;
  fail(error: unknown, options?: { status?: string }): void;
  interrupt(): void | Promise<void>;
}

interface CreateManagedProviderRuntimeEngineOptions {
  activeRunsByThread: Map<string, ActiveRunEntry>;
  adapter: ManagedProviderAdapter;
  buildHistoryWindowResponse(
    snapshot: unknown,
    historyRequest: unknown,
    servedFromCache: boolean
  ): unknown;
  buildProviderMetadata(provider: unknown): { providerTitle: string };
  buildManagedThreadObject(
    threadMeta: RuntimeThreadMeta,
    turns?: unknown[] | null
  ): RuntimeThreadShape;
  createHistorySnapshotFromThread(threadObject: RuntimeThreadShape): unknown;
  createRuntimeError(code: number, message: string): Error & { code?: number };
  createTurnContext(
    threadMeta: RuntimeThreadMeta,
    params: UnknownRecord
  ): ManagedTurnRuntimeContext;
  firstNonEmptyString(values: unknown[]): string | null;
  normalizeOptionalString(value: unknown): string | null;
  providerId: "claude" | "gemini";
  sendThreadStartedNotification(threadObject: RuntimeThreadShape): void;
  store: RuntimeStore;
  syncThreadSessionFromMeta(
    threadMeta: RuntimeThreadMeta,
    overrides?: {
      engineSessionId?: string | null;
      ownerState?: "idle" | "running" | "waiting_for_client" | "closed";
      activeTurnId?: string | null;
      mode?: string | null;
    }
  ): void;
}

export function createManagedProviderRuntimeEngine({
  activeRunsByThread,
  adapter,
  buildHistoryWindowResponse,
  buildProviderMetadata,
  buildManagedThreadObject,
  createHistorySnapshotFromThread,
  createRuntimeError,
  createTurnContext,
  firstNonEmptyString,
  normalizeOptionalString,
  providerId,
  sendThreadStartedNotification,
  store,
  syncThreadSessionFromMeta,
}: CreateManagedProviderRuntimeEngineOptions): ProviderRuntimeEngine {
  const providerDefinition = getRuntimeProvider(providerId);

  async function ensureSession(
    threadMeta: RuntimeThreadMeta,
    _params: UnknownRecord = {}
  ): Promise<RuntimeSessionHandle> {
    syncThreadSessionFromMeta(threadMeta, {
      engineSessionId: threadMeta.providerSessionId || threadMeta.id,
      ownerState: activeRunsByThread.has(threadMeta.id) ? "running" : "idle",
      activeTurnId: activeRunsByThread.get(threadMeta.id)?.turnId || null,
    });
    return {
      threadId: threadMeta.id,
      provider: threadMeta.provider,
      engineSessionId: threadMeta.providerSessionId || threadMeta.id,
      providerSessionId: threadMeta.providerSessionId,
      cwd: threadMeta.cwd,
      mode: null,
      model: threadMeta.model,
      ownerState: activeRunsByThread.has(threadMeta.id) ? "running" : "idle",
      activeTurnId: activeRunsByThread.get(threadMeta.id)?.turnId || null,
      createdAt: threadMeta.createdAt,
      updatedAt: threadMeta.updatedAt,
    };
  }

  return {
    providerId,
    ensureSession,
    async initialize() {},
    async interruptTurn(threadMeta) {
      const activeRun = activeRunsByThread.get(threadMeta.id);
      if (!activeRun) {
        return {};
      }
      activeRun.stopRequested = true;
      activeRun.interrupt();
      return {};
    },
    async listModels() {
      return {
        items: listStaticModelsForProvider(providerId),
      };
    },
    async listThreads(params = {}) {
      const archived = Boolean(params.archived);
      return store.listThreadMetas()
        .filter((entry) => entry.provider === providerId)
        .filter((entry) => Boolean(entry.archived) === archived)
        .map((entry) => buildManagedThreadObject(entry));
    },
    async readThread(threadMeta, _params = {}, historyRequest = null) {
      await adapter.hydrateThread(threadMeta);
      const refreshedMeta = store.getThreadMeta(threadMeta.id) || threadMeta;
      syncThreadSessionFromMeta(refreshedMeta);
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
    },
    async resumeThread(threadMeta) {
      await ensureSession(threadMeta);
      await adapter.hydrateThread(threadMeta);
      const refreshedMeta = store.getThreadMeta(threadMeta.id) || threadMeta;
      syncThreadSessionFromMeta(refreshedMeta);
      const history = store.getThreadHistory(threadMeta.id);
      return {
        thread: buildManagedThreadObject(refreshedMeta, history?.turns || []),
        threadId: threadMeta.id,
        resumed: true,
      };
    },
    shutdown() {},
    async startThread(params = {}) {
      const threadMeta = store.createThread({
        provider: providerId,
        cwd: firstNonEmptyString([params.cwd, params.current_working_directory, params.working_directory]),
        model: normalizeOptionalString(params.model),
        title: null,
        name: null,
        preview: null,
        metadata: buildProviderMetadata(providerId),
        capabilities: providerDefinition.supports,
      });
      syncThreadSessionFromMeta(threadMeta);
      const threadObject = buildManagedThreadObject(threadMeta);
      sendThreadStartedNotification(threadObject);
      return { thread: threadObject };
    },
    async startTurn(threadMeta, params = {}) {
      await ensureSession(threadMeta, params);
      if (activeRunsByThread.has(threadMeta.id)) {
        throw createRuntimeError(ERROR_INVALID_PARAMS, "A turn is already running for this thread");
      }

      const turnContext = createTurnContext(threadMeta, params);
      const runEntry: ActiveRunEntry = {
        provider: threadMeta.provider,
        threadId: threadMeta.id,
        turnId: turnContext.turnId,
        stopRequested: false,
        interrupt() {
          turnContext.interrupt();
        },
      };
      activeRunsByThread.set(threadMeta.id, runEntry);
      syncThreadSessionFromMeta(threadMeta, {
        engineSessionId: threadMeta.providerSessionId || threadMeta.id,
        ownerState: "running",
        activeTurnId: turnContext.turnId,
      });

      void Promise.resolve()
        .then(() => adapter.startTurn({
          params,
          threadMeta,
          turnContext,
        }))
        .then((result) => {
          if (!activeRunsByThread.has(threadMeta.id)) {
            return;
          }
          const resultRecord = result && typeof result === "object"
            ? (result as ManagedProviderTurnResult & UnknownRecord)
            : {};
          turnContext.complete({
            status: runEntry.stopRequested ? "stopped" : "completed",
            usage: resultRecord.usage || null,
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
          const refreshedMeta = store.getThreadMeta(threadMeta.id) || threadMeta;
          syncThreadSessionFromMeta(refreshedMeta, {
            engineSessionId: refreshedMeta.providerSessionId || refreshedMeta.id,
            ownerState: "idle",
            activeTurnId: null,
          });
        });

      return {
        threadId: threadMeta.id,
        turnId: turnContext.turnId,
      };
    },
    async syncImportedThreads() {
      await adapter.syncImportedThreads();
    },
  };
}
