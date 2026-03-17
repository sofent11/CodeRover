// FILE: coderover-desktop-refresher.ts
// Purpose: Debounced Mac desktop refresh controller for CodeRover.app after phone-authored conversation changes.

import { execFile, type ExecFileException } from "child_process";
import * as path from "path";

import {
  createSessionRolloutActivityWatcher,
  type SessionRolloutActivityEvent,
  type SessionRolloutActivityWatcher,
} from "./rollout-watch";

const DEFAULT_BUNDLE_ID = "com.sofent.CodeRover";
const DEFAULT_APP_PATH = "/Applications/CodeRover.app";
const DEFAULT_DEBOUNCE_MS = 1200;
const DEFAULT_FALLBACK_NEW_THREAD_MS = 2_000;
const DEFAULT_MID_RUN_REFRESH_THROTTLE_MS = 3_000;
const DEFAULT_ROLLOUT_LOOKUP_TIMEOUT_MS = 5_000;
const DEFAULT_ROLLOUT_IDLE_TIMEOUT_MS = 10_000;
const DEFAULT_CUSTOM_REFRESH_FAILURE_THRESHOLD = 3;
const REFRESH_SCRIPT_PATH = path.join(__dirname, "scripts", "coderover-refresh.applescript");
const NEW_THREAD_DEEP_LINK = "coderover://threads/new";

type RefreshKind = "phone" | "rollout_materialized" | "rollout_growth" | "completion";
type RefresherMode = "idle" | "pending_new_thread" | "watching_thread";
type RefreshBackend = "command" | "applescript";
type JsonRecord = Record<string, unknown>;

interface RefreshTarget {
  sessionId: string | null;
  url: string;
}

interface BridgeConfig {
  localHost: string;
  localPort: number;
  tailnetUrl: string;
  relayUrls: string[];
  refreshEnabled: boolean;
  refreshDebounceMs: number;
  coderoverEndpoint: string;
  refreshCommand: string;
  coderoverBundleId: string;
  coderoverAppPath: string;
}

interface WatchFactoryOptions {
  sessionId: string;
  lookupTimeoutMs: number;
  idleTimeoutMs: number;
  onEvent: (event: SessionRolloutActivityEvent) => void;
  onIdle: () => void;
  onTimeout: () => void;
  onError: (error: Error) => void;
}

type WatchSessionRolloutFactory = (options: WatchFactoryOptions) => SessionRolloutActivityWatcher;
type RefreshExecutor = (targetUrl: string) => Promise<unknown>;

interface ReadBridgeConfigOptions {
  env?: NodeJS.ProcessEnv | Record<string, string>;
  platform?: NodeJS.Platform | string;
}

interface RefreshExecError extends Error {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}

interface CodeRoverDesktopRefresherOptions {
  enabled?: boolean;
  debounceMs?: number;
  refreshCommand?: string;
  bundleId?: string;
  appPath?: string;
  logPrefix?: string;
  fallbackNewThreadMs?: number;
  midRunRefreshThrottleMs?: number;
  rolloutLookupTimeoutMs?: number;
  rolloutIdleTimeoutMs?: number;
  now?: () => number;
  refreshExecutor?: RefreshExecutor | null;
  watchSessionRolloutFactory?: WatchSessionRolloutFactory;
  refreshBackend?: RefreshBackend | null;
  customRefreshFailureThreshold?: number;
}

export class CodeRoverDesktopRefresher {
  enabled: boolean;
  debounceMs: number;
  refreshCommand: string;
  bundleId: string;
  appPath: string;
  logPrefix: string;
  fallbackNewThreadMs: number;
  midRunRefreshThrottleMs: number;
  rolloutLookupTimeoutMs: number;
  rolloutIdleTimeoutMs: number;
  now: () => number;
  refreshExecutor: RefreshExecutor | null;
  watchSessionRolloutFactory: WatchSessionRolloutFactory;
  refreshBackend: RefreshBackend;
  customRefreshFailureThreshold: number;

  mode: RefresherMode = "idle";
  pendingNewThread = false;
  pendingRefreshKinds = new Set<RefreshKind>();
  pendingCompletionRefresh = false;
  pendingCompletionTurnId: string | null = null;
  pendingCompletionTargetUrl = "";
  pendingCompletionTargetSessionId = "";
  pendingTargetUrl = "";
  pendingTargetSessionId = "";
  lastRefreshAt = 0;
  lastRefreshSignature = "";
  lastTurnIdRefreshed: string | null = null;
  lastMidRunRefreshAt = 0;
  refreshTimer: NodeJS.Timeout | null = null;
  refreshRunning = false;
  fallbackTimer: NodeJS.Timeout | null = null;
  activeWatcher: SessionRolloutActivityWatcher | null = null;
  activeWatchedSessionId: string | null = null;
  watchStartAt = 0;
  lastRolloutSize: number | null = null;
  stopWatcherAfterRefreshSessionId: string | null = null;
  runtimeRefreshAvailable: boolean;
  consecutiveRefreshFailures = 0;
  unavailableLogged = false;

  constructor({
    enabled = true,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    refreshCommand = "",
    bundleId = DEFAULT_BUNDLE_ID,
    appPath = DEFAULT_APP_PATH,
    logPrefix = "[coderover]",
    fallbackNewThreadMs = DEFAULT_FALLBACK_NEW_THREAD_MS,
    midRunRefreshThrottleMs = DEFAULT_MID_RUN_REFRESH_THROTTLE_MS,
    rolloutLookupTimeoutMs = DEFAULT_ROLLOUT_LOOKUP_TIMEOUT_MS,
    rolloutIdleTimeoutMs = DEFAULT_ROLLOUT_IDLE_TIMEOUT_MS,
    now = () => Date.now(),
    refreshExecutor = null,
    watchSessionRolloutFactory = createSessionRolloutActivityWatcher,
    refreshBackend = null,
    customRefreshFailureThreshold = DEFAULT_CUSTOM_REFRESH_FAILURE_THRESHOLD,
  }: CodeRoverDesktopRefresherOptions = {}) {
    this.enabled = enabled;
    this.debounceMs = debounceMs;
    this.refreshCommand = refreshCommand;
    this.bundleId = bundleId;
    this.appPath = appPath;
    this.logPrefix = logPrefix;
    this.fallbackNewThreadMs = fallbackNewThreadMs;
    this.midRunRefreshThrottleMs = midRunRefreshThrottleMs;
    this.rolloutLookupTimeoutMs = rolloutLookupTimeoutMs;
    this.rolloutIdleTimeoutMs = rolloutIdleTimeoutMs;
    this.now = now;
    this.refreshExecutor = refreshExecutor;
    this.watchSessionRolloutFactory = watchSessionRolloutFactory;
    this.refreshBackend =
      refreshBackend || (this.refreshCommand || this.refreshExecutor ? "command" : "applescript");
    this.customRefreshFailureThreshold = customRefreshFailureThreshold;
    this.runtimeRefreshAvailable = enabled;
  }

  handleInbound(rawMessage: string): void {
    const parsed = safeParseJSON(rawMessage);
    if (!parsed) {
      return;
    }

    const method = normalizeOptionalString(parsed.method);
    if (method === "session/new") {
      const target = resolveInboundTarget(method, parsed);
      if (target?.sessionId) {
        this.queueRefresh("phone", target, `phone ${method}`);
        this.ensureWatcher(target.sessionId);
        return;
      }

      this.pendingNewThread = true;
      this.mode = "pending_new_thread";
      this.clearPendingTarget();
      this.scheduleNewThreadFallback();
      return;
    }

    if (method === "session/prompt") {
      const target = resolveInboundTarget(method, parsed);
      if (!target) {
        return;
      }

      this.queueRefresh("phone", target, `phone ${method}`);
      if (target.sessionId) {
        this.ensureWatcher(target.sessionId);
      }
    }
  }

  handleOutbound(rawMessage: string): void {
    const parsed = safeParseJSON(rawMessage);
    if (!parsed) {
      return;
    }

    const method = normalizeOptionalString(parsed.method);
    if (method === "session/update") {
      const target = resolveOutboundTarget(method, parsed);
      const runState = extractSessionRunState(parsed);
      const turnId = extractTurnId(parsed);

      if (runState === "completed" || runState === "stopped" || runState === "failed" || runState === "idle") {
        this.clearFallbackTimer();
        if (turnId && turnId === this.lastTurnIdRefreshed) {
          this.log(`refresh skipped (debounced): completion already refreshed for ${turnId}`);
          return;
        }
        this.queueCompletionRefresh(target, turnId, `coderover ${method}`);
        return;
      }

      this.pendingNewThread = false;
      this.clearFallbackTimer();
      this.queueRefresh("phone", target, `coderover ${method}`);
      if (target?.sessionId) {
        this.mode = "watching_thread";
        this.ensureWatcher(target.sessionId);
      }
    }
  }

  handleTransportReset(): void {
    this.clearRefreshTimer();
    this.clearPendingState();
    this.lastRefreshAt = 0;
    this.lastRefreshSignature = "";
    this.mode = "idle";
    this.clearFallbackTimer();
    this.stopWatcher();
  }

  queueRefresh(kind: RefreshKind, target: RefreshTarget | null, reason: string): void {
    this.noteRefreshTarget(target);
    this.pendingRefreshKinds.add(kind);
    this.scheduleRefresh(reason);
  }

  queueCompletionRefresh(target: RefreshTarget | null, turnId: string | null, reason: string): void {
    this.noteCompletionTarget(target);
    this.pendingCompletionRefresh = true;
    this.pendingCompletionTurnId = turnId;
    this.stopWatcherAfterRefreshSessionId = target?.sessionId || null;
    this.scheduleRefresh(reason);
  }

  noteRefreshTarget(target: RefreshTarget | null): void {
    if (!target?.url) {
      return;
    }
    this.pendingTargetUrl = target.url;
    this.pendingTargetSessionId = target.sessionId || "";
  }

  clearPendingTarget(): void {
    this.pendingTargetUrl = "";
    this.pendingTargetSessionId = "";
  }

  noteCompletionTarget(target: RefreshTarget | null): void {
    if (!target?.url) {
      return;
    }
    this.pendingCompletionTargetUrl = target.url;
    this.pendingCompletionTargetSessionId = target.sessionId || "";
  }

  clearPendingCompletionTarget(): void {
    this.pendingCompletionTargetUrl = "";
    this.pendingCompletionTargetSessionId = "";
  }

  scheduleRefresh(reason: string): void {
    if (!this.canRefresh()) {
      return;
    }

    if (this.refreshTimer) {
      this.log(`refresh already pending: ${reason}`);
      return;
    }

    const elapsedSinceLastRefresh = this.now() - this.lastRefreshAt;
    const waitMs = Math.max(0, this.debounceMs - elapsedSinceLastRefresh);
    this.log(`refresh scheduled: ${reason}`);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.runPendingRefresh();
    }, waitMs);
  }

  async runPendingRefresh(): Promise<void> {
    if (!this.canRefresh()) {
      this.clearPendingState();
      return;
    }

    if (!this.hasPendingRefreshWork()) {
      return;
    }

    if (this.refreshRunning) {
      this.log("refresh skipped (debounced): another refresh is already running");
      return;
    }

    const isCompletionRun = this.pendingCompletionRefresh;
    const pendingRefreshKinds = isCompletionRun ? new Set<RefreshKind>(["completion"]) : new Set(this.pendingRefreshKinds);
    const completionTurnId = this.pendingCompletionTurnId;
    const targetUrl = isCompletionRun ? this.pendingCompletionTargetUrl : this.pendingTargetUrl;
    const targetSessionId = isCompletionRun ? this.pendingCompletionTargetSessionId : this.pendingTargetSessionId;
    const stopWatcherAfterRefreshSessionId = isCompletionRun ? this.stopWatcherAfterRefreshSessionId : null;
    const shouldForceCompletionRefresh = isCompletionRun;

    if (isCompletionRun) {
      this.pendingCompletionRefresh = false;
      this.pendingCompletionTurnId = null;
      this.clearPendingCompletionTarget();
      this.stopWatcherAfterRefreshSessionId = null;
    } else {
      this.pendingRefreshKinds.clear();
      this.clearPendingTarget();
    }

    this.refreshRunning = true;
    this.log(
      `refresh running: ${Array.from(pendingRefreshKinds).join("+")}${targetSessionId ? ` session=${targetSessionId}` : ""}`
    );

    let didRefresh = false;
    try {
      const refreshSignature = `${targetUrl || "app"}|${targetSessionId || "no-session"}`;
      if (
        !shouldForceCompletionRefresh
        && refreshSignature === this.lastRefreshSignature
        && this.now() - this.lastRefreshAt < this.debounceMs
      ) {
        this.log(`refresh skipped (duplicate target): ${refreshSignature}`);
      } else {
        await this.executeRefresh(targetUrl);
        this.lastRefreshAt = this.now();
        this.lastRefreshSignature = refreshSignature;
        this.consecutiveRefreshFailures = 0;
        didRefresh = true;
      }
      if (completionTurnId && didRefresh) {
        this.lastTurnIdRefreshed = completionTurnId;
      }
    } catch (error) {
      this.handleRefreshFailure(error);
    } finally {
      this.refreshRunning = false;
      if (
        didRefresh
        && stopWatcherAfterRefreshSessionId
        && stopWatcherAfterRefreshSessionId === this.activeWatchedSessionId
      ) {
        this.stopWatcher();
        this.mode = this.pendingNewThread ? "pending_new_thread" : "idle";
      }
      if (this.hasPendingRefreshWork()) {
        this.scheduleRefresh("pending follow-up refresh");
      }
    }
  }

  executeRefresh(targetUrl: string): Promise<unknown> {
    if (this.refreshExecutor) {
      return this.refreshExecutor(targetUrl || "");
    }

    if (this.refreshCommand) {
      return execFilePromise("/bin/sh", ["-lc", this.refreshCommand]);
    }

    return execFilePromise("osascript", [
      REFRESH_SCRIPT_PATH,
      this.bundleId,
      this.appPath,
      targetUrl || "",
    ]);
  }

  clearPendingState(): void {
    this.pendingNewThread = false;
    this.pendingRefreshKinds.clear();
    this.pendingCompletionRefresh = false;
    this.pendingCompletionTurnId = null;
    this.clearPendingCompletionTarget();
    this.clearPendingTarget();
    this.stopWatcherAfterRefreshSessionId = null;
  }

  clearRefreshTimer(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  scheduleNewThreadFallback(): void {
    if (!this.canRefresh() || this.fallbackTimer) {
      return;
    }

    this.fallbackTimer = setTimeout(() => {
      this.fallbackTimer = null;
      if (!this.pendingNewThread || this.pendingTargetSessionId) {
        return;
      }

      this.noteRefreshTarget({ sessionId: null, url: NEW_THREAD_DEEP_LINK });
      this.pendingRefreshKinds.add("phone");
      this.scheduleRefresh("fallback session/new");
    }, this.fallbackNewThreadMs);
  }

  clearFallbackTimer(): void {
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
  }

  ensureWatcher(sessionId: string | null): void {
    if (!this.canRefresh() || !sessionId) {
      return;
    }

    if (this.activeWatchedSessionId === sessionId && this.activeWatcher) {
      return;
    }

    this.stopWatcher();
    this.activeWatchedSessionId = sessionId;
    this.watchStartAt = this.now();
    this.lastRolloutSize = null;
    this.mode = "watching_thread";
    this.activeWatcher = this.watchSessionRolloutFactory({
      sessionId,
      lookupTimeoutMs: this.rolloutLookupTimeoutMs,
      idleTimeoutMs: this.rolloutIdleTimeoutMs,
      onEvent: (event) => this.handleWatcherEvent(event),
      onIdle: () => {
        this.log(`rollout watcher idle session=${sessionId}`);
        this.stopWatcher();
        this.mode = this.pendingNewThread ? "pending_new_thread" : "idle";
      },
      onTimeout: () => {
        this.log(`rollout watcher timeout session=${sessionId}`);
        this.stopWatcher();
        this.mode = this.pendingNewThread ? "pending_new_thread" : "idle";
      },
      onError: (error) => {
        this.log(`rollout watcher failed session=${sessionId}: ${error.message}`);
        this.stopWatcher();
        this.mode = this.pendingNewThread ? "pending_new_thread" : "idle";
      },
    });
  }

  stopWatcher(): void {
    if (!this.activeWatcher) {
      this.activeWatchedSessionId = null;
      this.watchStartAt = 0;
      this.lastRolloutSize = null;
      return;
    }

    this.activeWatcher.stop();
    this.activeWatcher = null;
    this.activeWatchedSessionId = null;
    this.watchStartAt = 0;
    this.lastRolloutSize = null;
  }

  handleWatcherEvent(event: SessionRolloutActivityEvent): void {
    if (!event.sessionId || event.sessionId !== this.activeWatchedSessionId) {
      return;
    }

    const previousSize = this.lastRolloutSize;
    this.lastRolloutSize = event.size;
    this.noteRefreshTarget({
      sessionId: event.sessionId,
      url: buildSessionDeepLink(event.sessionId),
    });

    if (event.reason === "materialized") {
      this.queueRefresh("rollout_materialized", {
        sessionId: event.sessionId,
        url: buildSessionDeepLink(event.sessionId),
      }, `rollout ${event.reason}`);
      return;
    }

    if (event.reason !== "growth") {
      return;
    }

    if (previousSize == null) {
      this.queueRefresh("rollout_growth", {
        sessionId: event.sessionId,
        url: buildSessionDeepLink(event.sessionId),
      }, "rollout first-growth");
      this.lastMidRunRefreshAt = this.now();
      return;
    }

    if (this.now() - this.lastMidRunRefreshAt < this.midRunRefreshThrottleMs) {
      return;
    }

    this.lastMidRunRefreshAt = this.now();
    this.queueRefresh("rollout_growth", {
      sessionId: event.sessionId,
      url: buildSessionDeepLink(event.sessionId),
    }, "rollout mid-run");
  }

  log(message: string): void {
    console.log(`${this.logPrefix} ${message}`);
  }

  handleRefreshFailure(error: unknown): void {
    const message = extractErrorMessage(error);
    console.error(`${this.logPrefix} refresh failed: ${message}`);

    if (this.refreshBackend === "applescript" && isDesktopUnavailableError(message)) {
      this.disableRuntimeRefresh("desktop refresh unavailable on this Mac");
      return;
    }

    if (this.refreshBackend === "command") {
      this.consecutiveRefreshFailures += 1;
      if (this.consecutiveRefreshFailures >= this.customRefreshFailureThreshold) {
        this.disableRuntimeRefresh("custom refresh command kept failing");
      }
    }
  }

  disableRuntimeRefresh(reason: string): void {
    if (!this.runtimeRefreshAvailable) {
      return;
    }

    this.runtimeRefreshAvailable = false;
    this.clearRefreshTimer();
    this.clearFallbackTimer();
    this.stopWatcher();
    this.clearPendingState();
    this.mode = "idle";

    if (!this.unavailableLogged) {
      console.error(`${this.logPrefix} desktop refresh disabled until restart: ${reason}`);
      this.unavailableLogged = true;
    }
  }

  canRefresh(): boolean {
    return this.enabled && this.runtimeRefreshAvailable;
  }

  hasPendingRefreshWork(): boolean {
    return this.pendingCompletionRefresh || this.pendingRefreshKinds.size > 0;
  }
}

export function readBridgeConfig({ env = process.env }: ReadBridgeConfigOptions = {}): BridgeConfig {
  const environment = env as Record<string, string | undefined>;
  const coderoverEndpoint = readFirstDefinedEnv(["CODEROVER_ENDPOINT", "CODEROVER_ENDPOINT"], "", environment);
  const refreshCommand = readFirstDefinedEnv(["CODEROVER_REFRESH_COMMAND"], "", environment);
  const explicitRefreshEnabled = readOptionalBooleanEnv(["CODEROVER_REFRESH_ENABLED"], environment);
  const defaultRefreshEnabled = false;

  return {
    localHost: readFirstDefinedEnv(["CODEROVER_LOCAL_HOST"], "0.0.0.0", environment),
    localPort: parseIntegerEnv(readFirstDefinedEnv(["CODEROVER_LOCAL_PORT"], "8765", environment), 8765),
    tailnetUrl: readFirstDefinedEnv(["CODEROVER_TAILNET_URL"], "", environment),
    relayUrls: readListEnv(["CODEROVER_RELAY_URLS", "CODEROVER_RELAY_URL"], environment),
    refreshEnabled: explicitRefreshEnabled == null ? defaultRefreshEnabled : explicitRefreshEnabled,
    refreshDebounceMs: parseIntegerEnv(
      readFirstDefinedEnv(["CODEROVER_REFRESH_DEBOUNCE_MS"], String(DEFAULT_DEBOUNCE_MS), environment),
      DEFAULT_DEBOUNCE_MS
    ),
    coderoverEndpoint,
    refreshCommand,
    coderoverBundleId: readFirstDefinedEnv(["CODEROVER_BUNDLE_ID"], DEFAULT_BUNDLE_ID, environment),
    coderoverAppPath: DEFAULT_APP_PATH,
  };
}

function readListEnv(keys: string[], env: Record<string, string | undefined>): string[] {
  for (const key of keys) {
    const rawValue = env[key];
    if (typeof rawValue !== "string") {
      continue;
    }
    return rawValue.split(/[,\n]/).map((value) => value.trim()).filter(Boolean);
  }
  return [];
}

function execFilePromise(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) {
        const execError = error as RefreshExecError & ExecFileException;
        execError.stdout = stdout;
        execError.stderr = stderr;
        reject(execError);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function safeParseJSON(value: string): JsonRecord | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonRecord)
      : null;
  } catch {
    return null;
  }
}

function extractTurnId(message: JsonRecord): string | null {
  const params = asRecord(message.params);
  if (!params) {
    return null;
  }

  const update = asRecord(params.update);
  const coderoverMeta = asRecord(asRecord(update?._meta)?.coderover);
  if (typeof coderoverMeta?.turnId === "string" && coderoverMeta.turnId) {
    return coderoverMeta.turnId;
  }

  if (typeof params.turnId === "string" && params.turnId) {
    return params.turnId;
  }

  const turn = asRecord(params.turn);
  if (typeof turn?.id === "string" && turn.id) {
    return turn.id;
  }

  return null;
}

function extractSessionId(message: JsonRecord): string | null {
  const params = asRecord(message.params);
  const result = asRecord(message.result);
  const update = asRecord(params?.update);
  const coderoverMeta = asRecord(asRecord(update?._meta)?.coderover);

  const thread = asRecord(params.thread);
  const turn = asRecord(params.turn);
  const candidates = [
    params?.sessionId,
    result?.sessionId,
    coderoverMeta?.sessionId,
    thread?.id,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate) {
      return candidate;
    }
  }

  return null;
}

function resolveInboundTarget(method: string, message: JsonRecord): RefreshTarget | null {
  const sessionId = extractSessionId(message);
  if (sessionId) {
    return { sessionId, url: buildSessionDeepLink(sessionId) };
  }

  if (method === "session/new") {
    return { sessionId: null, url: NEW_THREAD_DEEP_LINK };
  }

  return null;
}

function resolveOutboundTarget(method: string, message: JsonRecord): RefreshTarget | null {
  const sessionId = extractSessionId(message);
  if (sessionId) {
    return { sessionId, url: buildSessionDeepLink(sessionId) };
  }

  if (method === "session/update") {
    return { sessionId: null, url: NEW_THREAD_DEEP_LINK };
  }

  return null;
}

function buildSessionDeepLink(sessionId: string): string {
  return `coderover://threads/${sessionId}`;
}

function extractSessionRunState(message: JsonRecord): string | null {
  const params = asRecord(message.params);
  const update = asRecord(params?.update);
  const coderoverMeta = asRecord(asRecord(update?._meta)?.coderover);
  if (typeof coderoverMeta?.runState === "string" && coderoverMeta.runState) {
    return coderoverMeta.runState;
  }
  return null;
}

function readOptionalBooleanEnv(
  keys: string[],
  env: Record<string, string | undefined> = process.env
): boolean | null {
  for (const key of keys) {
    const value = env[key];
    if (typeof value === "string" && value.trim() !== "") {
      return parseBooleanEnv(value.trim());
    }
  }
  return null;
}

function readFirstDefinedEnv(
  keys: string[],
  fallback: string,
  env: Record<string, string | undefined> = process.env
): string {
  for (const key of keys) {
    const value = env[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return fallback;
}

function parseBooleanEnv(value: string): boolean {
  const normalized = String(value).trim().toLowerCase();
  return normalized !== "false" && normalized !== "0" && normalized !== "no";
}

function parseIntegerEnv(value: string, fallback: number): number {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function extractErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const execError = error as RefreshExecError;
    return (
      readBufferish(execError.stderr)
      || readBufferish(execError.stdout)
      || (error as Error).message
      || "unknown refresh error"
    ).trim();
  }
  return String(error || "unknown refresh error").trim();
}

function readBufferish(value: string | Buffer | undefined): string {
  if (typeof value === "string") {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  return "";
}

function isDesktopUnavailableError(message: string): boolean {
  const normalized = String(message).toLowerCase();
  return [
    "unable to find application named",
    "application isn’t running",
    "application isn't running",
    "can’t get application id",
    "can't get application id",
    "does not exist",
    "no application knows how to open",
    "cannot find app",
    "could not find application",
  ].some((snippet) => normalized.includes(snippet));
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}
