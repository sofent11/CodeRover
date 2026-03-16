// FILE: runtime-manager/codex-history.ts
// Purpose: Typed history-window and cursor helpers for Codex-backed thread reads.

import type { RuntimeItemShape, RuntimeThreadShape } from "../bridge-types";
import type {
  RuntimeHistoryCursor,
  RuntimeHistoryRecord,
  RuntimeHistoryRequest,
  RuntimeHistorySnapshot,
  RuntimeThreadWindowDependencies,
} from "./types";

type UnknownRecord = Record<string, unknown>;
type StripProviderField = <TValue>(params: TValue) => Omit<TValue, "provider"> | TValue;
type NormalizeOptionalString = (value: unknown) => string | null;
const MAX_HISTORY_INLINE_IMAGE_URL_BYTES = 128 * 1024;

interface ThreadListLike {
  id?: string;
  updatedAt?: string | null;
  [key: string]: unknown;
}

interface UpstreamHistoryWindowLike {
  hasOlder?: boolean;
  hasNewer?: boolean;
}

interface UpstreamHistoryWindowResponse {
  thread: RuntimeThreadShape | null;
  historyWindow: {
    mode: RuntimeHistoryRequest["mode"];
    olderCursor: string | null;
    newerCursor: string | null;
    oldestAnchor: RuntimeHistoryCursor | null;
    newestAnchor: RuntimeHistoryCursor | null;
    hasOlder: boolean;
    hasNewer: boolean;
    isPartial: true;
    servedFromCache: false;
    pageSize: number;
  };
}

export function extractThreadArray(
  result: unknown,
  extractArray: (value: unknown, candidatePaths: string[]) => unknown[]
): unknown[] {
  return extractArray(result, ["data", "items", "threads"]);
}

export function extractThreadFromResult(result: unknown): RuntimeThreadShape | null {
  if (!result || typeof result !== "object") {
    return null;
  }
  const thread = (result as UnknownRecord).thread;
  return thread && typeof thread === "object" ? (thread as RuntimeThreadShape) : null;
}

export function extractHistoryWindowFromResult(result: unknown): UnknownRecord | null {
  if (!result || typeof result !== "object") {
    return null;
  }
  const windowObject = (result as UnknownRecord).historyWindow
    ?? (result as UnknownRecord).history_window;
  return windowObject && typeof windowObject === "object" && !Array.isArray(windowObject)
    ? (windowObject as UnknownRecord)
    : null;
}

export function buildUpstreamCodexHistoryParams(
  params: Record<string, unknown> | null | undefined,
  historyRequest: RuntimeHistoryRequest | null,
  stripProviderField: StripProviderField
): Record<string, unknown> {
  const upstreamParams = {
    ...stripProviderField(params || {}),
  };
  if (!historyRequest) {
    return upstreamParams;
  }

  upstreamParams.history = {
    mode: historyRequest.mode,
    limit: historyRequest.limit,
  };
  if (historyRequest.mode !== "tail") {
    if (historyRequest.rawCursor) {
      (upstreamParams.history as Record<string, unknown>).cursor = historyRequest.rawCursor;
    }
    if (historyRequest.cursor) {
      (upstreamParams.history as Record<string, unknown>).anchor = historyRequest.cursor;
    }
  }
  return upstreamParams;
}

export function buildUpstreamHistoryWindowResponse(
  snapshot: RuntimeHistorySnapshot,
  historyRequest: RuntimeHistoryRequest,
  upstreamHistoryWindow: UpstreamHistoryWindowLike | null | undefined,
  thread: RuntimeThreadShape | null,
  dependencies: RuntimeThreadWindowDependencies
): UpstreamHistoryWindowResponse {
  const records = [...(snapshot?.records || [])].sort(dependencies.compareHistoryRecord);
  const oldestRecord = records.length > 0 ? records[0] : null;
  const newestRecord = records.length > 0 ? records[records.length - 1] : null;
  return {
    thread,
    historyWindow: {
      mode: historyRequest.mode,
      olderCursor: oldestRecord ? dependencies.historyCursorForRecord(snapshot.threadId, oldestRecord) : null,
      newerCursor: newestRecord ? dependencies.historyCursorForRecord(snapshot.threadId, newestRecord) : null,
      oldestAnchor: oldestRecord ? dependencies.historyRecordAnchor(oldestRecord) : null,
      newestAnchor: newestRecord ? dependencies.historyRecordAnchor(newestRecord) : null,
      hasOlder: Boolean(upstreamHistoryWindow?.hasOlder),
      hasNewer: Boolean(upstreamHistoryWindow?.hasNewer),
      isPartial: true,
      servedFromCache: false,
      pageSize: records.length,
    },
  };
}

export function extractArray(
  value: unknown,
  candidatePaths: string[],
  readPath: (root: unknown, path: string) => unknown
): unknown[] {
  if (!value) {
    return [];
  }

  for (const candidatePath of candidatePaths) {
    const candidateValue = readPath(value, candidatePath);
    if (Array.isArray(candidateValue)) {
      return candidateValue;
    }
  }

  return [];
}

export function readPath(root: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = root;
  for (const part of parts) {
    if (!current || typeof current !== "object") {
      return null;
    }
    current = (current as UnknownRecord)[part];
  }
  return current;
}

export function mergeThreadLists<TThread extends ThreadListLike>(threads: TThread[]): TThread[] {
  const seen = new Map<string, TThread>();
  for (const thread of threads) {
    if (!thread || typeof thread !== "object" || !thread.id) {
      continue;
    }
    const previous = seen.get(thread.id);
    if (!previous) {
      seen.set(thread.id, thread);
      continue;
    }
    const previousUpdated = Date.parse(previous.updatedAt || "0") || 0;
    const nextUpdated = Date.parse(thread.updatedAt || "0") || 0;
    if (nextUpdated >= previousUpdated) {
      seen.set(thread.id, thread);
    }
  }

  return [...seen.values()].sort((left, right) => {
    const leftUpdated = Date.parse(left.updatedAt || "0") || 0;
    const rightUpdated = Date.parse(right.updatedAt || "0") || 0;
    if (leftUpdated !== rightUpdated) {
      return rightUpdated - leftUpdated;
    }
    return String(left.id).localeCompare(String(right.id));
  });
}

export function extractThreadListCursor(
  result: unknown,
  normalizeOptionalString: NormalizeOptionalString
): string | number | null {
  const record = result && typeof result === "object" ? (result as UnknownRecord) : null;
  const cursor = record?.nextCursor ?? record?.next_cursor ?? null;
  if (cursor == null) {
    return null;
  }
  if (typeof cursor === "string") {
    const normalized = normalizeOptionalString(cursor);
    return normalized || null;
  }
  return typeof cursor === "number" ? cursor : null;
}

export function sanitizeHistoryItemForTransport(itemObject: RuntimeItemShape): RuntimeItemShape {
  const clone = JSON.parse(JSON.stringify(itemObject || {})) as RuntimeItemShape & Record<string, unknown>;
  if (!Array.isArray(clone.content)) {
    return clone;
  }

  clone.content = clone.content.map((entry) => sanitizeHistoryContentEntryForTransport(entry));
  return clone;
}

export function sanitizeThreadHistoryForTransport(thread: RuntimeThreadShape | null): RuntimeThreadShape | null {
  if (!thread) {
    return null;
  }
  const clone = JSON.parse(JSON.stringify(thread)) as RuntimeThreadShape;
  if (!Array.isArray(clone.turns)) {
    return clone;
  }
  clone.turns = clone.turns.map((turn) => {
    if (!turn || typeof turn !== "object" || !Array.isArray(turn.items)) {
      return turn;
    }
    return {
      ...turn,
      items: turn.items.map((item) => sanitizeHistoryItemForTransport(item)),
    };
  });
  return clone;
}

export function sanitizeThreadResultForTransport(
  result: unknown,
  extractThread: (value: unknown) => RuntimeThreadShape | null
): unknown {
  const record = result && typeof result === "object" ? (result as UnknownRecord) : null;
  const thread = extractThread(record);
  if (!thread || !record) {
    return result;
  }
  return {
    ...record,
    thread: sanitizeThreadHistoryForTransport(thread),
  };
}

function sanitizeHistoryContentEntryForTransport(entry: unknown): unknown {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return entry;
  }

  const clone = JSON.parse(JSON.stringify(entry)) as Record<string, unknown>;
  for (const key of ["url", "image_url"]) {
    const value = clone[key];
    if (typeof value !== "string" || !value.startsWith("data:image")) {
      continue;
    }
    if (Buffer.byteLength(value, "utf8") <= MAX_HISTORY_INLINE_IMAGE_URL_BYTES) {
      continue;
    }
    delete clone[key];
    clone.omittedLargeInlineImage = true;
  }
  return clone;
}
