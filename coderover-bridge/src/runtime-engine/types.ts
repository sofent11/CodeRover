// FILE: runtime-engine/types.ts
// Purpose: Shared bridge-internal runtime engine types for session ownership, provider control, events, and projection.

import type { RuntimeThreadShape } from "../bridge-types";
import type { RuntimeThreadMeta } from "../runtime-store";

export type RuntimeOwnerState = "idle" | "running" | "waiting_for_client" | "closed";

export interface RuntimeSessionHandle {
  threadId: string;
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
  threadId: string;
  turnId: string;
}

export interface RuntimeTurnCompletedEvent {
  kind: "turn_completed";
  threadId: string;
  turnId: string;
  status: string | null;
}

export interface RuntimeAssistantDeltaEvent {
  kind: "assistant_delta";
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface RuntimeReasoningDeltaEvent {
  kind: "reasoning_delta";
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface RuntimePlanUpdateEvent {
  kind: "plan_update";
  threadId: string;
  turnId: string;
  itemId: string;
  explanation: string | null;
  summary: string | null;
  plan: unknown[];
  delta: string;
}

export interface RuntimeToolDeltaEvent {
  kind: "tool_delta";
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
  toolName: string | null;
  changes: unknown[];
  completed: boolean;
}

export interface RuntimeCommandDeltaEvent {
  kind: "command_delta";
  threadId: string;
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
  threadId: string;
  turnId: string;
  itemId: string;
  method: string;
  command: string | null;
  reason: string | null;
  toolName: string | null;
}

export interface RuntimeUserInputRequestEvent {
  kind: "user_input_request";
  threadId: string;
  turnId: string;
  itemId: string;
  questions: unknown;
}

export interface RuntimeTokenUsageEvent {
  kind: "token_usage";
  threadId: string;
  usage: Record<string, unknown>;
}

export interface RuntimeErrorEvent {
  kind: "runtime_error";
  threadId: string;
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
  ensureSession(threadId: string, params?: Record<string, unknown>): Promise<RuntimeSessionHandle>;
  startTurn(
    threadId: string,
    input: unknown,
    options?: Record<string, unknown>
  ): Promise<{ threadId: string; turnId: string }>;
  interruptTurn(threadId: string, turnId?: string | null): Promise<unknown>;
  steerTurn(threadId: string, turnId: string, prompt: string): Promise<unknown>;
  resumeThread(threadId: string, params?: Record<string, unknown>): Promise<unknown>;
  shutdown(): void;
}

export interface ProviderRuntimeEngine {
  providerId: string;
  compactThread?(threadMeta: RuntimeThreadMeta, params?: Record<string, unknown>): Promise<unknown>;
  ensureSession(
    threadMeta: RuntimeThreadMeta,
    params?: Record<string, unknown>
  ): Promise<RuntimeSessionHandle>;
  initialize(clientCaps?: Record<string, unknown>): Promise<void>;
  interruptTurn(threadMeta: RuntimeThreadMeta, params?: Record<string, unknown>): Promise<unknown>;
  listModels(params?: Record<string, unknown>): Promise<unknown>;
  resumeThread(threadMeta: RuntimeThreadMeta, params?: Record<string, unknown>): Promise<unknown>;
  shutdown(): void;
  startThread(params?: Record<string, unknown>): Promise<unknown>;
  startTurn(threadMeta: RuntimeThreadMeta, params?: Record<string, unknown>): Promise<unknown>;
  steerTurn?(threadMeta: RuntimeThreadMeta, params?: Record<string, unknown>): Promise<unknown>;
}
