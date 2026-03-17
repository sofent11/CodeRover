// FILE: runtime-engine/types.ts
// Purpose: Shared bridge-internal runtime engine types for session ownership, provider control, events, and projection.

import type { RuntimeThreadShape } from "../bridge-types";
import type { RuntimeStore, RuntimeSessionMeta } from "../runtime-store";

export type RuntimeOwnerState = "idle" | "running" | "waiting_for_client" | "closed";

export interface RuntimeSessionHandle {
  sessionId: string;
  provider: string;
  engineSessionId: string | null;
  providerSessionId: string | null;
  cwd: string | null;
  mode: string | null;
  model: string | null;
  ownerState: RuntimeOwnerState;
  activeTurnId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeThreadStartedEvent {
  kind: "thread_started";
  thread: RuntimeThreadShape;
}

export interface RuntimeTurnStartedEvent {
  kind: "turn_started";
  sessionId: string;
  turnId: string;
}

export interface RuntimeTurnCompletedEvent {
  kind: "turn_completed";
  sessionId: string;
  turnId: string;
  status: string | null;
}

export interface RuntimeAssistantDeltaEvent {
  kind: "assistant_delta";
  sessionId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface RuntimeReasoningDeltaEvent {
  kind: "reasoning_delta";
  sessionId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface RuntimePlanUpdateEvent {
  kind: "plan_update";
  sessionId: string;
  turnId: string;
  itemId: string;
  explanation: string | null;
  summary: string | null;
  plan: unknown[];
  delta: string;
}

export interface RuntimeToolDeltaEvent {
  kind: "tool_delta";
  sessionId: string;
  turnId: string;
  itemId: string;
  delta: string;
  toolName: string | null;
  changes: unknown[];
  completed: boolean;
}

export interface RuntimeCommandDeltaEvent {
  kind: "command_delta";
  sessionId: string;
  turnId: string;
  itemId: string;
  command: string | null;
  cwd: string | null;
  status: string | null;
  exitCode: number | null;
  durationMs: number | null;
  delta: string;
}

export interface RuntimeApprovalRequestEvent {
  kind: "approval_request";
  sessionId: string;
  turnId: string;
  itemId: string;
  method: string;
  command: string | null;
  reason: string | null;
  toolName: string | null;
}

export interface RuntimeUserInputRequestEvent {
  kind: "user_input_request";
  sessionId: string;
  turnId: string;
  itemId: string;
  questions: unknown;
}

export interface RuntimeTokenUsageEvent {
  kind: "token_usage";
  sessionId: string;
  usage: Record<string, unknown>;
}

export interface RuntimeErrorEvent {
  kind: "runtime_error";
  sessionId: string;
  turnId: string;
  message: string;
}

export type RuntimeEvent =
  | RuntimeThreadStartedEvent
  | RuntimeTurnStartedEvent
  | RuntimeTurnCompletedEvent
  | RuntimeAssistantDeltaEvent
  | RuntimeReasoningDeltaEvent
  | RuntimePlanUpdateEvent
  | RuntimeToolDeltaEvent
  | RuntimeCommandDeltaEvent
  | RuntimeApprovalRequestEvent
  | RuntimeUserInputRequestEvent
  | RuntimeTokenUsageEvent
  | RuntimeErrorEvent;

export interface RuntimeEngine {
  initialize(clientCaps?: Record<string, unknown>): Promise<void>;
  listProviders(): Promise<unknown>;
  listModels(provider: string, params?: Record<string, unknown>): Promise<unknown>;
  ensureSession(sessionId: string, params?: Record<string, unknown>): Promise<RuntimeSessionHandle>;
  startTurn(
    sessionId: string,
    input: unknown,
    options?: Record<string, unknown>
  ): Promise<{ sessionId: string; turnId: string }>;
  interruptTurn(sessionId: string, turnId?: string | null): Promise<unknown>;
  steerTurn(sessionId: string, turnId: string, prompt: string): Promise<unknown>;
  resumeSession(sessionId: string, params?: Record<string, unknown>): Promise<unknown>;
  shutdown(): void;
}

export interface ProviderRuntimeEngine {
  providerId: string;
  compactSession?(sessionMeta: RuntimeSessionMeta, params?: Record<string, unknown>): Promise<unknown>;
  ensureSession(
    sessionMeta: RuntimeSessionMeta,
    params?: Record<string, unknown>
  ): Promise<RuntimeSessionHandle>;
  initialize(clientCaps?: Record<string, unknown>): Promise<void>;
  interruptTurn(sessionMeta: RuntimeSessionMeta, params?: Record<string, unknown>): Promise<unknown>;
  listModels(params?: Record<string, unknown>): Promise<unknown>;
  listSessions(params?: Record<string, unknown>): Promise<RuntimeThreadShape[]>;
  lookupSessionMeta?(sessionId: string, store: RuntimeStore): Promise<RuntimeSessionMeta | null>;
  readSession(
    sessionMeta: RuntimeSessionMeta,
    params?: Record<string, unknown>,
    historyRequest?: unknown
  ): Promise<unknown>;
  resumeSession(sessionMeta: RuntimeSessionMeta, params?: Record<string, unknown>): Promise<unknown>;
  shutdown(): void;
  startSession(params?: Record<string, unknown>): Promise<unknown>;
  startTurn(sessionMeta: RuntimeSessionMeta, params?: Record<string, unknown>): Promise<unknown>;
  steerTurn?(sessionMeta: RuntimeSessionMeta, params?: Record<string, unknown>): Promise<unknown>;
  syncImportedSessions?(): Promise<void>;
}
