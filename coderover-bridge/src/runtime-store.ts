// FILE: runtime-store.ts
// Purpose: Provider-aware local overlay store for CodeRover runtime sessions and histories.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";

type ProviderId = "codex" | "claude" | "gemini";
type UnknownRecord = Record<string, unknown>;

export interface RuntimeStoreItem {
  id: string;
  type: string;
  role: string | null;
  content: UnknownRecord[];
  text: string | null;
  message: string | null;
  createdAt: string;
  status: string | null;
  command: string | null;
  metadata: UnknownRecord | null;
  plan: UnknownRecord[] | UnknownRecord | null;
  summary: string | null;
  fileChanges: UnknownRecord[];
  [key: string]: unknown;
}

export interface RuntimeStoreTurn {
  id: string;
  createdAt: string;
  status: string | null;
  items: RuntimeStoreItem[];
}

export interface RuntimeSessionHistory {
  sessionId: string;
  turns: RuntimeStoreTurn[];
}

export interface RuntimeSessionMeta {
  id: string;
  provider: ProviderId;
  providerSessionId: string | null;
  title: string | null;
  name: string | null;
  preview: string | null;
  cwd: string | null;
  model: string | null;
  metadata: UnknownRecord | null;
  capabilities: UnknownRecord | null;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

interface RuntimeStoreIndex {
  version: number;
  sessions: Record<string, RuntimeSessionMeta>;
  providerSessions: Record<string, string>;
}

export interface CreateSessionInput {
  id?: string | null;
  provider?: unknown;
  providerSessionId?: string | null;
  title?: string | null;
  name?: string | null;
  preview?: string | null;
  cwd?: string | null;
  model?: string | null;
  metadata?: UnknownRecord | null;
  capabilities?: UnknownRecord | null;
  createdAt?: string | number | Date | null;
  updatedAt?: string | number | Date | null;
  archived?: boolean;
}

export interface RuntimeStore {
  baseDir: string;
  createSession(input: CreateSessionInput): RuntimeSessionMeta;
  deleteSession(sessionId: unknown): boolean;
  findSessionIdByProviderSession(provider: unknown, providerSessionId: unknown): string | null;
  flush(): void;
  getSessionHistory(sessionId: unknown): RuntimeSessionHistory | null;
  getSessionMeta(sessionId: unknown): RuntimeSessionMeta | null;
  listSessionMetas(): RuntimeSessionMeta[];
  saveSessionHistory(sessionId: unknown, history: unknown): RuntimeSessionHistory;
  shutdown(): void;
  bindProviderSession(sessionId: unknown, provider: unknown, providerSessionId: unknown): RuntimeSessionMeta | null;
  updateSessionMeta(
    sessionId: unknown,
    updater: (entry: RuntimeSessionMeta) => RuntimeSessionMeta | null | undefined
  ): RuntimeSessionMeta | null;
  upsertSessionMeta(sessionMeta: unknown): RuntimeSessionMeta;
}

const DEFAULT_STORE_DIR = path.join(os.homedir(), ".coderover", "runtime");
const INDEX_FILE = "index.json";
const SESSIONS_DIR = "sessions";
const INDEX_VERSION = 1;

export function createRuntimeStore({ baseDir = DEFAULT_STORE_DIR }: { baseDir?: string } = {}): RuntimeStore {
  const indexPath = path.join(baseDir, INDEX_FILE);
  const sessionsDir = path.join(baseDir, SESSIONS_DIR);
  fs.mkdirSync(sessionsDir, { recursive: true });

  let indexState = loadIndex(indexPath);
  let writeTimer: NodeJS.Timeout | null = null;

  function listSessionMetas(): RuntimeSessionMeta[] {
    return Object.values(indexState.sessions)
      .map((entry) => ({ ...entry }))
      .sort(compareSessionMeta);
  }

  function getSessionMeta(sessionId: unknown): RuntimeSessionMeta | null {
    const normalizedSessionId = normalizeNonEmptyString(sessionId);
    if (!normalizedSessionId) {
      return null;
    }

    const entry = indexState.sessions[normalizedSessionId];
    return entry ? { ...entry } : null;
  }

  function getSessionHistory(sessionId: unknown): RuntimeSessionHistory | null {
    const normalizedSessionId = normalizeNonEmptyString(sessionId);
    if (!normalizedSessionId) {
      return null;
    }

    const historyPath = sessionHistoryPath(normalizedSessionId);
    if (!fs.existsSync(historyPath)) {
      return null;
    }

    try {
      const raw = fs.readFileSync(historyPath, "utf8");
      return normalizeSessionHistory(JSON.parse(raw), normalizedSessionId);
    } catch {
      return defaultSessionHistory(normalizedSessionId);
    }
  }

  function saveSessionHistory(sessionId: unknown, history: unknown): RuntimeSessionHistory {
    const normalizedSessionId = normalizeNonEmptyString(sessionId);
    if (!normalizedSessionId) {
      throw new Error("saveSessionHistory requires a non-empty sessionId");
    }

    const normalizedHistory = normalizeSessionHistory(history, normalizedSessionId);
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      sessionHistoryPath(normalizedSessionId),
      JSON.stringify(normalizedHistory, null, 2)
    );
    return normalizedHistory;
  }

  function createSession({
    id,
    provider,
    providerSessionId = null,
    title = null,
    name = null,
    preview = null,
    cwd = null,
    model = null,
    metadata = null,
    capabilities = null,
    createdAt = null,
    updatedAt = null,
    archived = false,
  }: CreateSessionInput): RuntimeSessionMeta {
    const normalizedProvider = normalizeProvider(provider);
    const sessionId = normalizeSessionId(id, normalizedProvider);
    const nowIso = toIsoDateString(updatedAt || createdAt || Date.now());
    const createdIso = toIsoDateString(createdAt || updatedAt || Date.now());

    const sessionMeta = normalizeSessionMeta({
      id: sessionId,
      provider: normalizedProvider,
      providerSessionId,
      title,
      name,
      preview,
      cwd,
      model,
      metadata,
      capabilities,
      createdAt: createdIso,
      updatedAt: nowIso,
      archived,
    });

    indexState.sessions[sessionId] = sessionMeta;
    syncProviderSessionIndex(sessionId, sessionMeta.provider, sessionMeta.providerSessionId);
    scheduleIndexWrite();

    if (!getSessionHistory(sessionId)) {
      saveSessionHistory(sessionId, defaultSessionHistory(sessionId));
    }

    return { ...sessionMeta };
  }

  function upsertSessionMeta(sessionMeta: unknown): RuntimeSessionMeta {
    const normalized = normalizeSessionMeta(sessionMeta);
    const previous = indexState.sessions[normalized.id] || null;
    indexState.sessions[normalized.id] = {
      ...(previous || {}),
      ...normalized,
      metadata: normalized.metadata || previous?.metadata || null,
      capabilities: normalized.capabilities || previous?.capabilities || null,
      updatedAt: normalized.updatedAt || previous?.updatedAt || toIsoDateString(Date.now()),
    };

    if (previous?.providerSessionId && previous.providerSessionId !== normalized.providerSessionId) {
      const previousKey = providerSessionKey(previous.provider, previous.providerSessionId);
      delete indexState.providerSessions[previousKey];
    }

    syncProviderSessionIndex(
      normalized.id,
      normalized.provider,
      normalized.providerSessionId
    );
    scheduleIndexWrite();
    const storedEntry = indexState.sessions[normalized.id];
    if (!storedEntry) {
      return { ...normalized };
    }
    return { ...storedEntry };
  }

  function updateSessionMeta(
    sessionId: unknown,
    updater: (entry: RuntimeSessionMeta) => RuntimeSessionMeta | null | undefined
  ): RuntimeSessionMeta | null {
    const existing = getSessionMeta(sessionId);
    if (!existing) {
      return null;
    }

    const next = updater({ ...existing }) || existing;
    return upsertSessionMeta(next);
  }

  function bindProviderSession(
    sessionId: unknown,
    provider: unknown,
    providerSessionId: unknown
  ): RuntimeSessionMeta | null {
    return updateSessionMeta(sessionId, (entry) => ({
      ...entry,
      provider: normalizeProvider(provider || entry.provider),
      providerSessionId: normalizeNonEmptyString(providerSessionId) || null,
    }));
  }

  function findSessionIdByProviderSession(provider: unknown, providerSessionId: unknown): string | null {
    const key = providerSessionKey(provider, providerSessionId);
    return key ? indexState.providerSessions[key] || null : null;
  }

  function deleteSession(sessionId: unknown): boolean {
    const existing = getSessionMeta(sessionId);
    if (!existing) {
      return false;
    }

    delete indexState.sessions[existing.id];
    const key = providerSessionKey(existing.provider, existing.providerSessionId);
    if (key) {
      delete indexState.providerSessions[key];
    }
    scheduleIndexWrite();

    const historyPath = sessionHistoryPath(existing.id);
    if (fs.existsSync(historyPath)) {
      try {
        fs.unlinkSync(historyPath);
      } catch {
        // Best-effort cleanup only.
      }
    }
    return true;
  }

  function flush(): void {
    persistIndex(indexPath, indexState);
  }

  function shutdown(): void {
    if (writeTimer) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
    flush();
  }

  function scheduleIndexWrite(): void {
    if (writeTimer) {
      return;
    }

    writeTimer = setTimeout(() => {
      writeTimer = null;
      flush();
    }, 50);
    writeTimer.unref?.();
  }

  function syncProviderSessionIndex(sessionId: string, provider: ProviderId, providerSessionId: string | null): void {
    const key = providerSessionKey(provider, providerSessionId);
    if (!key) {
      return;
    }
    indexState.providerSessions[key] = sessionId;
  }

  function sessionHistoryPath(sessionId: string): string {
    return path.join(sessionsDir, `${sessionId}.json`);
  }

  return {
    baseDir,
    createSession,
    deleteSession,
    findSessionIdByProviderSession,
    flush,
    getSessionHistory,
    getSessionMeta,
    listSessionMetas,
    saveSessionHistory,
    shutdown,
    bindProviderSession,
    updateSessionMeta,
    upsertSessionMeta,
  };
}

function loadIndex(indexPath: string): RuntimeStoreIndex {
  if (!fs.existsSync(indexPath)) {
    return defaultIndex();
  }

  try {
    return normalizeIndex(JSON.parse(fs.readFileSync(indexPath, "utf8")));
  } catch {
    return defaultIndex();
  }
}

function persistIndex(indexPath: string, indexState: RuntimeStoreIndex): void {
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, JSON.stringify(indexState, null, 2));
}

function defaultIndex(): RuntimeStoreIndex {
  return {
    version: INDEX_VERSION,
    sessions: {},
    providerSessions: {},
  };
}

function normalizeIndex(input: unknown): RuntimeStoreIndex {
  const normalized = defaultIndex();
  if (!input || typeof input !== "object") {
    return normalized;
  }

  const record = input as UnknownRecord;
  if (record.sessions && typeof record.sessions === "object") {
    for (const [sessionId, value] of Object.entries(record.sessions as Record<string, unknown>)) {
      const normalizedSessionId = normalizeNonEmptyString(sessionId);
      if (!normalizedSessionId || !value || typeof value !== "object") {
        continue;
      }

      normalized.sessions[normalizedSessionId] = normalizeSessionMeta({
        ...(value as UnknownRecord),
        id: normalizedSessionId,
      });
    }
  }

  if (record.providerSessions && typeof record.providerSessions === "object") {
    for (const [key, sessionId] of Object.entries(record.providerSessions as Record<string, unknown>)) {
      const normalizedKey = normalizeNonEmptyString(key);
      const normalizedSessionId = normalizeNonEmptyString(sessionId);
      if (!normalizedKey || !normalizedSessionId) {
        continue;
      }
      normalized.providerSessions[normalizedKey] = normalizedSessionId;
    }
  }

  if (Object.keys(normalized.providerSessions).length === 0) {
    for (const entry of Object.values(normalized.sessions)) {
      const key = providerSessionKey(entry.provider, entry.providerSessionId);
      if (key) {
        normalized.providerSessions[key] = entry.id;
      }
    }
  }

  return normalized;
}

function normalizeSessionMeta(input: unknown): RuntimeSessionMeta {
  const record = input && typeof input === "object" ? (input as UnknownRecord) : {};
  const normalizedProvider = normalizeProvider(record.provider);
  const normalizedId = normalizeSessionId(record.id, normalizedProvider);
  const metadata = normalizeObject(record.metadata);
  const capabilities = normalizeObject(record.capabilities);

  return {
    id: normalizedId,
    provider: normalizedProvider,
    providerSessionId: firstNonEmptyString([
      record.providerSessionId,
      record.sessionId,
    ]),
    title: firstNonEmptyString([
      record.title,
      record.summary,
    ]),
    name: normalizeOptionalString(record.name),
    preview: firstNonEmptyString([
      record.preview,
      record.summary,
    ]),
    cwd: firstNonEmptyPath([record.cwd]),
    model: normalizeOptionalString(record.model),
    metadata,
    capabilities,
    createdAt: toIsoDateString(record.createdAt || Date.now()),
    updatedAt: toIsoDateString(record.updatedAt || record.createdAt || Date.now()),
    archived: Boolean(record.archived),
  };
}

function normalizeSessionHistory(input: unknown, sessionId: string): RuntimeSessionHistory {
  const record = input && typeof input === "object" ? (input as UnknownRecord) : {};
  const turns = Array.isArray(record.turns)
    ? record.turns
    : [];
  return {
    sessionId: normalizeNonEmptyString(record.sessionId) || sessionId,
    turns: turns
      .filter((entry): entry is UnknownRecord => Boolean(entry) && typeof entry === "object")
      .map((entry) => normalizeTurn(entry)),
  };
}

function normalizeTurn(input: UnknownRecord): RuntimeStoreTurn {
  return {
    ...(input as UnknownRecord),
    id: normalizeNonEmptyString(input.id || input.turnId) || randomUUID(),
    createdAt: toIsoDateString(input.createdAt || Date.now()),
    status: normalizeOptionalString(input.status),
    items: Array.isArray(input.items)
      ? input.items
        .filter((entry): entry is UnknownRecord => Boolean(entry) && typeof entry === "object")
        .map((entry) => normalizeItem(entry))
      : [],
  };
}

function normalizeItem(input: UnknownRecord): RuntimeStoreItem {
  const normalizedItem = {
    ...(input as UnknownRecord),
    id: normalizeNonEmptyString(input.id || input.itemId) || randomUUID(),
    type: normalizeNonEmptyString(input.type) || "message",
    role: normalizeOptionalString(input.role),
    content: Array.isArray(input.content)
      ? input.content.map((entry) => normalizeContent(entry))
      : Array.isArray(input.contents)
        ? input.contents.map((entry) => normalizeContent(entry))
        : [],
    text: normalizeOptionalString(input.text),
    message: normalizeOptionalString(input.message),
    createdAt: toIsoDateString(input.createdAt || Date.now()),
    status: normalizeOptionalString(input.status),
    command: normalizeOptionalString(input.command),
    metadata: normalizeObject(input.metadata),
    plan: Array.isArray(input.plan)
      ? input.plan.map((entry) => normalizeObject(entry) || {})
      : normalizeObject(input.plan),
    summary: normalizeOptionalString(input.summary),
    fileChanges: normalizeObjectArray(input.fileChanges || input.changes),
  } as RuntimeStoreItem & UnknownRecord;

  if (normalizedItem.fileChanges.length === 0 && Array.isArray(input.changes)) {
    normalizedItem.fileChanges = normalizeObjectArray(input.changes);
  }

  return normalizedItem;
}

function normalizeContent(input: unknown): UnknownRecord {
  if (!input || typeof input !== "object") {
    return { type: "text", text: "" };
  }

  const type = normalizeNonEmptyString((input as UnknownRecord).type) || "text";
  const normalized: UnknownRecord = { type };

  for (const [key, value] of Object.entries(input as UnknownRecord)) {
    if (key === "type") {
      continue;
    }

    if (Array.isArray(value)) {
      normalized[key] = value;
      continue;
    }

    if (value && typeof value === "object") {
      normalized[key] = { ...(value as UnknownRecord) };
      continue;
    }

    normalized[key] = value;
  }

  return normalized;
}

function defaultSessionHistory(sessionId: string): RuntimeSessionHistory {
  return {
    sessionId,
    turns: [],
  };
}

function compareSessionMeta(left: RuntimeSessionMeta, right: RuntimeSessionMeta): number {
  const leftUpdated = Date.parse(left.updatedAt || "0") || 0;
  const rightUpdated = Date.parse(right.updatedAt || "0") || 0;
  if (leftUpdated !== rightUpdated) {
    return rightUpdated - leftUpdated;
  }

  return left.id.localeCompare(right.id);
}

function providerSessionKey(provider: unknown, providerSessionId: unknown): string {
  const normalizedProvider = normalizeProvider(provider);
  const normalizedSessionId = normalizeNonEmptyString(providerSessionId);
  if (!normalizedProvider || !normalizedSessionId) {
    return "";
  }
  return `${normalizedProvider}:${normalizedSessionId}`;
}

function normalizeSessionId(value: unknown, provider: unknown): string {
  const normalized = normalizeNonEmptyString(value);
  if (normalized) {
    return normalized;
  }
  return `${normalizeProvider(provider)}:${randomUUID()}`;
}

function normalizeProvider(value: unknown): ProviderId {
  const normalized = normalizeNonEmptyString(value).toLowerCase();
  if (normalized === "claude" || normalized === "gemini" || normalized === "codex") {
    return normalized;
  }
  return "codex";
}

function normalizeObject(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return { ...(value as UnknownRecord) };
}

function normalizeObjectArray(value: unknown): UnknownRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => normalizeObject(entry) || {});
}

function normalizeOptionalString(value: unknown): string | null {
  const normalized = normalizeNonEmptyString(value);
  return normalized || null;
}

function firstNonEmptyString(values: unknown[]): string | null {
  for (const value of values) {
    const normalized = normalizeOptionalString(value);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function firstNonEmptyPath(values: unknown[]): string | null {
  for (const value of values) {
    const normalized = normalizeOptionalPath(value);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function normalizeOptionalPath(value: unknown): string | null {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return null;
  }
  if (normalized === "/") {
    return normalized;
  }

  let trimmed = normalized;
  while (trimmed.length > 1 && trimmed.endsWith("/")) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed || "/";
}

function normalizeNonEmptyString(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function toIsoDateString(value: unknown): string {
  if (!value) {
    return new Date().toISOString();
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }

  if (typeof value === "number") {
    const milliseconds = value > 10_000_000_000 ? value : value * 1000;
    return new Date(milliseconds).toISOString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return new Date().toISOString();
}
