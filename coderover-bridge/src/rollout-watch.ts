// FILE: rollout-watch.ts
// Purpose: Shared rollout-file lookup/watch helpers for CLI inspection and desktop refresh.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { readLastActiveSession } from "./session-state";

const DEFAULT_WATCH_INTERVAL_MS = 1_000;
const DEFAULT_LOOKUP_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_TIMEOUT_MS = 10_000;
const DEFAULT_TRANSIENT_ERROR_RETRY_LIMIT = 2;
const DEFAULT_CONTEXT_READ_SCAN_BYTES = 512 * 1024;
const DEFAULT_RECENT_ROLLOUT_CANDIDATE_LIMIT = 24;

interface RolloutDirectoryEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

interface RolloutStat {
  size: number;
  mtimeMs?: number;
}

export interface RolloutScanFsModule {
  existsSync(filePath: string): boolean;
  readdirSync(filePath: string, options: { withFileTypes: true }): RolloutDirectoryEntry[];
  statSync(filePath: string): RolloutStat;
}

interface RolloutReadFsModule extends RolloutScanFsModule {
  readFileSync(filePath: string, options: { encoding: "utf8" }): string;
}

export interface SessionRolloutActivityEvent {
  reason: "materialized" | "growth";
  sessionId: string;
  rolloutPath: string;
  size: number;
}

export interface SessionRolloutIdleEvent {
  sessionId: string;
  rolloutPath: string;
  size: number | null;
}

export interface SessionRolloutTimeoutEvent {
  sessionId: string;
}

export interface SessionRolloutActivityWatcher {
  stop(): void;
  readonly sessionId: string;
}

interface CreateSessionRolloutActivityWatcherOptions {
  sessionId?: string;
  intervalMs?: number;
  lookupTimeoutMs?: number;
  idleTimeoutMs?: number;
  now?: () => number;
  fsModule?: RolloutScanFsModule;
  transientErrorRetryLimit?: number;
  onEvent?: (event: SessionRolloutActivityEvent) => void;
  onIdle?: (event: SessionRolloutIdleEvent) => void;
  onTimeout?: (event: SessionRolloutTimeoutEvent) => void;
  onError?: (error: Error) => void;
}

export interface ContextWindowUsage {
  tokensUsed: number;
  tokenLimit: number;
}

export interface ContextWindowUsageReadResult {
  rolloutPath: string;
  usage: ContextWindowUsage;
}

interface ReadLatestContextWindowUsageOptions {
  sessionId?: string;
  turnId?: string;
  root?: string;
  fsModule?: RolloutReadFsModule;
  scanBytes?: number;
}

interface FindRecentRolloutOptions {
  sessionId?: string;
  turnId?: string;
  fsModule?: RolloutReadFsModule;
  candidateLimit?: number;
  scanBytes?: number;
}

interface CollectRecentRolloutOptions {
  fsModule?: RolloutScanFsModule;
  candidateLimit?: number;
}

interface RolloutTokenSearchOptions {
  fsModule?: RolloutReadFsModule;
  scanBytes?: number;
}

interface RecentRolloutFile {
  filePath: string;
  modifiedAtMs: number;
}

const defaultScanFsModule: RolloutScanFsModule = {
  existsSync(filePath) {
    return fs.existsSync(filePath);
  },
  readdirSync(filePath, options) {
    return fs.readdirSync(filePath, options);
  },
  statSync(filePath) {
    return fs.statSync(filePath);
  },
};

const defaultReadFsModule: RolloutReadFsModule = {
  ...defaultScanFsModule,
  readFileSync(filePath, options) {
    return fs.readFileSync(filePath, options);
  },
};

function getDefaultScanFsModule(): RolloutScanFsModule {
  return defaultScanFsModule;
}

function getDefaultReadFsModule(): RolloutReadFsModule {
  return defaultReadFsModule;
}

export function createSessionRolloutActivityWatcher({
  sessionId,
  intervalMs = DEFAULT_WATCH_INTERVAL_MS,
  lookupTimeoutMs = DEFAULT_LOOKUP_TIMEOUT_MS,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  now = () => Date.now(),
  fsModule = getDefaultScanFsModule(),
  transientErrorRetryLimit = DEFAULT_TRANSIENT_ERROR_RETRY_LIMIT,
  onEvent = () => {},
  onIdle = () => {},
  onTimeout = () => {},
  onError = () => {},
}: CreateSessionRolloutActivityWatcherOptions = {}): SessionRolloutActivityWatcher {
  const resolvedSessionId = resolveSessionId(sessionId);
  const sessionsRoot = resolveSessionsRoot();
  const startedAt = now();

  let isStopped = false;
  let rolloutPath: string | null = null;
  let lastSize: number | null = null;
  let lastGrowthAt = startedAt;
  let transientErrorCount = 0;

  const tick = (): void => {
    if (isStopped) {
      return;
    }

    try {
      const currentTime = now();

      if (!rolloutPath) {
        if (currentTime - startedAt >= lookupTimeoutMs) {
          onTimeout({ sessionId: resolvedSessionId });
          stop();
          return;
        }

        rolloutPath = findRolloutFileForSession(sessionsRoot, resolvedSessionId, { fsModule });
        if (!rolloutPath) {
          transientErrorCount = 0;
          return;
        }

        lastSize = readFileSize(rolloutPath, fsModule);
        lastGrowthAt = currentTime;
        transientErrorCount = 0;
        onEvent({
          reason: "materialized",
          sessionId: resolvedSessionId,
          rolloutPath,
          size: lastSize,
        });
        return;
      }

      const nextSize = readFileSize(rolloutPath, fsModule);
      transientErrorCount = 0;
      if (lastSize === null || nextSize > lastSize) {
        lastSize = nextSize;
        lastGrowthAt = currentTime;
        onEvent({
          reason: "growth",
          sessionId: resolvedSessionId,
          rolloutPath,
          size: nextSize,
        });
        return;
      }

      if (currentTime - lastGrowthAt >= idleTimeoutMs) {
        onIdle({
          sessionId: resolvedSessionId,
          rolloutPath,
          size: lastSize,
        });
        stop();
      }
    } catch (error) {
      if (
        isRetryableFilesystemError(error)
        && transientErrorCount < transientErrorRetryLimit
      ) {
        transientErrorCount += 1;
        return;
      }

      onError(asError(error));
      stop();
    }
  };

  const intervalId = setInterval(tick, intervalMs);
  tick();

  function stop(): void {
    if (isStopped) {
      return;
    }

    isStopped = true;
    clearInterval(intervalId);
  }

  return {
    stop,
    get sessionId() {
      return resolvedSessionId;
    },
  };
}

export function watchSessionRollout(sessionId = ""): void {
  const resolvedSessionId = resolveSessionId(sessionId);
  const sessionsRoot = resolveSessionsRoot();
  const rolloutPath = findRolloutFileForSession(sessionsRoot, resolvedSessionId);

  if (!rolloutPath) {
    throw new Error(`No rollout file found for session ${resolvedSessionId}.`);
  }

  let offset = fs.statSync(rolloutPath).size;
  let partialLine = "";

  console.log(`[coderover] Watching session ${resolvedSessionId}`);
  console.log(`[coderover] Rollout file: ${rolloutPath}`);
  console.log("[coderover] Waiting for new persisted events... (Ctrl+C to stop)");

  const onChange = (current: fs.Stats, previous: fs.Stats): void => {
    if (current.size <= previous.size) {
      return;
    }

    const stream = fs.createReadStream(rolloutPath, {
      start: offset,
      end: current.size - 1,
      encoding: "utf8",
    });

    let chunkBuffer = "";
    stream.on("data", (chunk: string | Buffer) => {
      chunkBuffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });

    stream.on("end", () => {
      offset = current.size;
      const combined = partialLine + chunkBuffer;
      const lines = combined.split("\n");
      partialLine = lines.pop() || "";

      for (const line of lines) {
        const formatted = formatRolloutLine(line);
        if (formatted) {
          console.log(formatted);
        }
      }
    });
  };

  fs.watchFile(rolloutPath, { interval: 700 }, onChange);

  const cleanup = (): never => {
    fs.unwatchFile(rolloutPath, onChange);
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

function resolveSessionId(sessionId: string | undefined): string {
  if (sessionId && typeof sessionId === "string") {
    return sessionId;
  }

  const last = readLastActiveSession();
  if (last?.sessionId) {
    return last.sessionId;
  }

  throw new Error("No session id provided and no remembered CodeRover session found.");
}

export function resolveSessionsRoot(): string {
  const coderoverHome = process.env.CODEROVER_HOME || path.join(os.homedir(), ".coderover");
  return path.join(coderoverHome, "sessions");
}

export function findRolloutFileForSession(
  root: string,
  sessionId: string,
  { fsModule = getDefaultScanFsModule() }: { fsModule?: RolloutScanFsModule } = {}
): string | null {
  if (!fsModule.existsSync(root)) {
    return null;
  }

  const stack: string[] = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    const entries = fsModule.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (
        entry.name.includes(sessionId)
        && entry.name.startsWith("rollout-")
        && entry.name.endsWith(".jsonl")
      ) {
        return fullPath;
      }
    }
  }

  return null;
}

export function readLatestContextWindowUsage({
  sessionId,
  turnId = "",
  root = resolveSessionsRoot(),
  fsModule = getDefaultReadFsModule(),
  scanBytes = DEFAULT_CONTEXT_READ_SCAN_BYTES,
}: ReadLatestContextWindowUsageOptions = {}): ContextWindowUsageReadResult | null {
  const normalizedSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
  const normalizedTurnId = typeof turnId === "string" ? turnId.trim() : "";
  if (!normalizedSessionId && !normalizedTurnId) {
    return null;
  }

  const rolloutPath =
    findRolloutFileForSession(root, normalizedSessionId, { fsModule })
    || findRecentRolloutFileForContextRead(root, {
      sessionId: normalizedSessionId,
      turnId: normalizedTurnId,
      fsModule,
    });
  if (!rolloutPath) {
    return null;
  }

  const stat = fsModule.statSync(rolloutPath);
  const start = Math.max(0, stat.size - Math.max(0, scanBytes));
  const chunk = fsModule.readFileSync(rolloutPath, { encoding: "utf8" }).slice(start);
  const lines = chunk.split("\n");
  if (start > 0 && lines.length > 0) {
    lines.shift();
  }

  let latestUsage: ContextWindowUsage | null = null;
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      continue;
    }

    let parsed: unknown = null;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      continue;
    }

    const usage = extractContextWindowUsage(parsed);
    if (usage) {
      latestUsage = usage;
    }
  }

  if (!latestUsage) {
    return null;
  }

  return {
    rolloutPath,
    usage: latestUsage,
  };
}

function findRecentRolloutFileForContextRead(
  root: string,
  {
    sessionId = "",
    turnId = "",
    fsModule = getDefaultReadFsModule(),
    candidateLimit = DEFAULT_RECENT_ROLLOUT_CANDIDATE_LIMIT,
    scanBytes = 16 * 1024,
  }: FindRecentRolloutOptions = {}
): string | null {
  const candidates = collectRecentRolloutFiles(root, { fsModule, candidateLimit });
  if (candidates.length === 0) {
    return null;
  }

  if (turnId) {
    for (const candidate of candidates) {
      if (rolloutFileContainsToken(candidate.filePath, turnId, { fsModule, scanBytes })) {
        return candidate.filePath;
      }
    }
  }

  if (sessionId) {
    for (const candidate of candidates) {
      if (rolloutFileContainsToken(candidate.filePath, sessionId, { fsModule, scanBytes })) {
        return candidate.filePath;
      }
    }
  }

  return null;
}

function collectRecentRolloutFiles(
  root: string,
  {
    fsModule = getDefaultScanFsModule(),
    candidateLimit = DEFAULT_RECENT_ROLLOUT_CANDIDATE_LIMIT,
  }: CollectRecentRolloutOptions = {}
): RecentRolloutFile[] {
  if (!root || !fsModule.existsSync(root)) {
    return [];
  }

  const stack: string[] = [root];
  const files: RecentRolloutFile[] = [];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    const entries = fsModule.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (!entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) {
        continue;
      }

      let modifiedAtMs = 0;
      try {
        modifiedAtMs = fsModule.statSync(fullPath).mtimeMs || 0;
      } catch {
        modifiedAtMs = 0;
      }

      files.push({
        filePath: fullPath,
        modifiedAtMs,
      });
    }
  }

  return files
    .sort((left, right) => right.modifiedAtMs - left.modifiedAtMs)
    .slice(0, candidateLimit);
}

function rolloutFileContainsToken(
  filePath: string,
  token: string,
  {
    fsModule = getDefaultReadFsModule(),
    scanBytes = 16 * 1024,
  }: RolloutTokenSearchOptions = {}
): boolean {
  const normalizedToken = typeof token === "string" ? token.trim() : "";
  if (!filePath || !normalizedToken) {
    return false;
  }

  const stat = fsModule.statSync(filePath);
  const start = Math.max(0, stat.size - Math.max(0, scanBytes));
  const chunk = fsModule.readFileSync(filePath, { encoding: "utf8" }).slice(start);
  return chunk.includes(normalizedToken);
}

function extractContextWindowUsage(root: unknown): ContextWindowUsage | null {
  const usage = normalizeContextWindowUsage(root);
  if (usage) {
    return usage;
  }

  if (!root || typeof root !== "object") {
    return null;
  }

  if (Array.isArray(root)) {
    let latest: ContextWindowUsage | null = null;
    for (const value of root) {
      const nested = extractContextWindowUsage(value);
      if (nested) {
        latest = nested;
      }
    }
    return latest;
  }

  let latest: ContextWindowUsage | null = null;
  for (const value of Object.values(root)) {
    const nested = extractContextWindowUsage(value);
    if (nested) {
      latest = nested;
    }
  }
  return latest;
}

function normalizeContextWindowUsage(value: unknown): ContextWindowUsage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const root = value as Record<string, unknown>;
  const tokensUsed = firstFiniteNumber(root, [
    "tokensUsed",
    "tokens_used",
    "totalTokens",
    "total_tokens",
    "input_tokens",
  ]);
  const tokenLimit = firstFiniteNumber(root, [
    "tokenLimit",
    "token_limit",
    "maxTokens",
    "max_tokens",
    "contextWindow",
    "context_window",
  ]);

  if (tokensUsed == null || tokenLimit == null || tokenLimit <= 0) {
    return null;
  }

  return {
    tokensUsed: Math.max(0, Math.round(tokensUsed)),
    tokenLimit: Math.max(0, Math.round(tokenLimit)),
  };
}

function firstFiniteNumber(object: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

function formatRolloutLine(rawLine: string): string | null {
  const trimmed = rawLine.trim();
  if (!trimmed) {
    return null;
  }

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const root = parsed as Record<string, unknown>;
  const timestamp = formatTimestamp(root.timestamp);
  const payload =
    root.payload && typeof root.payload === "object" && !Array.isArray(root.payload)
      ? (root.payload as Record<string, unknown>)
      : {};

  if (root.type === "event_msg") {
    const eventType = payload.type;
    if (eventType === "user_message") {
      return `${timestamp} Phone: ${previewText(payload.message)}`;
    }
    if (eventType === "agent_message") {
      return `${timestamp} CodeRover: ${previewText(payload.message)}`;
    }
    if (eventType === "task_started") {
      return `${timestamp} Task started`;
    }
    if (eventType === "task_complete") {
      return `${timestamp} Task complete`;
    }
  }

  return null;
}

function formatTimestamp(value: unknown): string {
  if (!value || typeof value !== "string") {
    return "[time?]";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "[time?]";
  }

  return `[${date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })}]`;
}

function previewText(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 120) {
    return normalized;
  }

  return `${normalized.slice(0, 117)}...`;
}

function readFileSize(filePath: string, fsModule: RolloutScanFsModule): number {
  return fsModule.statSync(filePath).size;
}

function isRetryableFilesystemError(error: unknown): error is NodeJS.ErrnoException {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && ["ENOENT", "EACCES", "EPERM", "EBUSY"].includes(code);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
