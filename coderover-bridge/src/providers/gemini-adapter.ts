// FILE: providers/gemini-adapter.ts
// Purpose: Gemini CLI provider adapter backed by `gemini --output-format stream-json`.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import { randomUUID } from "crypto";

import { getRuntimeProvider } from "../provider-catalog";
import type { RuntimeInputItem } from "../bridge-types";
import type {
  RuntimeStore,
  RuntimeThreadHistory,
  RuntimeThreadMeta,
} from "../runtime-store";
import type {
  ManagedProviderAdapter,
  ManagedProviderAdapterFactoryOptions,
  ManagedProviderStartTurnOptions,
  ManagedProviderTurnContext,
} from "../runtime-manager/types";

type ProviderRole = "user" | "assistant";

interface GeminiHistoryMessage {
  role: ProviderRole;
  text: string;
}

interface GeminiDiscoveredThread {
  providerSessionId: string;
  cwd: string | null;
  title: string;
  preview: string | null;
  updatedAt: string;
}

interface GeminiStartTurnParams extends Record<string, unknown> {
  model?: unknown;
  approvalPolicy?: unknown;
  sandbox?: unknown;
  sandboxPolicy?: { type?: unknown } | unknown;
}

interface GeminiUsageResult {
  tokensUsed: number;
  totalTokens: number;
}

type JsonRecord = Record<string, unknown>;

export function createGeminiAdapter({
  store,
}: ManagedProviderAdapterFactoryOptions): ManagedProviderAdapter {
  async function syncImportedThreads(): Promise<void> {
    const providerDefinition = getRuntimeProvider("gemini");
    for (const entry of discoverGeminiChatFiles()) {
      const existingThreadId = store.findThreadIdByProviderSession("gemini", entry.providerSessionId);
      const nextMeta = {
        id: existingThreadId || `gemini:${randomUUID()}`,
        provider: "gemini" as const,
        providerSessionId: entry.providerSessionId,
        title: entry.title,
        name: null,
        preview: entry.preview,
        cwd: entry.cwd,
        metadata: {
          providerTitle: providerDefinition.title,
        },
        capabilities: providerDefinition.supports,
        createdAt: entry.updatedAt,
        updatedAt: entry.updatedAt,
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

    const existingHistory = store.getThreadHistory(threadMeta.id);
    if (existingHistory?.turns?.length) {
      return;
    }

    const messages = loadGeminiHistoryMessages(threadMeta.providerSessionId);
    const history = buildGeminiHistory(threadMeta.id, messages);
    store.saveThreadHistory(threadMeta.id, history);
  }

  async function startTurn({
    params,
    threadMeta,
    turnContext,
  }: ManagedProviderStartTurnOptions): Promise<{ usage?: GeminiUsageResult | null }> {
    const prompt = await buildGeminiPrompt(turnContext.inputItems, threadMeta.cwd);
    const model =
      normalizeOptionalString(params.model)
      || threadMeta.model
      || getRuntimeProvider("gemini").defaultModelId;
    const args: string[] = [];

    if (prompt) {
      args.push("--prompt", prompt);
    }
    if (model) {
      args.push("--model", model);
    }
    args.push("--output-format", "stream-json");

    if (resolveFullAccess(params)) {
      args.push("--yolo");
    } else {
      args.push("--approval-mode", "auto_edit");
    }

    const binary = process.env.GEMINI_PATH || "gemini";
    const child = process.platform === "win32"
      ? spawn(binary, args, {
        cwd: threadMeta.cwd || process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      })
      : spawn("sh", ["-c", "exec \"$0\" \"$@\"", binary, ...args], {
        cwd: threadMeta.cwd || process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

    turnContext.setInterruptHandler(() => {
      child.kill("SIGTERM");
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let usage: GeminiUsageResult | null = null;

    return new Promise<{ usage?: GeminiUsageResult | null }>((resolve, reject) => {
      child.stdout.on("data", (chunk: string | Buffer) => {
        stdoutBuffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() || "";

        for (const line of lines) {
          handleGeminiLine(line, turnContext, (nextUsage) => {
            usage = nextUsage;
          }, reject);
        }
      });

      child.stderr.on("data", (chunk: string | Buffer) => {
        stderrBuffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      });

      child.on("error", (error) => reject(error));
      child.on("close", (code) => {
        if (stdoutBuffer.trim()) {
          handleGeminiLine(stdoutBuffer, turnContext, (nextUsage) => {
            usage = nextUsage;
          }, reject);
          stdoutBuffer = "";
        }

        if (code !== 0 && !turnContext.abortController.signal.aborted) {
          reject(new Error(stderrBuffer.trim() || `Gemini CLI exited with code ${code}`));
          return;
        }

        resolve({ usage });
      });
    });
  }

  return {
    hydrateThread,
    startTurn,
    syncImportedThreads,
  };
}

function buildGeminiHistory(threadId: string, messages: GeminiHistoryMessage[]): RuntimeThreadHistory {
  const turns: RuntimeThreadHistory["turns"] = [];
  let currentTurn: RuntimeThreadHistory["turns"][number] | null = null;

  for (const message of messages) {
    if (message.role === "user" || !currentTurn) {
      currentTurn = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        status: "completed",
        items: [],
      };
      turns.push(currentTurn);
    }

    currentTurn.items.push({
      id: randomUUID(),
      type: message.role === "user" ? "user_message" : "agent_message",
      role: message.role === "user" ? "user" : "assistant",
      createdAt: new Date().toISOString(),
      content: [{ type: "text", text: message.text }],
      text: message.text,
      message: null,
      status: null,
      command: null,
      metadata: null,
      plan: null,
      summary: null,
      fileChanges: [],
    });
  }

  return { threadId, turns };
}

function discoverGeminiChatFiles(): GeminiDiscoveredThread[] {
  const candidates = [
    path.join(os.homedir(), ".gemini", "tmp"),
    path.join(os.homedir(), ".gemini", "history"),
  ];
  const results: GeminiDiscoveredThread[] = [];

  for (const baseDir of candidates) {
    if (!fs.existsSync(baseDir)) {
      continue;
    }

    for (const projectName of safeReaddir(baseDir)) {
      const projectDir = path.join(baseDir, projectName);
      const cwd = readProjectRoot(projectDir);
      const chatFiles = discoverChatFiles(projectDir);

      for (const chatFile of chatFiles) {
        const stats = safeStat(chatFile);
        const historyMessages = loadGeminiHistoryMessages(chatFile);
        const preview = historyMessages.find((entry) => entry.role === "user")?.text || null;
        results.push({
          providerSessionId: chatFile,
          cwd,
          title: path.basename(chatFile, path.extname(chatFile)),
          preview,
          updatedAt: stats?.mtime?.toISOString?.() || new Date().toISOString(),
        });
      }
    }
  }

  return results;
}

function discoverChatFiles(projectDir: string): string[] {
  const candidates = [path.join(projectDir, "chats"), projectDir];
  const files: string[] = [];

  for (const directory of candidates) {
    if (!fs.existsSync(directory) || !safeStat(directory)?.isDirectory()) {
      continue;
    }

    for (const entry of safeReaddir(directory)) {
      if (entry.endsWith(".json")) {
        files.push(path.join(directory, entry));
      }
    }
  }

  return files;
}

function readProjectRoot(projectDir: string): string | null {
  const markerPath = path.join(projectDir, ".project_root");
  if (!fs.existsSync(markerPath)) {
    return null;
  }

  try {
    return fs.readFileSync(markerPath, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function loadGeminiHistoryMessages(chatFile: string): GeminiHistoryMessage[] {
  if (!chatFile || !fs.existsSync(chatFile)) {
    return [];
  }

  try {
    return extractGeminiMessages(JSON.parse(fs.readFileSync(chatFile, "utf8")) as unknown);
  } catch {
    return [];
  }
}

export function extractGeminiMessages(parsed: unknown): GeminiHistoryMessage[] {
  if (Array.isArray(parsed)) {
    return parsed
      .map((entry) => normalizeGeminiMessage(entry))
      .filter((entry): entry is GeminiHistoryMessage => Boolean(entry));
  }

  if (parsed && typeof parsed === "object") {
    const root = parsed as JsonRecord;
    const candidateArrays = [root.messages, root.entries, root.history, root.chat];
    for (const candidate of candidateArrays) {
      if (Array.isArray(candidate)) {
        return candidate
          .map((entry) => normalizeGeminiMessage(entry))
          .filter((entry): entry is GeminiHistoryMessage => Boolean(entry));
      }
    }
  }

  return [];
}

export function normalizeGeminiMessage(entry: unknown): GeminiHistoryMessage | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const root = entry as JsonRecord;
  const rawRole = normalizeOptionalString(root.role || root.author || root.sender || root.type);
  const role = normalizeGeminiRole(rawRole);
  const text = normalizeOptionalString(extractGeminiMessageText(root));
  if (!role || !text) {
    return null;
  }

  return { role, text };
}

function normalizeGeminiRole(rawRole: string | null): ProviderRole | null {
  const role = rawRole?.toLowerCase() || "";
  if (!role) {
    return null;
  }
  if (role.includes("user")) {
    return "user";
  }
  if (role.includes("gemini") || role.includes("assistant") || role.includes("model")) {
    return "assistant";
  }
  return null;
}

function extractGeminiMessageText(entry: JsonRecord): string | null {
  const directTextCandidates = [
    entry.text,
    entry.message,
    entry.content,
    entry.resultDisplay,
  ];

  for (const candidate of directTextCandidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }

  const joinedCandidates = [
    joinGeminiTextParts(entry.content),
    joinGeminiTextParts(entry.parts),
    joinGeminiTextParts(entry.messages),
    joinGeminiThoughts(entry.thoughts),
  ];

  for (const candidate of joinedCandidates) {
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

function joinGeminiTextParts(parts: unknown): string | null {
  if (!Array.isArray(parts)) {
    return null;
  }

  const flattened = parts
    .map((part) => extractGeminiPartText(part))
    .filter((value): value is string => Boolean(value));

  return flattened.length > 0 ? flattened.join("\n") : null;
}

function extractGeminiPartText(part: unknown): string | null {
  if (typeof part === "string") {
    return normalizeOptionalString(part);
  }

  if (!part || typeof part !== "object") {
    return null;
  }

  const root = part as JsonRecord;
  const directText = normalizeOptionalString(
    root.text || root.content || root.message || root.resultDisplay || root.description
  );
  if (directText) {
    return directText;
  }

  return [
    joinGeminiTextParts(root.parts),
    joinGeminiTextParts(root.content),
    joinGeminiTextParts(root.messages),
    joinGeminiTextParts(root.result),
    joinGeminiThoughts(root.thoughts),
  ].find((value): value is string => Boolean(value)) || null;
}

function joinGeminiThoughts(thoughts: unknown): string | null {
  if (!Array.isArray(thoughts)) {
    return null;
  }

  const flattened = thoughts
    .map((thought) => {
      if (!thought || typeof thought !== "object") {
        return null;
      }
      const root = thought as JsonRecord;
      return normalizeOptionalString(root.description || root.text || root.message || root.subject);
    })
    .filter((value): value is string => Boolean(value));

  return flattened.length > 0 ? flattened.join("\n") : null;
}

async function buildGeminiPrompt(inputItems: RuntimeInputItem[], cwd: string | null): Promise<string> {
  const textParts: string[] = [];
  const imagePaths: string[] = [];

  for (const item of inputItems) {
    if (item.type === "text" && typeof item.text === "string" && item.text) {
      textParts.push(item.text);
      continue;
    }

    if (item.type === "skill" && typeof item.id === "string" && item.id) {
      textParts.push(`$${item.id}`);
      continue;
    }

    if (
      (item.type === "image" || item.type === "local_image")
      && (typeof item.url === "string" || typeof item.image_url === "string" || typeof item.path === "string")
    ) {
      const source = readFirstString([item.path, item.url, item.image_url]);
      const imagePath = source ? await materializeImage(source, cwd) : null;
      if (imagePath) {
        imagePaths.push(imagePath);
      }
    }
  }

  let prompt = textParts.join("\n").trim();
  if (imagePaths.length > 0) {
    prompt = `${prompt}\n\n[Images provided at paths]\n${imagePaths.join("\n")}`.trim();
  }
  return prompt;
}

async function materializeImage(source: string, cwd: string | null): Promise<string | null> {
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
  if (!mimeType || !base64) {
    return normalized;
  }
  const extension = mimeType.split("/")[1] || "png";
  const tempDir = path.join(cwd || os.tmpdir(), ".coderover", "gemini-images");
  fs.mkdirSync(tempDir, { recursive: true });
  const filePath = path.join(tempDir, `${Date.now()}-${randomUUID()}.${extension}`);
  fs.writeFileSync(filePath, Buffer.from(base64, "base64"));
  return filePath;
}

function handleGeminiLine(
  line: string,
  turnContext: ManagedProviderTurnContext,
  updateUsage: (usage: GeminiUsageResult) => void,
  reject: (reason?: unknown) => void
): void {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  let event: unknown = null;
  try {
    event = JSON.parse(trimmed) as unknown;
  } catch {
    return;
  }

  if (!event || typeof event !== "object") {
    return;
  }

  const root = event as JsonRecord;
  const type = normalizeOptionalString(root.type);
  if (!type) {
    return;
  }

  if (type === "init") {
    const sessionId = normalizeOptionalString(root.session_id);
    if (sessionId) {
      turnContext.bindProviderSession(sessionId);
    }
    return;
  }

  if (type === "message" && normalizeOptionalString(root.role) === "assistant") {
    const content = normalizeOptionalString(root.content);
    if (content) {
      turnContext.appendAgentDelta(content, {
        itemId: normalizeOptionalString(root.id) || randomUUID(),
      });
      turnContext.updatePreview(content);
    }
    return;
  }

  if (type === "tool_use") {
    turnContext.appendToolCallDelta(renderGeminiToolUse(root), {
      itemId: normalizeOptionalString(root.tool_id) || randomUUID(),
      toolName: normalizeOptionalString(root.tool_name),
    });
    return;
  }

  if (type === "tool_result") {
    turnContext.appendToolCallDelta(
      normalizeOptionalString(root.output) || normalizeOptionalString(root.status) || "tool_result",
      {
        itemId: normalizeOptionalString(root.tool_id) || randomUUID(),
        toolName: normalizeOptionalString(root.tool_name),
        completed: true,
      }
    );
    return;
  }

  if (type === "result") {
    const stats = asRecord(root.stats);
    const usageRoot = asRecord(root.usage);
    const totalTokens = numberOrNull(stats?.total_tokens) ?? numberOrNull(usageRoot?.totalTokens);
    if (totalTokens != null) {
      updateUsage({ tokensUsed: totalTokens, totalTokens });
    }
    return;
  }

  if (type === "error") {
    reject(new Error(normalizeOptionalString(root.error || root.message) || "Gemini CLI error"));
  }
}

function renderGeminiToolUse(event: JsonRecord): string {
  const toolName = normalizeOptionalString(event.tool_name) || "tool";
  const parameters = event.parameters && typeof event.parameters === "object"
    ? JSON.stringify(event.parameters)
    : "";
  return parameters ? `${toolName}: ${parameters}` : toolName;
}

function resolveFullAccess(params: GeminiStartTurnParams): boolean {
  const approvalPolicy = normalizeOptionalString(params.approvalPolicy);
  const sandbox = normalizeOptionalString(params.sandbox);
  const sandboxPolicy = asRecord(params.sandboxPolicy);
  const sandboxType = normalizeOptionalString(sandboxPolicy?.type);
  return approvalPolicy === "never"
    || sandbox === "dangerFullAccess"
    || sandboxType === "dangerFullAccess";
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

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readFirstString(values: unknown[]): string | null {
  for (const value of values) {
    const normalized = normalizeOptionalString(value);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}
