// FILE: coderover-desktop-refresher.js
// Purpose: Debounced Mac desktop refresh controller for CodeRover.app after phone-authored conversation changes.
// Layer: CLI helper
// Exports: CodeRoverDesktopRefresher, readBridgeConfig
// Depends on: child_process, path, ./rollout-watch

const { execFile } = require("child_process");
const path = require("path");
const { createThreadRolloutActivityWatcher } = require("./rollout-watch");

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

class CodeRoverDesktopRefresher {
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
    watchThreadRolloutFactory = createThreadRolloutActivityWatcher,
    refreshBackend = null,
    customRefreshFailureThreshold = DEFAULT_CUSTOM_REFRESH_FAILURE_THRESHOLD,
  } = {}) {
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
    this.watchThreadRolloutFactory = watchThreadRolloutFactory;
    this.refreshBackend = refreshBackend
      || (this.refreshCommand ? "command" : (this.refreshExecutor ? "command" : "applescript"));
    this.customRefreshFailureThreshold = customRefreshFailureThreshold;

    this.mode = "idle";
    this.pendingNewThread = false;
    this.pendingRefreshKinds = new Set();
    this.pendingCompletionRefresh = false;
    this.pendingCompletionTurnId = null;
    this.pendingCompletionTargetUrl = "";
    this.pendingCompletionTargetThreadId = "";
    this.pendingTargetUrl = "";
    this.pendingTargetThreadId = "";
    this.lastRefreshAt = 0;
    this.lastRefreshSignature = "";
    this.lastTurnIdRefreshed = null;
    this.lastMidRunRefreshAt = 0;
    this.refreshTimer = null;
    this.refreshRunning = false;
    this.fallbackTimer = null;
    this.activeWatcher = null;
    this.activeWatchedThreadId = null;
    this.watchStartAt = 0;
    this.lastRolloutSize = null;
    this.stopWatcherAfterRefreshThreadId = null;
    this.runtimeRefreshAvailable = enabled;
    this.consecutiveRefreshFailures = 0;
    this.unavailableLogged = false;
  }

  handleInbound(rawMessage) {
    const parsed = safeParseJSON(rawMessage);
    if (!parsed) {
      return;
    }

    const method = parsed.method;
    if (method === "thread/start") {
      const target = resolveInboundTarget(method, parsed);
      if (target?.threadId) {
        this.queueRefresh("phone", target, `phone ${method}`);
        this.ensureWatcher(target.threadId);
        return;
      }

      this.pendingNewThread = true;
      this.mode = "pending_new_thread";
      this.clearPendingTarget();
      this.scheduleNewThreadFallback();
      return;
    }

    if (method === "turn/start") {
      const target = resolveInboundTarget(method, parsed);
      if (!target) {
        return;
      }

      this.queueRefresh("phone", target, `phone ${method}`);
      if (target.threadId) {
        this.ensureWatcher(target.threadId);
      }
    }
  }

  handleOutbound(rawMessage) {
    const parsed = safeParseJSON(rawMessage);
    if (!parsed) {
      return;
    }

    const method = parsed.method;
    if (method === "turn/completed") {
      this.clearFallbackTimer();
      const turnId = extractTurnId(parsed);
      if (turnId && turnId === this.lastTurnIdRefreshed) {
        this.log(`refresh skipped (debounced): completion already refreshed for ${turnId}`);
        return;
      }

      const target = resolveOutboundTarget(method, parsed);
      this.queueCompletionRefresh(target, turnId, `coderover ${method}`);
      return;
    }

    if (method === "thread/started") {
      const target = resolveOutboundTarget(method, parsed);
      this.pendingNewThread = false;
      this.clearFallbackTimer();
      this.queueRefresh("phone", target, `coderover ${method}`);
      if (target?.threadId) {
        this.mode = "watching_thread";
        this.ensureWatcher(target.threadId);
      }
    }
  }

  // Stops volatile watcher/fallback state when transport drops or bridge exits.
  handleTransportReset() {
    this.clearRefreshTimer();
    this.clearPendingState();
    this.lastRefreshAt = 0;
    this.lastRefreshSignature = "";
    this.mode = "idle";
    this.clearFallbackTimer();
    this.stopWatcher();
  }

  queueRefresh(kind, target, reason) {
    this.noteRefreshTarget(target);
    this.pendingRefreshKinds.add(kind);
    this.scheduleRefresh(reason);
  }

  queueCompletionRefresh(target, turnId, reason) {
    this.noteCompletionTarget(target);
    this.pendingCompletionRefresh = true;
    this.pendingCompletionTurnId = turnId;
    this.stopWatcherAfterRefreshThreadId = target?.threadId || null;
    this.scheduleRefresh(reason);
  }

  noteRefreshTarget(target) {
    if (!target?.url) {
      return;
    }

    this.pendingTargetUrl = target.url;
    this.pendingTargetThreadId = target.threadId || "";
  }

  clearPendingTarget() {
    this.pendingTargetUrl = "";
    this.pendingTargetThreadId = "";
  }

  noteCompletionTarget(target) {
    if (!target?.url) {
      return;
    }

    this.pendingCompletionTargetUrl = target.url;
    this.pendingCompletionTargetThreadId = target.threadId || "";
  }

  clearPendingCompletionTarget() {
    this.pendingCompletionTargetUrl = "";
    this.pendingCompletionTargetThreadId = "";
  }

  scheduleRefresh(reason) {
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

  async runPendingRefresh() {
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
    const pendingRefreshKinds = isCompletionRun
      ? new Set(["completion"])
      : new Set(this.pendingRefreshKinds);
    const completionTurnId = this.pendingCompletionTurnId;
    const targetUrl = isCompletionRun ? this.pendingCompletionTargetUrl : this.pendingTargetUrl;
    const targetThreadId = isCompletionRun
      ? this.pendingCompletionTargetThreadId
      : this.pendingTargetThreadId;
    const stopWatcherAfterRefreshThreadId = isCompletionRun
      ? this.stopWatcherAfterRefreshThreadId
      : null;
    const shouldForceCompletionRefresh = isCompletionRun;

    if (isCompletionRun) {
      this.pendingCompletionRefresh = false;
      this.pendingCompletionTurnId = null;
      this.clearPendingCompletionTarget();
      this.stopWatcherAfterRefreshThreadId = null;
    } else {
      this.pendingRefreshKinds.clear();
      this.clearPendingTarget();
    }
    this.refreshRunning = true;
    this.log(
      `refresh running: ${Array.from(pendingRefreshKinds).join("+")}${targetThreadId ? ` thread=${targetThreadId}` : ""}`
    );

    let didRefresh = false;
    try {
      const refreshSignature = `${targetUrl || "app"}|${targetThreadId || "no-thread"}`;
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
        && stopWatcherAfterRefreshThreadId
        && stopWatcherAfterRefreshThreadId === this.activeWatchedThreadId
      ) {
        this.stopWatcher();
        this.mode = this.pendingNewThread ? "pending_new_thread" : "idle";
      }
      // A completion refresh can queue while another refresh is still running,
      // so retry whenever either queue still has work.
      if (this.hasPendingRefreshWork()) {
        this.scheduleRefresh("pending follow-up refresh");
      }
    }
  }

  executeRefresh(targetUrl) {
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

  clearPendingState() {
    this.pendingNewThread = false;
    this.pendingRefreshKinds.clear();
    this.pendingCompletionRefresh = false;
    this.pendingCompletionTurnId = null;
    this.clearPendingCompletionTarget();
    this.clearPendingTarget();
    this.stopWatcherAfterRefreshThreadId = null;
  }

  clearRefreshTimer() {
    if (!this.refreshTimer) {
      return;
    }

    clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }

  // Schedules a single low-cost fallback when a brand new thread id is still unknown.
  scheduleNewThreadFallback() {
    if (!this.canRefresh()) {
      return;
    }

    if (this.fallbackTimer) {
      return;
    }

    this.fallbackTimer = setTimeout(() => {
      this.fallbackTimer = null;
      if (!this.pendingNewThread || this.pendingTargetThreadId) {
        return;
      }

      this.noteRefreshTarget({ threadId: null, url: NEW_THREAD_DEEP_LINK });
      this.pendingRefreshKinds.add("phone");
      this.scheduleRefresh("fallback thread/start");
    }, this.fallbackNewThreadMs);
  }

  clearFallbackTimer() {
    if (!this.fallbackTimer) {
      return;
    }

    clearTimeout(this.fallbackTimer);
    this.fallbackTimer = null;
  }

  // Keeps one lightweight rollout watcher alive for the current CodeRover-controlled thread.
  ensureWatcher(threadId) {
    if (!this.canRefresh() || !threadId) {
      return;
    }

    if (this.activeWatchedThreadId === threadId && this.activeWatcher) {
      return;
    }

    this.stopWatcher();
    this.activeWatchedThreadId = threadId;
    this.watchStartAt = this.now();
    this.lastRolloutSize = null;
    this.mode = "watching_thread";
    this.activeWatcher = this.watchThreadRolloutFactory({
      threadId,
      lookupTimeoutMs: this.rolloutLookupTimeoutMs,
      idleTimeoutMs: this.rolloutIdleTimeoutMs,
      onEvent: (event) => this.handleWatcherEvent(event),
      onIdle: () => {
        this.log(`rollout watcher idle thread=${threadId}`);
        this.stopWatcher();
        this.mode = this.pendingNewThread ? "pending_new_thread" : "idle";
      },
      onTimeout: () => {
        this.log(`rollout watcher timeout thread=${threadId}`);
        this.stopWatcher();
        this.mode = this.pendingNewThread ? "pending_new_thread" : "idle";
      },
      onError: (error) => {
        this.log(`rollout watcher failed thread=${threadId}: ${error.message}`);
        this.stopWatcher();
        this.mode = this.pendingNewThread ? "pending_new_thread" : "idle";
      },
    });
  }

  stopWatcher() {
    if (!this.activeWatcher) {
      this.activeWatchedThreadId = null;
      this.watchStartAt = 0;
      this.lastRolloutSize = null;
      return;
    }

    this.activeWatcher.stop();
    this.activeWatcher = null;
    this.activeWatchedThreadId = null;
    this.watchStartAt = 0;
    this.lastRolloutSize = null;
  }

  // Converts rollout growth into occasional refreshes without spamming the desktop.
  handleWatcherEvent(event) {
    if (!event?.threadId || event.threadId !== this.activeWatchedThreadId) {
      return;
    }

    const previousSize = this.lastRolloutSize;
    this.lastRolloutSize = event.size;
    this.noteRefreshTarget({
      threadId: event.threadId,
      url: buildThreadDeepLink(event.threadId),
    });

    if (event.reason === "materialized") {
      this.queueRefresh("rollout_materialized", {
        threadId: event.threadId,
        url: buildThreadDeepLink(event.threadId),
      }, `rollout ${event.reason}`);
      return;
    }

    if (event.reason !== "growth") {
      return;
    }

    if (previousSize == null) {
      this.queueRefresh("rollout_growth", {
        threadId: event.threadId,
        url: buildThreadDeepLink(event.threadId),
      }, "rollout first-growth");
      this.lastMidRunRefreshAt = this.now();
      return;
    }

    if (this.now() - this.lastMidRunRefreshAt < this.midRunRefreshThrottleMs) {
      return;
    }

    this.lastMidRunRefreshAt = this.now();
    this.queueRefresh("rollout_growth", {
      threadId: event.threadId,
      url: buildThreadDeepLink(event.threadId),
    }, "rollout mid-run");
  }

  log(message) {
    console.log(`${this.logPrefix} ${message}`);
  }

  handleRefreshFailure(error) {
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

  disableRuntimeRefresh(reason) {
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

  canRefresh() {
    return this.enabled && this.runtimeRefreshAvailable;
  }

  // Tells the debounce loop whether any phone/completion refresh is still waiting to run.
  hasPendingRefreshWork() {
    return this.pendingCompletionRefresh || this.pendingRefreshKinds.size > 0;
  }
}

function readBridgeConfig({ env = process.env, platform = process.platform } = {}) {
  const coderoverEndpoint = readFirstDefinedEnv(
    ["CODEROVER_ENDPOINT", "CODEROVER_ENDPOINT"],
    "",
    env
  );
  const refreshCommand = readFirstDefinedEnv(
    ["CODEROVER_REFRESH_COMMAND"],
    "",
    env
  );
  const explicitRefreshEnabled = readOptionalBooleanEnv(["CODEROVER_REFRESH_ENABLED"], env);
  // Desktop refresh is opt-in for now because CodeRover.app still lacks true live updates.
  const defaultRefreshEnabled = false;
  return {
    localHost: readFirstDefinedEnv(["CODEROVER_LOCAL_HOST"], "0.0.0.0", env),
    localPort: parseIntegerEnv(
      readFirstDefinedEnv(["CODEROVER_LOCAL_PORT"], "8765", env),
      8765
    ),
    tailnetUrl: readFirstDefinedEnv(["CODEROVER_TAILNET_URL"], "", env),
    relayUrls: readListEnv(["CODEROVER_RELAY_URLS", "CODEROVER_RELAY_URL"], env),
    refreshEnabled: explicitRefreshEnabled == null
      ? defaultRefreshEnabled
      : explicitRefreshEnabled,
    refreshDebounceMs: parseIntegerEnv(
      readFirstDefinedEnv(["CODEROVER_REFRESH_DEBOUNCE_MS"], String(DEFAULT_DEBOUNCE_MS), env),
      DEFAULT_DEBOUNCE_MS
    ),
    coderoverEndpoint,
    refreshCommand,
    coderoverBundleId: readFirstDefinedEnv(["CODEROVER_BUNDLE_ID"], DEFAULT_BUNDLE_ID, env),
    coderoverAppPath: DEFAULT_APP_PATH,
  };
}

function readListEnv(keys, env) {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(env, key)) {
      continue;
    }

    const rawValue = env[key];
    if (typeof rawValue !== "string") {
      continue;
    }

    return rawValue
      .split(/[,\n]/)
      .map((value) => value.trim())
      .filter(Boolean);
  }

  return [];
}

function execFilePromise(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function safeParseJSON(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractTurnId(message) {
  const params = message?.params;
  if (!params || typeof params !== "object") {
    return null;
  }

  if (typeof params.turnId === "string" && params.turnId) {
    return params.turnId;
  }

  if (params.turn && typeof params.turn === "object" && typeof params.turn.id === "string") {
    return params.turn.id;
  }

  return null;
}

function extractThreadId(message) {
  const params = message?.params;
  if (!params || typeof params !== "object") {
    return null;
  }

  const candidates = [
    params.threadId,
    params.conversationId,
    params.thread?.id,
    params.thread?.threadId,
    params.turn?.threadId,
    params.turn?.conversationId,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate) {
      return candidate;
    }
  }

  return null;
}

function resolveInboundTarget(method, message) {
  const threadId = extractThreadId(message);
  if (threadId) {
    return { threadId, url: buildThreadDeepLink(threadId) };
  }

  if (method === "thread/start" || method === "turn/start") {
    return { threadId: null, url: NEW_THREAD_DEEP_LINK };
  }

  return null;
}

function resolveOutboundTarget(method, message) {
  const threadId = extractThreadId(message);
  if (threadId) {
    return { threadId, url: buildThreadDeepLink(threadId) };
  }

  if (method === "thread/started") {
    return { threadId: null, url: NEW_THREAD_DEEP_LINK };
  }

  return null;
}

function buildThreadDeepLink(threadId) {
  return `coderover://threads/${threadId}`;
}

function readOptionalBooleanEnv(keys, env = process.env) {
  for (const key of keys) {
    const value = env[key];
    if (typeof value === "string" && value.trim() !== "") {
      return parseBooleanEnv(value.trim());
    }
  }
  return null;
}

function readFirstDefinedEnv(keys, fallback, env = process.env) {
  for (const key of keys) {
    const value = env[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return fallback;
}

function parseBooleanEnv(value) {
  const normalized = String(value).trim().toLowerCase();
  return normalized !== "false" && normalized !== "0" && normalized !== "no";
}

function parseIntegerEnv(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function extractErrorMessage(error) {
  return (
    error?.stderr?.toString("utf8")
    || error?.stdout?.toString("utf8")
    || error?.message
    || "unknown refresh error"
  ).trim();
}

function isDesktopUnavailableError(message) {
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

module.exports = {
  CodeRoverDesktopRefresher,
  readBridgeConfig,
};
