export {};

// FILE: providers/claude-adapter.ts
// Purpose: Claude Code provider adapter backed by @anthropic-ai/claude-agent-sdk.
// Layer: Runtime provider
// Exports: createClaudeAdapter
// Depends on: fs, os, path, crypto, ../provider-catalog

import { createHash, randomUUID } from "crypto";

import { getRuntimeProvider } from "../provider-catalog";
import type {
  RuntimeStoreItem,
  RuntimeStoreTurn,
  RuntimeThreadMeta,
} from "../runtime-store";
import type { RuntimeInputItem } from "../bridge-types";
import type {
  ManagedProviderAdapter,
  ManagedProviderAdapterFactoryOptions,
  ManagedProviderStartTurnOptions,
  ManagedProviderTurnContext,
} from "../runtime-manager/types";
import {
  normalizeMetadataTimestamp,
  shouldRefreshHistoryByTimestamp,
} from "./shared/history-refresh";
import {
  buildPathPromptFromInputItems,
  cleanupMaterializedImageInputs,
} from "./shared/prompt-input";
import {
  asProviderRecord,
  normalizeOptionalString,
  toIsoDateString,
  type ProviderRecord as UnknownRecord,
} from "./shared/provider-utils";
type ClaudePermissionMode = "plan" | "bypassPermissions" | "default";

interface ClaudeSdkSession {
  sessionId?: string;
  customTitle?: unknown;
  summary?: unknown;
  firstPrompt?: unknown;
  cwd?: unknown;
  lastModified?: unknown;
}

interface ClaudeSdkHistoryMessage {
  uuid?: string;
  type?: unknown;
  message?: unknown;
}

interface ClaudeSdkToolContext {
  toolUseID: string;
}

interface ClaudeSdkQueryMessage {
  type?: unknown;
  uuid?: string;
  session_id?: string;
  event?: unknown;
  message?: unknown;
  usage?: unknown;
  tool_use_id?: string;
}

interface ClaudeSdkQuery extends AsyncIterable<ClaudeSdkQueryMessage> {
  interrupt(): Promise<void>;
}

interface ClaudeSdkModule {
  listSessions(): Promise<ClaudeSdkSession[]>;
  getSessionMessages(
    sessionId: string,
    options?: {
      dir?: string;
    }
  ): Promise<ClaudeSdkHistoryMessage[]>;
  query(options: {
    prompt: string;
    options: {
      cwd: string;
      model: string | null;
      resume?: string;
      includePartialMessages: boolean;
      tools: {
        type: "preset";
        preset: "claude_code";
      };
      settingSources: string[];
      systemPrompt: {
        type: "preset";
        preset: "claude_code";
      };
      permissionMode: ClaudePermissionMode;
      allowDangerouslySkipPermissions: boolean;
      canUseTool: (
        toolName: unknown,
        input: unknown,
        context: ClaudeSdkToolContext
      ) => Promise<UnknownRecord>;
    };
  }): ClaudeSdkQuery;
}

interface ClaudeHistoryContentBlock extends UnknownRecord {
  type?: unknown;
  text?: unknown;
  thinking?: unknown;
  name?: unknown;
  input?: unknown;
  id?: unknown;
}

interface ClaudeStreamBlockState {
  type: string;
  itemId: string;
  toolName: string | null;
}

interface ClaudeStreamState {
  blocksByIndex: Map<number, ClaudeStreamBlockState>;
  didEmitAssistantText: boolean;
  didEmitPlan: boolean;
}

interface StructuredQuestionOption {
  label: string;
  description: string;
}

interface StructuredQuestion {
  id: string;
  header: string;
  question: string;
  options: StructuredQuestionOption[];
}

interface StructuredInputRequest extends UnknownRecord {
  itemId: string;
  questions: StructuredQuestion[];
}

export function createClaudeAdapter({
  store,
  logPrefix = "[coderover]",
  sdkLoader,
}: ManagedProviderAdapterFactoryOptions): ManagedProviderAdapter {
  void logPrefix;
  let sdkModulePromise: Promise<ClaudeSdkModule> | null = null;

  async function syncImportedThreads(): Promise<void> {
    const sdk = await loadSdkModule();
    const sessions = await sdk.listSessions().catch(() => []);
    const providerDefinition = getRuntimeProvider("claude");

    for (const session of sessions) {
      if (!session?.sessionId) {
        continue;
      }

      const existingThreadId = store.findThreadIdByProviderSession("claude", session.sessionId);
      const existingThreadMeta = existingThreadId ? store.getThreadMeta(existingThreadId) : null;
      const sessionLastModified = toIsoDateString(session.lastModified);
      const nextMeta = {
        id: existingThreadId || `claude:${randomUUID()}`,
        provider: "claude",
        providerSessionId: session.sessionId,
        title: normalizeOptionalString(session.customTitle || session.summary),
        name: normalizeOptionalString(session.customTitle),
        preview: normalizeOptionalString(session.firstPrompt || session.summary),
        cwd: normalizeOptionalString(session.cwd),
        metadata: {
          ...(existingThreadMeta?.metadata || {}),
          providerTitle: providerDefinition.title,
          claudeSessionLastModified: sessionLastModified,
        },
        capabilities: providerDefinition.supports,
        createdAt: existingThreadMeta?.createdAt || sessionLastModified,
        updatedAt: sessionLastModified,
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
    if (!threadMeta?.providerSessionId) {
      return;
    }

    const currentThreadMeta = store.getThreadMeta(threadMeta.id) || threadMeta;
    const existingHistory = store.getThreadHistory(threadMeta.id);
    if (!shouldRefreshClaudeHistory(currentThreadMeta, existingHistory)) {
      return;
    }

    const sdk = await loadSdkModule();
    const messages = await sdk.getSessionMessages(
      currentThreadMeta.providerSessionId,
      currentThreadMeta.cwd ? { dir: currentThreadMeta.cwd } : undefined
    ).catch(() => []);

    const turns: RuntimeStoreTurn[] = [];
    let currentTurn: RuntimeStoreTurn | null = null;
    let virtualTimeMs = Date.now() - ((messages.length + 1) * 2 * 1000);

    const firstRole = normalizeOptionalString(messages[0]?.type);
    const hasInitialUserPrompt = firstRole === "user" || firstRole === "human";
    if (!hasInitialUserPrompt && currentThreadMeta.preview) {
      currentTurn = {
        id: `turn-initial-${createHash("md5").update(currentThreadMeta.preview).digest("hex")}`,
        createdAt: new Date(virtualTimeMs++).toISOString(),
        status: "completed",
        items: [{
          id: `item-initial-${createHash("md5").update(currentThreadMeta.preview).digest("hex")}`,
          type: "user_message",
          role: "user",
          createdAt: new Date(virtualTimeMs++).toISOString(),
          content: [{ type: "text", text: currentThreadMeta.preview }],
          text: currentThreadMeta.preview,
          message: null,
          status: null,
          command: null,
          metadata: null,
          plan: null,
          summary: null,
          fileChanges: [],
        }],
      };
      turns.push(currentTurn);
    }

    messages.forEach((message, index) => {
      const role = normalizeOptionalString(message?.type);
      if (!role) {
        return;
      }

      const deterministicId = createHash("md5")
        .update(`${index}-${role}-${message.uuid || ""}`)
        .digest("hex");

      if (role === "user" || role === "human" || !currentTurn) {
        currentTurn = {
          id: `turn-${deterministicId}`,
          createdAt: new Date(virtualTimeMs++).toISOString(),
          status: "completed",
          items: [],
        };
        turns.push(currentTurn);
      }

      currentTurn.items.push(
        ...buildClaudeHistoryItems({
          role,
          messageId: message.uuid || `item-${deterministicId}`,
          message: message.message,
          createdAt: new Date(virtualTimeMs++).toISOString(),
        })
      );
    });

    store.saveThreadHistory(threadMeta.id, {
      threadId: threadMeta.id,
      turns,
    });
    store.updateThreadMeta(threadMeta.id, (entry) => ({
      ...entry,
      metadata: {
        ...(entry.metadata || {}),
        claudeHistorySyncedAt: resolveClaudeHistorySyncTimestamp(currentThreadMeta),
      },
    }));
  }

  async function startTurn({
    params,
    threadMeta,
    turnContext,
  }: ManagedProviderStartTurnOptions): Promise<Record<string, unknown>> {
    const sdk = await loadSdkModule();
    const prompt = await buildPromptFromInput(turnContext.inputItems, threadMeta.cwd, turnContext.turnId);
    const permissionMode = resolveClaudePermissionMode(params);
    const toolInputsById = new Map<string, { toolName: string | null; input: UnknownRecord | null }>();
    const streamState: ClaudeStreamState = {
      blocksByIndex: new Map(),
      didEmitAssistantText: false,
      didEmitPlan: false,
    };

    const query = sdk.query({
      prompt,
      options: {
        cwd: threadMeta.cwd || process.cwd(),
        model: normalizeOptionalString(params.model) || threadMeta.model || getRuntimeProvider("claude").defaultModelId,
        includePartialMessages: true,
        tools: {
          type: "preset",
          preset: "claude_code",
        },
        settingSources: ["project", "user", "local"],
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
        },
        permissionMode,
        allowDangerouslySkipPermissions: permissionMode === "bypassPermissions",
        canUseTool: async (toolName: unknown, input: unknown, context: ClaudeSdkToolContext) => {
          const normalizedToolName = normalizeOptionalString(toolName);
          const normalizedInput = asRecord(input);
          toolInputsById.set(context.toolUseID, {
            toolName: normalizedToolName,
            input: normalizedInput,
          });

          if (permissionMode === "bypassPermissions") {
            return {
              behavior: "allow",
              updatedInput: input,
            };
          }

          if (normalizedToolName === "AskUserQuestion") {
            const request = buildStructuredUserInputRequest(normalizedInput, context.toolUseID);
            if (!request) {
              return {
                behavior: "allow",
                updatedInput: normalizedInput,
              };
            }

            const response = await turnContext.requestStructuredInput(request);
            return {
              behavior: "allow",
              updatedInput: {
                ...(normalizedInput || {}),
                ...convertStructuredResponseToClaudeAnswerPayload(request.questions, response),
              },
            };
          }

          const decision = await turnContext.requestApproval({
            itemId: context.toolUseID,
            method: approvalMethodForClaudeTool(normalizedToolName),
            command: extractToolCommand(normalizedToolName, normalizedInput),
            reason: `Claude wants to use ${normalizedToolName || "a tool"}`,
            toolName: normalizedToolName,
          });

          if (isApprovalAccepted(decision)) {
            return {
              behavior: "allow",
              updatedInput: normalizedInput,
            };
          }

          return {
            behavior: "deny",
            message: "User denied tool use",
          };
        },
        ...(threadMeta.providerSessionId ? { resume: threadMeta.providerSessionId } : {}),
      },
    });

    turnContext.setInterruptHandler(async () => {
      try {
        await query.interrupt();
      } catch {
        // Best-effort only.
      }
    });

    try {
      for await (const message of query) {
        if (message?.session_id) {
          turnContext.bindProviderSession(message.session_id);
        }

        if (message.type === "stream_event") {
          handleClaudeStreamEvent(message.event, streamState, turnContext);
          continue;
        }

        if (message.type === "tool_progress") {
          if (!message.tool_use_id) {
            continue;
          }
          const toolUse = toolInputsById.get(message.tool_use_id);
          if (!toolUse) {
            continue;
          }

          if (toolUse.toolName === "Bash") {
            turnContext.updateCommandExecution({
              itemId: message.tool_use_id,
              command: extractToolCommand(toolUse.toolName, toolUse.input),
              cwd: threadMeta.cwd,
              status: "running",
              outputDelta: "",
            });
          } else {
            const renderedToolUse = renderToolUse(toolUse.toolName, toolUse.input);
            if (!renderedToolUse) {
              continue;
            }
            turnContext.appendToolCallDelta(
              renderedToolUse,
              {
                itemId: message.tool_use_id,
                toolName: toolUse.toolName,
              }
            );
          }
          continue;
        }

        if (message.type === "assistant") {
          const assistantText = extractClaudeAssistantText(message.message);
          if (assistantText && !streamState.didEmitAssistantText) {
            turnContext.appendAgentDelta(assistantText, {
              itemId: message.uuid || randomUUID(),
            });
            streamState.didEmitAssistantText = true;
          }

          if (isPlanMode(params) && assistantText && !streamState.didEmitPlan) {
            turnContext.upsertPlan({
              explanation: assistantText,
              steps: [],
            }, {
              itemId: `${message.uuid || randomUUID()}-plan`,
              deltaText: assistantText,
            });
            streamState.didEmitPlan = true;
          }

          for (const block of extractClaudeContentBlocks(message.message)) {
            if (block.type !== "tool_use") {
              continue;
            }

            const rendered = renderToolUse(normalizeOptionalString(block.name), asRecord(block.input));
            if (!rendered) {
              continue;
            }
            turnContext.appendToolCallDelta(rendered, {
              itemId: normalizeOptionalString(block.id) || randomUUID(),
              toolName: normalizeOptionalString(block.name),
              completed: true,
            });
          }
          continue;
        }

        if (message.type === "result") {
          return {
            usage: buildClaudeUsage(message.usage),
          };
        }
      }

      return {};
    } finally {
      cleanupMaterializedImageInputs({
        imageTempDirName: "claude-images",
        turnId: turnContext.turnId,
      });
    }
  }

  async function loadSdkModule() {
    if (!sdkModulePromise) {
      const loadModule = sdkLoader || (() => import("@anthropic-ai/claude-agent-sdk"));
      sdkModulePromise = loadModule().then((module) => module as ClaudeSdkModule);
    }
    return sdkModulePromise;
  }

  return {
    hydrateThread,
    startTurn,
    syncImportedThreads,
  };
}

function shouldRefreshClaudeHistory(
  threadMeta: RuntimeThreadMeta,
  existingHistory: { turns?: RuntimeStoreTurn[] } | null
): boolean {
  const sessionLastModified = normalizeMetadataTimestamp(
    threadMeta.metadata,
    "claudeSessionLastModified"
  );
  const historySyncedAt = normalizeMetadataTimestamp(
    threadMeta.metadata,
    "claudeHistorySyncedAt"
  );
  return shouldRefreshHistoryByTimestamp(existingHistory?.turns, historySyncedAt, sessionLastModified);
}

function resolveClaudeHistorySyncTimestamp(threadMeta: RuntimeThreadMeta): string {
  return normalizeMetadataTimestamp(threadMeta.metadata, "claudeSessionLastModified")
    || toIsoDateString(Date.now());
}

function handleClaudeStreamEvent(
  event: unknown,
  streamState: ClaudeStreamState,
  turnContext: ManagedProviderTurnContext
): void {
  const eventRecord = asRecord(event);
  if (!eventRecord) {
    return;
  }

  const eventType = normalizeOptionalString(eventRecord.type);
  if (!eventType) {
    return;
  }

  if (eventType === "content_block_start") {
    const block = asRecord(eventRecord.content_block) || {};
    const blockType = normalizeOptionalString(block.type);
    const blockIndex = resolveClaudeBlockIndex(eventRecord);
    if (blockIndex == null || !blockType) {
      return;
    }
    streamState.blocksByIndex.set(blockIndex, {
      type: blockType,
      itemId: normalizeOptionalString(block.id) || randomUUID(),
      toolName: normalizeOptionalString(block.name),
    });
    return;
  }

  if (eventType !== "content_block_delta") {
    return;
  }

  const blockIndex = resolveClaudeBlockIndex(eventRecord);
  const delta = asRecord(eventRecord.delta) || {};
  const blockState = blockIndex == null ? null : streamState.blocksByIndex.get(blockIndex);
  const deltaType = normalizeOptionalString(delta.type);
  if (!blockState || !deltaType) {
    return;
  }

  if (deltaType === "text_delta") {
    const text = normalizeOptionalString(delta.text);
    if (text) {
      turnContext.appendAgentDelta(text, {
        itemId: blockState.itemId,
      });
      streamState.didEmitAssistantText = true;
    }
    return;
  }

  if (deltaType === "thinking_delta") {
    const thinking = normalizeOptionalString(delta.thinking);
    if (thinking) {
      turnContext.appendReasoningDelta(thinking, {
        itemId: blockState.itemId,
      });
    }
    return;
  }

  if (deltaType === "input_json_delta") {
    const partialJson = normalizeOptionalString(delta.partial_json);
    if (partialJson) {
      turnContext.appendToolCallDelta(partialJson, {
        itemId: blockState.itemId,
        toolName: blockState.toolName,
      });
    }
  }
}

async function buildPromptFromInput(
  inputItems: RuntimeInputItem[],
  cwd: string | null | undefined,
  turnId: string | null | undefined
): Promise<string> {
  return buildPathPromptFromInputItems(inputItems, {
    cwd,
    imageTempDirName: "claude-images",
    turnId,
  });
}

function resolveClaudePermissionMode(params: Record<string, unknown>): ClaudePermissionMode {
  if (isPlanMode(params)) {
    return "plan";
  }

  const approvalPolicy = normalizeOptionalString(params.approvalPolicy);
  const sandbox = normalizeOptionalString(params.sandbox);
  const sandboxType = normalizeOptionalString(asRecord(params.sandboxPolicy)?.type);
  const fullAccess = approvalPolicy === "never"
    || sandbox === "dangerFullAccess"
    || sandboxType === "dangerFullAccess";

  return fullAccess ? "bypassPermissions" : "default";
}

function isPlanMode(params: Record<string, unknown>): boolean {
  const collaborationMode = asRecord(params.collaborationMode);
  if (!collaborationMode) {
    return false;
  }
  return normalizeOptionalString(collaborationMode.mode) === "plan";
}

function approvalMethodForClaudeTool(toolName: string | null): string {
  if (toolName === "Bash") {
    return "item/commandExecution/requestApproval";
  }
  if (toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit") {
    return "item/fileChange/requestApproval";
  }
  return "item/tool/requestApproval";
}

function extractToolCommand(toolName: string | null, input: UnknownRecord | null | undefined): string | null {
  if (toolName === "Bash") {
    return normalizeOptionalString(input?.command);
  }
  if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") {
    return normalizeOptionalString(input?.file_path || input?.path);
  }
  return normalizeOptionalString(toolName);
}

function renderToolUse(toolName: string | null, input: UnknownRecord | null | undefined): string | null {
  const command = extractToolCommand(toolName, input);
  if (command) {
    return `${toolName}: ${command}`;
  }
  return normalizeOptionalString(toolName);
}

function buildStructuredUserInputRequest(
  input: UnknownRecord | null | undefined,
  itemId: string
): StructuredInputRequest | null {
  const rawQuestions = Array.isArray(input?.questions) ? input.questions : null;
  if (!rawQuestions || rawQuestions.length === 0) {
    return null;
  }

  return {
    itemId,
    questions: rawQuestions.map((question, index) => ({
      ...(asRecord(question) || {}),
      id: `question-${index + 1}`,
      header: normalizeOptionalString(asRecord(question)?.header) || `Q${index + 1}`,
      question: normalizeOptionalString(asRecord(question)?.question) || `Question ${index + 1}?`,
      options: Array.isArray(asRecord(question)?.options)
        ? (asRecord(question)?.options as unknown[])
          .map((option) => ({
            label: normalizeOptionalString(asRecord(option)?.label) || "Option",
            description: normalizeOptionalString(asRecord(option)?.description) || "",
          }))
          .filter((option) => option.label)
        : [],
    })).filter((question) => question.options.length >= 2),
  };
}

function convertStructuredResponseToClaudeAnswerPayload(
  questions: StructuredQuestion[],
  response: unknown
): { questions: Array<StructuredQuestion & { multiSelect: false }>; answers: Record<string, string> } {
  const responseObject = asRecord(response);
  const answersObject = asRecord(responseObject?.answers) || {};
  const answerMap: Record<string, string> = {};

  for (const question of questions) {
    const answerEntry = asRecord(answersObject[question.id]);
    const answers = Array.isArray(answerEntry?.answers)
      ? answerEntry.answers
        .map((entry) => normalizeOptionalString(entry))
        .filter((entry): entry is string => Boolean(entry))
      : [];
    answerMap[question.question] = answers.join(", ");
  }

  return {
    questions: questions.map((question) => ({
      id: question.id,
      question: question.question,
      header: question.header,
      options: question.options,
      multiSelect: false,
    })),
    answers: answerMap,
  };
}

function isApprovalAccepted(result: unknown): boolean {
  const resultObject = asRecord(result);
  const decision = normalizeOptionalString(typeof result === "string" ? result : resultObject?.decision || resultObject?.result);
  return decision === "accept" || decision === "acceptForSession";
}

function buildClaudeUsage(usage: unknown): { tokensUsed: number; totalTokens: number } | null {
  const usageObject = asRecord(usage);
  if (!usageObject) {
    return null;
  }
  const inputTokens = numberOrNull(usageObject.input_tokens || usageObject.inputTokens);
  const outputTokens = numberOrNull(usageObject.output_tokens || usageObject.outputTokens);
  const totalTokens = numberOrNull(usageObject.total_tokens || usageObject.totalTokens)
    || ((inputTokens || 0) + (outputTokens || 0));
  if (totalTokens == null) {
    return null;
  }
  return {
    tokensUsed: totalTokens,
    totalTokens,
  };
}

function buildClaudeHistoryContent(message: unknown): RuntimeStoreItem["content"] {
  const text = extractClaudeMessageText(message);
  return text ? [{ type: "text", text }] : [];
}

function buildClaudeHistoryItems({
  role,
  messageId,
  message,
  createdAt,
}: {
  role: string;
  messageId: string | undefined;
  message: unknown;
  createdAt: string;
}): RuntimeStoreItem[] {
  const normalizedMessageId = normalizeOptionalString(messageId) || randomUUID();

  if (role === "user" || role === "human") {
    const text = extractClaudeMessageText(message);
    return [{
      id: normalizedMessageId,
      type: "user_message",
      role: "user",
      createdAt,
      content: buildClaudeHistoryContent(message),
      text,
      message: null,
      status: null,
      command: null,
      metadata: null,
      plan: null,
      summary: null,
      fileChanges: [],
    }];
  }

  const items: RuntimeStoreItem[] = [];
  const contentBlocks = extractClaudeContentBlocks(message);
  const thinkingText = contentBlocks
    .filter((block) => block.type === "thinking")
    .map((block) => normalizeOptionalString(block.thinking) || "")
    .filter(Boolean)
    .join("\n\n")
    .trim();
  if (thinkingText) {
    items.push({
      id: `${normalizedMessageId}:thinking`,
      type: "reasoning",
      role: null,
      createdAt,
      content: [],
      text: thinkingText,
      message: null,
      status: null,
      command: null,
      metadata: null,
      plan: null,
      summary: null,
      fileChanges: [],
    });
  }

  const assistantText = extractClaudeMessageText(message);
  if (assistantText) {
    items.push({
      id: normalizedMessageId,
      type: "agent_message",
      role: "assistant",
      createdAt,
      content: [{ type: "text", text: assistantText }],
      text: assistantText,
      message: null,
      status: null,
      command: null,
      metadata: null,
      plan: null,
      summary: null,
      fileChanges: [],
    });
  }

  return items;
}

function extractClaudeAssistantText(message: unknown): string {
  return extractClaudeMessageText(message);
}

function extractClaudeMessageText(message: unknown): string {
  if (typeof message === "string") {
    return message.trim();
  }

  const messageObject = asRecord(message);
  if (!messageObject) {
    return "";
  }

  const directText = normalizeOptionalString(messageObject.text);
  if (directText) {
    return directText;
  }

  const content = Array.isArray(messageObject.content) ? messageObject.content : [];
  const textParts = content
    .map((block) => {
      const contentBlock = asRecord(block);
      if (!contentBlock) {
        return "";
      }
      if (contentBlock.type === "text") {
        return normalizeOptionalString(contentBlock.text) || "";
      }
      return "";
    })
    .filter((value): value is string => Boolean(value));
  return textParts.join("\n").trim();
}

function extractClaudeContentBlocks(message: unknown): ClaudeHistoryContentBlock[] {
  const messageObject = asRecord(message);
  if (!messageObject || !Array.isArray(messageObject.content)) {
    return [];
  }
  return messageObject.content
    .map((entry) => asRecord(entry))
    .filter((entry): entry is ClaudeHistoryContentBlock => Boolean(entry));
}

function resolveClaudeBlockIndex(event: UnknownRecord): number | null {
  if (typeof event.index === "number") {
    return event.index;
  }
  if (typeof event.content_block_index === "number") {
    return event.content_block_index;
  }
  return null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return null;
}

function asRecord(value: unknown): UnknownRecord | null {
  return asProviderRecord<UnknownRecord>(value);
}
