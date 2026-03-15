// FILE: rpc-client.ts
// Purpose: Typed JSON-RPC helper around a line-oriented transport such as Codex app-server.

import { randomUUID } from "crypto";

import type {
  JsonRpcEnvelope,
  JsonRpcErrorShape,
  JsonRpcId,
} from "./bridge-types";

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeout: NodeJS.Timeout;
}

interface JsonRpcClientOptions {
  sendRawMessage: (rawMessage: string) => void;
  responseTimeoutMs?: number;
  onUnhandledMessage?: ((rawMessage: string, parsedMessage: JsonRpcEnvelope | null) => void) | null;
}

interface JsonRpcClient {
  close(error?: Error): void;
  handleIncomingRaw(rawMessage: string): void;
  notify(method: string, params?: Record<string, unknown> | unknown): void;
  onRawMessage(listener: (rawMessage: string) => void): () => boolean;
  request<TResult = unknown>(method: string, params?: Record<string, unknown> | unknown): Promise<TResult>;
  sendRaw(rawMessage: string): void;
}

interface JsonRpcRequestError extends Error {
  code?: number;
  data?: unknown;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isJsonRpcEnvelope(value: unknown): value is JsonRpcEnvelope {
  return isObjectRecord(value);
}

export function createJsonRpcClient({
  sendRawMessage,
  responseTimeoutMs = 30_000,
  onUnhandledMessage = null,
}: JsonRpcClientOptions): JsonRpcClient {
  if (typeof sendRawMessage !== "function") {
    throw new Error("createJsonRpcClient requires sendRawMessage");
  }

  const pendingRequests = new Map<string, PendingRequest>();
  const rawListeners = new Set<(rawMessage: string) => void>();

  function request<TResult = unknown>(method: string, params?: Record<string, unknown> | unknown): Promise<TResult> {
    const id = randomUUID();
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    };

    return new Promise<TResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error(`RPC request timed out for method ${method}`));
      }, responseTimeoutMs);
      timeout.unref?.();

      pendingRequests.set(id, {
        method,
        resolve: (value: unknown) => resolve(value as TResult),
        reject,
        timeout,
      });
      sendRawMessage(JSON.stringify(payload));
    });
  }

  function notify(method: string, params?: Record<string, unknown> | unknown): void {
    const payload = {
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    };
    sendRawMessage(JSON.stringify(payload));
  }

  function sendRaw(rawMessage: string): void {
    sendRawMessage(rawMessage);
  }

  function handleIncomingRaw(rawMessage: string): void {
    for (const listener of rawListeners) {
      listener(rawMessage);
    }

    let parsed: unknown = null;
    try {
      parsed = JSON.parse(rawMessage);
    } catch {
      onUnhandledMessage?.(rawMessage, null);
      return;
    }

    if (!isJsonRpcEnvelope(parsed)) {
      onUnhandledMessage?.(rawMessage, null);
      return;
    }

    if ("id" in parsed && parsed.id != null && ("result" in parsed || "error" in parsed)) {
      const pending = pendingRequests.get(String(parsed.id));
      if (!pending) {
        onUnhandledMessage?.(rawMessage, parsed);
        return;
      }

      pendingRequests.delete(String(parsed.id));
      clearTimeout(pending.timeout);

      if ("error" in parsed && parsed.error) {
        const rpcError = parsed.error as JsonRpcErrorShape;
        const error = new Error(rpcError.message || `RPC ${pending.method} failed`) as JsonRpcRequestError;
        error.code = rpcError.code;
        error.data = rpcError.data;
        pending.reject(error);
        return;
      }

      pending.resolve(("result" in parsed ? parsed.result : undefined) as unknown);
      return;
    }

    onUnhandledMessage?.(rawMessage, parsed);
  }

  function close(error: Error = new Error("RPC transport closed")): void {
    for (const pending of pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    pendingRequests.clear();
  }

  function onRawMessage(listener: (rawMessage: string) => void): () => boolean {
    rawListeners.add(listener);
    return () => rawListeners.delete(listener);
  }

  return {
    close,
    handleIncomingRaw,
    notify,
    onRawMessage,
    request,
    sendRaw,
  };
}

export function buildRpcSuccess<TResult>(id: JsonRpcId | undefined, result: TResult): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: result === undefined ? {} : result,
  });
}

export function buildRpcError(
  id: JsonRpcId | undefined,
  code: number,
  message: string,
  data?: unknown
): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: id === undefined ? null : id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  });
}
