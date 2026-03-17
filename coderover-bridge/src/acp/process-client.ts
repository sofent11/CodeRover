// FILE: acp/process-client.ts
// Purpose: Minimal stdio JSON-RPC ACP adapter client for bridge-managed agent processes.

import { spawn, type ChildProcessWithoutNullStreams } from "child_process";

import { buildRpcError, buildRpcSuccess, createJsonRpcClient } from "../rpc-client";

export interface AcpClientInitializeResult {
  protocolVersion?: string;
  agentInfo?: Record<string, unknown>;
  agentCapabilities?: Record<string, unknown>;
}

export interface AcpClientNewSessionResult {
  sessionId: string;
  _meta?: Record<string, unknown>;
}

export interface AcpClientLoadSessionResult {
  _meta?: Record<string, unknown>;
}

export interface AcpClientPromptResult {
  stopReason?: string | null;
  usage?: unknown;
}

export interface AcpClientSessionUpdateNotification {
  sessionId: string | null;
  update: Record<string, unknown>;
}

export interface AcpClientServerRequest {
  id: string | number | null;
  method: string;
  params: Record<string, unknown>;
}

export interface AcpProcessClient {
  cancel(sessionId: string): Promise<void>;
  close(): void;
  initialize(params: Record<string, unknown>): Promise<AcpClientInitializeResult>;
  isRunning(): boolean;
  listModels(params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  loadSession(params: Record<string, unknown>): Promise<AcpClientLoadSessionResult>;
  newSession(params: Record<string, unknown>): Promise<AcpClientNewSessionResult>;
  onServerRequest(listener: (request: AcpClientServerRequest) => void): () => boolean;
  onSessionUpdate(listener: (notification: AcpClientSessionUpdateNotification) => void): () => boolean;
  prompt(params: Record<string, unknown>): Promise<AcpClientPromptResult>;
  respondError(id: string | number | null, code: number, message: string): Promise<void>;
  respondSuccess(id: string | number | null, result: unknown): Promise<void>;
  resumeSession(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  setConfigOption(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  setMode(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  setModel(params: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export function createAcpProcessClient(commandLine: string): AcpProcessClient {
  const command = splitCommandLine(commandLine);
  const child = spawn(command.command, command.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  const rpcClient = createJsonRpcClient({
    sendRawMessage(rawMessage) {
      child.stdin.write(`${rawMessage}\n`);
    },
    onUnhandledMessage(rawMessage, parsedMessage) {
      handleUnhandled(rawMessage, parsedMessage as unknown as Record<string, unknown> | null);
    },
  });

  const sessionListeners = new Set<(notification: AcpClientSessionUpdateNotification) => void>();
  const requestListeners = new Set<(request: AcpClientServerRequest) => void>();
  let stdoutBuffer = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const rawLine = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (rawLine) {
        rpcClient.handleIncomingRaw(rawLine);
      }
      newlineIndex = stdoutBuffer.indexOf("\n");
    }
  });

  child.on("close", () => {
    rpcClient.close(new Error(`ACP agent exited: ${commandLine}`));
  });

  function handleUnhandled(_rawMessage: string, parsedMessage: Record<string, unknown> | null): void {
    if (!parsedMessage || typeof parsedMessage !== "object") {
      return;
    }

    const method = normalizeOptionalString(parsedMessage.method);
    if (!method) {
      return;
    }

    const params = asObject(parsedMessage.params);
    if (method === "session/update") {
      const notification: AcpClientSessionUpdateNotification = {
        sessionId: normalizeOptionalString(params.sessionId),
        update: asObject(params.update),
      };
      sessionListeners.forEach((listener) => listener(notification));
      return;
    }

    const id = normalizeJsonRpcId(parsedMessage.id);
    if (id == null) {
      return;
    }
    requestListeners.forEach((listener) => {
      listener({
        id,
        method,
        params,
      });
    });
  }

  function onSessionUpdate(listener: (notification: AcpClientSessionUpdateNotification) => void): () => boolean {
    sessionListeners.add(listener);
    return () => sessionListeners.delete(listener);
  }

  function onServerRequest(listener: (request: AcpClientServerRequest) => void): () => boolean {
    requestListeners.add(listener);
    return () => requestListeners.delete(listener);
  }

  async function initialize(params: Record<string, unknown>): Promise<AcpClientInitializeResult> {
    return await rpcClient.request("initialize", params);
  }

  async function newSession(params: Record<string, unknown>): Promise<AcpClientNewSessionResult> {
    return await rpcClient.request("session/new", params);
  }

  async function listModels(params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return await rpcClient.request("model/list", params);
  }

  async function loadSession(params: Record<string, unknown>): Promise<AcpClientLoadSessionResult> {
    return await rpcClient.request("session/load", params);
  }

  async function resumeSession(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return await rpcClient.request("session/resume", params);
  }

  async function prompt(params: Record<string, unknown>): Promise<AcpClientPromptResult> {
    return await rpcClient.request("session/prompt", params);
  }

  async function cancel(sessionId: string): Promise<void> {
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId },
    })}\n`);
  }

  async function setMode(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return await rpcClient.request("session/set_mode", params);
  }

  async function setConfigOption(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return await rpcClient.request("session/set_config_option", params);
  }

  async function setModel(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return await rpcClient.request("session/set_model", params);
  }

  async function respondSuccess(id: string | number | null, result: unknown): Promise<void> {
    child.stdin.write(`${buildRpcSuccess(id == null ? undefined : id, result)}\n`);
  }

  async function respondError(id: string | number | null, code: number, message: string): Promise<void> {
    child.stdin.write(`${buildRpcError(id == null ? undefined : id, code, message)}\n`);
  }

  function close(): void {
    try {
      child.stdin.end();
    } catch {}
    child.kill("SIGTERM");
  }

  return {
    cancel,
    close,
    initialize,
    isRunning() {
      return child.exitCode == null && child.signalCode == null;
    },
    listModels,
    loadSession,
    newSession,
    onServerRequest,
    onSessionUpdate,
    prompt,
    respondError,
    respondSuccess,
    resumeSession,
    setConfigOption,
    setMode,
    setModel,
  };
}

export function sendAcpClientResponse(
  child: ChildProcessWithoutNullStreams,
  id: string | number | null,
  result: unknown
): void {
  child.stdin.write(`${buildRpcSuccess(id == null ? undefined : id, result)}\n`);
}

export function sendAcpClientError(
  child: ChildProcessWithoutNullStreams,
  id: string | number | null,
  code: number,
  message: string
): void {
  child.stdin.write(`${buildRpcError(id == null ? undefined : id, code, message)}\n`);
}

function splitCommandLine(value: string): { command: string; args: string[] } {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const character of value) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current.length > 0) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }

  if (quote) {
    throw new Error(`Invalid ACP command: ${value}`);
  }
  if (current.length > 0) {
    parts.push(current);
  }
  if (parts.length === 0) {
    throw new Error("ACP command must not be empty");
  }
  return {
    command: parts[0] || "",
    args: parts.slice(1),
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeJsonRpcId(value: unknown): string | number | null {
  if (typeof value === "string" || typeof value === "number") {
    return value;
  }
  return null;
}
