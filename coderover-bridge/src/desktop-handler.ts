// FILE: desktop-handler.ts
// Purpose: Handles explicit desktop/* bridge actions, with Codex desktop restart support on macOS.

import { execFile, type ExecFileException } from "child_process";
import * as path from "path";
import { promisify } from "util";

import {
  findRolloutFileForSession,
  resolveSessionsRoot,
  type RolloutScanFsModule,
} from "./rollout-watch";

const execFileAsync = promisify(execFile);

const DEFAULT_CODEX_BUNDLE_ID = "com.openai.codex";
const DEFAULT_CODEX_APP_PATH = "/Applications/Codex.app";
const HANDOFF_TIMEOUT_MS = 20_000;
const DEFAULT_RELAUNCH_WAIT_MS = 300;
const DEFAULT_APP_BOOT_WAIT_MS = 1_200;
const DEFAULT_THREAD_MATERIALIZE_WAIT_MS = 4_000;
const DEFAULT_THREAD_MATERIALIZE_POLL_MS = 250;

type SendResponse = (response: string) => void;
type JsonObject = Record<string, unknown>;
type DesktopProvider = "codex" | "claude" | "gemini";
type DesktopExecResult = { stdout?: string | Buffer; stderr?: string | Buffer };
type DesktopExecutor = (
  file: string,
  args?: readonly string[],
  options?: {
    timeout?: number;
  }
) => Promise<DesktopExecResult>;

interface DesktopRequestParams extends JsonObject {
  sessionId?: unknown;
  session_id?: unknown;
  provider?: unknown;
  threadId?: unknown;
  thread_id?: unknown;
}

interface ParsedDesktopRequest {
  method?: unknown;
  id?: unknown;
  params?: DesktopRequestParams;
}

interface DesktopHandlerError extends Error {
  errorCode: string;
  userMessage: string;
}

interface DesktopHandlerOptions {
  platform?: NodeJS.Platform | string;
  env?: NodeJS.ProcessEnv | Record<string, string>;
  executor?: DesktopExecutor;
  fsModule?: RolloutScanFsModule;
  isAppRunning?: (appPath: string) => Promise<boolean>;
  sleepFn?: (ms: number) => Promise<void>;
  appBootWaitMs?: number;
  relaunchWaitMs?: number;
  threadMaterializeWaitMs?: number;
  threadMaterializePollMs?: number;
  sessionMaterializeWaitMs?: number;
  sessionMaterializePollMs?: number;
  codexBundleId?: string;
  codexAppPath?: string;
}

interface RestartDesktopResult {
  success: true;
  provider: DesktopProvider;
  restarted: boolean;
  targetUrl: string;
  sessionId: string;
  desktopKnown: boolean;
}

export function handleDesktopRequest(
  rawMessage: string,
  sendResponse: SendResponse,
  options: DesktopHandlerOptions = {}
): boolean {
  const parsed = parseDesktopRequest(rawMessage);
  if (!parsed) {
    return false;
  }

  const method = normalizeDesktopMethod(parsed.method);
  if (!method) {
    return false;
  }

  const id = parsed.id;
  const params = parsed.params || {};

  handleDesktopMethod(method, params, options)
    .then((result) => {
      sendResponse(JSON.stringify({ id, result }));
    })
    .catch((error: DesktopHandlerError) => {
      sendResponse(JSON.stringify({
        id,
        error: {
          code: -32000,
          message: error.userMessage || error.message || "Unknown desktop error",
          data: {
            errorCode: error.errorCode || "desktop_error",
          },
        },
      }));
    });

  return true;
}

function normalizeDesktopMethod(value: unknown): string | null {
  const method = readNonEmptyString(value);
  if (!method) {
    return null;
  }
  if (method.startsWith("desktop/")) {
    return method;
  }
  if (method.startsWith("_coderover/desktop/")) {
    return method.replace(/^_coderover\//, "");
  }
  return null;
}

function parseDesktopRequest(rawMessage: string): ParsedDesktopRequest | null {
  try {
    return JSON.parse(rawMessage) as ParsedDesktopRequest;
  } catch {
    return null;
  }
}

async function handleDesktopMethod(
  method: string,
  params: DesktopRequestParams,
  options: DesktopHandlerOptions
): Promise<RestartDesktopResult> {
  switch (method) {
    case "desktop/restartApp":
      return restartDesktopApp(params, options);
    default:
      throw desktopError("unknown_method", `Unknown desktop method: ${method}`);
  }
}

async function restartDesktopApp(
  params: DesktopRequestParams,
  {
    platform = process.platform,
    env = process.env,
    executor = execFileAsync,
    fsModule,
    isAppRunning = null,
    sleepFn = sleep,
    appBootWaitMs = DEFAULT_APP_BOOT_WAIT_MS,
    relaunchWaitMs = DEFAULT_RELAUNCH_WAIT_MS,
    threadMaterializeWaitMs = DEFAULT_THREAD_MATERIALIZE_WAIT_MS,
    threadMaterializePollMs = DEFAULT_THREAD_MATERIALIZE_POLL_MS,
    sessionMaterializeWaitMs = DEFAULT_THREAD_MATERIALIZE_WAIT_MS,
    sessionMaterializePollMs = DEFAULT_THREAD_MATERIALIZE_POLL_MS,
    codexBundleId = readFirstDefinedEnv(["CODEX_DESKTOP_BUNDLE_ID", "CODEX_BUNDLE_ID"], DEFAULT_CODEX_BUNDLE_ID, env),
    codexAppPath = readFirstDefinedEnv(["CODEX_DESKTOP_APP_PATH", "CODEX_APP_PATH"], DEFAULT_CODEX_APP_PATH, env),
  }: DesktopHandlerOptions = {}
): Promise<RestartDesktopResult> {
  const provider = normalizeProvider(params.provider);
  if (provider !== "codex") {
    throw desktopError(
      "unsupported_provider",
      `${providerTitle(provider)} desktop restart is not supported in this build.`
    );
  }

  if (platform !== "darwin") {
    throw desktopError(
      "unsupported_platform",
      "Desktop restart is only available when the bridge is running on macOS."
    );
  }

  const sessionId = resolveSessionId(params);
  if (!sessionId) {
    throw desktopError("missing_session_id", "A session id is required to reopen the desktop app.");
  }

  const targetUrl = `codex://threads/${sessionId}`;
  const desktopKnown = hasDesktopRolloutForSession(sessionId, { env, fsModule });
  const appRunning = typeof isAppRunning === "function"
    ? await isAppRunning(codexAppPath)
    : await detectRunningDesktopApp(codexAppPath, executor);

  try {
    if (appRunning) {
      await forceRelaunchDesktopApp({
        bundleId: codexBundleId,
        appPath: codexAppPath,
        executor,
        isAppRunning,
        sleepFn,
        relaunchWaitMs,
        appBootWaitMs,
      });
    } else {
      await openDesktopApp({
        bundleId: codexBundleId,
        appPath: codexAppPath,
        executor,
      });
      await sleepFn(appBootWaitMs);
    }

    await openWhenSessionReady(sessionId, targetUrl, {
      bundleId: codexBundleId,
      appPath: codexAppPath,
      executor,
      env,
      fsModule,
      sleepFn,
      waitMs: sessionMaterializeWaitMs || threadMaterializeWaitMs,
      pollMs: sessionMaterializePollMs || threadMaterializePollMs,
    });
  } catch (error) {
    throw desktopError(
      "restart_failed",
      "Could not restart the Codex desktop app on this Mac.",
      error
    );
  }

  return {
    success: true,
    provider,
    restarted: appRunning,
    targetUrl,
    sessionId,
    desktopKnown,
  };
}

function normalizeProvider(value: unknown): DesktopProvider {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "claude" || normalized === "gemini" || normalized === "codex") {
    return normalized;
  }
  return "codex";
}

function providerTitle(provider: DesktopProvider): string {
  switch (provider) {
    case "claude":
      return "Claude";
    case "gemini":
      return "Gemini";
    default:
      return "Codex";
  }
}

function resolveSessionId(params: DesktopRequestParams): string {
  return (
    readNonEmptyString(params.sessionId)
    || readNonEmptyString(params.session_id)
    || readNonEmptyString(params.threadId)
    || readNonEmptyString(params.thread_id)
    || ""
  );
}

function desktopError(errorCode: string, userMessage: string, cause: unknown = null): DesktopHandlerError {
  const error = new Error(userMessage) as DesktopHandlerError;
  error.errorCode = errorCode;
  error.userMessage = userMessage;
  if (cause) {
    error.cause = cause as Error;
  }
  return error;
}

function hasDesktopRolloutForSession(
  sessionId: string,
  {
    env = process.env,
    fsModule,
  }: {
    env?: NodeJS.ProcessEnv | Record<string, string>;
    fsModule?: RolloutScanFsModule;
  } = {}
): boolean {
  const sessionsRoot = resolveSessionsRootForEnv(env);
  return findRolloutFileForSession(sessionsRoot, sessionId, { fsModule }) != null;
}

function resolveSessionsRootForEnv(env: NodeJS.ProcessEnv | Record<string, string> = process.env): string {
  const coderoverHome = readNonEmptyString(env.CODEROVER_HOME);
  if (coderoverHome) {
    return path.join(coderoverHome, "sessions");
  }
  return resolveSessionsRoot();
}

async function detectRunningDesktopApp(appPath: string, executor: DesktopExecutor): Promise<boolean> {
  const appName = path.basename(appPath, ".app");
  try {
    await executor("pgrep", ["-x", appName], { timeout: HANDOFF_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

async function openDesktopApp({
  bundleId,
  appPath,
  executor,
}: {
  bundleId: string;
  appPath: string;
  executor: DesktopExecutor;
}): Promise<void> {
  try {
    await executor("open", ["-b", bundleId], { timeout: HANDOFF_TIMEOUT_MS });
  } catch {
    await executor("open", ["-a", appPath], { timeout: HANDOFF_TIMEOUT_MS });
  }
}

async function openDesktopTarget(
  targetUrl: string,
  {
    bundleId,
    appPath,
    executor,
  }: {
    bundleId: string;
    appPath: string;
    executor: DesktopExecutor;
  }
): Promise<void> {
  try {
    await executor("open", ["-b", bundleId, targetUrl], { timeout: HANDOFF_TIMEOUT_MS });
  } catch {
    await executor("open", ["-a", appPath, targetUrl], { timeout: HANDOFF_TIMEOUT_MS });
  }
}

async function openWhenSessionReady(
  sessionId: string,
  targetUrl: string,
  {
    bundleId,
    appPath,
    executor,
    env,
    fsModule,
    sleepFn,
    waitMs,
    pollMs,
  }: {
    bundleId: string;
    appPath: string;
    executor: DesktopExecutor;
    env: NodeJS.ProcessEnv | Record<string, string>;
    fsModule?: RolloutScanFsModule;
    sleepFn: (ms: number) => Promise<void>;
    waitMs: number;
    pollMs: number;
  }
): Promise<void> {
  await waitForSessionMaterialization(sessionId, {
    env,
    fsModule,
    sleepFn,
    timeoutMs: waitMs,
    pollMs,
  });
  await openDesktopTarget(targetUrl, { bundleId, appPath, executor });
}

async function forceRelaunchDesktopApp({
  bundleId,
  appPath,
  executor,
  isAppRunning,
  sleepFn,
  relaunchWaitMs,
  appBootWaitMs,
}: {
  bundleId: string;
  appPath: string;
  executor: DesktopExecutor;
  isAppRunning?: ((appPath: string) => Promise<boolean>) | null;
  sleepFn: (ms: number) => Promise<void>;
  relaunchWaitMs: number;
  appBootWaitMs: number;
}): Promise<void> {
  const appName = path.basename(appPath, ".app");
  try {
    await executor("pkill", ["-x", appName], { timeout: HANDOFF_TIMEOUT_MS });
  } catch (error) {
    if ((error as ExecFileException | null)?.code !== 1) {
      throw error;
    }
  }

  await waitForAppExit(appPath, executor, isAppRunning || null);
  await sleepFn(relaunchWaitMs);
  await openDesktopApp({ bundleId, appPath, executor });
  await sleepFn(appBootWaitMs);
}

async function waitForAppExit(
  appPath: string,
  executor: DesktopExecutor,
  isAppRunning: ((appPath: string) => Promise<boolean>) | null
): Promise<void> {
  const deadline = Date.now() + HANDOFF_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const running = typeof isAppRunning === "function"
      ? await isAppRunning(appPath)
      : await detectRunningDesktopApp(appPath, executor);
    if (!running) {
      return;
    }
    await sleep(100);
  }

  throw desktopError("restart_timeout", "Timed out waiting for Codex.app to close.");
}

async function waitForSessionMaterialization(
  sessionId: string,
  {
    env,
    fsModule,
    sleepFn,
    timeoutMs,
    pollMs,
  }: {
    env: NodeJS.ProcessEnv | Record<string, string>;
    fsModule?: RolloutScanFsModule;
    sleepFn: (ms: number) => Promise<void>;
    timeoutMs: number;
    pollMs: number;
  }
): Promise<boolean> {
  if (hasDesktopRolloutForSession(sessionId, { env, fsModule })) {
    return true;
  }

  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    await sleepFn(pollMs);
    if (hasDesktopRolloutForSession(sessionId, { env, fsModule })) {
      return true;
    }
  }

  return false;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readFirstDefinedEnv(
  names: string[],
  fallback: string,
  env: NodeJS.ProcessEnv | Record<string, string> = process.env
): string {
  for (const name of names) {
    const value = readNonEmptyString(env[name]);
    if (value) {
      return value;
    }
  }
  return fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
