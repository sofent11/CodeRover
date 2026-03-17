// FILE: runtime-manager/types.ts
// Purpose: Shared constants and TypeScript contracts for runtime-manager module boundaries.

import type {
  JsonRpcEnvelope,
  PlanModeStateShape,
  RuntimeInputItem,
  RuntimeItemShape,
  RuntimeThreadShape,
} from "../bridge-types";
import type { RuntimeStore, RuntimeSessionMeta } from "../runtime-store";

export const ERROR_METHOD_NOT_FOUND = -32601;
export const ERROR_INVALID_PARAMS = -32602;
export const ERROR_INTERNAL = -32603;
export const ERROR_THREAD_NOT_FOUND = -32004;
export const EXTERNAL_SYNC_INTERVAL_MS = 10_000;
export const DEFAULT_THREAD_LIST_PAGE_SIZE = 60;

export type RuntimeRpcEnvelope = JsonRpcEnvelope;

export interface ManagedSessionMeta extends RuntimeSessionMeta {}

export interface RuntimeInitializeParams {
  clientInfo: {
    name: string;
    title: string;
    version: string;
  };
  capabilities: {
    experimentalApi: boolean;
  };
}

export interface RuntimeErrorShape extends Error {
  code?: number;
  data?: unknown;
}

export interface RuntimeRoutingHelpers {
  normalizeOptionalString(value: unknown): string | null;
  normalizePositiveInteger(value: unknown): number | null;
  normalizeTimestampString(value: unknown): string | null;
}

export interface RuntimeSessionMetaHelpers extends RuntimeRoutingHelpers {
  asObject(value: unknown): Record<string, unknown>;
  firstNonEmptyString(values: unknown[]): string | null;
  getRuntimeProvider(providerId: unknown): { title: string; supports: Record<string, unknown> };
  resolveProviderId(value: unknown): string;
}

export interface ManagedProviderTurnContext {
  inputItems: RuntimeInputItem[];
  abortController: AbortController;
  setInterruptHandler(handler: () => Promise<void> | void): void;
  bindProviderSession(sessionId: string): void;
  requestStructuredInput(request: Record<string, unknown>): Promise<unknown>;
  requestApproval(request: Record<string, unknown>): Promise<unknown>;
  updateCommandExecution(payload: unknown): void;
  appendToolCallDelta(delta: string, options?: Record<string, unknown>): void;
  appendAgentDelta(delta: string, options?: Record<string, unknown>): void;
  appendReasoningDelta(delta: string, options?: Record<string, unknown>): void;
  upsertPlan(planState: Record<string, unknown>, options?: Record<string, unknown>): void;
  updatePreview(preview: string): void;
}

export interface RuntimeNormalizedPlanState extends PlanModeStateShape {}
export type RuntimeNormalizedInputItem = RuntimeInputItem;
