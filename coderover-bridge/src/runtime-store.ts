// FILE: runtime-store.ts
// Purpose: Provider-aware local overlay store for CodeRover runtime threads and histories.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash, randomUUID } from "crypto";

type ProviderId = "codex" | "claude" | "gemini" | "copilot";
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

export interface RuntimeThreadHistory {
  threadId: string;
  turns: RuntimeStoreTurn[];
}

export interface RuntimeThreadMeta {
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
  threads: Record<string, RuntimeThreadMeta>;
  providerSessions: Record<string, string>;
}

export interface CreateThreadInput {
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
  createThread(input: CreateThreadInput): RuntimeThreadMeta;
  deleteThread(threadId: unknown): boolean;
  findThreadIdByProviderSession(provider: unknown, providerSessionId: unknown): string | null;
  flush(): void;
  getThreadHistory(threadId: unknown): RuntimeThreadHistory | null;
  getThreadMeta(threadId: unknown): RuntimeThreadMeta | null;
  listThreadMetas(): RuntimeThreadMeta[];
  saveThreadHistory(threadId: unknown, history: unknown): RuntimeThreadHistory;
  shutdown(): void;
  bindProviderSession(threadId: unknown, provider: unknown, providerSessionId: unknown): RuntimeThreadMeta | null;
  updateThreadMeta(
    threadId: unknown,
    updater: (entry: RuntimeThreadMeta) => RuntimeThreadMeta | null | undefined
  ): RuntimeThreadMeta | null;
  upsertThreadMeta(threadMeta: unknown): RuntimeThreadMeta;
}

const DEFAULT_STORE_DIR = path.join(os.homedir(), ".coderover", "runtime");
const INDEX_FILE = "index.json";
const THREADS_DIR = "threads";
const INDEX_VERSION = 1;

export function createRuntimeStore({ baseDir = DEFAULT_STORE_DIR }: { baseDir?: string } = {}): RuntimeStore {
  const indexPath = path.join(baseDir, INDEX_FILE);
  const threadsDir = path.join(baseDir, THREADS_DIR);
  fs.mkdirSync(threadsDir, { recursive: true });

  let indexState = loadIndex(indexPath);
  let writeTimer: NodeJS.Timeout | null = null;

  function listThreadMetas(): RuntimeThreadMeta[] {
    return Object.values(indexState.threads)
      .map((entry) => ({ ...entry }))
      .sort(compareThreadMeta);
  }

  function getThreadMeta(threadId: unknown): RuntimeThreadMeta | null {
    const normalizedThreadId = normalizeNonEmptyString(threadId);
    if (!normalizedThreadId) {
      return null;
    }

    const entry = indexState.threads[normalizedThreadId];
    return entry ? { ...entry } : null;
  }

  function getThreadHistory(threadId: unknown): RuntimeThreadHistory | null {
    const normalizedThreadId = normalizeNonEmptyString(threadId);
    if (!normalizedThreadId) {
      return null;
    }

    const historyPath = threadHistoryPath(normalizedThreadId);
    const legacyPath = legacyThreadHistoryPath(normalizedThreadId);
    const readablePath = fs.existsSync(historyPath)
      ? historyPath
      : fs.existsSync(legacyPath)
        ? legacyPath
        : "";
    if (!readablePath) {
      return null;
    }

    try {
      const history = normalizeThreadHistory(readJsonFileWithBackup(readablePath), normalizedThreadId);
      if (readablePath === legacyPath && legacyPath !== historyPath) {
        persistJsonAtomic(historyPath, history);
      }
      return history;
    } catch {
      return defaultThreadHistory(normalizedThreadId);
    }
  }

  function saveThreadHistory(threadId: unknown, history: unknown): RuntimeThreadHistory {
    const normalizedThreadId = normalizeNonEmptyString(threadId);
    if (!normalizedThreadId) {
      throw new Error("saveThreadHistory requires a non-empty threadId");
    }

    const normalizedHistory = normalizeThreadHistory(history, normalizedThreadId);
    fs.mkdirSync(threadsDir, { recursive: true });
    persistJsonAtomic(threadHistoryPath(normalizedThreadId), normalizedHistory);
    return normalizedHistory;
  }

  function createThread({
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
  }: CreateThreadInput): RuntimeThreadMeta {
    const normalizedProvider = normalizeProvider(provider);
    const threadId = normalizeThreadId(id, normalizedProvider);
    const nowIso = toIsoDateString(updatedAt || createdAt || Date.now());
    const createdIso = toIsoDateString(createdAt || updatedAt || Date.now());

    const threadMeta = normalizeThreadMeta({
      id: threadId,
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

    indexState.threads[threadId] = threadMeta;
    syncProviderSessionIndex(threadId, threadMeta.provider, threadMeta.providerSessionId);
    scheduleIndexWrite();

    if (!getThreadHistory(threadId)) {
      saveThreadHistory(threadId, defaultThreadHistory(threadId));
    }

    return { ...threadMeta };
  }

  function upsertThreadMeta(threadMeta: unknown): RuntimeThreadMeta {
    const normalized = normalizeThreadMeta(threadMeta);
    const previous = indexState.threads[normalized.id] || null;
    indexState.threads[normalized.id] = {
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
    const storedEntry = indexState.threads[normalized.id];
    if (!storedEntry) {
      return { ...normalized };
    }
    return { ...storedEntry };
  }

  function updateThreadMeta(
    threadId: unknown,
    updater: (entry: RuntimeThreadMeta) => RuntimeThreadMeta | null | undefined
  ): RuntimeThreadMeta | null {
    const existing = getThreadMeta(threadId);
    if (!existing) {
      return null;
    }

    const next = updater({ ...existing }) || existing;
    return upsertThreadMeta(next);
  }

  function bindProviderSession(
    threadId: unknown,
    provider: unknown,
    providerSessionId: unknown
  ): RuntimeThreadMeta | null {
    return updateThreadMeta(threadId, (entry) => ({
      ...entry,
      provider: normalizeProvider(provider || entry.provider),
      providerSessionId: normalizeNonEmptyString(providerSessionId) || null,
    }));
  }

  function findThreadIdByProviderSession(provider: unknown, providerSessionId: unknown): string | null {
    const key = providerSessionKey(provider, providerSessionId);
    return key ? indexState.providerSessions[key] || null : null;
  }

  function deleteThread(threadId: unknown): boolean {
    const existing = getThreadMeta(threadId);
    if (!existing) {
      return false;
    }

    delete indexState.threads[existing.id];
    const key = providerSessionKey(existing.provider, existing.providerSessionId);
    if (key) {
      delete indexState.providerSessions[key];
    }
    scheduleIndexWrite();

    const historyPath = threadHistoryPath(existing.id);
    if (fs.existsSync(historyPath)) {
      try {
        fs.unlinkSync(historyPath);
      } catch {
        // Best-effort cleanup only.
      }
    }
    const legacyHistoryPath = legacyThreadHistoryPath(existing.id);
    if (legacyHistoryPath !== historyPath && fs.existsSync(legacyHistoryPath)) {
      try {
        fs.unlinkSync(legacyHistoryPath);
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

  function syncProviderSessionIndex(threadId: string, provider: ProviderId, providerSessionId: string | null): void {
    const key = providerSessionKey(provider, providerSessionId);
    if (!key) {
      return;
    }
    indexState.providerSessions[key] = threadId;
  }

  function threadHistoryPath(threadId: string): string {
    return path.join(threadsDir, encodedThreadHistoryFileName(threadId));
  }

  function legacyThreadHistoryPath(threadId: string): string {
    if (!isSafeLegacyThreadFileName(threadId)) {
      return "";
    }
    return path.join(threadsDir, `${threadId}.json`);
  }

  return {
    baseDir,
    createThread,
    deleteThread,
    findThreadIdByProviderSession,
    flush,
    getThreadHistory,
    getThreadMeta,
    listThreadMetas,
    saveThreadHistory,
    shutdown,
    bindProviderSession,
    updateThreadMeta,
    upsertThreadMeta,
  };
}

function loadIndex(indexPath: string): RuntimeStoreIndex {
  if (!fs.existsSync(indexPath)) {
    return defaultIndex();
  }

  try {
    return normalizeIndex(readJsonFileWithBackup(indexPath));
  } catch {
    return defaultIndex();
  }
}

function persistIndex(indexPath: string, indexState: RuntimeStoreIndex): void {
  persistJsonAtomic(indexPath, indexState);
}

function readJsonFileWithBackup(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (primaryError) {
    const backupPath = backupFilePath(filePath);
    if (!fs.existsSync(backupPath)) {
      throw primaryError;
    }
    return JSON.parse(fs.readFileSync(backupPath, "utf8"));
  }
}

function persistJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const backupPath = backupFilePath(filePath);

  const fd = fs.openSync(tempPath, "w", 0o600);
  try {
    fs.writeFileSync(fd, payload);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  if (fs.existsSync(filePath)) {
    try {
      fs.copyFileSync(filePath, backupPath);
    } catch {
      // A backup is helpful but should not block the primary write.
    }
  }
  fs.renameSync(tempPath, filePath);
}

function backupFilePath(filePath: string): string {
  return `${filePath}.bak`;
}

function encodedThreadHistoryFileName(threadId: string): string {
  const digest = createHash("sha256").update(threadId, "utf8").digest("hex");
  return `thread-${digest}.json`;
}

function isSafeLegacyThreadFileName(threadId: string): boolean {
  return Boolean(threadId)
    && !threadId.includes("/")
    && !threadId.includes("\\")
    && threadId !== "."
    && threadId !== ".."
    && !threadId.includes("..");
}

function defaultIndex(): RuntimeStoreIndex {
  return {
    version: INDEX_VERSION,
    threads: {},
    providerSessions: {},
  };
}

function normalizeIndex(input: unknown): RuntimeStoreIndex {
  const normalized = defaultIndex();
  if (!input || typeof input !== "object") {
    return normalized;
  }

  const record = input as UnknownRecord;
  if (record.threads && typeof record.threads === "object") {
    for (const [threadId, value] of Object.entries(record.threads as Record<string, unknown>)) {
      const normalizedThreadId = normalizeNonEmptyString(threadId);
      if (!normalizedThreadId || !value || typeof value !== "object") {
        continue;
      }

      normalized.threads[normalizedThreadId] = normalizeThreadMeta({
        ...(value as UnknownRecord),
        id: normalizedThreadId,
      });
    }
  }

  if (record.providerSessions && typeof record.providerSessions === "object") {
    for (const [key, threadId] of Object.entries(record.providerSessions as Record<string, unknown>)) {
      const normalizedKey = normalizeNonEmptyString(key);
      const normalizedThreadId = normalizeNonEmptyString(threadId);
      if (!normalizedKey || !normalizedThreadId) {
        continue;
      }
      normalized.providerSessions[normalizedKey] = normalizedThreadId;
    }
  }

  if (Object.keys(normalized.providerSessions).length === 0) {
    for (const entry of Object.values(normalized.threads)) {
      const key = providerSessionKey(entry.provider, entry.providerSessionId);
      if (key) {
        normalized.providerSessions[key] = entry.id;
      }
    }
  }

  return normalized;
}

function normalizeThreadMeta(input: unknown): RuntimeThreadMeta {
  const record = input && typeof input === "object" ? (input as UnknownRecord) : {};
  const normalizedProvider = normalizeProvider(record.provider);
  const normalizedId = normalizeThreadId(record.id, normalizedProvider);
  const metadata = normalizeObject(record.metadata);
  const capabilities = normalizeObject(record.capabilities);

  return {
    id: normalizedId,
    provider: normalizedProvider,
    providerSessionId: firstNonEmptyString([
      record.providerSessionId,
      record.provider_session_id,
      record.sessionId,
      record.session_id,
    ]),
    title: firstNonEmptyString([
      record.title,
      record.customTitle,
      record.custom_title,
      record.summary,
    ]),
    name: normalizeOptionalString(record.name),
    preview: firstNonEmptyString([
      record.preview,
      record.firstPrompt,
      record.first_prompt,
      record.summary,
    ]),
    cwd: firstNonEmptyPath([
      record.cwd,
      record.current_working_directory,
      record.working_directory,
    ]),
    model: normalizeOptionalString(record.model),
    metadata,
    capabilities,
    createdAt: toIsoDateString(record.createdAt || record.created_at || record.lastModified || record.last_modified || Date.now()),
    updatedAt: toIsoDateString(
      record.updatedAt || record.updated_at || record.lastModified || record.last_modified || record.createdAt || record.created_at || Date.now()
    ),
    archived: Boolean(record.archived),
  };
}

function normalizeThreadHistory(input: unknown, threadId: string): RuntimeThreadHistory {
  const record = input && typeof input === "object" ? (input as UnknownRecord) : {};
  const turns = Array.isArray(record.turns)
    ? record.turns
    : Array.isArray(record.history)
      ? record.history
      : [];
  return {
    threadId: normalizeNonEmptyString(record.threadId || record.thread_id) || threadId,
    turns: turns
      .filter((entry): entry is UnknownRecord => Boolean(entry) && typeof entry === "object")
      .map((entry) => normalizeTurn(entry)),
  };
}

function normalizeTurn(input: UnknownRecord): RuntimeStoreTurn {
  return {
    ...(input as UnknownRecord),
    id: normalizeNonEmptyString(input.id || input.turnId || input.turn_id) || randomUUID(),
    createdAt: toIsoDateString(input.createdAt || input.created_at || Date.now()),
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
    id: normalizeNonEmptyString(input.id || input.itemId || input.item_id) || randomUUID(),
    type: normalizeNonEmptyString(input.type) || "message",
    role: normalizeOptionalString(input.role),
    content: Array.isArray(input.content)
      ? input.content.map((entry) => normalizeContent(entry))
      : Array.isArray(input.contents)
        ? input.contents.map((entry) => normalizeContent(entry))
        : [],
    text: normalizeOptionalString(input.text),
    message: normalizeOptionalString(input.message),
    createdAt: toIsoDateString(input.createdAt || input.created_at || Date.now()),
    status: normalizeOptionalString(input.status),
    command: normalizeOptionalString(input.command),
    metadata: normalizeObject(input.metadata),
    plan: Array.isArray(input.plan)
      ? input.plan.map((entry) => normalizeObject(entry) || {})
      : normalizeObject(input.plan),
    summary: normalizeOptionalString(input.summary),
    fileChanges: normalizeObjectArray(input.fileChanges || input.file_changes || input.changes),
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

function defaultThreadHistory(threadId: string): RuntimeThreadHistory {
  return {
    threadId,
    turns: [],
  };
}

function compareThreadMeta(left: RuntimeThreadMeta, right: RuntimeThreadMeta): number {
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

function normalizeThreadId(value: unknown, provider: unknown): string {
  const normalized = normalizeNonEmptyString(value);
  if (normalized) {
    return normalized;
  }
  return `${normalizeProvider(provider)}:${randomUUID()}`;
}

function normalizeProvider(value: unknown): ProviderId {
  const normalized = normalizeNonEmptyString(value).toLowerCase();
  if (
    normalized === "claude"
    || normalized === "gemini"
    || normalized === "codex"
    || normalized === "copilot"
  ) {
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
