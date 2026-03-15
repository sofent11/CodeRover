"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// FILE: providers/claude-adapter.js
// Purpose: Claude Code provider adapter backed by @anthropic-ai/claude-agent-sdk.
// Layer: Runtime provider
// Exports: createClaudeAdapter
// Depends on: fs, os, path, crypto, ../provider-catalog
const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");
const { getRuntimeProvider } = require("../provider-catalog");
function createClaudeAdapter({ store, logPrefix = "[coderover]", }) {
    let sdkModulePromise = null;
    async function syncImportedThreads() {
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
            }
            else {
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
        const sdk = await loadSdkModule();
        const messages = await sdk.getSessionMessages(threadMeta.providerSessionId, {
            dir: threadMeta.cwd || undefined,
        }).catch(() => []);
        const turns = [];
        let currentTurn = null;
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
            const item = role === "user"
                ? {
                    id: message.uuid || randomUUID(),
                    type: "user_message",
                    role: "user",
                    createdAt: new Date().toISOString(),
                    content: buildClaudeHistoryContent(message.message),
                    text: extractClaudeMessageText(message.message),
                }
                : {
                    id: message.uuid || randomUUID(),
                    type: "agent_message",
                    role: "assistant",
                    createdAt: new Date().toISOString(),
                    content: [{ type: "text", text: extractClaudeMessageText(message.message) }],
                    text: extractClaudeMessageText(message.message),
                };
            currentTurn.items.push(item);
        }
        store.saveThreadHistory(threadMeta.id, {
            threadId: threadMeta.id,
            turns,
        });
    }
    async function startTurn({ params, threadMeta, turnContext, }) {
        const sdk = await loadSdkModule();
        const prompt = await buildPromptFromInput(turnContext.inputItems, threadMeta.cwd);
        const permissionMode = resolveClaudePermissionMode(params);
        const toolInputsById = new Map();
        const streamState = {
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
                canUseTool: async (toolName, input, context) => {
                    toolInputsById.set(context.toolUseID, {
                        toolName,
                        input,
                    });
                    if (permissionMode === "bypassPermissions") {
                        return {
                            behavior: "allow",
                            updatedInput: input,
                        };
                    }
                    if (toolName === "AskUserQuestion") {
                        const request = buildStructuredUserInputRequest(input, context.toolUseID);
                        if (!request) {
                            return {
                                behavior: "allow",
                                updatedInput: input,
                            };
                        }
                        const response = await turnContext.requestStructuredInput(request);
                        return {
                            behavior: "allow",
                            updatedInput: {
                                ...input,
                                ...convertStructuredResponseToClaudeAnswerPayload(request.questions, response),
                            },
                        };
                    }
                    const decision = await turnContext.requestApproval({
                        itemId: context.toolUseID,
                        method: approvalMethodForClaudeTool(toolName),
                        command: extractToolCommand(toolName, input),
                        reason: `Claude wants to use ${toolName}`,
                        toolName,
                    });
                    if (isApprovalAccepted(decision)) {
                        return {
                            behavior: "allow",
                            updatedInput: input,
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
            }
            catch {
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
                }
                else {
                    turnContext.appendToolCallDelta(renderToolUse(toolUse.toolName, toolUse.input), {
                        itemId: message.tool_use_id,
                        toolName: toolUse.toolName,
                    });
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
                    const rendered = renderToolUse(block.name, block.input);
                    if (!rendered) {
                        continue;
                    }
                    turnContext.appendToolCallDelta(rendered, {
                        itemId: block.id || randomUUID(),
                        toolName: block.name,
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
            sdkModulePromise = Promise.resolve().then(() => require("@anthropic-ai/claude-agent-sdk"));
        }
        return sdkModulePromise;
    }
    return {
        hydrateThread,
        startTurn,
        syncImportedThreads,
    };
}
function handleClaudeStreamEvent(event, streamState, turnContext) {
    if (!event || typeof event !== "object") {
        return;
    }
    const eventType = normalizeOptionalString(event.type);
    if (!eventType) {
        return;
    }
    if (eventType === "content_block_start") {
        const block = event.content_block || {};
        const blockType = normalizeOptionalString(block.type);
        const blockIndex = resolveClaudeBlockIndex(event);
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
    const blockIndex = resolveClaudeBlockIndex(event);
    const delta = event.delta || {};
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
async function buildPromptFromInput(inputItems, cwd) {
    const textChunks = [];
    const imagePaths = [];
    for (const item of inputItems) {
        if (item.type === "text" && item.text) {
            textChunks.push(item.text);
            continue;
        }
        if (item.type === "skill" && item.id) {
            textChunks.push(`$${item.id}`);
            continue;
        }
        if ((item.type === "image" || item.type === "local_image") && (item.url || item.image_url || item.path)) {
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
    const tempDir = path.join(cwd || os.tmpdir(), ".coderover", "claude-images");
    fs.mkdirSync(tempDir, { recursive: true });
    const filePath = path.join(tempDir, `${Date.now()}-${randomUUID()}.${extension}`);
    fs.writeFileSync(filePath, Buffer.from(base64, "base64"));
    return filePath;
}
function resolveClaudePermissionMode(params) {
    if (isPlanMode(params)) {
        return "plan";
    }
    const approvalPolicy = normalizeOptionalString(params.approvalPolicy);
    const sandbox = normalizeOptionalString(params.sandbox);
    const sandboxType = normalizeOptionalString(params.sandboxPolicy?.type);
    const fullAccess = approvalPolicy === "never"
        || sandbox === "dangerFullAccess"
        || sandboxType === "dangerFullAccess";
    return fullAccess ? "bypassPermissions" : "default";
}
function isPlanMode(params) {
    const collaborationMode = params?.collaborationMode;
    if (!collaborationMode || typeof collaborationMode !== "object") {
        return false;
    }
    return normalizeOptionalString(collaborationMode.mode) === "plan";
}
function approvalMethodForClaudeTool(toolName) {
    if (toolName === "Bash") {
        return "item/commandExecution/requestApproval";
    }
    if (toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit") {
        return "item/fileChange/requestApproval";
    }
    return "item/tool/requestApproval";
}
function extractToolCommand(toolName, input) {
    if (toolName === "Bash") {
        return normalizeOptionalString(input?.command);
    }
    if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") {
        return normalizeOptionalString(input?.file_path || input?.path);
    }
    return normalizeOptionalString(toolName);
}
function renderToolUse(toolName, input) {
    const command = extractToolCommand(toolName, input);
    if (command) {
        return `${toolName}: ${command}`;
    }
    return normalizeOptionalString(toolName);
}
function buildStructuredUserInputRequest(input, itemId) {
    const rawQuestions = Array.isArray(input?.questions) ? input.questions : null;
    if (!rawQuestions || rawQuestions.length === 0) {
        return null;
    }
    return {
        itemId,
        questions: rawQuestions.map((question, index) => ({
            id: `question-${index + 1}`,
            header: normalizeOptionalString(question.header) || `Q${index + 1}`,
            question: normalizeOptionalString(question.question) || `Question ${index + 1}?`,
            options: Array.isArray(question.options)
                ? question.options
                    .map((option) => ({
                    label: normalizeOptionalString(option.label) || "Option",
                    description: normalizeOptionalString(option.description) || "",
                }))
                    .filter((option) => option.label)
                : [],
        })).filter((question) => question.options.length >= 2),
    };
}
function convertStructuredResponseToClaudeAnswerPayload(questions, response) {
    const answersObject = response?.answers && typeof response.answers === "object"
        ? response.answers
        : {};
    const answerMap = {};
    for (const question of questions) {
        const answerEntry = answersObject[question.id];
        const answers = Array.isArray(answerEntry?.answers)
            ? answerEntry.answers
                .map((entry) => normalizeOptionalString(entry))
                .filter(Boolean)
            : [];
        answerMap[question.question] = answers.join(", ");
    }
    return {
        questions: questions.map((question) => ({
            question: question.question,
            header: question.header,
            options: question.options,
            multiSelect: false,
        })),
        answers: answerMap,
    };
}
function isApprovalAccepted(result) {
    const decision = normalizeOptionalString(typeof result === "string" ? result : result?.decision || result?.result);
    return decision === "accept" || decision === "acceptForSession";
}
function buildClaudeUsage(usage) {
    if (!usage || typeof usage !== "object") {
        return null;
    }
    const inputTokens = numberOrNull(usage.input_tokens || usage.inputTokens);
    const outputTokens = numberOrNull(usage.output_tokens || usage.outputTokens);
    const totalTokens = numberOrNull(usage.total_tokens || usage.totalTokens)
        || ((inputTokens || 0) + (outputTokens || 0));
    if (totalTokens == null) {
        return null;
    }
    return {
        tokensUsed: totalTokens,
        totalTokens,
    };
}
function buildClaudeHistoryContent(message) {
    const text = extractClaudeMessageText(message);
    return text ? [{ type: "text", text }] : [];
}
function extractClaudeAssistantText(message) {
    return extractClaudeMessageText(message);
}
function extractClaudeMessageText(message) {
    if (!message || typeof message !== "object") {
        return "";
    }
    const content = Array.isArray(message.content) ? message.content : [];
    const textParts = content
        .map((block) => {
        if (!block || typeof block !== "object") {
            return "";
        }
        if (block.type === "text") {
            return normalizeOptionalString(block.text) || "";
        }
        if (block.type === "thinking") {
            return normalizeOptionalString(block.thinking) || "";
        }
        return "";
    })
        .filter(Boolean);
    return textParts.join("\n").trim();
}
function extractClaudeContentBlocks(message) {
    if (!message || typeof message !== "object" || !Array.isArray(message.content)) {
        return [];
    }
    return message.content.filter((entry) => entry && typeof entry === "object");
}
function resolveClaudeBlockIndex(event) {
    if (typeof event.index === "number") {
        return event.index;
    }
    if (typeof event.content_block_index === "number") {
        return event.content_block_index;
    }
    return null;
}
function normalizeOptionalString(value) {
    if (typeof value !== "string") {
        return null;
    }
    const trimmed = value.trim();
    return trimmed || null;
}
function toIsoDateString(value) {
    if (typeof value === "number") {
        const milliseconds = value > 10_000_000_000 ? value : value * 1000;
        return new Date(milliseconds).toISOString();
    }
    return new Date().toISOString();
}
function numberOrNull(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    return null;
}
module.exports = {
    createClaudeAdapter,
};
