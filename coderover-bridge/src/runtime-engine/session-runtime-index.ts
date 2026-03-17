// FILE: runtime-engine/session-runtime-index.ts
// Purpose: Persists bridge-local ACP session ownership metadata.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { RuntimeOwnerState, RuntimeSessionHandle } from "./types";

interface SessionRuntimeIndexFileShape {
  version: 1;
  sessions: Record<string, RuntimeSessionHandle>;
}

export interface SessionRuntimeIndex {
  baseDir: string;
  delete(sessionId: unknown): boolean;
  get(sessionId: unknown): RuntimeSessionHandle | null;
  list(): RuntimeSessionHandle[];
  shutdown(): void;
  upsert(record: Partial<RuntimeSessionHandle> & { sessionId: string; provider: string }): RuntimeSessionHandle;
  update(
    sessionId: unknown,
    updater: (record: RuntimeSessionHandle) => RuntimeSessionHandle | null | undefined
  ): RuntimeSessionHandle | null;
}

const INDEX_FILE = "session-runtime-index.json";
const LEGACY_INDEX_FILE = "thread-session-index.json";
const INDEX_VERSION = 1;
const DEFAULT_BASE_DIR = path.join(os.homedir(), ".coderover", "runtime");

export function createSessionRuntimeIndex(
  { baseDir = DEFAULT_BASE_DIR }: { baseDir?: string } = {}
): SessionRuntimeIndex {
  fs.mkdirSync(baseDir, { recursive: true });
  const indexPath = path.join(baseDir, INDEX_FILE);
  const legacyIndexPath = path.join(baseDir, LEGACY_INDEX_FILE);
  let state = loadIndex(indexPath, legacyIndexPath);
  let writeTimer: NodeJS.Timeout | null = null;

  function get(sessionId: unknown): RuntimeSessionHandle | null {
    const normalizedSessionId = normalizeNonEmptyString(sessionId);
    if (!normalizedSessionId) {
      return null;
    }
    const record = state.sessions[normalizedSessionId];
    return record ? { ...record } : null;
  }

  function list(): RuntimeSessionHandle[] {
    return Object.values(state.sessions)
      .map((entry) => ({ ...entry }))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  function upsert(record: Partial<RuntimeSessionHandle> & { sessionId: string; provider: string }): RuntimeSessionHandle {
    const normalized = normalizeSessionHandle(record);
    const existing = state.sessions[normalized.sessionId] || null;
    const nextRecord: RuntimeSessionHandle = {
      ...(existing || normalized),
      ...normalized,
      createdAt: existing?.createdAt || normalized.createdAt,
      updatedAt: normalized.updatedAt || existing?.updatedAt || isoNow(),
    };
    state.sessions[nextRecord.sessionId] = nextRecord;
    scheduleWrite();
    return { ...nextRecord };
  }

  function update(
    sessionId: unknown,
    updater: (record: RuntimeSessionHandle) => RuntimeSessionHandle | null | undefined
  ): RuntimeSessionHandle | null {
    const existing = get(sessionId);
    if (!existing) {
      return null;
    }
    const nextRecord = updater({ ...existing });
    if (!nextRecord) {
      delete state.sessions[existing.sessionId];
      scheduleWrite();
      return null;
    }
    return upsert(nextRecord);
  }

  function remove(sessionId: unknown): boolean {
    const normalizedSessionId = normalizeNonEmptyString(sessionId);
    if (!normalizedSessionId || !state.sessions[normalizedSessionId]) {
      return false;
    }
    delete state.sessions[normalizedSessionId];
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
    const payload = JSON.stringify({
      version: INDEX_VERSION,
      sessions: state.sessions,
    }, null, 2);
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    const tempPath = `${indexPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, `${payload}\n`);
    fs.renameSync(tempPath, indexPath);
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

function loadIndex(indexPath: string, legacyIndexPath: string): SessionRuntimeIndexFileShape {
  const sourcePath = fs.existsSync(indexPath)
    ? indexPath
    : (fs.existsSync(legacyIndexPath) ? legacyIndexPath : null);
  if (!sourcePath) {
    return { version: INDEX_VERSION, sessions: {} };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(sourcePath, "utf8")) as SessionRuntimeIndexFileShape;
    const sessions = parsed?.sessions && typeof parsed.sessions === "object"
      ? Object.entries(parsed.sessions).reduce((result, [sessionId, value]) => {
        const normalized = normalizeSessionHandle({
          ...(value || {}),
          sessionId: normalizeNonEmptyString((value as RuntimeSessionHandle | null)?.sessionId) || sessionId,
          provider: normalizeNonEmptyString((value as RuntimeSessionHandle | null)?.provider) || "codex",
        });
        result[normalized.sessionId] = normalized;
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
  value: Partial<RuntimeSessionHandle> & { sessionId: string; provider: string }
): RuntimeSessionHandle {
  const now = isoNow();
  const sessionId = normalizeNonEmptyString(value.sessionId) || "";
  return {
    sessionId,
    provider: normalizeNonEmptyString(value.provider) || "codex",
    engineSessionId: normalizeNullableString(value.engineSessionId),
    providerSessionId: normalizeNullableString(value.providerSessionId),
    cwd: normalizeNullableString(value.cwd),
    mode: normalizeNullableString(value.mode),
    model: normalizeNullableString(value.model),
    ownerState: normalizeOwnerState(value.ownerState),
    activeTurnId: normalizeNullableString(value.activeTurnId),
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
