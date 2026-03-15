// FILE: providers/codex-adapter.ts
// Purpose: Thin adapter over the existing Codex app-server JSON-RPC transport.

import { createJsonRpcClient } from "../rpc-client";

interface CodexTransport {
  send(message: string): void;
}

type SendToClient = (rawMessage: string, parsedMessage: unknown) => void;

interface CreateCodexAdapterOptions {
  sendToClient?: SendToClient;
  logPrefix?: string;
}

interface CodexAdapter {
  attachTransport(transport: CodexTransport | null | undefined): void;
  collaborationModes(params?: Record<string, unknown>): Promise<unknown>;
  compactThread(params?: Record<string, unknown>): Promise<unknown>;
  fuzzyFileSearch(params?: Record<string, unknown>): Promise<unknown>;
  handleIncomingRaw(rawMessage: string): void;
  handleTransportClosed(reason?: string): void;
  interruptTurn(params?: Record<string, unknown>): Promise<unknown>;
  isAvailable(): boolean;
  listModels(params?: Record<string, unknown>): Promise<unknown>;
  listSkills(params?: Record<string, unknown>): Promise<unknown>;
  listThreads(params?: Record<string, unknown>): Promise<unknown>;
  notify(method: string, params?: Record<string, unknown> | unknown): void;
  readThread(params?: Record<string, unknown>): Promise<unknown>;
  request(method: string, params?: Record<string, unknown> | unknown): Promise<unknown>;
  resumeThread(params?: Record<string, unknown>): Promise<unknown>;
  sendRaw(rawMessage: string): void;
  startThread(params?: Record<string, unknown>): Promise<unknown>;
  startTurn(params?: Record<string, unknown>): Promise<unknown>;
  steerTurn(params?: Record<string, unknown>): Promise<unknown>;
}

export function createCodexAdapter({
  sendToClient,
  logPrefix = "[coderover]",
}: CreateCodexAdapterOptions = {}): CodexAdapter {
  let rpcClient: ReturnType<typeof createJsonRpcClient> | null = null;

  function attachTransport(transport: CodexTransport | null | undefined): void {
    if (!transport) {
      rpcClient?.close(new Error("Codex transport detached"));
      rpcClient = null;
      return;
    }

    rpcClient?.close(new Error("Codex transport replaced"));
    rpcClient = createJsonRpcClient({
      sendRawMessage(message) {
        transport.send(message);
      },
      onUnhandledMessage(rawMessage, parsedMessage) {
        sendToClient?.(rawMessage, parsedMessage);
      },
    });
  }

  function handleIncomingRaw(rawMessage: string): void {
    rpcClient?.handleIncomingRaw(rawMessage);
  }

  function handleTransportClosed(reason = "Codex transport closed"): void {
    rpcClient?.close(new Error(reason));
  }

  async function request(method: string, params?: Record<string, unknown> | unknown): Promise<unknown> {
    if (!rpcClient) {
      throw new Error(`${logPrefix} Codex transport is not available`);
    }
    return rpcClient.request(method, params);
  }

  function notify(method: string, params?: Record<string, unknown> | unknown): void {
    if (!rpcClient) {
      throw new Error(`${logPrefix} Codex transport is not available`);
    }
    rpcClient.notify(method, params);
  }

  function sendRaw(rawMessage: string): void {
    if (!rpcClient) {
      throw new Error(`${logPrefix} Codex transport is not available`);
    }
    rpcClient.sendRaw(rawMessage);
  }

  return {
    attachTransport,
    collaborationModes(params) {
      return request("collaborationMode/list", params);
    },
    compactThread(params) {
      return request("thread/compact/start", params);
    },
    fuzzyFileSearch(params) {
      return request("fuzzyFileSearch", params);
    },
    handleIncomingRaw,
    handleTransportClosed,
    interruptTurn(params) {
      return request("turn/interrupt", params);
    },
    isAvailable() {
      return Boolean(rpcClient);
    },
    listModels(params) {
      return request("model/list", params);
    },
    listSkills(params) {
      return request("skills/list", params);
    },
    listThreads(params) {
      return request("thread/list", params);
    },
    notify,
    readThread(params) {
      return request("thread/read", params);
    },
    request,
    resumeThread(params) {
      return request("thread/resume", params);
    },
    sendRaw,
    startThread(params) {
      return request("thread/start", params);
    },
    startTurn(params) {
      return request("turn/start", params);
    },
    steerTurn(params) {
      return request("turn/steer", params);
    },
  };
}
