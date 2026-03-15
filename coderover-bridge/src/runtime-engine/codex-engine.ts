// FILE: runtime-engine/codex-engine.ts
// Purpose: Wraps the existing Codex app-server transport behind the bridge runtime engine interface.

import type { RuntimeThreadShape } from "../bridge-types";
import type { CodexAdapter } from "../providers/codex-adapter";
import type { RuntimeThreadMeta } from "../runtime-store";
import type { ProviderRuntimeEngine, RuntimeSessionHandle } from "./types";

type UnknownRecord = Record<string, unknown>;

interface CreateCodexRuntimeEngineOptions {
  codexAdapter: CodexAdapter;
  decorateConversationThread(threadObject: RuntimeThreadShape): RuntimeThreadShape;
  ensureCodexWarm(initializeParams?: Record<string, unknown> | null): Promise<void>;
  extractThreadFromResult(result: unknown): RuntimeThreadShape | null;
  normalizeModelListResult(result: unknown): { items: unknown[] };
  observeCodexThread(
    threadId: unknown,
    options?: { immediate?: boolean; reason?: string }
  ): void;
  sanitizeCodexThreadResult(result: unknown): unknown;
  seedCodexHistoryCacheWithUserInput(
    threadId: string,
    turnId: string | null,
    params: UnknownRecord
  ): void;
  sendThreadStartedNotification(threadObject: RuntimeThreadShape): void;
  stripProviderField<TValue>(params: TValue): Omit<TValue, "provider"> | TValue;
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
}

export function createCodexRuntimeEngine({
  codexAdapter,
  decorateConversationThread,
  ensureCodexWarm,
  extractThreadFromResult,
  normalizeModelListResult,
  observeCodexThread,
  sanitizeCodexThreadResult,
  seedCodexHistoryCacheWithUserInput,
  sendThreadStartedNotification,
  stripProviderField,
  syncThreadSessionFromMeta,
  updateThreadSessionOwnerState,
  upsertOverlayFromThread,
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
  };
}

function asObject(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
