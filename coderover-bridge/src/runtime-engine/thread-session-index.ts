// FILE: runtime-engine/thread-session-index.ts
// Purpose: Persists bridge-local thread-to-runtime session ownership metadata.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { readJsonFileWithBackup, writeJsonFileAtomic } from "../atomic-json-file";
import type { RuntimeOwnerState, RuntimeSessionHandle, RuntimeSessionSourceKind } from "./types";

interface ThreadSessionIndexFileShape {
  version: 1;
  sessions: Record<string, RuntimeSessionHandle>;
}

export interface ThreadSessionIndex {
  baseDir: string;
  delete(threadId: unknown): boolean;
  get(threadId: unknown): RuntimeSessionHandle | null;
  list(): RuntimeSessionHandle[];
  shutdown(): void;
  upsert(record: Partial<RuntimeSessionHandle> & { threadId: string; provider: string }): RuntimeSessionHandle;
  update(
    threadId: unknown,
    updater: (record: RuntimeSessionHandle) => RuntimeSessionHandle | null | undefined
  ): RuntimeSessionHandle | null;
}

const INDEX_FILE = "thread-session-index.json";
const INDEX_VERSION = 1;
const DEFAULT_BASE_DIR = path.join(os.homedir(), ".coderover", "runtime");

export function createThreadSessionIndex(
  { baseDir = DEFAULT_BASE_DIR }: { baseDir?: string } = {}
): ThreadSessionIndex {
  fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  const indexPath = path.join(baseDir, INDEX_FILE);
  let state = loadIndex(indexPath);
  let writeTimer: NodeJS.Timeout | null = null;

  function get(threadId: unknown): RuntimeSessionHandle | null {
    const normalizedThreadId = normalizeNonEmptyString(threadId);
    if (!normalizedThreadId) {
      return null;
    }
    const record = state.sessions[normalizedThreadId];
    return record ? { ...record } : null;
  }

  function list(): RuntimeSessionHandle[] {
    return Object.values(state.sessions)
      .map((entry) => ({ ...entry }))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  function upsert(record: Partial<RuntimeSessionHandle> & { threadId: string; provider: string }): RuntimeSessionHandle {
    const normalized = normalizeSessionHandle(record);
    const existing = state.sessions[normalized.threadId] || null;
    const nextRecord: RuntimeSessionHandle = {
      ...(existing || normalized),
      ...normalized,
      createdAt: existing?.createdAt || normalized.createdAt,
      updatedAt: normalized.updatedAt || existing?.updatedAt || isoNow(),
    };
    state.sessions[nextRecord.threadId] = nextRecord;
    scheduleWrite();
    return { ...nextRecord };
  }

  function update(
    threadId: unknown,
    updater: (record: RuntimeSessionHandle) => RuntimeSessionHandle | null | undefined
  ): RuntimeSessionHandle | null {
    const existing = get(threadId);
    if (!existing) {
      return null;
    }
    const nextRecord = updater({ ...existing });
    if (!nextRecord) {
      delete state.sessions[existing.threadId];
      scheduleWrite();
      return null;
    }
    return upsert(nextRecord);
  }

  function remove(threadId: unknown): boolean {
    const normalizedThreadId = normalizeNonEmptyString(threadId);
    if (!normalizedThreadId || !state.sessions[normalizedThreadId]) {
      return false;
    }
    delete state.sessions[normalizedThreadId];
    scheduleWrite();
    return true;
  }

  function scheduleWrite(): void {
    if (writeTimer) {
      return;
    }
    writeTimer = setTimeout(() => {
      writeTimer = null;
      flush();
    }, 10);
    writeTimer.unref?.();
  }

  function flush(): void {
    writeJsonFileAtomic(indexPath, {
      version: INDEX_VERSION,
      sessions: state.sessions,
    });
  }

  return {
    baseDir,
    delete: remove,
    get,
    list,
    shutdown() {
      if (writeTimer) {
        clearTimeout(writeTimer);
        writeTimer = null;
      }
      flush();
    },
    upsert,
    update,
  };
}

function loadIndex(indexPath: string): ThreadSessionIndexFileShape {
  if (!fs.existsSync(indexPath)) {
    return { version: INDEX_VERSION, sessions: {} };
  }

  try {
    const parsed = readJsonFileWithBackup(indexPath) as ThreadSessionIndexFileShape;
    const sessions = parsed?.sessions && typeof parsed.sessions === "object"
      ? Object.entries(parsed.sessions).reduce((result, [threadId, value]) => {
        const normalized = normalizeSessionHandle({
          ...(value || {}),
          threadId,
          provider: normalizeNonEmptyString((value as RuntimeSessionHandle | null)?.provider) || "codex",
        });
        result[threadId] = normalized;
        return result;
      }, {} as Record<string, RuntimeSessionHandle>)
      : {};
    return {
      version: INDEX_VERSION,
      sessions,
    };
  } catch {
    return { version: INDEX_VERSION, sessions: {} };
  }
}

function normalizeSessionHandle(
  value: Partial<RuntimeSessionHandle> & { threadId: string; provider: string }
): RuntimeSessionHandle {
  const now = isoNow();
  return {
    threadId: normalizeNonEmptyString(value.threadId) || "",
    provider: normalizeNonEmptyString(value.provider) || "codex",
    engineSessionId: normalizeNullableString(value.engineSessionId),
    providerSessionId: normalizeNullableString(value.providerSessionId),
    cwd: normalizeNullableString(value.cwd),
    mode: normalizeNullableString(value.mode),
    model: normalizeNullableString(value.model),
    ownerState: normalizeOwnerState(value.ownerState),
    activeTurnId: normalizeNullableString(value.activeTurnId),
    sourceKind: normalizeSourceKind(value.sourceKind),
    syncEpoch: normalizeSyncEpoch(value.syncEpoch),
    rolloutPath: normalizeNullableString(value.rolloutPath),
    lastProjectedCursor: normalizeNullableString(value.lastProjectedCursor),
    takeoverWatermark: normalizeNullableString(value.takeoverWatermark),
    createdAt: normalizeTimestamp(value.createdAt) || now,
    updatedAt: normalizeTimestamp(value.updatedAt) || now,
  };
}

function normalizeNullableString(value: unknown): string | null {
  const normalized = normalizeNonEmptyString(value);
  return normalized || null;
}

function normalizeNonEmptyString(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function normalizeOwnerState(value: unknown): RuntimeOwnerState {
  if (
    value === "idle"
    || value === "running"
    || value === "waiting_for_client"
    || value === "closed"
  ) {
    return value;
  }
  return "idle";
}

function normalizeSourceKind(value: unknown): RuntimeSessionSourceKind {
  if (
    value === "managed_runtime"
    || value === "rollout_observer"
    || value === "thread_read_fallback"
  ) {
    return value;
  }
  return "thread_read_fallback";
}

function normalizeSyncEpoch(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 1) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed >= 1) {
      return Math.floor(parsed);
    }
  }
  return 1;
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function isoNow(): string {
  return new Date().toISOString();
}
