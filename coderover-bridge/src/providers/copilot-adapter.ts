// FILE: providers/copilot-adapter.ts
// Purpose: GitHub Copilot provider adapter backed by the Copilot CLI ACP server plus local session-state imports.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "child_process";
import { createHash, randomUUID } from "crypto";
import { Readable, Writable } from "stream";
import { pathToFileURL } from "url";

import type { RuntimeInputItem } from "../bridge-types";
import { getRuntimeProvider } from "../provider-catalog";
import type {
  RuntimeStore,
  RuntimeStoreItem,
  RuntimeStoreTurn,
  RuntimeThreadMeta,
} from "../runtime-store";
import type {
  ManagedProviderAdapter,
  ManagedProviderAdapterFactoryOptions,
  ManagedProviderStartTurnOptions,
} from "../runtime-manager/types";
import {
  asProviderRecord,
  normalizeOptionalString,
  type ProviderRecord as UnknownRecord,
} from "./shared/provider-utils";
type CopilotSdkModule = typeof import("@agentclientprotocol/sdk");
type CopilotClientSideConnection = import("@agentclientprotocol/sdk").ClientSideConnection;
type CopilotPermissionRequest = import("@agentclientprotocol/sdk").RequestPermissionRequest;
type CopilotPermissionResponse = import("@agentclientprotocol/sdk").RequestPermissionResponse;
type CopilotSessionNotification = import("@agentclientprotocol/sdk").SessionNotification;
type CopilotSessionUpdate = import("@agentclientprotocol/sdk").SessionUpdate;
type CopilotCreateElicitationRequest = import("@agentclientprotocol/sdk").CreateElicitationRequest;
type CopilotCreateElicitationResponse = import("@agentclientprotocol/sdk").CreateElicitationResponse;
type CopilotNewSessionResponse = import("@agentclientprotocol/sdk").NewSessionResponse;
type CopilotLoadSessionResponse = import("@agentclientprotocol/sdk").LoadSessionResponse;

interface CopilotWorkspaceMeta {
  sessionId: string;
  cwd: string | null;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CopilotEventRecord {
  id?: unknown;
  type?: unknown;
  timestamp?: unknown;
  data?: UnknownRecord | null;
}

interface CopilotActiveRun {
  turnContext: ManagedProviderStartTurnOptions["turnContext"];
  abortSignal: AbortSignal;
}

interface CopilotLaunchPlan {
  command: string;
  args: string[];
  description: string;
}

interface CopilotAcpConnection {
  child: ChildProcessWithoutNullStreams;
  closeRequested: boolean;
  connection: CopilotClientSideConnection;
  stderrBuffer: string;
  initialized: boolean;
}

interface CopilotAdapterOptions extends ManagedProviderAdapterFactoryOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

interface StructuredQuestionOption {
  label: string;
  description: string;
}

interface StructuredQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: StructuredQuestionOption[];
}

interface StructuredInputRequestPayload {
  itemId: string;
  questions: StructuredQuestion[];
  schemaByQuestionId: Record<string, UnknownRecord>;
}

interface ImportedTurnState {
  turn: RuntimeStoreTurn;
  itemsById: Map<string, RuntimeStoreItem>;
}

interface CopilotHistoryState {
  fingerprint: string;
}

const COPILOT_SESSION_ROOT = path.join(os.homedir(), ".copilot", "session-state");

export function createCopilotAdapter({
  store,
  logPrefix = "[coderover]",
  sdkLoader,
  env = process.env,
  homeDir = os.homedir(),
}: CopilotAdapterOptions): ManagedProviderAdapter {
  void logPrefix;
  let sdkModulePromise: Promise<CopilotSdkModule> | null = null;
  let acpConnectionPromise: Promise<CopilotAcpConnection> | null = null;
  const activeRunsBySession = new Map<string, CopilotActiveRun>();

  async function syncImportedThreads(): Promise<void> {
    const providerDefinition = getRuntimeProvider("copilot");
    for (const workspaceMeta of discoverCopilotWorkspaces(homeDir)) {
      const existingThreadId = store.findThreadIdByProviderSession("copilot", workspaceMeta.sessionId);
      const nextMeta = {
        id: existingThreadId || `copilot:${workspaceMeta.sessionId}`,
        provider: "copilot" as const,
        providerSessionId: workspaceMeta.sessionId,
        title: workspaceMeta.summary,
        name: null,
        preview: workspaceMeta.summary,
        cwd: workspaceMeta.cwd,
        metadata: {
          providerTitle: providerDefinition.title,
          copilotSessionUpdatedAt: workspaceMeta.updatedAt,
        },
        capabilities: providerDefinition.supports,
        createdAt: workspaceMeta.createdAt,
        updatedAt: workspaceMeta.updatedAt,
        archived: false,
      };

      if (existingThreadId) {
        store.upsertThreadMeta(nextMeta);
      } else {
        store.createThread(nextMeta);
      }
    }
  }

  async function hydrateThread(threadMeta: RuntimeThreadMeta): Promise<void> {
    if (!threadMeta.providerSessionId) {
      return;
    }

    const currentThreadMeta = store.getThreadMeta(threadMeta.id) || threadMeta;
    const existingHistory = store.getThreadHistory(threadMeta.id);
    const historyState = readCopilotHistoryState(currentThreadMeta.providerSessionId, homeDir);
    if (!shouldRefreshCopilotHistory(currentThreadMeta, existingHistory, historyState)) {
      return;
    }

    const workspaceMeta = readCopilotWorkspaceMeta(currentThreadMeta.providerSessionId, homeDir);
    const events = loadCopilotEvents(currentThreadMeta.providerSessionId, homeDir);
    const history = buildCopilotHistory({
      threadId: threadMeta.id,
      events,
      fallbackPreview: currentThreadMeta.preview,
    });

    store.saveThreadHistory(threadMeta.id, history);
    store.updateThreadMeta(threadMeta.id, (entry) => ({
      ...entry,
      title: workspaceMeta?.summary || entry.title,
      preview: history.turns.flatMap((turn) => turn.items).find((item) => item.role === "user")?.text
        || workspaceMeta?.summary
        || entry.preview,
      cwd: workspaceMeta?.cwd || entry.cwd,
      updatedAt: workspaceMeta?.updatedAt || entry.updatedAt,
      metadata: {
        ...(entry.metadata || {}),
        copilotHistorySyncedAt: new Date().toISOString(),
        copilotHistoryFingerprint: historyState?.fingerprint || null,
        copilotSessionUpdatedAt: workspaceMeta?.updatedAt || normalizeOptionalString(entry.metadata?.copilotSessionUpdatedAt),
      },
    }));
  }

  async function startTurn({
    params,
    threadMeta,
    turnContext,
  }: ManagedProviderStartTurnOptions): Promise<{ usage?: Record<string, unknown> | null }> {
    const acp = await ensureAcpConnection();
    const promptBlocks = await buildCopilotPromptBlocks(turnContext.inputItems);
    const session = await ensureCopilotSession(acp.connection, threadMeta, params);
    turnContext.bindProviderSession(session.sessionId);

    activeRunsBySession.set(session.sessionId, {
      turnContext,
      abortSignal: turnContext.abortController.signal,
    });

    turnContext.setInterruptHandler(() => acp.connection.cancel({ sessionId: session.sessionId }));

    try {
      const result = await acp.connection.prompt({
        sessionId: session.sessionId,
        prompt: promptBlocks,
        messageId: randomUUID(),
      });
      return {
        usage: normalizeUsage(result?.usage),
      };
    } finally {
      activeRunsBySession.delete(session.sessionId);
    }
  }

  return {
    hydrateThread,
    startTurn,
    syncImportedThreads,
  };

  async function ensureAcpConnection(): Promise<CopilotAcpConnection> {
    if (!acpConnectionPromise) {
      acpConnectionPromise = createAcpConnection();
    }
    return acpConnectionPromise;
  }

  async function createAcpConnection(): Promise<CopilotAcpConnection> {
    const sdk = await loadSdkModule();
    const launchPlan = createCopilotLaunchPlan(env);
    const child = spawn(launchPlan.command, launchPlan.args, {
      env: { ...env },
      stdio: ["pipe", "pipe", "pipe"],
      ...(process.platform === "win32" ? { windowsHide: true } : {}),
    });

    const stream = sdk.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
    );

    const connectionState: CopilotAcpConnection = {
      child,
      closeRequested: false,
      connection: null as unknown as CopilotClientSideConnection,
      stderrBuffer: "",
      initialized: false,
    };

    child.stderr.on("data", (chunk: Buffer | string) => {
      connectionState.stderrBuffer = appendOutputBuffer(
        connectionState.stderrBuffer,
        typeof chunk === "string" ? chunk : chunk.toString("utf8")
      );
    });

    child.on("close", () => {
      if (!connectionState.closeRequested) {
        acpConnectionPromise = null;
      }
    });

    child.on("error", () => {
      acpConnectionPromise = null;
    });

    connectionState.connection = new sdk.ClientSideConnection(() => ({
      requestPermission: (request) => handlePermissionRequest(request),
      sessionUpdate: (notification) => handleSessionUpdate(notification),
      unstable_createElicitation: (request) => handleCreateElicitation(request),
    }), stream);

    await connectionState.connection.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        elicitation: {
          form: {},
        },
      },
      clientInfo: {
        name: "CodeRover",
        title: "CodeRover",
        version: "1.0.0",
      },
    });

    connectionState.initialized = true;
    return connectionState;
  }

  async function handlePermissionRequest(
    request: CopilotPermissionRequest
  ): Promise<CopilotPermissionResponse> {
    const activeRun = activeRunsBySession.get(request.sessionId);
    if (!activeRun || activeRun.abortSignal.aborted) {
      return { outcome: { outcome: "cancelled" } };
    }

    const response = await activeRun.turnContext.requestApproval({
      itemId: request.toolCall.toolCallId,
      method: approvalMethodForToolCall(request.toolCall),
      command: extractToolCallCommand(request.toolCall),
      reason: normalizeOptionalString(request.toolCall.title),
      toolName: normalizeOptionalString(request.toolCall.title),
    });

    return {
      outcome: mapApprovalResponseToOutcome(request, response),
    };
  }

  async function handleSessionUpdate(notification: CopilotSessionNotification): Promise<void> {
    const activeRun = activeRunsBySession.get(notification.sessionId);
    if (!activeRun || activeRun.abortSignal.aborted) {
      return;
    }

    const { turnContext } = activeRun;
    const update = notification.update;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        turnContext.appendAgentDelta(extractTextContent(update.content), {
          itemId: normalizeOptionalString(update.messageId) || undefined,
        });
        return;

      case "agent_thought_chunk":
        turnContext.appendReasoningDelta(extractTextContent(update.content), {
          itemId: normalizeOptionalString(update.messageId) || undefined,
        });
        return;

      case "plan":
        turnContext.upsertPlan({
          explanation: null,
          steps: update.entries.map((entry) => ({
            step: normalizeOptionalString(entry.content) || "Untitled step",
            status: normalizePlanStatus(entry.status),
          })),
        }, {
          itemId: `${notification.sessionId}:plan`,
        });
        return;

      case "tool_call":
      case "tool_call_update":
        applyToolCallUpdate(turnContext, update);
        return;

      case "session_info_update":
        if (normalizeOptionalString(update.title)) {
          turnContext.updatePreview(update.title);
        }
        return;

      case "usage_update":
        return;

      default:
        return;
    }
  }

  async function handleCreateElicitation(
    request: CopilotCreateElicitationRequest
  ): Promise<CopilotCreateElicitationResponse> {
    if (!("sessionId" in request) || request.mode !== "form") {
      return { action: "cancel" };
    }

    const activeRun = activeRunsBySession.get(request.sessionId);
    if (!activeRun || activeRun.abortSignal.aborted) {
      return { action: "cancel" };
    }

    const structuredRequest = buildStructuredInputRequest(request);
    if (!structuredRequest.questions.length) {
      return { action: "cancel" };
    }

    const response = await activeRun.turnContext.requestStructuredInput({
      itemId: structuredRequest.itemId,
      questions: structuredRequest.questions,
    });

    const content = convertStructuredResponseToElicitationContent(
      structuredRequest.schemaByQuestionId,
      response
    );
    if (!content) {
      return { action: "cancel" };
    }

    return {
      action: "accept",
      content: content as Record<string, import("@agentclientprotocol/sdk").ElicitationContentValue>,
    };
  }

  async function loadSdkModule(): Promise<CopilotSdkModule> {
    if (!sdkModulePromise) {
      sdkModulePromise = Promise.resolve()
        .then(() => sdkLoader?.())
        .then((provided) => provided as CopilotSdkModule | undefined)
        .then((provided) => provided || import("@agentclientprotocol/sdk"));
    }
    return sdkModulePromise;
  }
}

async function ensureCopilotSession(
  connection: CopilotClientSideConnection,
  threadMeta: RuntimeThreadMeta,
  params: Record<string, unknown>
): Promise<{ sessionId: string }> {
  const cwd = normalizeOptionalString(threadMeta.cwd)
    || normalizeOptionalString(params.cwd)
    || process.cwd();
  const response = threadMeta.providerSessionId
    ? await connection.loadSession({
      sessionId: threadMeta.providerSessionId,
      cwd,
      mcpServers: [],
    }).catch(async () => connection.newSession({
      cwd,
      mcpServers: [],
    }))
    : await connection.newSession({
      cwd,
      mcpServers: [],
    });

  const sessionId = "sessionId" in response && normalizeOptionalString(response.sessionId)
    ? String(response.sessionId)
    : threadMeta.providerSessionId
      || randomUUID();

  await applyCopilotSessionSettings(connection, sessionId, response, params);
  return { sessionId };
}

async function applyCopilotSessionSettings(
  connection: CopilotClientSideConnection,
  sessionId: string,
  response: CopilotNewSessionResponse | CopilotLoadSessionResponse,
  params: Record<string, unknown>
): Promise<void> {
  const desiredModeId = resolveDesiredModeId(response, params);
  if (desiredModeId) {
    await connection.setSessionMode({
      sessionId,
      modeId: desiredModeId,
    }).catch(() => {});
  }

  const desiredModel = normalizeOptionalString(params.model);
  if (desiredModel) {
    await connection.setSessionConfigOption({
      sessionId,
      configId: "model",
      value: desiredModel,
    }).catch(() => {});
  }

  const desiredReasoning = normalizeOptionalString(params.effort);
  if (desiredReasoning) {
    await connection.setSessionConfigOption({
      sessionId,
      configId: "reasoning_effort",
      value: desiredReasoning,
    }).catch(() => {});
  }
}

function resolveDesiredModeId(
  response: CopilotNewSessionResponse | CopilotLoadSessionResponse,
  params: Record<string, unknown>
): string | null {
  const collaborationMode = asRecord(params.collaborationMode);
  const requestedMode = normalizeOptionalString(collaborationMode?.mode) === "plan"
    ? "plan"
    : "agent";
  const availableModes = Array.isArray(response.modes?.availableModes)
    ? response.modes.availableModes
    : [];
  const matched = availableModes.find((entry) => {
    const id = normalizeOptionalString(entry.id)?.toLowerCase();
    const name = normalizeOptionalString(entry.name)?.toLowerCase();
    return id?.endsWith(`#${requestedMode}`) || name === requestedMode;
  });
  return normalizeOptionalString(matched?.id) || null;
}

async function buildCopilotPromptBlocks(
  inputItems: RuntimeInputItem[]
): Promise<Array<import("@agentclientprotocol/sdk").ContentBlock>> {
  const prompt: Array<import("@agentclientprotocol/sdk").ContentBlock> = [];

  for (const item of inputItems) {
    if (item.type === "text") {
      const text = normalizeOptionalString(item.text);
      if (text) {
        prompt.push({
          type: "text",
          text,
        });
      }
      continue;
    }

    if (item.type === "image" || item.type === "local_image") {
      const imageBlock = await buildCopilotImageBlock(item);
      if (imageBlock) {
        prompt.push(imageBlock);
      }
      continue;
    }

    if (item.type === "skill") {
      const pathValue = normalizeOptionalString((item as UnknownRecord).path);
      const skillName = normalizeOptionalString((item as UnknownRecord).name)
        || normalizeOptionalString((item as UnknownRecord).id)
        || "Skill";
      if (pathValue) {
        prompt.push({
          type: "resource_link",
          name: skillName,
          uri: pathToFileURL(pathValue).toString(),
        });
      } else if (skillName) {
        prompt.push({
          type: "text",
          text: `$${skillName}`,
        });
      }
    }
  }

  return prompt;
}

async function buildCopilotImageBlock(
  item: RuntimeInputItem
): Promise<import("@agentclientprotocol/sdk").ContentBlock | null> {
  const record = item as UnknownRecord;
  const dataUrl = normalizeOptionalString(record.image_url || record.url);
  if (dataUrl) {
    const parsed = parseDataUrl(dataUrl);
    if (!parsed) {
      return null;
    }
    return {
      type: "image",
      data: parsed.data,
      mimeType: parsed.mimeType,
    };
  }

  const imagePath = normalizeOptionalString(record.path);
  if (!imagePath || !fs.existsSync(imagePath)) {
    return null;
  }

  const mimeType = mimeTypeForPath(imagePath);
  return {
    type: "image",
    data: fs.readFileSync(imagePath).toString("base64"),
    mimeType,
    uri: pathToFileURL(imagePath).toString(),
  };
}

function applyToolCallUpdate(
  turnContext: ManagedProviderStartTurnOptions["turnContext"],
  update: CopilotSessionUpdate
): void {
  const toolCallId = normalizeOptionalString("toolCallId" in update ? update.toolCallId : null);
  const itemId = toolCallId || undefined;
  const title = normalizeOptionalString("title" in update ? update.title : null);
  const status = normalizeOptionalString("status" in update ? update.status : null);
  const contentText = extractToolCallContentText("content" in update ? update.content : null);
  const changes = extractToolLocations("locations" in update ? update.locations : null);
  const rawInput = asRecord("rawInput" in update ? update.rawInput : null);

  if (normalizeOptionalString("kind" in update ? update.kind : null) === "execute") {
    turnContext.updateCommandExecution({
      itemId,
      command: normalizeOptionalString(rawInput?.command)
        || firstString(rawInput?.commands)
        || title,
      cwd: normalizeOptionalString(rawInput?.cwd),
      status: status || "running",
      outputDelta: contentText || title || "",
    });
    return;
  }

  turnContext.appendToolCallDelta(contentText || title || "", {
    itemId,
    toolName: title || normalizeOptionalString("kind" in update ? update.kind : null) || undefined,
    fileChanges: changes,
    completed: status === "completed",
  });
}

function approvalMethodForToolCall(request: CopilotPermissionRequest["toolCall"]): string {
  const kind = normalizeOptionalString(request.kind);
  if (kind === "execute") {
    return "item/commandExecution/requestApproval";
  }
  if (kind === "edit" || kind === "delete" || kind === "move") {
    return "item/fileChange/requestApproval";
  }
  return "item/tool/requestApproval";
}

function extractToolCallCommand(toolCall: CopilotPermissionRequest["toolCall"]): string | null {
  const rawInput = asRecord(toolCall.rawInput);
  return normalizeOptionalString(rawInput?.command)
    || firstString(rawInput?.commands)
    || normalizeOptionalString(toolCall.title);
}

function mapApprovalResponseToOutcome(
  request: CopilotPermissionRequest,
  response: unknown
): CopilotPermissionResponse["outcome"] {
  const normalized = normalizeOptionalString(response)?.toLowerCase();
  const options = Array.isArray(request.options) ? request.options : [];
  const findOption = (optionId: string): string | null => {
    const matched = options.find((option) => normalizeOptionalString(option.optionId) === optionId);
    return normalizeOptionalString(matched?.optionId);
  };

  if (normalized === "acceptforsession" || normalized === "accept_for_session") {
    const optionId = findOption("allow_always") || findOption("allow_once");
    if (optionId) {
      return { outcome: "selected", optionId };
    }
  }

  if (normalized === "accept") {
    const optionId = findOption("allow_once") || findOption("allow_always");
    if (optionId) {
      return { outcome: "selected", optionId };
    }
  }

  if (normalized === "decline" || normalized === "reject") {
    const optionId = findOption("reject_once");
    if (optionId) {
      return { outcome: "selected", optionId };
    }
  }

  return { outcome: "cancelled" };
}

function buildStructuredInputRequest(
  request: Extract<CopilotCreateElicitationRequest, { mode: "form" }>
): StructuredInputRequestPayload {
  const schema = request.requestedSchema || {};
  const properties = asRecord(schema.properties);
  const questionIds = Object.keys(properties);

  return {
    itemId: randomUUID(),
    questions: questionIds.map((questionId) => {
      const property = asRecord(properties[questionId]);
      const enumValues = Array.isArray(property.enum)
        ? property.enum.map((entry) => normalizeOptionalString(entry)).filter(Boolean) as string[]
        : [];
      const title = normalizeOptionalString(property.title)
        || normalizeOptionalString(schema.title)
        || questionId;
      const description = normalizeOptionalString(property.description)
        || normalizeOptionalString(request.message)
        || title;

      return {
        id: questionId,
        header: title,
        question: description,
        isOther: enumValues.length === 0,
        isSecret: false,
        options: enumValues.map((entry) => ({
          label: entry,
          description: "",
        })),
      };
    }),
    schemaByQuestionId: questionIds.reduce<Record<string, UnknownRecord>>((result, questionId) => {
      result[questionId] = asRecord(properties[questionId]);
      return result;
    }, {}),
  };
}

function convertStructuredResponseToElicitationContent(
  schemaByQuestionId: Record<string, UnknownRecord>,
  response: unknown
): Record<string, unknown> | null {
  const answerRoot = asRecord(response);
  const answers = asRecord(answerRoot.answers);
  const contentEntries = Object.entries(schemaByQuestionId)
    .map(([questionId, schema]) => {
      const answerEntry = asRecord(answers[questionId]);
      const answerValue = firstString(answerEntry.answers);
      if (!answerValue) {
        return null;
      }

      const normalizedType = normalizeOptionalString(schema.type);
      if (normalizedType === "boolean") {
        return [questionId, answerValue.toLowerCase() === "true"] as const;
      }
      if (normalizedType === "integer") {
        const parsed = Number.parseInt(answerValue, 10);
        return [questionId, Number.isNaN(parsed) ? answerValue : parsed] as const;
      }
      if (normalizedType === "number") {
        const parsed = Number.parseFloat(answerValue);
        return [questionId, Number.isNaN(parsed) ? answerValue : parsed] as const;
      }
      if (normalizedType === "array") {
        return [questionId, [answerValue]] as const;
      }
      return [questionId, answerValue] as const;
    })
    .filter(Boolean) as Array<readonly [string, unknown]>;

  if (!contentEntries.length) {
    return null;
  }

  return Object.fromEntries(contentEntries);
}

function shouldRefreshCopilotHistory(
  threadMeta: RuntimeThreadMeta,
  existingHistory: { turns?: unknown[] } | null,
  historyState: CopilotHistoryState | null
): boolean {
  if (!threadMeta.providerSessionId || !existingHistory?.turns?.length) {
    return true;
  }

  if (!historyState) {
    return false;
  }

  const storedFingerprint = normalizeMetadataTimestamp(threadMeta.metadata, "copilotHistoryFingerprint");
  if (!storedFingerprint) {
    return true;
  }
  return storedFingerprint !== historyState.fingerprint;
}

function readCopilotHistoryState(
  sessionId: string,
  homeDir = os.homedir()
): CopilotHistoryState | null {
  const workspaceMeta = readCopilotWorkspaceMeta(sessionId, homeDir);
  const workspacePath = path.join(homeDir, ".copilot", "session-state", sessionId, "workspace.yaml");
  const workspaceStats = safeStat(workspacePath);
  const eventsStats = safeStat(copilotEventsPath(sessionId, homeDir));

  if (!workspaceMeta && !workspaceStats && !eventsStats) {
    return null;
  }

  return {
    fingerprint: JSON.stringify({
      workspaceUpdatedAt: workspaceMeta?.updatedAt || null,
      workspaceMtimeMs: workspaceStats?.mtimeMs || null,
      eventsMtimeMs: eventsStats?.mtimeMs || null,
      eventsSize: eventsStats?.size || null,
    }),
  };
}

function normalizeMetadataTimestamp(
  metadata: Record<string, unknown> | null | undefined,
  key: string
): string | null {
  if (!metadata || typeof metadata[key] !== "string") {
    return null;
  }
  const normalized = String(metadata[key]).trim();
  return normalized || null;
}

export function discoverCopilotWorkspaces(homeDir = os.homedir()): CopilotWorkspaceMeta[] {
  const sessionRoot = path.join(homeDir, ".copilot", "session-state");
  if (!fs.existsSync(sessionRoot)) {
    return [];
  }

  return safeReaddir(sessionRoot)
    .map((sessionId) => readCopilotWorkspaceMeta(sessionId, homeDir))
    .filter((entry): entry is CopilotWorkspaceMeta => Boolean(entry))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function readCopilotWorkspaceMeta(
  sessionId: string,
  homeDir = os.homedir()
): CopilotWorkspaceMeta | null {
  const workspacePath = path.join(homeDir, ".copilot", "session-state", sessionId, "workspace.yaml");
  if (!fs.existsSync(workspacePath)) {
    return null;
  }

  const raw = safeReadText(workspacePath);
  if (!raw) {
    return null;
  }

  const parsed = parseSimpleYaml(raw);
  const normalizedSessionId = normalizeOptionalString(parsed.id) || sessionId;
  const updatedAt = normalizeOptionalString(parsed.updated_at)
    || safeStat(workspacePath)?.mtime?.toISOString?.()
    || new Date().toISOString();
  const createdAt = normalizeOptionalString(parsed.created_at) || updatedAt;

  return {
    sessionId: normalizedSessionId,
    cwd: normalizeOptionalString(parsed.cwd),
    summary: normalizeOptionalString(parsed.summary),
    createdAt,
    updatedAt,
  };
}

export function loadCopilotEvents(
  sessionId: string,
  homeDir = os.homedir()
): CopilotEventRecord[] {
  const eventsPath = copilotEventsPath(sessionId, homeDir);
  if (!fs.existsSync(eventsPath)) {
    return [];
  }

  const lines = safeReadText(eventsPath)
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    || [];

  return lines.map((line) => {
    try {
      return JSON.parse(line) as CopilotEventRecord;
    } catch {
      return {};
    }
  });
}

export function buildCopilotHistory({
  threadId,
  events,
  fallbackPreview = null,
}: {
  threadId: string;
  events: CopilotEventRecord[];
  fallbackPreview?: string | null;
}): { threadId: string; turns: RuntimeStoreTurn[] } {
  const turns: ImportedTurnState[] = [];
  const turnsByKey = new Map<string, ImportedTurnState>();
  const toolTurnKeyById = new Map<string, string>();
  let lastTurnKey: string | null = null;
  let virtualTimeMs = Date.now() - ((events.length + 1) * 4_000);

  function nextTimestamp(seed?: unknown): string {
    const parsed = normalizeTimestampString(seed);
    if (parsed) {
      const ms = Date.parse(parsed);
      if (!Number.isNaN(ms) && ms > virtualTimeMs) {
        virtualTimeMs = ms;
      } else {
        virtualTimeMs += 1;
      }
      return new Date(virtualTimeMs++).toISOString();
    }
    return new Date(virtualTimeMs++).toISOString();
  }

  function ensureTurn(key: string, createdAtSeed?: unknown): ImportedTurnState {
    let existing = turnsByKey.get(key);
    if (existing) {
      return existing;
    }
    existing = {
      turn: {
        id: key,
        createdAt: nextTimestamp(createdAtSeed),
        status: "completed",
        items: [],
      },
      itemsById: new Map(),
    };
    turnsByKey.set(key, existing);
    turns.push(existing);
    lastTurnKey = key;
    return existing;
  }

  function ensureItem(
    turnState: ImportedTurnState,
    itemId: string,
    builder: () => RuntimeStoreItem
  ): RuntimeStoreItem {
    const existing = turnState.itemsById.get(itemId);
    if (existing) {
      return existing;
    }
    const created = builder();
    turnState.itemsById.set(itemId, created);
    turnState.turn.items.push(created);
    return created;
  }

  function appendAssistantMessage(
    turnState: ImportedTurnState,
    itemId: string,
    text: string,
    createdAtSeed?: unknown
  ): void {
    const normalizedText = normalizeOptionalString(text);
    if (!normalizedText) {
      return;
    }

    const previousAssistantItem = [...turnState.turn.items].reverse().find((item) => item.type === "agent_message");
    if (normalizeOptionalString(previousAssistantItem?.text) === normalizedText) {
      return;
    }

    turnState.turn.items.push({
      id: itemId,
      type: "agent_message",
      role: "assistant",
      content: [{ type: "text", text: normalizedText }],
      text: normalizedText,
      message: null,
      createdAt: nextTimestamp(createdAtSeed),
      status: null,
      command: null,
      metadata: null,
      plan: null,
      summary: null,
      fileChanges: [],
    });
  }

  for (const [index, event] of events.entries()) {
    const type = normalizeOptionalString(event.type);
    const data = asRecord(event.data);
    const interactionId = normalizeOptionalString(data.interactionId)
      || normalizeOptionalString(data.turnId)
      || normalizeOptionalString(data.requestId);
    const eventKey = interactionId || `copilot-turn-${index}`;

    if (type === "user.message") {
      const turnState = ensureTurn(eventKey, event.timestamp);
      const text = normalizeOptionalString(data.transformedContent)
        || normalizeOptionalString(data.content)
        || fallbackPreview
        || "";
      turnState.turn.items.push({
        id: normalizeOptionalString(event.id) || `user-${createHash("md5").update(`${eventKey}-${text}`).digest("hex")}`,
        type: "user_message",
        role: "user",
        content: [{ type: "text", text }],
        text,
        message: null,
        createdAt: nextTimestamp(event.timestamp),
        status: null,
        command: null,
        metadata: null,
        plan: null,
        summary: null,
        fileChanges: [],
      });
      lastTurnKey = eventKey;
      continue;
    }

    if (type === "assistant.turn_start") {
      ensureTurn(eventKey, event.timestamp);
      continue;
    }

    if (type === "assistant.message") {
      const turnState = ensureTurn(eventKey, event.timestamp);
      const text = extractCopilotAssistantMessageText(data);
      appendAssistantMessage(
        turnState,
        normalizeOptionalString(data.messageId)
          || normalizeOptionalString(event.id)
          || `assistant-${createHash("md5").update(`${eventKey}-${text || "empty"}`).digest("hex")}`,
        text,
        event.timestamp
      );
      lastTurnKey = eventKey;
      continue;
    }

    if (type === "session.task_complete") {
      const turnKey = lastTurnKey || eventKey;
      const turnState = ensureTurn(turnKey, event.timestamp);
      const summary = formatCopilotTaskCompleteText(normalizeOptionalString(data.summary));
      appendAssistantMessage(
        turnState,
        normalizeOptionalString(event.id)
          || `task-complete-${createHash("md5").update(`${turnKey}-${summary || "empty"}`).digest("hex")}`,
        summary,
        event.timestamp
      );
      continue;
    }

    if (type === "assistant.turn_end") {
      const turnState = turnsByKey.get(eventKey);
      if (turnState) {
        turnState.turn.status = "completed";
      }
      continue;
    }

    if (type === "tool.execution_start" || type === "tool.execution_complete") {
      const toolCallId = normalizeOptionalString(data.toolCallId) || `tool-${index}`;
      const turnKey = interactionId
        || toolTurnKeyById.get(toolCallId)
        || lastTurnKey
        || eventKey;
      const turnState = ensureTurn(turnKey, event.timestamp);
      toolTurnKeyById.set(toolCallId, turnKey);
      const toolName = normalizeOptionalString(data.toolName) || "Tool";
      if (toolName === "task_complete") {
        continue;
      }
      const itemType = data.arguments && asRecord(data.arguments).command ? "command_execution" : "tool_call";
      const item = ensureItem(turnState, toolCallId, () => ({
        id: toolCallId,
        type: itemType,
        role: "assistant",
        content: [],
        text: "",
        message: null,
        createdAt: nextTimestamp(event.timestamp),
        status: "running",
        command: normalizeOptionalString(asRecord(data.arguments).command),
        metadata: { toolName },
        plan: null,
        summary: null,
        fileChanges: [],
      }));

      if (type === "tool.execution_start") {
        item.status = "running";
        item.text = normalizeOptionalString(data.toolName) || item.text || "Running tool";
        continue;
      }

      item.status = data.success === false ? "failed" : "completed";
      item.text = summarizeCopilotToolResult(data, item);
      continue;
    }
  }

  return {
    threadId,
    turns: turns.map((entry) => entry.turn),
  };
}

function summarizeCopilotToolResult(data: UnknownRecord, item: RuntimeStoreItem): string {
  const result = data.result;
  const normalizedString = normalizeOptionalString(result);
  if (normalizedString) {
    return normalizedString;
  }

  const resultRecord = asRecord(result);
  const contentString = normalizeOptionalString(resultRecord.content)
    || normalizeOptionalString(resultRecord.detailedContent);
  if (contentString) {
    return contentString;
  }

  if (item.type === "command_execution") {
    return `${item.status === "failed" ? "Failed" : "Completed"} ${item.command || "command"}`;
  }

  const toolName = normalizeOptionalString(asRecord(item.metadata).toolName) || "tool";
  return `${item.status === "failed" ? "Failed" : "Completed"} ${toolName}`;
}

function createCopilotLaunchPlan(env: NodeJS.ProcessEnv): CopilotLaunchPlan {
  const configuredPath = normalizeOptionalString(env.COPILOT_PATH);
  if (configuredPath) {
    return {
      command: configuredPath,
      args: ["--acp"],
      description: `\`${configuredPath} --acp\``,
    };
  }

  if (commandExists("copilot")) {
    return {
      command: "copilot",
      args: ["--acp"],
      description: "`copilot --acp`",
    };
  }

  return {
    command: "gh",
    args: ["copilot", "--", "--acp"],
    description: "`gh copilot -- --acp`",
  };
}

function commandExists(command: string): boolean {
  const check = process.platform === "win32"
    ? spawnSync("where", [command], { stdio: "ignore" })
    : spawnSync("which", [command], { stdio: "ignore" });
  return check.status === 0;
}

function copilotEventsPath(sessionId: string, homeDir: string): string {
  return path.join(homeDir, ".copilot", "session-state", sessionId, "events.jsonl");
}

function parseSimpleYaml(source: string): UnknownRecord {
  return source.split(/\r?\n/).reduce<UnknownRecord>((result, line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return result;
    }
    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex <= 0) {
      return result;
    }
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    result[key] = value.replace(/^['"]|['"]$/g, "");
    return result;
  }, {});
}

function parseDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(dataUrl);
  if (!match) {
    return null;
  }
  return {
    mimeType: match[1] || "image/png",
    data: match[2] || "",
  };
}

function mimeTypeForPath(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "image/png";
  }
}

function normalizeUsage(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  if ("usage" in asRecord(value)) {
    return asRecord(asRecord(value).usage);
  }

  return asRecord(value);
}

function extractTextContent(content: unknown): string {
  const record = asRecord(content);
  return normalizeOptionalString(record.text)
    || normalizeOptionalString(asRecord(record.content).text)
    || "";
}

function extractCopilotAssistantMessageText(data: UnknownRecord): string {
  return normalizeOptionalString(data.content)
    || formatCopilotTaskCompleteText(extractCopilotTaskCompleteSummary(data))
    || "";
}

function extractCopilotTaskCompleteSummary(data: UnknownRecord): string | null {
  const toolRequests = Array.isArray(data.toolRequests) ? data.toolRequests : [];
  for (const request of toolRequests) {
    const requestRecord = asRecord(request);
    if (normalizeOptionalString(requestRecord.name) !== "task_complete") {
      continue;
    }
    const argumentsRecord = asRecord(requestRecord.arguments);
    return normalizeOptionalString(argumentsRecord.summary)
      || normalizeOptionalString(requestRecord.intentionSummary)
      || null;
  }
  return null;
}

function formatCopilotTaskCompleteText(summary: string | null): string | null {
  const normalizedSummary = normalizeOptionalString(summary);
  if (!normalizedSummary) {
    return null;
  }
  return `Task complete\n\n${normalizedSummary}`;
}

function extractToolCallContentText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  return content.map((entry) => {
    const record = asRecord(entry);
    if (normalizeOptionalString(record.type) === "content") {
      return extractTextContent(record.content);
    }
    if (normalizeOptionalString(record.type) === "diff") {
      return normalizeOptionalString(record.path) || "Updated file";
    }
    return "";
  }).filter(Boolean).join("\n");
}

function extractToolLocations(locations: unknown): unknown[] {
  if (!Array.isArray(locations)) {
    return [];
  }
  return locations
    .map((entry) => asRecord(entry))
    .filter((entry) => normalizeOptionalString(entry.path))
    .map((entry) => ({
      path: normalizeOptionalString(entry.path),
      line: typeof entry.line === "number" ? entry.line : null,
    }));
}

function normalizePlanStatus(value: unknown): "pending" | "in_progress" | "completed" {
  const normalized = normalizeOptionalString(value);
  if (normalized === "completed") {
    return "completed";
  }
  if (normalized === "in_progress") {
    return "in_progress";
  }
  return "pending";
}

function appendOutputBuffer(buffer: string, chunk: string): string {
  const next = `${buffer}${chunk}`;
  return next.slice(-4_096);
}

function safeReadText(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function safeReaddir(directory: string): string[] {
  try {
    return fs.readdirSync(directory);
  } catch {
    return [];
  }
}

function safeStat(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function normalizeTimestampString(value: unknown): string | null {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return null;
  }
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function asRecord(value: unknown): UnknownRecord {
  return asProviderRecord<UnknownRecord>(value) || {};
}

function firstString(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }
  for (const entry of value) {
    const normalized = normalizeOptionalString(entry);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}
