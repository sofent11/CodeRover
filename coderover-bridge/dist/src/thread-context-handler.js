"use strict";
// FILE: thread-context-handler.ts
// Purpose: Serves on-demand context-window usage reads from local Codex rollout files.
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleThreadContextRequest = handleThreadContextRequest;
const rollout_watch_1 = require("./rollout-watch");
function handleThreadContextRequest(rawMessage, sendResponse) {
    let parsed;
    try {
        parsed = JSON.parse(rawMessage);
    }
    catch {
        return false;
    }
    const method = typeof parsed?.method === "string" ? parsed.method.trim() : "";
    if (method !== "thread/contextWindow/read") {
        return false;
    }
    const id = parsed.id;
    const params = parsed.params || {};
    Promise.resolve()
        .then(() => handleThreadContextRead(params))
        .then((result) => {
        sendResponse(JSON.stringify({ id, result }));
    })
        .catch((error) => {
        sendResponse(JSON.stringify({
            id,
            error: {
                code: -32000,
                message: error.userMessage || error.message || "Unknown thread context error",
                data: {
                    errorCode: error.errorCode || "thread_context_error",
                },
            },
        }));
    });
    return true;
}
async function handleThreadContextRead(params) {
    const threadId = readString(params.threadId) || readString(params.thread_id);
    if (!threadId) {
        throw threadContextError("missing_thread_id", "thread/contextWindow/read requires a threadId.");
    }
    const turnId = readString(params.turnId) || readString(params.turn_id);
    const result = (0, rollout_watch_1.readLatestContextWindowUsage)({
        threadId,
        ...(turnId ? { turnId } : {}),
    });
    return {
        threadId,
        usage: result?.usage ?? null,
        rolloutPath: result?.rolloutPath ?? null,
    };
}
function readString(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}
function threadContextError(errorCode, userMessage) {
    const error = new Error(userMessage);
    error.errorCode = errorCode;
    error.userMessage = userMessage;
    return error;
}
