export {};

// FILE: providers/claude-adapter.ts
// Purpose: Claude Code provider adapter backed by @anthropic-ai/claude-agent-sdk.
// Layer: Runtime provider
// Exports: createClaudeAdapter
// Depends on: fs, os, path, crypto, ../provider-catalog

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";

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

type UnknownRecord = Record<string, unknown>;
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
      const nextMeta = {
        id: existingThreadId || `claude:${randomUUID()}`,
        provider: "claude",
        providerSessionId: session.sessionId,
        title: normalizeOptionalString(session.customTitle || session.summary),
        name: normalizeOptionalString(session.customTitle),
        preview: normalizeOptionalString(session.firstPrompt || session.summary),
        cwd: normalizeOptionalString(session.cwd),
        metadata: {
          providerTitle: providerDefinition.title,
        },
        capabilities: providerDefinition.supports,
        createdAt: toIsoDateString(session.lastModified),
        updatedAt: toIsoDateString(session.lastModified),
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

    const existingHistory = store.getThreadHistory(threadMeta.id);
    if (existingHistory?.turns?.length) {
      return;
    }

    const sdk = await loadSdkModule();
    const messages = await sdk.getSessionMessages(threadMeta.providerSessionId, {
      dir: threadMeta.cwd || undefined,
    }).catch(() => []);

    const turns: RuntimeStoreTurn[] = [];
    let currentTurn: RuntimeStoreTurn | null = null;
    for (const message of messages) {
      const role = normalizeOptionalString(message?.type);
      if (!role) {
        continue;
      }

      if (role === "user" || !currentTurn) {
        currentTurn = {
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          status: "completed",
          items: [],
        };
        turns.push(currentTurn);
      }

      const item: RuntimeStoreItem = role === "user"
        ? {
          id: message.uuid || randomUUID(),
          type: "user_message",
          role: "user",
          createdAt: new Date().toISOString(),
          content: buildClaudeHistoryContent(message.message),
          text: extractClaudeMessageText(message.message),
          message: null,
          status: null,
          command: null,
          metadata: null,
          plan: null,
          summary: null,
          fileChanges: [],
        }
        : {
          id: message.uuid || randomUUID(),
          type: "agent_message",
          role: "assistant",
          createdAt: new Date().toISOString(),
          content: [{ type: "text", text: extractClaudeMessageText(message.message) }],
          text: extractClaudeMessageText(message.message),
          message: null,
          status: null,
          command: null,
          metadata: null,
          plan: null,
          summary: null,
          fileChanges: [],
        };
      currentTurn.items.push(item);
    }

    store.saveThreadHistory(threadMeta.id, {
      threadId: threadMeta.id,
      turns,
    });
  }

  async function startTurn({
    params,
    threadMeta,
    turnContext,
  }: ManagedProviderStartTurnOptions): Promise<Record<string, unknown>> {
    const sdk = await loadSdkModule();
    const prompt = await buildPromptFromInput(turnContext.inputItems, threadMeta.cwd);
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
        resume: threadMeta.providerSessionId || undefined,
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
      },
    });

    turnContext.setInterruptHandler(async () => {
      try {
        await query.interrupt();
      } catch {
        // Best-effort only.
      }
    });

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
  }

  async function loadSdkModule() {
    if (!sdkModulePromise) {
      sdkModulePromise = import("@anthropic-ai/claude-agent-sdk") as unknown as Promise<ClaudeSdkModule>;
    }
    return sdkModulePromise;
  }

  return {
    hydrateThread,
    startTurn,
    syncImportedThreads,
  };
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
  cwd: string | null | undefined
): Promise<string> {
  const textChunks: string[] = [];
  const imagePaths: string[] = [];

  for (const item of inputItems) {
    if (isTextInputItem(item)) {
      textChunks.push(item.text);
      continue;
    }

    if (isSkillInputItem(item)) {
      textChunks.push(`$${item.id}`);
      continue;
    }

    if (isImageInputItem(item)) {
      const pathValue = item.path || await materializeImage(item.url || item.image_url, cwd);
      if (pathValue) {
        imagePaths.push(pathValue);
      }
    }
  }

  let prompt = textChunks.join("\n").trim();
  if (imagePaths.length > 0) {
    prompt = `${prompt}\n\n[Images provided at paths]\n${imagePaths.join("\n")}`.trim();
  }
  return prompt;
}

async function materializeImage(source: unknown, cwd: string | null | undefined): Promise<string | null> {
  const normalized = normalizeOptionalString(source);
  if (!normalized) {
    return null;
  }

  if (path.isAbsolute(normalized) && fs.existsSync(normalized)) {
    return normalized;
  }

  const match = normalized.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    return normalized;
  }

  const mimeType = match[1];
  const base64 = match[2];
  const extension = mimeType.split("/")[1] || "png";
  const tempDir = path.join(cwd || os.tmpdir(), ".coderover", "claude-images");
  fs.mkdirSync(tempDir, { recursive: true });
  const filePath = path.join(tempDir, `${Date.now()}-${randomUUID()}.${extension}`);
  fs.writeFileSync(filePath, Buffer.from(base64, "base64"));
  return filePath;
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

function extractClaudeAssistantText(message: unknown): string {
  return extractClaudeMessageText(message);
}

function extractClaudeMessageText(message: unknown): string {
  const messageObject = asRecord(message);
  if (!messageObject) {
    return "";
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
      if (contentBlock.type === "thinking") {
        return normalizeOptionalString(contentBlock.thinking) || "";
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

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function toIsoDateString(value: unknown): string {
  if (typeof value === "number") {
    const milliseconds = value > 10_000_000_000 ? value : value * 1000;
    return new Date(milliseconds).toISOString();
  }
  return new Date().toISOString();
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return null;
}

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as UnknownRecord;
}

function isTextInputItem(item: RuntimeInputItem): item is Extract<RuntimeInputItem, { type: "text" }> {
  return item.type === "text" && typeof item.text === "string" && item.text.length > 0;
}

function isSkillInputItem(item: RuntimeInputItem): item is Extract<RuntimeInputItem, { type: "skill" }> {
  return item.type === "skill" && typeof item.id === "string" && item.id.length > 0;
}

function isImageInputItem(
  item: RuntimeInputItem
): item is Extract<RuntimeInputItem, { type: "image" | "local_image" }> {
  return (item.type === "image" || item.type === "local_image")
    && (typeof item.path === "string"
      || typeof item.url === "string"
      || typeof item.image_url === "string");
}
