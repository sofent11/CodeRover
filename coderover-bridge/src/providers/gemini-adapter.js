// FILE: providers/gemini-adapter.js
// Purpose: Gemini CLI provider adapter backed by `gemini --output-format stream-json`.
// Layer: Runtime provider
// Exports: createGeminiAdapter
// Depends on: fs, os, path, child_process, crypto, ../provider-catalog

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { randomUUID } = require("crypto");
const { getRuntimeProvider } = require("../provider-catalog");

function createGeminiAdapter({
  store,
  logPrefix = "[coderover]",
} = {}) {
  async function syncImportedThreads() {
    const providerDefinition = getRuntimeProvider("gemini");
    for (const entry of discoverGeminiChatFiles()) {
      const existingThreadId = store.findThreadIdByProviderSession("gemini", entry.providerSessionId);
      const nextMeta = {
        id: existingThreadId || `gemini:${randomUUID()}`,
        provider: "gemini",
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

  async function hydrateThread(threadMeta) {
    if (!threadMeta?.providerSessionId) {
      return;
    }

    const existingHistory = store.getThreadHistory(threadMeta.id);
    if (existingHistory?.turns?.length) {
      return;
    }

    const messages = loadGeminiHistoryMessages(threadMeta.providerSessionId);
    const turns = [];
    let currentTurn = null;

    for (const message of messages) {
      if (!message.role || !message.text) {
        continue;
      }

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
        role: message.role,
        createdAt: new Date().toISOString(),
        content: [{ type: "text", text: message.text }],
        text: message.text,
      });
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
  }) {
    const prompt = await buildGeminiPrompt(turnContext.inputItems, threadMeta.cwd);
    const model = normalizeOptionalString(params.model) || threadMeta.model || getRuntimeProvider("gemini").defaultModelId;
    const args = [];

    if (prompt) {
      args.push("--prompt", prompt);
    }
    args.push("--model", model);
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
    let usage = null;

    const completion = new Promise((resolve, reject) => {
      child.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk.toString("utf8");
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() || "";

        for (const line of lines) {
          handleGeminiLine(line, turnContext, threadMeta, (nextUsage) => {
            usage = nextUsage;
          }, reject);
        }
      });

      child.stderr.on("data", (chunk) => {
        stderrBuffer += chunk.toString("utf8");
      });

      child.on("error", (error) => reject(error));
      child.on("close", (code) => {
        if (stdoutBuffer.trim()) {
          handleGeminiLine(stdoutBuffer, turnContext, threadMeta, (nextUsage) => {
            usage = nextUsage;
          }, reject);
          stdoutBuffer = "";
        }

        if (code !== 0 && !turnContext.abortController.signal.aborted) {
          reject(new Error(stderrBuffer.trim() || `Gemini CLI exited with code ${code}`));
          return;
        }

        resolve({
          usage,
        });
      });
    });

    return completion;
  }

  return {
    hydrateThread,
    startTurn,
    syncImportedThreads,
  };
}

function discoverGeminiChatFiles() {
  const candidates = [
    path.join(os.homedir(), ".gemini", "tmp"),
    path.join(os.homedir(), ".gemini", "history"),
  ];
  const results = [];

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

function discoverChatFiles(projectDir) {
  const candidates = [
    path.join(projectDir, "chats"),
    projectDir,
  ];
  const files = [];

  for (const directory of candidates) {
    if (!fs.existsSync(directory) || !safeStat(directory)?.isDirectory()) {
      continue;
    }

    for (const entry of safeReaddir(directory)) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      files.push(path.join(directory, entry));
    }
  }

  return files;
}

function readProjectRoot(projectDir) {
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

function loadGeminiHistoryMessages(chatFile) {
  if (!chatFile || !fs.existsSync(chatFile)) {
    return [];
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(chatFile, "utf8"));
    return extractGeminiMessages(parsed);
  } catch {
    return [];
  }
}

function extractGeminiMessages(parsed) {
  if (Array.isArray(parsed)) {
    return parsed
      .map((entry) => normalizeGeminiMessage(entry))
      .filter(Boolean);
  }

  if (parsed && typeof parsed === "object") {
    const candidateArrays = [
      parsed.messages,
      parsed.entries,
      parsed.history,
      parsed.chat,
    ];
    for (const candidate of candidateArrays) {
      if (!Array.isArray(candidate)) {
        continue;
      }
      return candidate
        .map((entry) => normalizeGeminiMessage(entry))
        .filter(Boolean);
    }
  }

  return [];
}

function normalizeGeminiMessage(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const rawRole = normalizeOptionalString(entry.role || entry.author || entry.sender || entry.type);
  const role = normalizeGeminiRole(rawRole);
  const text = normalizeOptionalString(extractGeminiMessageText(entry));
  if (!role || !text) {
    return null;
  }

  return {
    role,
    text,
  };
}

function normalizeGeminiRole(rawRole) {
  const role = normalizeOptionalString(rawRole)?.toLowerCase();
  if (!role) {
    return null;
  }

  if (role.includes("user")) {
    return "user";
  }

  if (
    role.includes("gemini")
    || role.includes("assistant")
    || role.includes("model")
  ) {
    return "assistant";
  }

  return null;
}

function extractGeminiMessageText(entry) {
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

function joinGeminiTextParts(parts) {
  if (!Array.isArray(parts)) {
    return null;
  }

  const flattened = parts
    .map((part) => extractGeminiPartText(part))
    .filter(Boolean);

  return flattened.length > 0 ? flattened.join("\n") : null;
}

function extractGeminiPartText(part) {
  if (typeof part === "string") {
    return normalizeOptionalString(part);
  }

  if (!part || typeof part !== "object") {
    return null;
  }

  const directText = normalizeOptionalString(
    part.text
    || part.content
    || part.message
    || part.resultDisplay
    || part.description
  );
  if (directText) {
    return directText;
  }

  const nested = [
    joinGeminiTextParts(part.parts),
    joinGeminiTextParts(part.content),
    joinGeminiTextParts(part.messages),
    joinGeminiTextParts(part.result),
    joinGeminiThoughts(part.thoughts),
  ].find(Boolean);

  return nested || null;
}

function joinGeminiThoughts(thoughts) {
  if (!Array.isArray(thoughts)) {
    return null;
  }

  const flattened = thoughts
    .map((thought) => {
      if (!thought || typeof thought !== "object") {
        return null;
      }
      return normalizeOptionalString(
        thought.description
        || thought.text
        || thought.message
        || thought.subject
      );
    })
    .filter(Boolean);

  return flattened.length > 0 ? flattened.join("\n") : null;
}

async function buildGeminiPrompt(inputItems, cwd) {
  const textParts = [];
  const imagePaths = [];

  for (const item of inputItems) {
    if (item.type === "text" && item.text) {
      textParts.push(item.text);
      continue;
    }

    if (item.type === "skill" && item.id) {
      textParts.push(`$${item.id}`);
      continue;
    }

    if ((item.type === "image" || item.type === "local_image") && (item.url || item.image_url || item.path)) {
      const imagePath = item.path || await materializeImage(item.url || item.image_url, cwd);
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

async function materializeImage(source, cwd) {
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
  const tempDir = path.join(cwd || os.tmpdir(), ".coderover", "gemini-images");
  fs.mkdirSync(tempDir, { recursive: true });
  const filePath = path.join(tempDir, `${Date.now()}-${randomUUID()}.${extension}`);
  fs.writeFileSync(filePath, Buffer.from(base64, "base64"));
  return filePath;
}

function handleGeminiLine(line, turnContext, threadMeta, updateUsage, reject) {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  let event = null;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return;
  }

  const type = normalizeOptionalString(event.type);
  if (!type) {
    return;
  }

  if (type === "init" && event.session_id) {
    turnContext.bindProviderSession(event.session_id);
    return;
  }

  if (type === "message" && normalizeOptionalString(event.role) === "assistant") {
    const content = normalizeOptionalString(event.content);
    if (content) {
      turnContext.appendAgentDelta(content, {
        itemId: event.id || randomUUID(),
      });
      turnContext.updatePreview(content);
    }
    return;
  }

  if (type === "tool_use") {
    const rendered = renderGeminiToolUse(event);
    turnContext.appendToolCallDelta(rendered, {
      itemId: normalizeOptionalString(event.tool_id) || randomUUID(),
      toolName: normalizeOptionalString(event.tool_name),
    });
    return;
  }

  if (type === "tool_result") {
    const rendered = normalizeOptionalString(event.output) || normalizeOptionalString(event.status) || "tool_result";
    turnContext.appendToolCallDelta(rendered, {
      itemId: normalizeOptionalString(event.tool_id) || randomUUID(),
      toolName: normalizeOptionalString(event.tool_name),
      completed: true,
    });
    return;
  }

  if (type === "result") {
    const totalTokens = numberOrNull(event?.stats?.total_tokens || event?.usage?.totalTokens);
    if (totalTokens != null) {
      updateUsage({
        tokensUsed: totalTokens,
        totalTokens,
      });
    }
    return;
  }

  if (type === "error") {
    reject(new Error(normalizeOptionalString(event.error || event.message) || "Gemini CLI error"));
  }
}

function renderGeminiToolUse(event) {
  const toolName = normalizeOptionalString(event.tool_name) || "tool";
  const parameters = event.parameters && typeof event.parameters === "object"
    ? JSON.stringify(event.parameters)
    : "";
  return parameters ? `${toolName}: ${parameters}` : toolName;
}

function resolveFullAccess(params) {
  const approvalPolicy = normalizeOptionalString(params.approvalPolicy);
  const sandbox = normalizeOptionalString(params.sandbox);
  const sandboxType = normalizeOptionalString(params.sandboxPolicy?.type);
  return approvalPolicy === "never"
    || sandbox === "dangerFullAccess"
    || sandboxType === "dangerFullAccess";
}

function safeReaddir(directory) {
  try {
    return fs.readdirSync(directory);
  } catch {
    return [];
  }
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function normalizeOptionalString(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function numberOrNull(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return null;
}

module.exports = {
  createGeminiAdapter,
  extractGeminiMessages,
  normalizeGeminiMessage,
};
