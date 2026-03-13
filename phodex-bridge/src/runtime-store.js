// FILE: runtime-store.js
// Purpose: Provider-aware local overlay store for Remodex runtime threads and histories.
// Layer: CLI helper
// Exports: createRuntimeStore
// Depends on: fs, os, path, crypto

const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");

const DEFAULT_STORE_DIR = path.join(os.homedir(), ".remodex", "runtime");
const INDEX_FILE = "index.json";
const THREADS_DIR = "threads";
const INDEX_VERSION = 1;

function createRuntimeStore({ baseDir = DEFAULT_STORE_DIR } = {}) {
  const indexPath = path.join(baseDir, INDEX_FILE);
  const threadsDir = path.join(baseDir, THREADS_DIR);
  fs.mkdirSync(threadsDir, { recursive: true });

  let indexState = loadIndex(indexPath);
  let writeTimer = null;

  function listThreadMetas() {
    return Object.values(indexState.threads)
      .map((entry) => ({ ...entry }))
      .sort(compareThreadMeta);
  }

  function getThreadMeta(threadId) {
    const normalizedThreadId = normalizeNonEmptyString(threadId);
    if (!normalizedThreadId) {
      return null;
    }

    const entry = indexState.threads[normalizedThreadId];
    return entry ? { ...entry } : null;
  }

  function getThreadHistory(threadId) {
    const normalizedThreadId = normalizeNonEmptyString(threadId);
    if (!normalizedThreadId) {
      return null;
    }

    const historyPath = threadHistoryPath(normalizedThreadId);
    if (!fs.existsSync(historyPath)) {
      return null;
    }

    try {
      const raw = fs.readFileSync(historyPath, "utf8");
      return normalizeThreadHistory(JSON.parse(raw), normalizedThreadId);
    } catch {
      return defaultThreadHistory(normalizedThreadId);
    }
  }

  function saveThreadHistory(threadId, history) {
    const normalizedThreadId = normalizeNonEmptyString(threadId);
    if (!normalizedThreadId) {
      throw new Error("saveThreadHistory requires a non-empty threadId");
    }

    const normalizedHistory = normalizeThreadHistory(history, normalizedThreadId);
    fs.mkdirSync(threadsDir, { recursive: true });
    fs.writeFileSync(
      threadHistoryPath(normalizedThreadId),
      JSON.stringify(normalizedHistory, null, 2)
    );
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
  }) {
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

  function upsertThreadMeta(threadMeta) {
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
    return { ...indexState.threads[normalized.id] };
  }

  function updateThreadMeta(threadId, updater) {
    const existing = getThreadMeta(threadId);
    if (!existing) {
      return null;
    }

    const next = updater({ ...existing }) || existing;
    return upsertThreadMeta(next);
  }

  function bindProviderSession(threadId, provider, providerSessionId) {
    return updateThreadMeta(threadId, (entry) => ({
      ...entry,
      provider: normalizeProvider(provider || entry.provider),
      providerSessionId: normalizeNonEmptyString(providerSessionId) || null,
    }));
  }

  function findThreadIdByProviderSession(provider, providerSessionId) {
    const key = providerSessionKey(provider, providerSessionId);
    return key ? indexState.providerSessions[key] || null : null;
  }

  function deleteThread(threadId) {
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
    return true;
  }

  function flush() {
    persistIndex(indexPath, indexState);
  }

  function shutdown() {
    if (writeTimer) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
    flush();
  }

  function scheduleIndexWrite() {
    if (writeTimer) {
      return;
    }

    writeTimer = setTimeout(() => {
      writeTimer = null;
      flush();
    }, 50);
    writeTimer.unref?.();
  }

  function syncProviderSessionIndex(threadId, provider, providerSessionId) {
    const key = providerSessionKey(provider, providerSessionId);
    if (!key) {
      return;
    }
    indexState.providerSessions[key] = threadId;
  }

  function threadHistoryPath(threadId) {
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

function loadIndex(indexPath) {
  if (!fs.existsSync(indexPath)) {
    return defaultIndex();
  }

  try {
    return normalizeIndex(JSON.parse(fs.readFileSync(indexPath, "utf8")));
  } catch {
    return defaultIndex();
  }
}

function persistIndex(indexPath, indexState) {
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, JSON.stringify(indexState, null, 2));
}

function defaultIndex() {
  return {
    version: INDEX_VERSION,
    threads: {},
    providerSessions: {},
  };
}

function normalizeIndex(input) {
  const normalized = defaultIndex();
  if (!input || typeof input !== "object") {
    return normalized;
  }

  if (input.threads && typeof input.threads === "object") {
    for (const [threadId, value] of Object.entries(input.threads)) {
      const normalizedThreadId = normalizeNonEmptyString(threadId);
      if (!normalizedThreadId || !value || typeof value !== "object") {
        continue;
      }

      normalized.threads[normalizedThreadId] = normalizeThreadMeta({
        ...value,
        id: normalizedThreadId,
      });
    }
  }

  if (input.providerSessions && typeof input.providerSessions === "object") {
    for (const [key, threadId] of Object.entries(input.providerSessions)) {
      const normalizedKey = normalizeNonEmptyString(key);
      const normalizedThreadId = normalizeNonEmptyString(threadId);
      if (!normalizedKey || !normalizedThreadId) {
        continue;
      }
      normalized.providerSessions[normalizedKey] = normalizedThreadId;
    }
  } else {
    for (const entry of Object.values(normalized.threads)) {
      const key = providerSessionKey(entry.provider, entry.providerSessionId);
      if (key) {
        normalized.providerSessions[key] = entry.id;
      }
    }
  }

  return normalized;
}

function normalizeThreadMeta(input) {
  const normalizedProvider = normalizeProvider(input?.provider);
  const normalizedId = normalizeThreadId(input?.id, normalizedProvider);
  const metadata = normalizeObject(input?.metadata);
  const capabilities = normalizeObject(input?.capabilities);

  return {
    id: normalizedId,
    provider: normalizedProvider,
    providerSessionId: normalizeNonEmptyString(input?.providerSessionId) || null,
    title: normalizeOptionalString(input?.title),
    name: normalizeOptionalString(input?.name),
    preview: normalizeOptionalString(input?.preview),
    cwd: normalizeOptionalPath(input?.cwd),
    model: normalizeOptionalString(input?.model),
    metadata,
    capabilities,
    createdAt: toIsoDateString(input?.createdAt || Date.now()),
    updatedAt: toIsoDateString(input?.updatedAt || input?.createdAt || Date.now()),
    archived: Boolean(input?.archived),
  };
}

function normalizeThreadHistory(input, threadId) {
  const turns = Array.isArray(input?.turns) ? input.turns : [];
  return {
    threadId,
    turns: turns
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => normalizeTurn(entry)),
  };
}

function normalizeTurn(input) {
  return {
    id: normalizeNonEmptyString(input?.id) || randomUUID(),
    createdAt: toIsoDateString(input?.createdAt || Date.now()),
    status: normalizeOptionalString(input?.status),
    items: Array.isArray(input?.items)
      ? input.items
        .filter((entry) => entry && typeof entry === "object")
        .map((entry) => normalizeItem(entry))
      : [],
  };
}

function normalizeItem(input) {
  return {
    id: normalizeNonEmptyString(input?.id) || randomUUID(),
    type: normalizeNonEmptyString(input?.type) || "message",
    role: normalizeOptionalString(input?.role),
    content: Array.isArray(input?.content) ? input.content.map((entry) => normalizeContent(entry)) : [],
    text: normalizeOptionalString(input?.text),
    message: normalizeOptionalString(input?.message),
    createdAt: toIsoDateString(input?.createdAt || Date.now()),
    status: normalizeOptionalString(input?.status),
    command: normalizeOptionalString(input?.command),
    metadata: normalizeObject(input?.metadata),
    plan: normalizeObject(input?.plan),
    summary: normalizeOptionalString(input?.summary),
    fileChanges: Array.isArray(input?.fileChanges) ? input.fileChanges.map((entry) => normalizeObject(entry)) : [],
  };
}

function normalizeContent(input) {
  if (!input || typeof input !== "object") {
    return { type: "text", text: "" };
  }

  const type = normalizeNonEmptyString(input.type) || "text";
  const normalized = { type };

  for (const [key, value] of Object.entries(input)) {
    if (key === "type") {
      continue;
    }

    if (Array.isArray(value)) {
      normalized[key] = value;
      continue;
    }

    if (value && typeof value === "object") {
      normalized[key] = { ...value };
      continue;
    }

    normalized[key] = value;
  }

  return normalized;
}

function defaultThreadHistory(threadId) {
  return {
    threadId,
    turns: [],
  };
}

function compareThreadMeta(left, right) {
  const leftUpdated = Date.parse(left.updatedAt || 0) || 0;
  const rightUpdated = Date.parse(right.updatedAt || 0) || 0;
  if (leftUpdated !== rightUpdated) {
    return rightUpdated - leftUpdated;
  }

  return left.id.localeCompare(right.id);
}

function providerSessionKey(provider, providerSessionId) {
  const normalizedProvider = normalizeProvider(provider);
  const normalizedSessionId = normalizeNonEmptyString(providerSessionId);
  if (!normalizedProvider || !normalizedSessionId) {
    return "";
  }
  return `${normalizedProvider}:${normalizedSessionId}`;
}

function normalizeThreadId(value, provider) {
  const normalized = normalizeNonEmptyString(value);
  if (normalized) {
    return normalized;
  }
  return `${normalizeProvider(provider)}:${randomUUID()}`;
}

function normalizeProvider(value) {
  const normalized = normalizeNonEmptyString(value).toLowerCase();
  if (normalized === "claude" || normalized === "gemini" || normalized === "codex") {
    return normalized;
  }
  return "codex";
}

function normalizeObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return { ...value };
}

function normalizeOptionalString(value) {
  const normalized = normalizeNonEmptyString(value);
  return normalized || null;
}

function normalizeOptionalPath(value) {
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

function normalizeNonEmptyString(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function toIsoDateString(value) {
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

module.exports = {
  createRuntimeStore,
};
