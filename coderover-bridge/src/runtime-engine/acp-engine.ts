// FILE: runtime-engine/acp-engine.ts
// Purpose: Bridge-internal ACP-style runtime engine that maps session lifecycle updates onto RuntimeEvents.

import { randomUUID } from "crypto";

import type {
  RuntimeApprovalRequestEvent,
  RuntimeEvent,
  RuntimeSessionHandle,
  RuntimeUserInputRequestEvent,
} from "./types";

export interface AcpPromptResult {
  stopReason?: string | null;
  usage?: unknown;
}

export interface AcpSessionRecord {
  sessionId: string;
  providerSessionId?: string | null;
}

export interface AcpAssistantDeltaUpdate {
  type: "assistant_delta";
  itemId?: string;
  delta: string;
}

export interface AcpReasoningDeltaUpdate {
  type: "reasoning_delta";
  itemId?: string;
  delta: string;
}

export interface AcpPlanUpdate {
  type: "plan_update";
  itemId?: string;
  explanation?: string | null;
  summary?: string | null;
  plan?: unknown[];
  delta?: string | null;
}

export interface AcpToolDeltaUpdate {
  type: "tool_delta";
  itemId?: string;
  delta?: string | null;
  toolName?: string | null;
  changes?: unknown[];
  completed?: boolean;
}

export interface AcpCommandDeltaUpdate {
  type: "command_delta";
  itemId?: string;
  command?: string | null;
  cwd?: string | null;
  status?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
  delta?: string | null;
}

export interface AcpApprovalRequestUpdate {
  type: "approval_request";
  itemId?: string;
  method?: string | null;
  command?: string | null;
  reason?: string | null;
  toolName?: string | null;
  respond(decision: unknown): Promise<void> | void;
}

export interface AcpUserInputRequestUpdate {
  type: "user_input_request";
  itemId?: string;
  questions: unknown;
  respond(answer: unknown): Promise<void> | void;
}

export interface AcpTokenUsageUpdate {
  type: "token_usage";
  usage: Record<string, unknown>;
}

export interface AcpRuntimeErrorUpdate {
  type: "runtime_error";
  message: string;
}

export type AcpSessionUpdate =
  | AcpAssistantDeltaUpdate
  | AcpReasoningDeltaUpdate
  | AcpPlanUpdate
  | AcpToolDeltaUpdate
  | AcpCommandDeltaUpdate
  | AcpApprovalRequestUpdate
  | AcpUserInputRequestUpdate
  | AcpTokenUsageUpdate
  | AcpRuntimeErrorUpdate;

export interface AcpTransport {
  cancel(sessionId: string, turnId?: string | null): Promise<void>;
  initialize(clientCaps?: Record<string, unknown>): Promise<void>;
  loadSession?(params: {
    sessionId: string;
    cwd?: string | null;
  }): Promise<AcpSessionRecord>;
  newSession(params: {
    cwd?: string | null;
    provider: string;
    model?: string | null;
    mode?: string | null;
  }): Promise<AcpSessionRecord>;
  prompt(params: {
    sessionId: string;
    input: unknown;
    options?: Record<string, unknown>;
    signal: AbortSignal;
    onUpdate(update: AcpSessionUpdate): Promise<void> | void;
  }): Promise<AcpPromptResult>;
  shutdown(): void;
}

export interface AcpEngineClientBridge {
  emitRuntimeEvent(event: RuntimeEvent): void;
  requestApproval(event: RuntimeApprovalRequestEvent): Promise<unknown>;
  requestStructuredInput(event: RuntimeUserInputRequestEvent): Promise<unknown>;
}

export interface AcpEngine {
  ensureSession(params: {
    sessionId: string;
    cwd?: string | null;
    model?: string | null;
    mode?: string | null;
    providerSessionId?: string | null;
  }): Promise<RuntimeSessionHandle>;
  initialize(clientCaps?: Record<string, unknown>): Promise<void>;
  interruptTurn(sessionId: string, turnId?: string | null): Promise<void>;
  shutdown(): void;
  startTurn(params: {
    sessionId: string;
    input: unknown;
    cwd?: string | null;
    model?: string | null;
    mode?: string | null;
    providerSessionId?: string | null;
    options?: Record<string, unknown>;
  }): Promise<{ sessionId: string; turnId: string }>;
}

export function createAcpEngine({
  provider,
  transport,
  clientBridge,
}: {
  provider: string;
  transport: AcpTransport;
  clientBridge: AcpEngineClientBridge;
}): AcpEngine {
  const sessions = new Map<string, RuntimeSessionHandle>();
  const abortControllers = new Map<string, AbortController>();

  async function initialize(clientCaps?: Record<string, unknown>): Promise<void> {
    await transport.initialize(clientCaps);
  }

  async function ensureSession({
    sessionId,
    cwd = null,
    model = null,
    mode = null,
    providerSessionId = null,
  }: {
    sessionId: string;
    cwd?: string | null;
    model?: string | null;
    mode?: string | null;
    providerSessionId?: string | null;
  }): Promise<RuntimeSessionHandle> {
    const existing = sessions.get(sessionId) || null;
    if (existing?.engineSessionId) {
      return {
        ...existing,
        cwd: cwd ?? existing.cwd,
        model: model ?? existing.model,
        mode: mode ?? existing.mode,
      };
    }

    const nextSession = providerSessionId && transport.loadSession
      ? await transport.loadSession({
        sessionId: providerSessionId,
        cwd,
      }).catch(async () => transport.newSession({
        cwd,
        provider,
        model,
        mode,
      }))
      : await transport.newSession({
        cwd,
        provider,
        model,
        mode,
      });

    const now = new Date().toISOString();
    const handle: RuntimeSessionHandle = {
      sessionId,
      provider,
      engineSessionId: nextSession.sessionId,
      providerSessionId: nextSession.providerSessionId || nextSession.sessionId,
      cwd,
      mode,
      model,
      ownerState: "idle",
      activeTurnId: null,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    sessions.set(sessionId, handle);
    return { ...handle };
  }

  async function startTurn({
    sessionId,
    input,
    cwd = null,
    model = null,
    mode = null,
    providerSessionId = null,
    options = {},
  }: {
    sessionId: string;
    input: unknown;
    cwd?: string | null;
    model?: string | null;
    mode?: string | null;
    providerSessionId?: string | null;
    options?: Record<string, unknown>;
  }): Promise<{ sessionId: string; turnId: string }> {
    const session = await ensureSession({
      sessionId,
      cwd,
      model,
      mode,
      providerSessionId,
    });
    if (session.ownerState === "running") {
      throw new Error(`Session ${sessionId} already has an active ACP turn`);
    }

    const turnId = randomUUID();
    const abortController = new AbortController();
    abortControllers.set(sessionId, abortController);
    sessions.set(sessionId, {
      ...session,
      ownerState: "running",
      activeTurnId: turnId,
      updatedAt: new Date().toISOString(),
    });
    clientBridge.emitRuntimeEvent({
      kind: "turn_started",
      sessionId,
      turnId,
    });

    void transport.prompt({
      sessionId: session.engineSessionId || session.providerSessionId || sessionId,
      input,
      options,
      signal: abortController.signal,
      onUpdate: async (update) => {
        await handleAcpUpdate({
          provider,
          sessionId,
          turnId,
          update,
          clientBridge,
        });
      },
    }).then((result) => {
      if (result.usage && typeof result.usage === "object") {
        clientBridge.emitRuntimeEvent({
          kind: "token_usage",
          sessionId,
          usage: result.usage as Record<string, unknown>,
        });
      }
      clientBridge.emitRuntimeEvent({
        kind: "turn_completed",
        sessionId,
        turnId,
        status: normalizeStopReason(result.stopReason),
      });
    }).catch((error) => {
      clientBridge.emitRuntimeEvent({
        kind: "runtime_error",
        sessionId,
        turnId,
        message: error instanceof Error ? error.message : String(error),
      });
      clientBridge.emitRuntimeEvent({
        kind: "turn_completed",
        sessionId,
        turnId,
        status: "failed",
      });
    }).finally(() => {
      abortControllers.delete(sessionId);
      const current = sessions.get(sessionId);
      if (!current) {
        return;
      }
      sessions.set(sessionId, {
        ...current,
        ownerState: "idle",
        activeTurnId: null,
        updatedAt: new Date().toISOString(),
      });
    });

    return { sessionId, turnId };
  }

  async function interruptTurn(sessionId: string, turnId?: string | null): Promise<void> {
    const session = sessions.get(sessionId);
    if (!session?.engineSessionId) {
      return;
    }
    abortControllers.get(sessionId)?.abort();
    await transport.cancel(session.engineSessionId, turnId || session.activeTurnId);
  }

  function shutdown(): void {
    for (const controller of abortControllers.values()) {
      controller.abort();
    }
    abortControllers.clear();
    transport.shutdown();
  }

  return {
    ensureSession,
    initialize,
    interruptTurn,
    shutdown,
    startTurn,
  };
}

async function handleAcpUpdate({
  provider,
  sessionId,
  turnId,
  update,
  clientBridge,
}: {
  provider: string;
  sessionId: string;
  turnId: string;
  update: AcpSessionUpdate;
  clientBridge: AcpEngineClientBridge;
}): Promise<void> {
  switch (update.type) {
    case "assistant_delta":
      clientBridge.emitRuntimeEvent({
        kind: "assistant_delta",
        sessionId,
        turnId,
        itemId: update.itemId || `${provider}:${turnId}:assistant`,
        delta: update.delta,
      });
      return;

    case "reasoning_delta":
      clientBridge.emitRuntimeEvent({
        kind: "reasoning_delta",
        sessionId,
        turnId,
        itemId: update.itemId || `${provider}:${turnId}:reasoning`,
        delta: update.delta,
      });
      return;

    case "plan_update":
      clientBridge.emitRuntimeEvent({
        kind: "plan_update",
        sessionId,
        turnId,
        itemId: update.itemId || `${provider}:${turnId}:plan`,
        explanation: normalizeOptionalString(update.explanation),
        summary: normalizeOptionalString(update.summary),
        plan: Array.isArray(update.plan) ? update.plan : [],
        delta: normalizeOptionalString(update.delta)
          || normalizeOptionalString(update.explanation)
          || "Planning...",
      });
      return;

    case "tool_delta":
      clientBridge.emitRuntimeEvent({
        kind: "tool_delta",
        sessionId,
        turnId,
        itemId: update.itemId || `${provider}:${turnId}:tool`,
        delta: normalizeOptionalString(update.delta) || "",
        toolName: normalizeOptionalString(update.toolName),
        changes: Array.isArray(update.changes) ? update.changes : [],
        completed: Boolean(update.completed),
      });
      return;

    case "command_delta":
      clientBridge.emitRuntimeEvent({
        kind: "command_delta",
        sessionId,
        turnId,
        itemId: update.itemId || `${provider}:${turnId}:command`,
        command: normalizeOptionalString(update.command),
        cwd: normalizeOptionalString(update.cwd),
        status: normalizeOptionalString(update.status),
        exitCode: typeof update.exitCode === "number" ? update.exitCode : null,
        durationMs: typeof update.durationMs === "number" ? update.durationMs : null,
        delta: normalizeOptionalString(update.delta) || "",
      });
      return;

    case "approval_request": {
      const event: RuntimeApprovalRequestEvent = {
        kind: "approval_request",
        sessionId,
        turnId,
        itemId: update.itemId || `${provider}:${turnId}:approval`,
        method: normalizeOptionalString(update.method) || "item/tool/requestApproval",
        command: normalizeOptionalString(update.command),
        reason: normalizeOptionalString(update.reason),
        toolName: normalizeOptionalString(update.toolName),
      };
      const response = await clientBridge.requestApproval(event);
      await update.respond(response);
      return;
    }

    case "user_input_request": {
      const event: RuntimeUserInputRequestEvent = {
        kind: "user_input_request",
        sessionId,
        turnId,
        itemId: update.itemId || `${provider}:${turnId}:user-input`,
        questions: update.questions,
      };
      const response = await clientBridge.requestStructuredInput(event);
      await update.respond(response);
      return;
    }

    case "token_usage":
      clientBridge.emitRuntimeEvent({
        kind: "token_usage",
        sessionId,
        usage: update.usage,
      });
      return;

    case "runtime_error":
      clientBridge.emitRuntimeEvent({
        kind: "runtime_error",
        sessionId,
        turnId,
        message: update.message,
      });
      return;
  }
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeStopReason(value: unknown): string {
  const normalized = normalizeOptionalString(value);
  return normalized || "completed";
}
