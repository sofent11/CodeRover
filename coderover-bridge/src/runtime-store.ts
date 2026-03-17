// FILE: runtime-store.ts
// Purpose: Provider-aware local checkpoint + ACP transcript store for bridge runtime sessions.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";

import type { JsonRpcNotificationShape, RuntimeTurnShape } from "./bridge-types";
import { normalizeAcpAgentId } from "./acp/agent-registry";
import {
  buildAcpReplayNotifications,
  projectSessionInfoFromSessionObject,
} from "./runtime-engine/acp-protocol";

type ProviderId = "codex" | "claude" | "gemini";
type UnknownRecord = Record<string, unknown>;

const CHECKPOINT_SCHEMA = "coderover.runtime.session.v2";

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

interface RuntimeSessionCheckpoint {
  schema: typeof CHECKPOINT_SCHEMA;
  sessionId: string;
  updatedAt: string;
  history: RuntimeSessionHistory;
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
  appendSessionTranscriptMessage(sessionId: unknown, message: unknown): void;
  createSession(input: CreateSessionInput): RuntimeSessionMeta;
  deleteSession(sessionId: unknown): boolean;
  findSessionIdByProviderSession(provider: unknown, providerSessionId: unknown): string | null;
  flush(): void;
  getSessionHistory(sessionId: unknown): RuntimeSessionHistory | null;
  getSessionMeta(sessionId: unknown): RuntimeSessionMeta | null;
  getSessionTranscriptMessages(sessionId: unknown): JsonRpcNotificationShape[];
  listSessionMetas(): RuntimeSessionMeta[];
  saveSessionHistory(sessionId: unknown, history: unknown): RuntimeSessionHistory;
  shutdown(): void;
  bindProviderSession(sessionId: unknown, provider: unknown, providerSessionId: unknown): RuntimeSessionMeta | null;
  updateSessionMeta(
    sessionId: unknown,
    updater: (entry: RuntimeSessionMeta) => RuntimeSessionMeta | null | undefined
  ): RuntimeSessionMeta | null;
  updateSessionProjection(sessionId: unknown, history: unknown): RuntimeSessionHistory;
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

    const checkpointPath = sessionCheckpointPath(normalizedSessionId);
    if (fs.existsSync(checkpointPath)) {
      const stored = readSessionCheckpointOrLegacy(normalizedSessionId);
      if (stored.kind === "checkpoint") {
        return stored.history;
      }
      if (stored.kind === "legacy") {
        migrateLegacyHistory(normalizedSessionId, stored.history);
        return stored.history;
      }
    }

    const transcriptMessages = getSessionTranscriptMessages(normalizedSessionId);
    if (transcriptMessages.length === 0) {
      return null;
    }
    const derivedHistory = projectHistoryFromTranscript(transcriptMessages, normalizedSessionId);
    writeSessionCheckpoint(normalizedSessionId, derivedHistory);
    return derivedHistory;
  }

  function updateSessionProjection(sessionId: unknown, history: unknown): RuntimeSessionHistory {
    const normalizedSessionId = normalizeNonEmptyString(sessionId);
    if (!normalizedSessionId) {
      throw new Error("updateSessionProjection requires a non-empty sessionId");
    }

    const normalizedHistory = normalizeSessionHistory(history, normalizedSessionId);
    writeSessionCheckpoint(normalizedSessionId, normalizedHistory);
    return normalizedHistory;
  }

  function saveSessionHistory(sessionId: unknown, history: unknown): RuntimeSessionHistory {
    const normalizedSessionId = normalizeNonEmptyString(sessionId);
    if (!normalizedSessionId) {
      throw new Error("saveSessionHistory requires a non-empty sessionId");
    }

    const normalizedHistory = updateSessionProjection(normalizedSessionId, history);
    rewriteTranscriptFromHistory(normalizedSessionId, normalizedHistory);
    return normalizedHistory;
  }

  function appendSessionTranscriptMessage(sessionId: unknown, message: unknown): void {
    const normalizedSessionId = normalizeNonEmptyString(sessionId);
    if (!normalizedSessionId) {
      return;
    }

    const normalizedMessage = normalizeTranscriptMessage(message);
    if (!normalizedMessage) {
      return;
    }

    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.appendFileSync(
      sessionTranscriptPath(normalizedSessionId),
      `${JSON.stringify(normalizedMessage)}\n`
    );
  }

  function getSessionTranscriptMessages(sessionId: unknown): JsonRpcNotificationShape[] {
    const normalizedSessionId = normalizeNonEmptyString(sessionId);
    if (!normalizedSessionId) {
      return [];
    }

    const transcriptPath = sessionTranscriptPath(normalizedSessionId);
    if (!fs.existsSync(transcriptPath)) {
      return [];
    }

    try {
      const raw = fs.readFileSync(transcriptPath, "utf8");
      return raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => normalizeTranscriptMessage(JSON.parse(line)))
        .filter((entry): entry is JsonRpcNotificationShape => Boolean(entry));
    } catch {
      return [];
    }
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
      updateSessionProjection(sessionId, defaultSessionHistory(sessionId));
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

    syncProviderSessionIndex(normalized.id, normalized.provider, normalized.providerSessionId);
    scheduleIndexWrite();
    const storedEntry = indexState.sessions[normalized.id];
    return storedEntry ? { ...storedEntry } : { ...normalized };
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

    for (const filePath of [sessionCheckpointPath(existing.id), sessionTranscriptPath(existing.id)]) {
      if (!fs.existsSync(filePath)) {
        continue;
      }
      try {
        fs.unlinkSync(filePath);
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

  function migrateLegacyHistory(sessionId: string, history: RuntimeSessionHistory): void {
    writeSessionCheckpoint(sessionId, history);
    rewriteTranscriptFromHistory(sessionId, history);
  }

  function rewriteTranscriptFromHistory(sessionId: string, history: RuntimeSessionHistory): void {
    const sessionMeta = getSessionMeta(sessionId);
    const notifications = buildAcpReplayNotifications({
      id: sessionId,
      provider: sessionMeta?.provider || inferProviderFromSessionId(sessionId),
      providerSessionId: sessionMeta?.providerSessionId || null,
      title: sessionMeta?.title,
      name: sessionMeta?.name,
      preview: sessionMeta?.preview,
      cwd: sessionMeta?.cwd,
      createdAt: sessionMeta?.createdAt,
      updatedAt: sessionMeta?.updatedAt,
      archived: sessionMeta?.archived,
      capabilities: sessionMeta?.capabilities,
      metadata: sessionMeta?.metadata,
      turns: history.turns as unknown as RuntimeTurnShape[],
    });
    const transcriptPath = sessionTranscriptPath(sessionId);
    fs.mkdirSync(sessionsDir, { recursive: true });
    const payload = notifications
      .map((notification) => JSON.stringify(projectedNotificationToEnvelope(notification)))
      .join("\n");
    fs.writeFileSync(transcriptPath, payload ? `${payload}\n` : "");
  }

  function writeSessionCheckpoint(sessionId: string, history: RuntimeSessionHistory): void {
    fs.mkdirSync(sessionsDir, { recursive: true });
    const checkpoint: RuntimeSessionCheckpoint = {
      schema: CHECKPOINT_SCHEMA,
      sessionId,
      updatedAt: new Date().toISOString(),
      history,
    };
    fs.writeFileSync(
      sessionCheckpointPath(sessionId),
      JSON.stringify(checkpoint, null, 2)
    );
  }

  function sessionCheckpointPath(sessionId: string): string {
    return path.join(sessionsDir, `${sessionId}.json`);
  }

  function sessionTranscriptPath(sessionId: string): string {
    return path.join(sessionsDir, `${sessionId}.stream.ndjson`);
  }

  function readSessionCheckpointOrLegacy(
    sessionId: string
  ): { kind: "checkpoint"; history: RuntimeSessionHistory } | { kind: "legacy"; history: RuntimeSessionHistory } {
    const raw = fs.readFileSync(sessionCheckpointPath(sessionId), "utf8");
    const parsed = JSON.parse(raw) as UnknownRecord;
    if (parsed.schema === CHECKPOINT_SCHEMA) {
      return {
        kind: "checkpoint",
        history: normalizeSessionHistory(asObject(parsed.history), sessionId),
      };
    }
    return {
      kind: "legacy",
      history: normalizeSessionHistory(parsed, sessionId),
    };
  }

  return {
    baseDir,
    appendSessionTranscriptMessage,
    createSession,
    deleteSession,
    findSessionIdByProviderSession,
    flush,
    getSessionHistory,
    getSessionMeta,
    getSessionTranscriptMessages,
    listSessionMetas,
    saveSessionHistory,
    shutdown,
    bindProviderSession,
    updateSessionMeta,
    updateSessionProjection,
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

function inferProviderFromSessionId(value: string): ProviderId {
  return normalizeProvider(value.split(":", 1)[0]);
}

function normalizeProvider(value: unknown): ProviderId {
  const normalized = normalizeAcpAgentId(value);
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
  if (value instanceof Date) {
    return new Date(value.getTime()).toISOString();
  }
  if (typeof value === "number") {
    return new Date(value).toISOString();
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  return new Date().toISOString();
}

function projectedNotificationToEnvelope(
  notification: ReturnType<typeof projectSessionInfoFromSessionObject>
): JsonRpcNotificationShape {
  return {
    jsonrpc: "2.0",
    method: notification.method,
    params: notification.params,
  };
}

function normalizeTranscriptMessage(message: unknown): JsonRpcNotificationShape | null {
  const parsed = typeof message === "string"
    ? safeParseJSON(message)
    : message;
  const record = asObject(parsed);
  if (!record || normalizeOptionalString(record.method) !== "session/update") {
    return null;
  }
  const params = asObject(record.params);
  if (!params || !asObject(params.update)) {
    return null;
  }
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: normalizeOptionalString(params.sessionId) || "",
      update: asObject(params.update),
    },
  };
}

function projectHistoryFromTranscript(
  messages: JsonRpcNotificationShape[],
  sessionId: string
): RuntimeSessionHistory {
  const history = defaultSessionHistory(sessionId);
  const turnById = new Map<string, RuntimeStoreTurn>();
  let activeTurnId: string | null = null;

  function ensureTurn(turnId: string | null): RuntimeStoreTurn {
    const normalizedTurnId = normalizeOptionalString(turnId) || activeTurnId || `${sessionId}:turn`;
    let turn = turnById.get(normalizedTurnId);
    if (!turn) {
      turn = {
        id: normalizedTurnId,
        createdAt: new Date().toISOString(),
        status: "running",
        items: [],
      };
      history.turns.push(turn);
      turnById.set(normalizedTurnId, turn);
    }
    return turn;
  }

  function upsertItem(turn: RuntimeStoreTurn, item: RuntimeStoreItem): RuntimeStoreItem {
    const existing = turn.items.find((entry) => entry.id === item.id);
    if (existing) {
      return existing;
    }
    turn.items.push(item);
    return item;
  }

  for (const message of messages) {
    const params = asObject(message.params);
    const update = asObject(params?.update);
    const sessionUpdate = normalizeOptionalString(update?.sessionUpdate);
    if (!sessionUpdate) {
      continue;
    }

    const coderoverMeta = asObject(asObject(update?._meta)?.coderover);
    const turnId = firstNonEmptyString([
      update?.turnId,
      coderoverMeta?.turnId,
      activeTurnId,
    ]);

    switch (sessionUpdate) {
      case "session_info_update": {
        const lifecycleTurnId = firstNonEmptyString([update?.turnId, coderoverMeta?.turnId]);
        const runState = normalizeOptionalString(update?.runState)
          || normalizeOptionalString(coderoverMeta?.runState);
        if (!lifecycleTurnId) {
          continue;
        }
        const turn = ensureTurn(lifecycleTurnId);
        if (runState === "running") {
          turn.status = "running";
          activeTurnId = turn.id;
        } else if (runState) {
          turn.status = normalizeTurnStatus(runState);
          if (activeTurnId === turn.id) {
            activeTurnId = null;
          }
        }
        continue;
      }

      case "user_message_chunk": {
        const turn = ensureTurn(turnId);
        const itemId = firstNonEmptyString([update?.messageId, coderoverMeta?.itemId]) || randomUUID();
        const contentBlock = normalizeContent(update?.content);
        const item = upsertItem(turn, {
          id: itemId,
          type: "user_message",
          role: "user",
          content: [],
          text: null,
          message: null,
          createdAt: new Date().toISOString(),
          status: null,
          command: null,
          metadata: null,
          plan: null,
          summary: null,
          fileChanges: [],
        });
        item.content.push(contentBlock);
        if (contentBlock.type === "text") {
          item.text = `${item.text || ""}${normalizeOptionalString(contentBlock.text) || ""}`;
        }
        continue;
      }

      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const turn = ensureTurn(turnId);
        const itemId = firstNonEmptyString([update?.messageId, coderoverMeta?.itemId]) || randomUUID();
        const item = upsertItem(turn, {
          id: itemId,
          type: sessionUpdate === "agent_thought_chunk" ? "reasoning" : "agent_message",
          role: sessionUpdate === "agent_thought_chunk" ? "system" : "assistant",
          content: [],
          text: "",
          message: null,
          createdAt: new Date().toISOString(),
          status: null,
          command: null,
          metadata: null,
          plan: null,
          summary: null,
          fileChanges: [],
        });
        item.text = `${item.text || ""}${readTextContent(update?.content)}`;
        continue;
      }

      case "plan": {
        const turn = ensureTurn(turnId);
        const itemId = firstNonEmptyString([update?.messageId, coderoverMeta?.itemId]) || `${turn.id}:plan`;
        const item = upsertItem(turn, {
          id: itemId,
          type: "plan",
          role: "system",
          content: [],
          text: normalizeOptionalString(coderoverMeta?.text) || "Planning...",
          message: null,
          createdAt: new Date().toISOString(),
          status: null,
          command: null,
          metadata: null,
          plan: [],
          summary: normalizeOptionalString(coderoverMeta?.summary),
          fileChanges: [],
          explanation: normalizeOptionalString(coderoverMeta?.explanation),
        } as RuntimeStoreItem);
        item.text = normalizeOptionalString(coderoverMeta?.text) || item.text || "Planning...";
        item.summary = normalizeOptionalString(coderoverMeta?.summary)
          || normalizeOptionalString(coderoverMeta?.explanation);
        item.explanation = normalizeOptionalString(coderoverMeta?.explanation);
        item.plan = normalizePlanEntries(update?.entries);
        continue;
      }

      case "tool_call":
      case "tool_call_update": {
        const turn = ensureTurn(turnId);
        const kind = normalizeOptionalString(update?.kind);
        const itemId = firstNonEmptyString([update?.toolCallId, coderoverMeta?.itemId]) || randomUUID();
        const rawInput = asObject(update?.rawInput);
        const rawOutput = asObject(update?.rawOutput);
        const isCommand = kind === "execute" || Boolean(normalizeOptionalString(rawInput?.command));
        const item = upsertItem(turn, {
          id: itemId,
          type: isCommand ? "command_execution" : "tool_call",
          role: null,
          content: [],
          text: "",
          message: null,
          createdAt: new Date().toISOString(),
          status: normalizeOptionalString(update?.status),
          command: normalizeOptionalString(rawInput?.command) || normalizeOptionalString(update?.title),
          metadata: isCommand
            ? null
            : { toolName: normalizeOptionalString(update?.title) || "Tool call" },
          plan: null,
          summary: null,
          fileChanges: [],
        });
        item.status = normalizeOptionalString(update?.status) || item.status;
        item.text = `${item.text || ""}${readToolText(update?.content)}`;
        if (isCommand) {
          item.cwd = normalizeOptionalString(rawInput?.cwd);
          item.exitCode = typeof rawOutput?.exitCode === "number" ? rawOutput.exitCode : item.exitCode;
          item.durationMs = typeof rawOutput?.durationMs === "number" ? rawOutput.durationMs : item.durationMs;
        } else if (Array.isArray(rawOutput?.changes)) {
          item.fileChanges = normalizeObjectArray(rawOutput.changes);
          item.changes = normalizeObjectArray(rawOutput.changes);
        }
        continue;
      }

      default:
        continue;
    }
  }

  if (history.turns.length === 0) {
    return history;
  }

  return {
    sessionId,
    turns: history.turns.map((turn) => ({
      ...turn,
      status: turn.status || "completed",
    })),
  };
}

function normalizeTurnStatus(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return "completed";
  }
  if (normalized.includes("run") || normalized.includes("progress")) {
    return "running";
  }
  if (normalized.includes("stop") || normalized.includes("cancel")) {
    return "stopped";
  }
  if (normalized.includes("fail") || normalized.includes("error")) {
    return "failed";
  }
  return "completed";
}

function normalizePlanEntries(entries: unknown): UnknownRecord[] {
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries.map((entry) => {
    const record = asObject(entry);
    return {
      step: normalizeOptionalString(record?.content) || normalizeOptionalString(record?.step) || "Step",
      status: normalizeOptionalString(record?.status) || "pending",
    };
  });
}

function readTextContent(content: unknown): string {
  const record = asObject(content);
  const directText = normalizeOptionalString(record?.text);
  if (directText) {
    return directText;
  }
  if (Array.isArray(content)) {
    return content
      .map((entry) => readTextContent(entry))
      .filter(Boolean)
      .join("");
  }
  return "";
}

function readToolText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((entry) => readTextContent(asObject(entry)?.content || entry))
    .filter(Boolean)
    .join("");
}

function asObject(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as UnknownRecord;
}

function safeParseJSON(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
