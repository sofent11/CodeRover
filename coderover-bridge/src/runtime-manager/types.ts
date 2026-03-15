// FILE: runtime-manager/types.ts
// Purpose: Shared constants and TypeScript contracts for runtime-manager module boundaries.

import type {
  HistoryCursorShape,
  JsonRpcEnvelope,
  PlanModeStateShape,
  RuntimeInputItem,
  RuntimeThreadShape,
  RuntimeTurnShape,
} from "../bridge-types";

export const ERROR_METHOD_NOT_FOUND = -32601;
export const ERROR_INVALID_PARAMS = -32602;
export const ERROR_INTERNAL = -32603;
export const ERROR_THREAD_NOT_FOUND = -32004;
export const EXTERNAL_SYNC_INTERVAL_MS = 10_000;
export const DEFAULT_HISTORY_WINDOW_LIMIT = 50;
export const DEFAULT_THREAD_LIST_PAGE_SIZE = 60;
export const CODEX_HISTORY_CACHE_THREAD_LIMIT = 20;
export const CODEX_HISTORY_CACHE_MESSAGE_LIMIT = 50;
export const HISTORY_CURSOR_VERSION = 1;
export const CODEX_OBSERVED_THREAD_POLL_INTERVAL_MS = 2_000;
export const CODEX_OBSERVED_THREAD_IDLE_TTL_MS = 10 * 60 * 1000;
export const CODEX_OBSERVED_THREAD_ERROR_BACKOFF_MS = 5_000;
export const CODEX_OBSERVED_THREAD_LIMIT = 3;

export type RuntimeRpcEnvelope = JsonRpcEnvelope;
export type RuntimeHistoryCursor = HistoryCursorShape;

export interface RuntimeHistoryRequest {
  mode: "tail" | "before" | "after";
  limit: number;
  cursor: RuntimeHistoryCursor | null;
}

export interface RuntimeHistoryRecord {
  turnId: string;
  turnMeta: RuntimeTurnShape & { id: string; createdAt: string };
  itemObject: Record<string, unknown>;
  createdAt: string;
  createdAtMs: number;
  ordinal: number;
  turnIndex: number;
  itemIndex: number;
}

export interface RuntimeHistorySnapshot {
  threadId: string;
  records: RuntimeHistoryRecord[];
}

export interface RuntimeThreadListPayload {
  threads: RuntimeThreadShape[];
  nextCursor?: string | number | null;
  hasMore?: boolean;
  pageSize?: number | null;
}

export interface ManagedThreadMeta extends RuntimeThreadShape {
  id: string;
  provider: string;
  providerSessionId: string | null;
}

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

export interface RuntimeThreadMetaHelpers extends RuntimeRoutingHelpers {
  asObject(value: unknown): Record<string, unknown>;
  firstNonEmptyString(values: unknown[]): string | null;
  getRuntimeProvider(providerId: unknown): { title: string; supports: Record<string, unknown> };
  resolveProviderId(value: unknown): string;
}

export interface RuntimeThreadWindowDependencies {
  compareHistoryRecord(left: RuntimeHistoryRecord, right: RuntimeHistoryRecord): number;
  historyCursorForRecord(threadId: string, record: RuntimeHistoryRecord): string | null;
  historyRecordAnchor(record: RuntimeHistoryRecord): RuntimeHistoryCursor;
}

export interface RuntimeInputNormalizerDependencies {
  normalizeOptionalString(value: unknown): string | null;
}

export interface RuntimeNormalizedPlanState extends PlanModeStateShape {}
export type RuntimeNormalizedInputItem = RuntimeInputItem;
