// FILE: runtime-manager/types.ts
// Purpose: Shared constants and TypeScript contracts for runtime-manager module boundaries.

import type {
  HistoryCursorShape,
  JsonRpcEnvelope,
  PlanModeStateShape,
  RuntimeInputItem,
  RuntimeItemShape,
  RuntimeThreadShape,
  RuntimeTurnShape,
} from "../bridge-types";
import type { RuntimeStore, RuntimeSessionMeta } from "../runtime-store";

export const ERROR_METHOD_NOT_FOUND = -32601;
export const ERROR_INVALID_PARAMS = -32602;
export const ERROR_INTERNAL = -32603;
export const ERROR_THREAD_NOT_FOUND = -32004;
export const EXTERNAL_SYNC_INTERVAL_MS = 10_000;
export const DEFAULT_HISTORY_WINDOW_LIMIT = 50;
export const DEFAULT_THREAD_LIST_PAGE_SIZE = 60;
export const CODEX_HISTORY_CACHE_THREAD_LIMIT = 20;
export const CODEX_HISTORY_CACHE_MESSAGE_LIMIT = 500;
export const HISTORY_CURSOR_VERSION = 1;
export const CODEX_OBSERVED_THREAD_POLL_INTERVAL_MS = 2_000;
export const CODEX_OBSERVED_THREAD_IDLE_TTL_MS = 10 * 60 * 1000;
export const CODEX_OBSERVED_THREAD_ERROR_BACKOFF_MS = 5_000;
export const CODEX_OBSERVED_THREAD_LIMIT = 3;

export type RuntimeRpcEnvelope = JsonRpcEnvelope;
export type RuntimeHistoryCursor =
  Omit<HistoryCursorShape, "sessionId"> & { sessionId?: string };

export interface RuntimeHistoryRequest {
  mode: "tail" | "before" | "after";
  limit: number;
  cursor: RuntimeHistoryCursor | null;
  rawCursor?: string | null;
}

export interface RuntimeHistoryRecord {
  turnId: string;
  turnMeta: RuntimeTurnShape & { id: string; createdAt: string };
  itemObject: RuntimeItemShape & Record<string, unknown>;
  createdAt: string;
  createdAtMs: number;
  ordinal: number;
  turnIndex: number;
  itemIndex: number;
}

export interface RuntimeHistorySnapshot {
  sessionId: string;
  records: RuntimeHistoryRecord[];
}

export interface RuntimeSessionListPayload {
  threads: RuntimeThreadShape[];
  nextCursor?: string | number | null;
  hasMore?: boolean;
  pageSize?: number | null;
}

export interface ManagedSessionMeta extends RuntimeSessionMeta {}

export interface RuntimeCommandPreviewContext {
  command: string | null;
  status: string | null;
  exitCode?: number | null;
}

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

export interface RuntimeThreadWindowDependencies {
  compareHistoryRecord(left: RuntimeHistoryRecord, right: RuntimeHistoryRecord): number;
  historyCursorForRecord(sessionId: string, record: RuntimeHistoryRecord): string | null;
  historyRecordAnchor(record: RuntimeHistoryRecord): RuntimeHistoryCursor;
}

export interface RuntimeInputNormalizerDependencies {
  normalizeOptionalString(value: unknown): string | null;
}

export interface ManagedProviderSessionMeta extends RuntimeSessionMeta {}

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

export interface ManagedProviderStartTurnOptions {
  params: Record<string, unknown>;
  sessionMeta: ManagedProviderSessionMeta;
  turnContext: ManagedProviderTurnContext;
}

export interface ManagedProviderTurnResult {
  usage?: unknown;
}

export interface ManagedProviderAdapter {
  hydrateSession(sessionMeta: RuntimeSessionMeta): Promise<void>;
  startTurn(options: ManagedProviderStartTurnOptions): Promise<ManagedProviderTurnResult | void>;
  syncImportedSessions(): Promise<void>;
}

export interface ManagedProviderAdapterFactoryOptions {
  store: RuntimeStore;
  logPrefix?: string;
  sdkLoader?: () => Promise<unknown>;
}

export interface RuntimeNormalizedPlanState extends PlanModeStateShape {}
export type RuntimeNormalizedInputItem = RuntimeInputItem;
