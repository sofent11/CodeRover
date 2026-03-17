export {};

// FILE: runtime-manager.ts
// Purpose: Bridge-owned multi-provider runtime router for Codex, Claude Code, and Gemini CLI.
// Layer: Runtime orchestration
// Exports: createRuntimeManager
// Depends on: crypto, ../runtime-store, ../acp/*, ../runtime-engine/*

import { randomUUID } from "crypto";

import type {
  JsonRpcId,
  RuntimeInputItem,
  RuntimeItemShape,
  RuntimeThreadShape,
  RuntimeTurnShape,
} from "../bridge-types";
import {
  createRuntimeStore,
  type RuntimeStore,
  type RuntimeStoreTurn,
  type RuntimeStoreItem,
  type RuntimeSessionMeta,
} from "../runtime-store";
import { buildRpcError, buildRpcSuccess } from "../rpc-client";
import { createAcpAgentRegistry } from "../acp/agent-registry";
import { createAcpSessionManager, type AcpSessionManager } from "../acp/session-manager";
import type { AcpClientServerRequest, AcpClientSessionUpdateNotification } from "../acp/process-client";
import {
  ACP_PROTOCOL_VERSION,
  normalizeRunState,
  projectSessionInfoFromSessionObject,
  projectRuntimeEventToAcpProtocol,
  type ProjectedAcpProtocolMessage,
} from "../runtime-engine/acp-protocol";
import {
  createSessionRuntimeIndex,
  type SessionRuntimeIndex,
} from "../runtime-engine/session-runtime-index";
import type { RuntimeEvent } from "../runtime-engine/types";
import * as routingHelpers from "./client-routing";
import * as managedRuntimeHelpers from "./managed-provider-runtime";
import * as normalizerHelpers from "./normalizers";
import {
  DEFAULT_THREAD_LIST_PAGE_SIZE,
  ERROR_INTERNAL,
  ERROR_INVALID_PARAMS,
  ERROR_METHOD_NOT_FOUND,
  ERROR_THREAD_NOT_FOUND,
  type ManagedProviderTurnContext,
  type RuntimeErrorShape,
} from "./types";
import {
  handleRuntimeExtensionMethod,
  isRuntimeExtensionMethod,
} from "./extension-router";

type UnknownRecord = Record<string, unknown>;
const THREAD_LIST_CURSOR_VERSION = 1;

interface RuntimeManager {
  handleClientMessage(rawMessage: string): Promise<boolean>;
  shutdown(): void;
}

interface PendingClientRequest {
  method: string;
  sessionId: string | null;
  rawResult?: boolean;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface PendingPromptRequest {
  requestId: JsonRpcId;
  sessionId: string;
  userMessageId: string | null;
  resolveCompletion(): void;
}

interface ActiveRunEntry {
  provider: RuntimeSessionMeta["provider"];
  sessionId: string;
  turnId: string;
  stopRequested: boolean;
  interrupt(): void | Promise<void>;
}

type InterruptHandler = (() => void | Promise<void>) | null;

type ManagedHistoryItem = RuntimeStoreItem & {
  cwd?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
  explanation?: string | null;
  changes?: unknown[] | null;
  plan?: unknown;
};

interface ManagedHistoryTurn extends Omit<RuntimeStoreTurn, "items"> {
  items: ManagedHistoryItem[];
}

interface LocalManagedTurnContext extends ManagedProviderTurnContext {
  turnId: string;
  sessionId: string;
  sessionMeta: RuntimeSessionMeta;
  params: UnknownRecord;
  userTextPreview: string;
  complete(options?: { status?: string; usage?: unknown }): void;
  fail(error: unknown, options?: { status?: string }): void;
  interrupt(): void | Promise<void>;
  updateTokenUsage(usage: unknown): void;
}

interface CreateRuntimeManagerOptions {
  sendApplicationMessage: (rawMessage: string) => void;
  logPrefix?: string;
  storeBaseDir?: string;
  store?: RuntimeStore | null;
  sessionRuntimeIndex?: SessionRuntimeIndex | null;
  acpSessionManager?: AcpSessionManager | null;
}

export function createRuntimeManager({
  sendApplicationMessage,
  logPrefix = "[coderover]",
  storeBaseDir,
  store: providedStore = null,
  sessionRuntimeIndex: providedSessionRuntimeIndex = null,
  acpSessionManager: providedAcpSessionManager = null,
}: CreateRuntimeManagerOptions): RuntimeManager {
  if (typeof sendApplicationMessage !== "function") {
    throw new Error("createRuntimeManager requires sendApplicationMessage");
  }

  const store = providedStore || createRuntimeStore(
    storeBaseDir ? { baseDir: storeBaseDir } : {}
  );
  const sessionRuntimeIndex = providedSessionRuntimeIndex || createSessionRuntimeIndex({
    baseDir: store.baseDir,
  });
  const acpAgentRegistry = createAcpAgentRegistry();
  const acpSessionManager = providedAcpSessionManager || createAcpSessionManager({
    registry: acpAgentRegistry,
    store,
    sessionRuntimeIndex,
  });

  function getRuntimeProvider(providerId: unknown): { title: string; supports: Record<string, unknown> } {
    const agent = acpAgentRegistry.get(providerId);
    return {
      title: agent?.name || "Unknown",
      supports: (agent?.supports || {}) as Record<string, unknown>,
    };
  }

  const pendingClientRequests = new Map<string, PendingClientRequest>();
  const pendingPromptRequests = new Map<string, PendingPromptRequest>();
  const pendingPromptUsage = new Map<string, UnknownRecord | null>();
  const pendingPromptErrors = new Map<string, string>();
  const seenAcpToolCallsBySession = new Map<string, Set<string>>();
  const activeRunsBySession = new Map<string, ActiveRunEntry>();
  let lastExternalSyncAt = 0;
  async function handleClientMessage(rawMessage: string): Promise<boolean> {
    let parsed: UnknownRecord | null = null;
    try {
      parsed = JSON.parse(rawMessage);
    } catch {
      return false;
    }

    if (parsed?.method == null && parsed?.id != null) {
      return handleClientResponse(rawMessage, parsed);
    }

    const method = normalizeNonEmptyString(parsed?.method);
    if (!method) {
      return false;
    }

    const params = asObject(parsed?.params);
    const requestId = parsed?.id as JsonRpcId | undefined;

    try {
      if (isRuntimeExtensionMethod(method)) {
        return await handleRuntimeExtensionMethod(method, requestId, params, {
          handleRequestWithResponse,
          handleAgentList: async () => ({
            agents: acpAgentRegistry.list().map((agent) => ({
              id: agent.id,
              name: agent.name,
              description: agent.description,
              _meta: {
                coderover: {
                  agentId: agent.id,
                  supports: getRuntimeProvider(agent.id).supports,
                  defaultModelId: agent.defaultModelId,
                  adapterCommand: agent.command,
                },
              },
            })),
            defaultAgentId: acpAgentRegistry.defaultAgentId,
          }),
          handleModelList: async (extensionParams) => {
            const provider = resolveAcpAgentId(extensionParams);
            const client = await acpSessionManager.getClient(provider);
            return buildAcpModelListResult(await client.listModels(extensionParams));
          },
          handleSessionSetTitle,
          handleSessionArchive,
          unsupportedExtension(extensionMethod) {
            throw createRuntimeError(
              ERROR_METHOD_NOT_FOUND,
              `Unsupported CodeRover runtime extension: ${extensionMethod}`
            );
          },
        });
      }

      switch (method) {
        case "initialize":
          if (requestId != null) {
            sendServerMessage(buildRpcSuccess(requestId, buildAcpInitializeResult(params)));
          }
          return true;

        case "session/list":
          return await handleRequestWithResponse(requestId, async () => {
            return handleAcpSessionList(params);
          });

        case "session/new":
          return await handleRequestWithResponse(requestId, async () => {
            return handleAcpSessionNew(params);
          });

        case "session/load":
          return await handleRequestWithResponse(requestId, async () => {
            return handleAcpSessionLoad(params);
          });

        case "session/resume":
          return await handleRequestWithResponse(requestId, async () => {
            return handleAcpSessionResume(params);
          });

        case "session/prompt":
          if (requestId == null) {
            throw createRuntimeError(ERROR_INVALID_PARAMS, "session/prompt requires a request id");
          }
          await handleAcpSessionPrompt(requestId, params);
          return true;

        case "session/cancel":
          await handleAcpSessionCancel(params);
          return true;

        case "session/set_mode":
          return await handleRequestWithResponse(requestId, async () => {
            return handleAcpSetMode(params);
          });

        case "session/set_config_option":
          return await handleRequestWithResponse(requestId, async () => {
            return handleAcpSetConfigOption(params);
          });

        case "session/set_model":
          return await handleRequestWithResponse(requestId, async () => {
            return handleAcpSetModel(params);
          });

        default:
          if (requestId != null) {
            sendServerMessage(buildRpcError(requestId, ERROR_METHOD_NOT_FOUND, `Unsupported method: ${method}`));
            return true;
          }
          return false;
      }
    } catch (error) {
      if (requestId == null) {
        console.error(`${logPrefix} ${error.message}`);
        return true;
      }

      const code = Number.isInteger(error.code) ? error.code : ERROR_INTERNAL;
      sendServerMessage(buildRpcError(requestId, code, error.message || "Internal runtime error"));
      return true;
    }
  }

  function shutdown(): void {
    acpSessionManager.shutdown();
    sessionRuntimeIndex.shutdown();
    store.shutdown();
  }

  async function handleClientResponse(rawMessage: string, parsed: UnknownRecord): Promise<boolean> {
    const responseKey = encodeRequestId(parsed.id as JsonRpcId | undefined);
    const pending = pendingClientRequests.get(responseKey);
    if (pending) {
      pendingClientRequests.delete(responseKey);
      if (parsed.error) {
        const errorRecord = asObject(parsed.error);
        pending.reject(new Error(normalizeOptionalString(errorRecord.message) || "Client rejected server request"));
      } else {
        pending.resolve(
          pending.rawResult
            ? parsed.result
            : normalizeClientResponseResult(pending.method, parsed.result)
        );
      }

      return true;
    }

    return false;
  }

  async function handleRequestWithResponse(
    requestId: JsonRpcId | undefined,
    handler: () => Promise<unknown>
  ): Promise<boolean> {
    if (requestId == null) {
      await handler();
      return true;
    }
    const result = await handler();
    sendServerMessage(buildRpcSuccess(requestId, result));
    return true;
  }

  async function requireSessionMeta(sessionId: unknown): Promise<RuntimeSessionMeta> {
    const normalizedSessionId = normalizeOptionalString(sessionId);
    if (!normalizedSessionId) {
      throw createRuntimeError(ERROR_INVALID_PARAMS, "sessionId is required");
    }

    const storedMeta = store.getSessionMeta(normalizedSessionId);
    if (storedMeta) {
      return storedMeta;
    }

    throw createRuntimeError(ERROR_THREAD_NOT_FOUND, `Session not found: ${normalizedSessionId}`);
  }

  async function handleSessionSetTitle(params: UnknownRecord): Promise<UnknownRecord> {
    const sessionMeta = await requireSessionMeta(params.sessionId);
    const nextName = normalizeOptionalString(params.title || params.name);
    const updatedMeta = store.updateSessionMeta(sessionMeta.id, (entry) => ({
      ...entry,
      name: nextName,
      updatedAt: new Date().toISOString(),
    }));
    const stableMeta = updatedMeta || sessionMeta;
    emitProjectedAcpMessage({
      kind: "notification",
      method: "session/update",
      params: {
        sessionId: stableMeta.id,
        update: {
          sessionUpdate: "session_info_update",
          title: stableMeta.name,
          updatedAt: stableMeta.updatedAt,
          _meta: {
            coderover: {
              sessionId: stableMeta.id,
              agentId: stableMeta.provider,
            },
          },
        },
      },
    });
    return {
      thread: buildManagedSessionObject(stableMeta),
    };
  }

  async function handleSessionArchive(
    params: UnknownRecord,
    archived: boolean
  ): Promise<UnknownRecord> {
    const sessionMeta = await requireSessionMeta(params.sessionId);
    const updatedMeta = store.updateSessionMeta(sessionMeta.id, (entry) => ({
      ...entry,
      archived,
      updatedAt: new Date().toISOString(),
    }));
    const stableMeta = updatedMeta || sessionMeta;
    emitProjectedAcpMessage({
      kind: "notification",
      method: "session/update",
      params: {
        sessionId: stableMeta.id,
        update: {
          sessionUpdate: "session_info_update",
          updatedAt: stableMeta.updatedAt,
          _meta: {
            coderover: {
              sessionId: stableMeta.id,
              agentId: stableMeta.provider,
              archived,
            },
          },
        },
      },
    });
    return {
      thread: buildManagedSessionObject(stableMeta),
    };
  }

  function createManagedTurnContext(
    sessionMeta: RuntimeSessionMeta,
    params: UnknownRecord
  ): LocalManagedTurnContext {
    const providerDefinition = getRuntimeProvider(sessionMeta.provider);
    const abortController = new AbortController();
    const nowIso = new Date().toISOString();
    const sessionHistory = (store.getSessionHistory(sessionMeta.id) || {
      sessionId: sessionMeta.id,
      turns: [],
    }) as {
      sessionId: string;
      turns: ManagedHistoryTurn[];
    };
    const turnId = randomUUID();
    const turnRecord: ManagedHistoryTurn = {
      id: turnId,
      createdAt: nowIso,
      status: "running",
      items: [],
    };
    sessionHistory.turns.push(turnRecord);

    const inputItems = normalizeInputItems(params.input);
    const userTextPreview = inputItems
      .map((entry) => readTextInput(entry))
      .filter(Boolean)
      .join("\n")
      .trim();
    const clientUserMessageId = normalizeOptionalString(
      asObject(asObject(params._meta).coderover).userMessageId
    );

    if (inputItems.length > 0) {
      turnRecord.items.push({
        id: clientUserMessageId || randomUUID(),
        type: "user_message",
        role: "user",
        content: inputItems.map((item) => ({ ...asObject(item) })),
        text: userTextPreview || null,
        createdAt: nowIso,
      } as ManagedHistoryItem);
    }

    store.updateSessionProjection(sessionMeta.id, sessionHistory);
    store.updateSessionMeta(sessionMeta.id, (entry) => ({
      ...entry,
      preview: userTextPreview || entry.preview,
      updatedAt: nowIso,
      model: normalizeOptionalString(params.model) || entry.model,
      metadata: {
        ...(entry.metadata || {}),
        providerTitle: providerDefinition.title,
      },
      capabilities: providerDefinition.supports,
    }));

    syncSessionRuntimeFromMeta(sessionMeta, {
      engineSessionId: sessionMeta.providerSessionId || sessionMeta.id,
    });
    updateSessionRuntimeOwnerState(sessionMeta.id, "running", {
      activeTurnId: turnId,
    });

    emitRuntimeEvent({
      kind: "turn_started",
      sessionId: sessionMeta.id,
      turnId,
    });

    let interruptHandler: InterruptHandler = null;

    function ensureItem({
      itemId,
      type,
      role = null,
      content = null,
      defaults = {},
    }: {
      itemId?: string;
      type: string;
      role?: string | null;
      content?: RuntimeItemShape[] | null;
      defaults?: Record<string, unknown>;
    }): ManagedHistoryItem {
      const normalizedItemId = normalizeOptionalString(itemId) || randomUUID();
      let item = turnRecord.items.find((entry) => entry.id === normalizedItemId);
      if (!item) {
        item = {
          id: normalizedItemId,
          type,
          role,
          text: null,
          message: null,
          status: null,
          command: null,
          metadata: null,
          plan: null,
          summary: null,
          fileChanges: [],
          content: content ? [...content] : [],
          createdAt: new Date().toISOString(),
          ...defaults,
        } as ManagedHistoryItem;
        turnRecord.items.push(item);
      }
      return item;
    }

    function persistSessionHistory(): void {
      store.updateSessionProjection(sessionMeta.id, sessionHistory);
      store.updateSessionMeta(sessionMeta.id, (entry) => ({
        ...entry,
        updatedAt: new Date().toISOString(),
      }));
    }

    function appendAgentDelta(delta: unknown, { itemId }: { itemId?: string } = {}): void {
      const normalizedDelta = normalizeOptionalString(delta);
      if (!normalizedDelta) {
        return;
      }
      const item = ensureItem({
        type: "agent_message",
        role: "assistant",
        content: [{ type: "text", text: "" }],
        ...(itemId ? { itemId } : {}),
      });
      const firstText = item.content.find((entry) => entry.type === "text") as RuntimeItemShape | undefined;
      if (firstText) {
        firstText.text = `${firstText.text || ""}${normalizedDelta}`;
      } else {
        item.content.push({ type: "text", text: normalizedDelta });
      }
      item.text = item.content
        .filter((entry) => entry.type === "text")
        .map((entry) => entry.text || "")
        .join("");
      persistSessionHistory();
      emitRuntimeEvent({
        kind: "assistant_delta",
        sessionId: sessionMeta.id,
        turnId,
        itemId: item.id,
        delta: normalizedDelta,
      });
    }

    function appendReasoningDelta(delta: unknown, { itemId }: { itemId?: string } = {}): void {
      const normalizedDelta = normalizeOptionalString(delta);
      if (!normalizedDelta) {
        return;
      }
      const item = ensureItem({
        type: "reasoning",
        defaults: { text: "" },
        ...(itemId ? { itemId } : {}),
      });
      item.text = `${item.text || ""}${normalizedDelta}`;
      persistSessionHistory();
      emitRuntimeEvent({
        kind: "reasoning_delta",
        sessionId: sessionMeta.id,
        turnId,
        itemId: item.id,
        delta: normalizedDelta,
      });
    }

    function appendToolCallDelta(
      delta: unknown,
      {
        itemId,
        toolName,
        fileChanges,
        completed = false,
      }: {
        itemId?: string;
        toolName?: string;
        fileChanges?: unknown[];
        completed?: boolean;
      } = {}
    ): void {
      const normalizedDelta = normalizeOptionalString(delta);
      const item = ensureItem({
        type: "tool_call",
        defaults: {
          text: "",
          metadata: {},
          changes: [],
        },
        ...(itemId ? { itemId } : {}),
      });
      if (normalizedDelta) {
        item.text = `${item.text || ""}${normalizedDelta}`;
      }
      if (toolName) {
        item.metadata = {
          ...(item.metadata || {}),
          toolName,
        };
      }
      if (Array.isArray(fileChanges) && fileChanges.length > 0) {
        item.changes = fileChanges;
      }
      persistSessionHistory();
      emitRuntimeEvent({
        kind: "tool_delta",
        sessionId: sessionMeta.id,
        turnId,
        itemId: item.id,
        delta: normalizedDelta || "",
        toolName: normalizeOptionalString(toolName),
        changes: Array.isArray(item.changes) ? item.changes : [],
        completed,
      });
    }

    function updateCommandExecution({
      itemId,
      command,
      cwd,
      status,
      exitCode,
      durationMs,
      outputDelta,
    }: {
      itemId?: string;
      command?: unknown;
      cwd?: unknown;
      status?: unknown;
      exitCode?: unknown;
      durationMs?: unknown;
      outputDelta?: unknown;
    }): void {
      const item = ensureItem({
        type: "command_execution",
        defaults: {
          command: null,
          status: "running",
          cwd: null,
          exitCode: null,
          durationMs: null,
          text: "",
        },
        ...(itemId ? { itemId } : {}),
      });
      item.command = normalizeOptionalString(command) || item.command || null;
      item.cwd = normalizeOptionalString(cwd) || item.cwd || null;
      item.status = normalizeOptionalString(status) || item.status || "running";
      if (typeof exitCode === "number") {
        item.exitCode = exitCode;
      }
      if (typeof durationMs === "number") {
        item.durationMs = durationMs;
      }
      if (outputDelta != null) {
        item.text = buildCommandPreview(item.command, item.status, item.exitCode);
      }
      persistSessionHistory();
      emitRuntimeEvent({
        kind: "command_delta",
        sessionId: sessionMeta.id,
        turnId,
        itemId: item.id,
        command: item.command,
        cwd: item.cwd,
        status: item.status,
        exitCode: item.exitCode,
        durationMs: item.durationMs,
        delta: item.text || "",
      });
    }

    function upsertPlan(
      planState: unknown,
      { itemId, deltaText }: { itemId?: string; deltaText?: string } = {}
    ): void {
      const item = ensureItem({
        type: "plan",
        defaults: {
          explanation: null,
          summary: null,
          plan: [],
          text: "",
        },
        ...(itemId ? { itemId } : {}),
      });
      const normalizedPlan = normalizePlanState(planState);
      item.explanation = normalizedPlan.explanation;
      item.summary = normalizedPlan.explanation;
      item.plan = normalizedPlan.steps.map((step) => ({ ...step }));
      item.text = normalizeOptionalString(deltaText)
        || normalizedPlan.explanation
        || item.text
        || "Planning...";
      persistSessionHistory();
      emitRuntimeEvent({
        kind: "plan_update",
        sessionId: sessionMeta.id,
        turnId,
        itemId: item.id,
        explanation: item.explanation,
        summary: item.summary,
        plan: item.plan,
        delta: normalizeOptionalString(deltaText) || item.text,
      });
    }

    function bindProviderSession(sessionId: unknown): void {
      if (!sessionId) {
        return;
      }
      store.bindProviderSession(sessionMeta.id, sessionMeta.provider, sessionId);
      updateSessionRuntimeOwnerState(sessionMeta.id, "running", {
        activeTurnId: turnId,
        providerSessionId: normalizeOptionalString(sessionId),
        engineSessionId: normalizeOptionalString(sessionId),
      });
    }

    function updateTokenUsage(usage: unknown): void {
      if (!usage || typeof usage !== "object") {
        return;
      }
      emitRuntimeEvent({
        kind: "token_usage",
        sessionId: sessionMeta.id,
        usage: usage as Record<string, unknown>,
      });
    }

    function updatePreview(preview: unknown): void {
      const normalizedPreview = normalizeOptionalString(preview);
      if (!normalizedPreview) {
        return;
      }
      store.updateSessionMeta(sessionMeta.id, (entry) => ({
        ...entry,
        preview: normalizedPreview,
      }));
    }

    function requestApproval(request: UnknownRecord): Promise<unknown> {
      updateSessionRuntimeOwnerState(sessionMeta.id, "waiting_for_client", {
        activeTurnId: turnId,
      });
      return requestFromRuntimeEvent({
        kind: "approval_request",
        sessionId: sessionMeta.id,
        turnId,
        itemId: normalizeOptionalString(request.itemId) || randomUUID(),
        method: normalizeOptionalString(request.method) || "item/tool/requestApproval",
        command: normalizeOptionalString(request.command),
        reason: normalizeOptionalString(request.reason),
        toolName: normalizeOptionalString(request.toolName),
      }).finally(() => {
        updateSessionRuntimeOwnerState(sessionMeta.id, "running", {
          activeTurnId: turnId,
        });
      });
    }

    function requestStructuredInput(request: UnknownRecord): Promise<unknown> {
      updateSessionRuntimeOwnerState(sessionMeta.id, "waiting_for_client", {
        activeTurnId: turnId,
      });
      return requestFromRuntimeEvent({
        kind: "user_input_request",
        sessionId: sessionMeta.id,
        turnId,
        itemId: normalizeOptionalString(request.itemId) || randomUUID(),
        questions: request.questions,
      }).finally(() => {
        updateSessionRuntimeOwnerState(sessionMeta.id, "running", {
          activeTurnId: turnId,
        });
      });
    }

    function setInterruptHandler(handler: unknown): void {
      interruptHandler = typeof handler === "function"
        ? (handler as () => void | Promise<void>)
        : null;
    }

    function complete({ status = "completed", usage = null }: { status?: string; usage?: unknown } = {}): void {
      turnRecord.status = status;
      persistSessionHistory();
      if (usage) {
        updateTokenUsage(usage);
      }
      updateSessionRuntimeOwnerState(sessionMeta.id, "idle", {
        activeTurnId: null,
      });
      emitRuntimeEvent({
        kind: "turn_completed",
        sessionId: sessionMeta.id,
        turnId,
        status,
      });
    }

    function fail(error: unknown, { status = "failed" }: { status?: string } = {}): void {
      const message = normalizeOptionalString(asObject(error).message) || "Runtime error";
      emitRuntimeEvent({
        kind: "runtime_error",
        sessionId: sessionMeta.id,
        turnId,
        message,
      });
      complete({ status });
    }

    return {
      abortController,
      appendAgentDelta,
      appendReasoningDelta,
      appendToolCallDelta,
      bindProviderSession,
      complete,
      fail,
      inputItems,
      params,
      requestApproval,
      requestStructuredInput,
      setInterruptHandler,
      sessionId: sessionMeta.id,
      sessionMeta,
      turnId,
      updateCommandExecution,
      updatePreview,
      updateTokenUsage,
      upsertPlan,
      userTextPreview,
      interrupt() {
        if (interruptHandler) {
          return interruptHandler();
        }
        return abortController.abort(new Error("Interrupted by user"));
      },
    };
  }

  function requestFromClient({
    method,
    params,
    sessionId,
    rawResult = false,
  }: {
    method: string;
    params: UnknownRecord;
    sessionId: string | null;
    rawResult?: boolean;
  }): Promise<unknown> {
    const requestId = randomUUID();
    const requestKey = encodeRequestId(requestId);
    return new Promise((resolve, reject) => {
      pendingClientRequests.set(requestKey, {
        method,
        sessionId,
        rawResult,
        resolve,
        reject,
      });
      sendServerMessage(JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method,
        params,
      }));
    });
  }

  function projectRuntimeEvent(event: RuntimeEvent): ProjectedAcpProtocolMessage {
    return projectRuntimeEventToAcpProtocol(event);
  }

  function emitRuntimeEvent(event: RuntimeEvent): void {
    const projected = projectRuntimeEvent(event);
    const sessionId = readRuntimeEventSessionId(event);
    if (projected.kind !== "notification") {
      throw new Error(`Runtime event ${event.kind} requires a request handler`);
    }
    emitProjectedAcpMessage(projected);
    if (event.kind === "token_usage") {
      pendingPromptUsage.set(sessionId, asObject((projected.params.update as UnknownRecord).usage));
      return;
    }
    if (event.kind === "runtime_error") {
      pendingPromptErrors.set(sessionId, event.message);
      return;
    }
    if (event.kind === "turn_completed") {
      resolvePendingPromptRequest(sessionId, event.status);
    }
  }

  function requestFromRuntimeEvent(event: RuntimeEvent): Promise<unknown> {
    const projected = projectRuntimeEvent(event);
    if (projected.kind !== "request") {
      throw new Error(`Runtime event ${event.kind} does not project to a client request`);
    }
    return requestFromClient({
      method: projected.method,
      params: projected.params,
      sessionId: readRuntimeEventSessionId(event),
    });
  }

  function readRuntimeEventSessionId(event: RuntimeEvent): string | null {
    if ("sessionId" in event) {
      return normalizeOptionalString(event.sessionId);
    }
    return null;
  }

  function upsertSessionRuntimeRecord({
    sessionId,
    provider,
    engineSessionId = null,
    providerSessionId = null,
    cwd = null,
    mode = null,
    model = null,
    ownerState = "idle",
    activeTurnId = null,
  }: {
    sessionId: string;
    provider: string;
    engineSessionId?: string | null;
    providerSessionId?: string | null;
    cwd?: string | null;
    mode?: string | null;
    model?: string | null;
    ownerState?: "idle" | "running" | "waiting_for_client" | "closed";
    activeTurnId?: string | null;
  }): void {
    if (!sessionId) {
      return;
    }
    sessionRuntimeIndex.upsert({
      sessionId,
      provider,
      engineSessionId,
      providerSessionId,
      cwd,
      mode,
      model,
      ownerState,
      activeTurnId,
    });
  }

  function syncSessionRuntimeFromMeta(
    sessionMeta: RuntimeSessionMeta,
    overrides: {
      engineSessionId?: string | null;
      ownerState?: "idle" | "running" | "waiting_for_client" | "closed";
      activeTurnId?: string | null;
      mode?: string | null;
    } = {}
  ): void {
    if (!sessionMeta?.id) {
      return;
    }
    upsertSessionRuntimeRecord({
      sessionId: sessionMeta.id,
      provider: sessionMeta.provider,
      engineSessionId: overrides.engineSessionId ?? sessionMeta.providerSessionId ?? sessionMeta.id,
      providerSessionId: sessionMeta.providerSessionId,
      cwd: sessionMeta.cwd,
      model: sessionMeta.model,
      mode: overrides.mode ?? null,
      ownerState: overrides.ownerState ?? "idle",
      activeTurnId: overrides.activeTurnId ?? null,
    });
  }

  function updateSessionRuntimeOwnerState(
    sessionId: unknown,
    ownerState: "idle" | "running" | "waiting_for_client" | "closed",
    options: {
      activeTurnId?: string | null;
      providerSessionId?: string | null;
      engineSessionId?: string | null;
    } = {}
  ): void {
    const normalizedSessionId = normalizeOptionalString(sessionId);
    if (!normalizedSessionId) {
      return;
    }
    const existing = sessionRuntimeIndex.get(normalizedSessionId);
    if (!existing) {
      return;
    }
    sessionRuntimeIndex.upsert({
      ...existing,
      ownerState,
      activeTurnId: options.activeTurnId !== undefined ? options.activeTurnId : existing.activeTurnId,
      providerSessionId: options.providerSessionId !== undefined ? options.providerSessionId : existing.providerSessionId,
      engineSessionId: options.engineSessionId !== undefined ? options.engineSessionId : existing.engineSessionId,
      updatedAt: new Date().toISOString(),
    });
  }


  function buildManagedSessionObject(
    sessionMeta: RuntimeSessionMeta,
    turns: RuntimeTurnShape[] | RuntimeStoreTurn[] | null = null
  ): RuntimeThreadShape {
    return managedRuntimeHelpers.buildManagedSessionObject(
      sessionMeta,
      turns,
      getRuntimeProvider
    );
  }

  function sessionObjectToMeta(sessionObject: UnknownRecord): RuntimeSessionMeta {
    return managedRuntimeHelpers.sessionObjectToMeta(sessionObject, {
      asObject,
      firstNonEmptyString,
      getRuntimeProvider,
      normalizeOptionalString,
      normalizePositiveInteger,
      normalizeTimestampString,
      resolveProviderId,
    });
  }

  function normalizeModelListResult(result: unknown): { items: unknown[] } {
    const items = extractArray(result, ["items", "data", "models"]);
    return {
      items,
    };
  }




  function buildAcpInitializeResult(params: UnknownRecord): UnknownRecord {
    const requestedVersion = typeof params.protocolVersion === "number"
      ? params.protocolVersion
      : ACP_PROTOCOL_VERSION;
    return {
      protocolVersion: requestedVersion,
      agentInfo: {
        name: "coderover_bridge",
        title: "CodeRover Bridge",
        version: "0.1.0",
      },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: true,
        },
        sessionCapabilities: {
          list: {},
          resume: {},
        },
      },
    };
  }

  function readExplicitAcpAgentId(params: UnknownRecord): string | null {
    const meta = asObject(params._meta);
    const coderoverMeta = asObject(meta?.coderover);
    const explicitAgentId = firstNonEmptyString([
      coderoverMeta.agentId
        || null,
      coderoverMeta.provider,
      params.provider,
      params.agentId,
    ]);
    return explicitAgentId ? resolveProviderId(explicitAgentId) : null;
  }

  function resolveAcpAgentId(params: UnknownRecord): string {
    return readExplicitAcpAgentId(params) || "codex";
  }

  function buildAcpModelListResult(result: unknown): { models: unknown[]; items: unknown[] } {
    const normalized = normalizeModelListResult(result);
    const items = Array.isArray(normalized.items) ? normalized.items : [];
    return {
      models: items.map((entry) => {
        const record = asObject(entry);
        return {
          modelId: normalizeOptionalString(record.model) || normalizeOptionalString(record.id) || "model",
          name: normalizeOptionalString(record.title)
            || normalizeOptionalString(record.displayName)
            || normalizeOptionalString(record.id)
            || "Model",
          ...(normalizeOptionalString(record.description)
            ? { description: normalizeOptionalString(record.description) }
            : {}),
          _meta: {
            coderover: record,
          },
        };
      }),
      items,
    };
  }

  async function handleAcpSessionList(params: UnknownRecord): Promise<UnknownRecord> {
    const archivedFilter = readAcpArchivedFilter(params);
    const requestedLimit = normalizePositiveInteger(params.limit) || DEFAULT_THREAD_LIST_PAGE_SIZE;
    const cursor = decodeThreadListCursor(params.cursor);
    let mergedThreads = store
      .listSessionMetas()
      .map((sessionMeta) => summarizeSessionForList(buildManagedSessionObject(
        sessionMeta,
        store.getSessionHistory(sessionMeta.id)?.turns || []
      )));

    mergedThreads = mergedThreads.filter((thread) => Boolean(thread.archived) === (archivedFilter ?? false));
    if (normalizeOptionalString(params.cwd)) {
      mergedThreads = mergedThreads.filter((thread) =>
        firstNonEmptyString([thread.cwd]) === normalizeOptionalString(params.cwd)
      );
    }

    const page = paginateSessionList(mergedThreads, {
      limit: requestedLimit,
      cursor,
    });

    return {
      sessions: await Promise.all(page.threads.map((thread) => buildAcpSessionInfo(thread))),
      nextCursor: page.nextCursor,
    };
  }

  async function handleAcpSessionNew(params: UnknownRecord): Promise<UnknownRecord> {
    const provider = resolveAcpAgentId(params);
    const sessionMeta = await acpSessionManager.createSession({
      agentId: provider,
      cwd: normalizeOptionalString(params.cwd),
      modelId: readAcpRequestedModel(params),
    });
    syncSessionRuntimeFromMeta(sessionMeta, {
      engineSessionId: sessionMeta.providerSessionId || sessionMeta.id,
      mode: "default",
    });
    emitProjectedAcpMessage(projectSessionInfoFromSessionObject(buildManagedSessionObject(sessionMeta)));
    const sessionState = await buildAcpSessionState(sessionMeta);
    return {
      sessionId: sessionMeta.id,
      ...sessionState,
      _meta: {
        coderover: {
          agentId: provider,
        },
      },
    };
  }

  async function handleAcpSessionLoad(params: UnknownRecord): Promise<UnknownRecord> {
    const sessionId = requireSessionId(params);
    const sessionMeta = await requireSessionMeta(sessionId);
    assertAcpAgentMatches(sessionMeta, params);
    const client = await acpSessionManager.getClient(sessionMeta.provider);
    await client.loadSession({
      sessionId: sessionMeta.providerSessionId || sessionId,
      ...(sessionMeta.cwd ? { cwd: sessionMeta.cwd } : {}),
    });
    const replayMessages = store.getSessionTranscriptMessages(sessionId);
    if (replayMessages.length === 0) {
      emitProjectedAcpMessage(
        projectSessionInfoFromSessionObject(buildManagedSessionObject(store.getSessionMeta(sessionId) || sessionMeta)),
        { recordTranscript: false }
      );
    } else {
      replayMessages.forEach((message) => {
        sendServerMessage(JSON.stringify({
          jsonrpc: "2.0",
          method: message.method,
          params: message.params,
        }));
      });
    }
    return buildAcpSessionState(sessionMeta);
  }

  async function handleAcpSessionResume(params: UnknownRecord): Promise<UnknownRecord> {
    const sessionId = requireSessionId(params);
    const sessionMeta = await requireSessionMeta(sessionId);
    assertAcpAgentMatches(sessionMeta, params);
    const client = await acpSessionManager.getClient(sessionMeta.provider);
    await client.resumeSession({
      sessionId: sessionMeta.providerSessionId || sessionId,
      ...(sessionMeta.cwd ? { cwd: sessionMeta.cwd } : {}),
    });
    return buildAcpSessionState(sessionMeta);
  }

  async function startAcpPromptRun({
    sessionMeta,
    runtimeParams,
    prompt,
  }: {
    sessionMeta: RuntimeSessionMeta;
    runtimeParams: UnknownRecord;
    prompt: unknown[];
  }): Promise<{ turnId: string; completionPromise: Promise<void> }> {
    const sessionId = sessionMeta.id;
    const providerSessionId = sessionMeta.providerSessionId || sessionId;
    const client = await acpSessionManager.getClient(sessionMeta.provider);

    if (activeRunsBySession.has(sessionId)) {
      throw createRuntimeError(ERROR_INVALID_PARAMS, "A turn is already running for this session");
    }

    const turnContext = createManagedTurnContext(sessionMeta, runtimeParams);
    let resolveCompletion: (() => void) | null = null;
    const completionPromise = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });

    const detachUpdateListener = client.onSessionUpdate((notification) => {
      if (!matchesAcpProviderSession(notification, providerSessionId)) {
        return;
      }
      handleInboundAcpSessionUpdate({
        sessionMeta,
        turnContext,
        notification,
      });
    });
    const detachRequestListener = client.onServerRequest((request) => {
      if (!matchesAcpProviderSession(request.params, providerSessionId)) {
        return;
      }
      void handleInboundAcpServerRequest({
        sessionMeta,
        turnContext,
        client,
        request,
      });
    });
    const activeRunEntry: ActiveRunEntry = {
      provider: sessionMeta.provider,
      sessionId,
      turnId: turnContext.turnId,
      stopRequested: false,
      interrupt() {
        return client.cancel(providerSessionId);
      },
    };
    activeRunsBySession.set(sessionId, activeRunEntry);

    void client.prompt({
      sessionId: providerSessionId,
      prompt,
      ...(normalizeOptionalString(runtimeParams.model) ? { modelId: normalizeOptionalString(runtimeParams.model) } : {}),
    }).then((result) => {
      turnContext.complete({
        status: normalizeAcpPromptStopReason(result.stopReason),
        usage: result.usage || null,
      });
    }).catch((error) => {
      turnContext.fail(error, {
        status: activeRunEntry.stopRequested ? "stopped" : "failed",
      });
    }).finally(() => {
      detachUpdateListener();
      detachRequestListener();
      activeRunsBySession.delete(sessionId);
      resolveCompletion?.();
    });

    return {
      turnId: turnContext.turnId,
      completionPromise,
    };
  }

  async function handleAcpSessionPrompt(
    requestId: JsonRpcId,
    params: UnknownRecord
  ): Promise<void> {
    const sessionId = requireSessionId(params);
    const sessionMeta = await requireSessionMeta(sessionId);
    const prompt = Array.isArray(params.prompt) ? params.prompt : [];
    const userMessageId = normalizeOptionalString(params.messageId) || randomUUID();
    const runtimeParams = buildRuntimePromptParams(sessionMeta, params, userMessageId);

    buildPromptUserChunks(sessionId, prompt, userMessageId).forEach((notification) => {
      emitProjectedAcpMessage(notification);
    });

    const completionPromise = new Promise<void>((resolve) => {
      pendingPromptRequests.set(sessionId, {
        requestId,
        sessionId,
        userMessageId,
        resolveCompletion: resolve,
      });
    });
    pendingPromptUsage.delete(sessionId);
    pendingPromptErrors.delete(sessionId);

    try {
      const run = await startAcpPromptRun({
        sessionMeta,
        runtimeParams,
        prompt,
      });
      await run.completionPromise;
    } catch (error) {
      pendingPromptRequests.delete(sessionId);
      const code = Number.isInteger((error as RuntimeErrorShape).code)
        ? Number((error as RuntimeErrorShape).code)
        : ERROR_INTERNAL;
      sendServerMessage(buildRpcError(requestId, code, (error as Error).message || "Prompt failed"));
    }
    await completionPromise;
  }

  async function handleAcpSessionCancel(params: UnknownRecord): Promise<void> {
    const sessionId = requireSessionId(params);
    const sessionMeta = await requireSessionMeta(sessionId);
    const runEntry = activeRunsBySession.get(sessionId);
    if (runEntry) {
      runEntry.stopRequested = true;
    }
    await acpSessionManager.getClient(sessionMeta.provider)
      .then((client) => client.cancel(sessionMeta.providerSessionId || sessionId));
  }

  async function handleAcpSetMode(params: UnknownRecord): Promise<UnknownRecord> {
    const sessionId = requireSessionId(params);
    const modeId = normalizeOptionalString(params.modeId);
    if (!modeId) {
      throw createRuntimeError(ERROR_INVALID_PARAMS, "modeId is required");
    }
    const sessionMeta = await requireSessionMeta(sessionId);
    await acpSessionManager.getClient(sessionMeta.provider)
      .then((client) => client.setMode({
        sessionId: sessionMeta.providerSessionId || sessionId,
        modeId,
      }));
    updateSessionRuntimeOwnerState(sessionId, sessionRuntimeIndex.get(sessionId)?.ownerState || "idle");
    sessionRuntimeIndex.upsert({
      ...(sessionRuntimeIndex.get(sessionId) || {
        sessionId,
        provider: sessionMeta.provider,
      }),
      mode: modeId,
      updatedAt: new Date().toISOString(),
    });
    emitProjectedAcpMessage({
      kind: "notification",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "current_mode_update",
          currentModeId: modeId,
          _meta: {
            coderover: {
              sessionId,
            },
          },
        },
      },
    });
    return {};
  }

  async function handleAcpSetConfigOption(params: UnknownRecord): Promise<UnknownRecord> {
    const sessionId = requireSessionId(params);
    const configId = normalizeOptionalString(params.configId);
    if (!configId) {
      throw createRuntimeError(ERROR_INVALID_PARAMS, "configId is required");
    }
    const sessionMeta = await requireSessionMeta(sessionId);
    const nextValue = normalizeAcpConfigValue(params);
    await acpSessionManager.getClient(sessionMeta.provider)
      .then((client) => client.setConfigOption({
        sessionId: sessionMeta.providerSessionId || sessionId,
        configId,
        value: nextValue,
      }));
    const updatedMeta = store.updateSessionMeta(sessionId, (entry) => ({
      ...entry,
      metadata: {
        ...(entry.metadata || {}),
        acpConfig: {
          ...(asObject((entry.metadata || {}).acpConfig) || {}),
          [configId]: nextValue,
        },
      },
      updatedAt: new Date().toISOString(),
    })) || sessionMeta;
    emitProjectedAcpMessage({
      kind: "notification",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "config_option_update",
          configOptions: buildAcpConfigOptions(updatedMeta),
        },
      },
    });
    return {
      configOptions: buildAcpConfigOptions(updatedMeta),
    };
  }

  async function handleAcpSetModel(params: UnknownRecord): Promise<UnknownRecord> {
    const sessionId = requireSessionId(params);
    const modelId = normalizeOptionalString(params.modelId);
    if (!modelId) {
      throw createRuntimeError(ERROR_INVALID_PARAMS, "modelId is required");
    }
    const sessionMeta = await requireSessionMeta(sessionId);
    await acpSessionManager.getClient(sessionMeta.provider)
      .then((client) => client.setModel({
        sessionId: sessionMeta.providerSessionId || sessionId,
        modelId,
      }));
    store.updateSessionMeta(sessionId, (entry) => ({
      ...entry,
      model: modelId,
      updatedAt: new Date().toISOString(),
    }));
    return {};
  }

  async function buildAcpSessionState(threadMeta: RuntimeSessionMeta): Promise<UnknownRecord> {
    const handle = sessionRuntimeIndex.get(threadMeta.id);
    const modes = buildAcpModeState(threadMeta, handle?.mode || null);
    const configOptions = buildAcpConfigOptions(threadMeta);
    const models = await buildAcpModelState(threadMeta);
    return {
      ...(modes ? { modes } : {}),
      ...(configOptions.length > 0 ? { configOptions } : {}),
      ...(models ? { models } : {}),
      _meta: {
        coderover: {
          agentId: threadMeta.provider,
        },
      },
    };
  }

  async function buildAcpSessionInfo(thread: RuntimeThreadShape): Promise<UnknownRecord> {
    const sessionId = normalizeOptionalString(thread.id) || "";
    const sessionMeta = sessionId ? (store.getSessionMeta(sessionId) || sessionObjectToMeta(asObject(thread))) : null;
    return {
      sessionId,
      cwd: firstNonEmptyString([thread.cwd]) || process.cwd(),
      ...(normalizeOptionalString(thread.name) || normalizeOptionalString(thread.title)
        ? { title: normalizeOptionalString(thread.name) || normalizeOptionalString(thread.title) }
        : {}),
      ...(normalizeTimestampString(thread.updatedAt) ? { updatedAt: normalizeTimestampString(thread.updatedAt) } : {}),
      _meta: {
        coderover: {
          agentId: normalizeOptionalString(thread.provider) || sessionMeta?.provider || "codex",
          archived: Boolean(thread.archived || sessionMeta?.archived),
          preview: normalizeOptionalString(thread.preview),
          providerSessionId: normalizeOptionalString(thread.providerSessionId) || sessionMeta?.providerSessionId || null,
          capabilities: sessionMeta?.capabilities || asObject(thread.capabilities),
        },
      },
    };
  }

  function buildAcpModeState(
    threadMeta: RuntimeSessionMeta,
    currentMode: string | null
  ): UnknownRecord | null {
    const supportsPlan = Boolean(getRuntimeProvider(threadMeta.provider).supports.planMode);
    const availableModes = [
      { id: "default", name: "Default" },
      ...(supportsPlan ? [{ id: "plan", name: "Plan" }] : []),
    ];
    return {
      availableModes,
      currentModeId: currentMode || "default",
    };
  }

  function buildAcpConfigOptions(threadMeta: RuntimeSessionMeta): UnknownRecord[] {
    const acpConfig = asObject((threadMeta.metadata || {}).acpConfig);
    const accessMode = normalizeOptionalString(acpConfig.access_mode) || "on-request";
    const options: UnknownRecord[] = [{
      configId: "access_mode",
      name: "Access mode",
      category: "_coderover_access_mode",
      type: "select",
      value: {
        currentValue: accessMode,
        options: [
          { value: "on-request", name: "On-Request" },
          { value: "full-access", name: "Full access" },
        ],
      },
    }];
    const reasoningEffort = normalizeOptionalString(acpConfig.reasoning_effort);
    if (reasoningEffort) {
      options.push({
        configId: "reasoning_effort",
        name: "Reasoning effort",
        category: "thought_level",
        type: "select",
        value: {
          currentValue: reasoningEffort,
          options: [
            { value: "low", name: "Low" },
            { value: "medium", name: "Medium" },
            { value: "high", name: "High" },
          ],
        },
      });
    }
    return options;
  }

  async function buildAcpModelState(threadMeta: RuntimeSessionMeta): Promise<UnknownRecord | null> {
    const client = await acpSessionManager.getClient(threadMeta.provider);
    const result = await client.listModels({ provider: threadMeta.provider });
    const normalized = buildAcpModelListResult(result);
    const models = Array.isArray(normalized.models) ? normalized.models : [];
    if (models.length === 0) {
      return null;
    }
    return {
      availableModels: models,
      currentModelId: threadMeta.model || normalizeOptionalString(asObject(models[0]).modelId) || "model",
    };
  }

  function buildRuntimePromptParams(
    threadMeta: RuntimeSessionMeta,
    params: UnknownRecord,
    userMessageId: string
  ): UnknownRecord {
    const handle = sessionRuntimeIndex.get(threadMeta.id);
    const meta = asObject(params._meta);
    const coderoverMeta = asObject(meta.coderover);
    const requestedModel = readAcpRequestedModel(params) || handle?.model || threadMeta.model || null;
    const currentMode = handle?.mode || "default";
    const reasoningEffort = readStoredReasoningEffort(threadMeta);
    return {
      sessionId: threadMeta.id,
      input: normalizeAcpPrompt(params.prompt),
      model: requestedModel,
      _meta: {
        coderover: {
          ...coderoverMeta,
          userMessageId,
          sessionId: threadMeta.id,
          sessionMode: currentMode,
          approvalPolicy: readApprovalPolicy(threadMeta),
          ...(requestedModel ? { model: requestedModel } : {}),
          ...(reasoningEffort ? { reasoningEffort } : {}),
        },
      },
    };
  }

  function buildPromptUserChunks(
    sessionId: string,
    prompt: unknown[],
    userMessageId: string
  ): ProjectedAcpProtocolMessage[] {
    return prompt
      .map((entry) => normalizeAcpContentBlock(entry))
      .filter((entry): entry is UnknownRecord => Boolean(entry))
      .map((content) => ({
        kind: "notification",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "user_message_chunk",
            messageId: userMessageId,
            content,
            _meta: {
              coderover: {
                sessionId,
                itemId: userMessageId,
                role: "user",
              },
            },
          },
        },
      }));
  }

  function matchesAcpProviderSession(
    payload: { sessionId?: string | null } | UnknownRecord,
    providerSessionId: string
  ): boolean {
    return normalizeOptionalString(payload.sessionId) === providerSessionId;
  }

  function handleInboundAcpSessionUpdate({
    sessionMeta,
    turnContext,
    notification,
  }: {
    sessionMeta: RuntimeSessionMeta;
    turnContext: LocalManagedTurnContext;
    notification: AcpClientSessionUpdateNotification;
  }): void {
    const update = asObject(notification.update);
    const sessionUpdate = normalizeOptionalString(update.sessionUpdate);
    if (!sessionUpdate) {
      return;
    }

    switch (sessionUpdate) {
      case "agent_message_chunk":
        turnContext.appendAgentDelta(readAcpTextContent(update.content), {
          itemId: normalizeOptionalString(update.messageId),
        });
        return;

      case "agent_thought_chunk":
        turnContext.appendReasoningDelta(readAcpTextContent(update.content), {
          itemId: normalizeOptionalString(update.messageId),
        });
        return;

      case "plan":
        turnContext.upsertPlan({
          explanation: normalizeOptionalString(asObject(asObject(update._meta).coderover).explanation),
          steps: readAcpPlanEntries(update.entries),
        }, {
          itemId: normalizeOptionalString(update.messageId)
            || normalizeOptionalString(asObject(asObject(update._meta).coderover).itemId)
            || "plan",
          deltaText: normalizeOptionalString(asObject(asObject(update._meta).coderover).text) || "Planning...",
        });
        return;

      case "tool_call":
      case "tool_call_update":
        handleInboundAcpToolCallUpdate(turnContext, update);
        return;

      case "usage_update":
        turnContext.updateTokenUsage(asObject(update.usage));
        return;

      case "session_info_update":
        persistAcpSessionInfoUpdate(sessionMeta.id, update);
        return;

      case "current_mode_update":
        if (normalizeOptionalString(update.currentModeId)) {
          sessionRuntimeIndex.upsert({
            ...(sessionRuntimeIndex.get(sessionMeta.id) || {
              sessionId: sessionMeta.id,
              provider: sessionMeta.provider,
            }),
            mode: normalizeOptionalString(update.currentModeId),
            updatedAt: new Date().toISOString(),
          });
        }
        return;

      default:
        return;
    }
  }

  async function handleInboundAcpServerRequest({
    sessionMeta,
    turnContext,
    client,
    request,
  }: {
    sessionMeta: RuntimeSessionMeta;
    turnContext: LocalManagedTurnContext;
    client: Awaited<ReturnType<typeof acpSessionManager.getClient>>;
    request: AcpClientServerRequest;
  }): Promise<void> {
    try {
      if (request.method === "session/request_permission") {
        updateSessionRuntimeOwnerState(sessionMeta.id, "waiting_for_client", {
          activeTurnId: turnContext.turnId,
        });
        const result = await requestFromClient({
          method: request.method,
          params: request.params,
          sessionId: sessionMeta.id,
          rawResult: true,
        });
        await client.respondSuccess(request.id, result);
        return;
      }

      if (request.method === "_coderover/session/request_input") {
        updateSessionRuntimeOwnerState(sessionMeta.id, "waiting_for_client", {
          activeTurnId: turnContext.turnId,
        });
        const result = await requestFromClient({
          method: request.method,
          params: request.params,
          sessionId: sessionMeta.id,
          rawResult: true,
        });
        await client.respondSuccess(request.id, result);
        return;
      }

      await client.respondError(request.id, ERROR_METHOD_NOT_FOUND, `Unsupported ACP server request: ${request.method}`);
    } catch (error) {
      await client.respondError(
        request.id,
        ERROR_INTERNAL,
        normalizeOptionalString(asObject(error).message) || "ACP server request failed"
      );
    } finally {
      updateSessionRuntimeOwnerState(sessionMeta.id, "running", {
        activeTurnId: turnContext.turnId,
      });
    }
  }

  function handleInboundAcpToolCallUpdate(
    turnContext: LocalManagedTurnContext,
    update: UnknownRecord
  ): void {
    const kind = normalizeOptionalString(update.kind);
    const toolCallId = normalizeOptionalString(update.toolCallId) || "tool-call";
    const status = normalizeOptionalString(update.status) || "in_progress";
    const rawInput = asObject(update.rawInput);
    const rawOutput = asObject(update.rawOutput);
    const text = readAcpToolText(update.content);

    if (kind === "execute" || normalizeOptionalString(rawInput.command)) {
      turnContext.updateCommandExecution({
        itemId: toolCallId,
        command: normalizeOptionalString(rawInput.command) || normalizeOptionalString(update.title),
        cwd: normalizeOptionalString(rawInput.cwd),
        status,
        exitCode: typeof rawOutput.exitCode === "number" ? rawOutput.exitCode : undefined,
        durationMs: typeof rawOutput.durationMs === "number" ? rawOutput.durationMs : undefined,
        outputDelta: text,
      });
      return;
    }

    turnContext.appendToolCallDelta(text, {
      itemId: toolCallId,
      toolName: normalizeOptionalString(update.title),
      fileChanges: Array.isArray(rawOutput.changes) ? rawOutput.changes : [],
      completed: status === "completed",
    });
  }

  function persistAcpSessionInfoUpdate(sessionId: string, update: UnknownRecord): void {
    const meta = asObject(asObject(update._meta).coderover);
    const updatedAt = normalizeOptionalString(update.updatedAt) || new Date().toISOString();
    store.updateSessionMeta(sessionId, (entry) => ({
      ...entry,
      title: normalizeOptionalString(update.title) || entry.title,
      name: normalizeOptionalString(update.title) || entry.name,
      preview: normalizeOptionalString(meta.preview) || entry.preview,
      updatedAt,
    }));
  }

  function readAcpPlanEntries(entries: unknown): UnknownRecord[] {
    const normalizedEntries = Array.isArray(entries) ? entries : [];
    return normalizedEntries.map((entry) => {
      const record = asObject(entry);
      return {
        step: normalizeOptionalString(record.content) || normalizeOptionalString(record.step) || "Step",
        status: normalizeOptionalString(record.status) || "pending",
      };
    });
  }

  function readAcpToolText(content: unknown): string {
    if (!Array.isArray(content)) {
      return "";
    }
    return content
      .map((entry) => readAcpTextContent(asObject(entry).content || entry))
      .filter((entry) => Boolean(entry))
      .join("");
  }

  function readAcpTextContent(content: unknown): string {
    const record = asObject(content);
    const directText = normalizeOptionalString(record.text);
    if (directText) {
      return directText;
    }
    if (Array.isArray(content)) {
      return content
        .map((entry) => readAcpTextContent(entry))
        .filter((entry) => Boolean(entry))
        .join("");
    }
    return "";
  }

  function normalizeAcpPromptStopReason(value: unknown): "completed" | "stopped" {
    const normalized = normalizeOptionalString(value);
    return normalized === "cancelled" || normalized === "stopped"
      ? "stopped"
      : "completed";
  }

  function readAcpArchivedFilter(params: UnknownRecord): boolean | null {
    const meta = asObject(params._meta);
    const coderoverMeta = asObject(meta?.coderover);
    if (typeof coderoverMeta.archived === "boolean") {
      return coderoverMeta.archived;
    }
    if (typeof params.archived === "boolean") {
      return params.archived;
    }
    return null;
  }

  function readAcpRequestedModel(params: UnknownRecord): string | null {
    const meta = asObject(params._meta);
    const coderoverMeta = asObject(meta?.coderover);
    return normalizeOptionalString(coderoverMeta.model)
      || normalizeOptionalString(params.modelId)
      || normalizeOptionalString(params.model);
  }

  function readStoredReasoningEffort(threadMeta: RuntimeSessionMeta): string | null {
    return normalizeOptionalString(asObject((threadMeta.metadata || {}).acpConfig).reasoning_effort);
  }

  function readApprovalPolicy(threadMeta: RuntimeSessionMeta): string {
    const accessMode = normalizeOptionalString(asObject((threadMeta.metadata || {}).acpConfig).access_mode);
    return accessMode === "full-access" ? "never" : "on-request";
  }

  function requireSessionId(params: UnknownRecord): string {
    const sessionId = normalizeOptionalString(params.sessionId);
    if (!sessionId) {
      throw createRuntimeError(ERROR_INVALID_PARAMS, "sessionId is required");
    }
    return sessionId;
  }

  function assertAcpAgentMatches(threadMeta: RuntimeSessionMeta, params: UnknownRecord): void {
    const requestedAgentId = readExplicitAcpAgentId(params);
    if (requestedAgentId && requestedAgentId !== threadMeta.provider) {
      throw createRuntimeError(
        ERROR_INVALID_PARAMS,
        `Session ${threadMeta.id} belongs to agent ${threadMeta.provider}, not ${requestedAgentId}`
      );
    }
  }

  function normalizeAcpConfigValue(params: UnknownRecord): string | boolean | null {
    if (params.type === "boolean" && typeof params.value === "boolean") {
      return params.value;
    }
    return normalizeOptionalString(params.value);
  }

  function normalizeAcpPrompt(prompt: unknown): UnknownRecord[] {
    const blocks = Array.isArray(prompt) ? prompt : [];
    return blocks
      .map((entry) => normalizeAcpPromptBlock(entry))
      .filter((entry): entry is UnknownRecord => Boolean(entry));
  }

  function normalizeAcpPromptBlock(block: unknown): UnknownRecord | null {
    const record = asObject(block);
    const type = normalizeOptionalString(record.type);
    if (type === "text") {
      const text = normalizeOptionalString(record.text);
      return text ? { type: "text", text } : null;
    }
    if (type === "image") {
      const data = normalizeOptionalString(record.data);
      const mimeType = normalizeOptionalString(record.mimeType) || "application/octet-stream";
      if (!data) {
        return null;
      }
      return {
        type: "image",
        url: `data:${mimeType};base64,${data}`,
      };
    }
    if (type === "resource_link") {
      const meta = asObject(record._meta);
      const coderoverMeta = asObject(meta.coderover);
      const inputType = normalizeOptionalString(coderoverMeta.inputType);
      if (inputType === "skill" || normalizeOptionalString(coderoverMeta.id)) {
        return {
          type: "skill",
          id: normalizeOptionalString(coderoverMeta.id)
            || normalizeOptionalString(record.name)
            || normalizeOptionalString(record.title)
            || "skill",
          name: normalizeOptionalString(record.name) || normalizeOptionalString(record.title),
          path: normalizeOptionalString(record.uri),
        };
      }
      const resourceTitle = normalizeOptionalString(record.title)
        || normalizeOptionalString(record.name)
        || normalizeOptionalString(record.uri);
      return resourceTitle
        ? { type: "text", text: resourceTitle }
        : null;
    }
    return null;
  }

  function normalizeAcpContentBlock(block: unknown): UnknownRecord | null {
    const record = asObject(block);
    const type = normalizeOptionalString(record.type);
    if (type === "text") {
      const text = normalizeOptionalString(record.text);
      return text ? { type: "text", text } : null;
    }
    if (type === "image") {
      const data = normalizeOptionalString(record.data);
      const mimeType = normalizeOptionalString(record.mimeType) || "application/octet-stream";
      return data
        ? {
          type: "image",
          data,
          mimeType,
          ...(normalizeOptionalString(record.uri) ? { uri: normalizeOptionalString(record.uri) } : {}),
        }
        : null;
    }
    if (type === "resource_link") {
      const uri = normalizeOptionalString(record.uri);
      const name = normalizeOptionalString(record.name) || normalizeOptionalString(record.title) || uri;
      return uri && name
        ? {
          type: "resource_link",
          uri,
          name,
          ...(normalizeOptionalString(record.title) ? { title: normalizeOptionalString(record.title) } : {}),
          ...(record._meta ? { _meta: record._meta } : {}),
        }
        : null;
    }
    return null;
  }

  function emitProjectedAcpMessage(
    projected: ProjectedAcpProtocolMessage,
    { recordTranscript = true }: { recordTranscript?: boolean } = {}
  ): void {
    if (projected.kind !== "notification") {
      return;
    }
    const params = asObject(projected.params);
    const sessionId = normalizeOptionalString(params.sessionId);
    const update = asObject(params.update);
    const toolCallId = normalizeOptionalString(update.toolCallId);
    if (sessionId && toolCallId && normalizeOptionalString(update.sessionUpdate) === "tool_call") {
      const seenToolCalls = seenAcpToolCallsBySession.get(sessionId) || new Set<string>();
      if (seenToolCalls.has(toolCallId)) {
        update.sessionUpdate = "tool_call_update";
      } else {
        seenToolCalls.add(toolCallId);
        seenAcpToolCallsBySession.set(sessionId, seenToolCalls);
      }
    }
    const envelope = {
      jsonrpc: "2.0",
      method: projected.method,
      params: {
        sessionId,
        update,
      },
    };
    if (recordTranscript && sessionId) {
      store.appendSessionTranscriptMessage(sessionId, envelope);
    }
    sendServerMessage(JSON.stringify(envelope));
  }

  function resolvePendingPromptRequest(sessionId: string, status: string | null): void {
    const pending = pendingPromptRequests.get(sessionId);
    if (!pending) {
      return;
    }
    pendingPromptRequests.delete(sessionId);
    const failureMessage = pendingPromptErrors.get(sessionId);
    const usage = pendingPromptUsage.get(sessionId);
    pendingPromptErrors.delete(sessionId);
    pendingPromptUsage.delete(sessionId);
    seenAcpToolCallsBySession.delete(sessionId);
    if (normalizeRunState(status) === "failed") {
      sendServerMessage(buildRpcError(
        pending.requestId,
        ERROR_INTERNAL,
        failureMessage || "Prompt failed"
      ));
      pending.resolveCompletion();
      return;
    }
    sendServerMessage(buildRpcSuccess(pending.requestId, {
      stopReason: normalizeRunState(status) === "stopped" ? "cancelled" : "end_turn",
      ...(usage && Object.keys(usage).length > 0 ? { usage } : {}),
      ...(pending.userMessageId ? { userMessageId: pending.userMessageId } : {}),
    }));
    pending.resolveCompletion();
  }

  function normalizeClientResponseResult(method: string, result: unknown): unknown {
    if (method !== "session/request_permission") {
      return result;
    }
    const response = asObject(result);
    const outcome = asObject(response.outcome);
    if (normalizeOptionalString(outcome.outcome) === "cancelled") {
      return "decline";
    }
    const optionId = normalizeOptionalString(outcome.optionId);
    switch (optionId) {
      case "allow_once":
        return "accept";
      case "allow_always":
        return "acceptForSession";
      case "reject_always":
      case "reject_once":
        return "decline";
      default:
        return result;
    }
  }

  function sendServerMessage(rawMessage: string): void {
    sendApplicationMessage(rawMessage);
  }

  return {
    handleClientMessage,
    shutdown,
  };
}

function summarizeSessionForList(session: RuntimeThreadShape): RuntimeThreadShape {
  const cwd = firstNonEmptyString([session.cwd]);
  return {
    id: normalizeOptionalString(session.id) || undefined,
    provider: normalizeOptionalString(session.provider) || "codex",
    providerSessionId: normalizeOptionalString(session.providerSessionId),
    title: normalizeOptionalString(session.title),
    name: normalizeOptionalString(session.name),
    archived: Boolean(session.archived),
    preview: managedRuntimeHelpers.truncateThreadPreview(session.preview),
    cwd,
    createdAt: normalizeTimestampString(session.createdAt) || null,
    updatedAt: normalizeTimestampString(session.updatedAt) || null,
    capabilities: asObject(session.capabilities),
    metadata: (() => {
      const record = asObject(session.metadata);
      const providerTitle = normalizeOptionalString(record?.providerTitle);
      return providerTitle ? { providerTitle } : null;
    })(),
  };
}

function paginateSessionList(
  sessions: RuntimeThreadShape[],
  {
    limit,
    cursor,
  }: {
    limit: number;
    cursor: { offset: number } | null;
  }
): {
  threads: RuntimeThreadShape[];
  nextCursor: string | null;
  hasMore: boolean;
  pageSize: number;
} {
  const offset = Math.max(0, cursor?.offset || 0);
  const pageThreads = sessions.slice(offset, offset + limit);
  const nextOffset = offset + pageThreads.length;
  const hasMore = nextOffset < sessions.length;

  return {
    threads: pageThreads,
    nextCursor: hasMore ? encodeThreadListCursor(nextOffset) : null,
    hasMore,
    pageSize: pageThreads.length,
  };
}

function encodeThreadListCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ v: THREAD_LIST_CURSOR_VERSION, offset }), "utf8").toString("base64url");
}

function decodeThreadListCursor(value: unknown): { offset: number } | null {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(normalized, "base64url").toString("utf8")) as UnknownRecord;
    const version = Number(parsed.v);
    const offset = Number(parsed.offset);
    if (version !== THREAD_LIST_CURSOR_VERSION || !Number.isInteger(offset) || offset < 0) {
      return null;
    }
    return { offset };
  } catch {
    return null;
  }
}

function extractArray(value: unknown, candidatePaths: string[]): unknown[] {
  return normalizerHelpers.extractArray(value, candidatePaths, readPath);
}

function readPath(root: unknown, path: string): unknown {
  return normalizerHelpers.readPath(root, path);
}
function normalizeTimestampString(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  if (typeof value === "number") {
    return new Date(value > 10_000_000_000 ? value : value * 1000).toISOString();
  }
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  const asNumber = Number(normalized);
  if (Number.isFinite(asNumber)) {
    return normalizeTimestampString(asNumber);
  }
  const parsed = Date.parse(normalized);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return new Date(parsed).toISOString();
}

function normalizePositiveInteger(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return null;
  }
  return numeric;
}


function normalizeInputItems(input: unknown): RuntimeInputItem[] {
  return normalizerHelpers.normalizeInputItems(input);
}

function normalizePlanState(planState: unknown) {
  return normalizerHelpers.normalizePlanState(planState);
}

function buildCommandPreview(command: unknown, status: unknown, exitCode: unknown): string {
  return normalizerHelpers.buildCommandPreview(command, status, exitCode);
}

function resolveProviderId(value: unknown): string {
  return managedRuntimeHelpers.resolveProviderId(value, normalizeOptionalString);
}

function createRuntimeError(code: number, message: string): RuntimeErrorShape {
  return routingHelpers.createRuntimeError(code, message);
}

function encodeRequestId(value: JsonRpcId | undefined): string {
  return routingHelpers.encodeRequestId(value);
}

function normalizeOptionalString(value: unknown): string | null {
  return normalizerHelpers.normalizeOptionalString(value);
}

function normalizeNonEmptyString(value: unknown): string {
  return normalizerHelpers.normalizeNonEmptyString(value);
}

function firstNonEmptyString(values: unknown[]): string | null {
  return normalizerHelpers.firstNonEmptyString(values);
}

function asObject(value: unknown): UnknownRecord {
  return normalizerHelpers.asObject(value);
}

function readTextInput(item: RuntimeInputItem | RuntimeItemShape | UnknownRecord): string | null {
  if (!item || item.type !== "text") {
    return null;
  }
  const text = typeof item.text === "string" ? item.text : "";
  return normalizeOptionalString(text);
}
