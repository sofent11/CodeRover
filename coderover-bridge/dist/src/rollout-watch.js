"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// FILE: rollout-watch.js
// Purpose: Shared rollout-file lookup/watch helpers for CLI inspection and desktop refresh.
// Layer: CLI helper
// Exports: watchThreadRollout, createThreadRolloutActivityWatcher
// Depends on: fs, os, path, ./session-state
const fs = require("fs");
const os = require("os");
const path = require("path");
const { readLastActiveThread } = require("./session-state");
const DEFAULT_WATCH_INTERVAL_MS = 1_000;
const DEFAULT_LOOKUP_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_TIMEOUT_MS = 10_000;
const DEFAULT_TRANSIENT_ERROR_RETRY_LIMIT = 2;
const DEFAULT_CONTEXT_READ_SCAN_BYTES = 512 * 1024;
const DEFAULT_RECENT_ROLLOUT_CANDIDATE_LIMIT = 24;
// Polls one rollout file until it materializes and then reports size growth.
function createThreadRolloutActivityWatcher({ threadId, intervalMs = DEFAULT_WATCH_INTERVAL_MS, lookupTimeoutMs = DEFAULT_LOOKUP_TIMEOUT_MS, idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS, now = () => Date.now(), fsModule = fs, transientErrorRetryLimit = DEFAULT_TRANSIENT_ERROR_RETRY_LIMIT, onEvent = () => { }, onIdle = () => { }, onTimeout = () => { }, onError = () => { }, } = {}) {
    const resolvedThreadId = resolveThreadId(threadId);
    const sessionsRoot = resolveSessionsRoot();
    const startedAt = now();
    let isStopped = false;
    let rolloutPath = null;
    let lastSize = null;
    let lastGrowthAt = startedAt;
    let transientErrorCount = 0;
    const tick = () => {
        if (isStopped) {
            return;
        }
        try {
            const currentTime = now();
            if (!rolloutPath) {
                if (currentTime - startedAt >= lookupTimeoutMs) {
                    onTimeout({ threadId: resolvedThreadId });
                    stop();
                    return;
                }
                rolloutPath = findRolloutFileForThread(sessionsRoot, resolvedThreadId, { fsModule });
                if (!rolloutPath) {
                    transientErrorCount = 0;
                    return;
                }
                lastSize = readFileSize(rolloutPath, fsModule);
                lastGrowthAt = currentTime;
                transientErrorCount = 0;
                onEvent({
                    reason: "materialized",
                    threadId: resolvedThreadId,
                    rolloutPath,
                    size: lastSize,
                });
                return;
            }
            const nextSize = readFileSize(rolloutPath, fsModule);
            transientErrorCount = 0;
            if (nextSize > lastSize) {
                lastSize = nextSize;
                lastGrowthAt = currentTime;
                onEvent({
                    reason: "growth",
                    threadId: resolvedThreadId,
                    rolloutPath,
                    size: nextSize,
                });
                return;
            }
            if (currentTime - lastGrowthAt >= idleTimeoutMs) {
                onIdle({
                    threadId: resolvedThreadId,
                    rolloutPath,
                    size: lastSize,
                });
                stop();
            }
        }
        catch (error) {
            if (isRetryableFilesystemError(error) && transientErrorCount < transientErrorRetryLimit) {
                transientErrorCount += 1;
                return;
            }
            onError(error);
            stop();
        }
    };
    const intervalId = setInterval(tick, intervalMs);
    tick();
    function stop() {
        if (isStopped) {
            return;
        }
        isStopped = true;
        clearInterval(intervalId);
    }
    return {
        stop,
        get threadId() {
            return resolvedThreadId;
        },
    };
}
function watchThreadRollout(threadId = "") {
    const resolvedThreadId = resolveThreadId(threadId);
    const sessionsRoot = resolveSessionsRoot();
    const rolloutPath = findRolloutFileForThread(sessionsRoot, resolvedThreadId);
    if (!rolloutPath) {
        throw new Error(`No rollout file found for thread ${resolvedThreadId}.`);
    }
    let offset = fs.statSync(rolloutPath).size;
    let partialLine = "";
    console.log(`[coderover] Watching thread ${resolvedThreadId}`);
    console.log(`[coderover] Rollout file: ${rolloutPath}`);
    console.log("[coderover] Waiting for new persisted events... (Ctrl+C to stop)");
    const onChange = (current, previous) => {
        if (current.size <= previous.size) {
            return;
        }
        const stream = fs.createReadStream(rolloutPath, {
            start: offset,
            end: current.size - 1,
            encoding: "utf8",
        });
        let chunkBuffer = "";
        stream.on("data", (chunk) => {
            chunkBuffer += chunk;
        });
        stream.on("end", () => {
            offset = current.size;
            const combined = partialLine + chunkBuffer;
            const lines = combined.split("\n");
            partialLine = lines.pop() || "";
            for (const line of lines) {
                const formatted = formatRolloutLine(line);
                if (formatted) {
                    console.log(formatted);
                }
            }
        });
    };
    fs.watchFile(rolloutPath, { interval: 700 }, onChange);
    const cleanup = () => {
        fs.unwatchFile(rolloutPath, onChange);
        process.exit(0);
    };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
}
function resolveThreadId(threadId) {
    if (threadId && typeof threadId === "string") {
        return threadId;
    }
    const last = readLastActiveThread();
    if (last?.threadId) {
        return last.threadId;
    }
    throw new Error("No thread id provided and no remembered CodeRover thread found.");
}
function resolveSessionsRoot() {
    const coderoverHome = process.env.CODEROVER_HOME || path.join(os.homedir(), ".coderover");
    return path.join(coderoverHome, "sessions");
}
function findRolloutFileForThread(root, threadId, { fsModule = fs } = {}) {
    if (!fsModule.existsSync(root)) {
        return null;
    }
    const stack = [root];
    while (stack.length > 0) {
        const current = stack.pop();
        const entries = fsModule.readdirSync(current, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(fullPath);
                continue;
            }
            if (!entry.isFile()) {
                continue;
            }
            if (entry.name.includes(threadId) && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
                return fullPath;
            }
        }
    }
    return null;
}
function readLatestContextWindowUsage({ threadId, turnId = "", root = resolveSessionsRoot(), fsModule = fs, scanBytes = DEFAULT_CONTEXT_READ_SCAN_BYTES, } = {}) {
    const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
    const normalizedTurnId = typeof turnId === "string" ? turnId.trim() : "";
    if (!normalizedThreadId && !normalizedTurnId) {
        return null;
    }
    const rolloutPath = findRolloutFileForThread(root, normalizedThreadId, { fsModule })
        || findRecentRolloutFileForContextRead(root, {
            threadId: normalizedThreadId,
            turnId: normalizedTurnId,
            fsModule,
        });
    if (!rolloutPath) {
        return null;
    }
    const stat = fsModule.statSync(rolloutPath);
    const start = Math.max(0, stat.size - Math.max(0, scanBytes));
    const chunk = fsModule.readFileSync(rolloutPath, { encoding: "utf8" }).slice(start);
    const lines = chunk.split("\n");
    if (start > 0 && lines.length > 0) {
        lines.shift();
    }
    let latestUsage = null;
    for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed) {
            continue;
        }
        let parsed = null;
        try {
            parsed = JSON.parse(trimmed);
        }
        catch {
            continue;
        }
        const usage = extractContextWindowUsage(parsed);
        if (usage) {
            latestUsage = usage;
        }
    }
    if (!latestUsage) {
        return null;
    }
    return {
        rolloutPath,
        usage: latestUsage,
    };
}
function findRecentRolloutFileForContextRead(root, { threadId = "", turnId = "", fsModule = fs, candidateLimit = DEFAULT_RECENT_ROLLOUT_CANDIDATE_LIMIT, scanBytes = 16 * 1024, } = {}) {
    const candidates = collectRecentRolloutFiles(root, { fsModule, candidateLimit });
    if (candidates.length === 0) {
        return null;
    }
    if (turnId) {
        for (const candidate of candidates) {
            if (rolloutFileContainsToken(candidate.filePath, turnId, { fsModule, scanBytes })) {
                return candidate.filePath;
            }
        }
    }
    if (threadId) {
        for (const candidate of candidates) {
            if (rolloutFileContainsToken(candidate.filePath, threadId, { fsModule, scanBytes })) {
                return candidate.filePath;
            }
        }
    }
    return null;
}
function collectRecentRolloutFiles(root, { fsModule = fs, candidateLimit = DEFAULT_RECENT_ROLLOUT_CANDIDATE_LIMIT, } = {}) {
    if (!root || !fsModule.existsSync(root)) {
        return [];
    }
    const stack = [root];
    const files = [];
    while (stack.length > 0) {
        const current = stack.pop();
        const entries = fsModule.readdirSync(current, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(fullPath);
                continue;
            }
            if (!entry.isFile()) {
                continue;
            }
            if (!entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) {
                continue;
            }
            let modifiedAtMs = 0;
            try {
                modifiedAtMs = fsModule.statSync(fullPath).mtimeMs || 0;
            }
            catch {
                modifiedAtMs = 0;
            }
            files.push({
                filePath: fullPath,
                modifiedAtMs,
            });
        }
    }
    return files
        .sort((lhs, rhs) => rhs.modifiedAtMs - lhs.modifiedAtMs)
        .slice(0, candidateLimit);
}
function rolloutFileContainsToken(filePath, token, { fsModule = fs, scanBytes = 16 * 1024, } = {}) {
    const normalizedToken = typeof token === "string" ? token.trim() : "";
    if (!filePath || !normalizedToken) {
        return false;
    }
    const stat = fsModule.statSync(filePath);
    const start = Math.max(0, stat.size - Math.max(0, scanBytes));
    const chunk = fsModule.readFileSync(filePath, { encoding: "utf8" }).slice(start);
    return chunk.includes(normalizedToken);
}
function extractContextWindowUsage(root) {
    const usage = normalizeContextWindowUsage(root);
    if (usage) {
        return usage;
    }
    if (!root || typeof root !== "object") {
        return null;
    }
    if (Array.isArray(root)) {
        let latest = null;
        for (const value of root) {
            const nested = extractContextWindowUsage(value);
            if (nested) {
                latest = nested;
            }
        }
        return latest;
    }
    let latest = null;
    for (const value of Object.values(root)) {
        const nested = extractContextWindowUsage(value);
        if (nested) {
            latest = nested;
        }
    }
    return latest;
}
function normalizeContextWindowUsage(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    const tokensUsed = firstFiniteNumber(value, [
        "tokensUsed",
        "tokens_used",
        "totalTokens",
        "total_tokens",
        "input_tokens",
    ]);
    const tokenLimit = firstFiniteNumber(value, [
        "tokenLimit",
        "token_limit",
        "maxTokens",
        "max_tokens",
        "contextWindow",
        "context_window",
    ]);
    if (!Number.isFinite(tokensUsed) || !Number.isFinite(tokenLimit) || tokenLimit <= 0) {
        return null;
    }
    return {
        tokensUsed: Math.max(0, Math.round(tokensUsed)),
        tokenLimit: Math.max(0, Math.round(tokenLimit)),
    };
}
function firstFiniteNumber(object, keys) {
    for (const key of keys) {
        const value = object[key];
        if (typeof value === "number" && Number.isFinite(value)) {
            return value;
        }
        if (typeof value === "string") {
            const parsed = Number(value.trim());
            if (Number.isFinite(parsed)) {
                return parsed;
            }
        }
    }
    return null;
}
function formatRolloutLine(rawLine) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
        return null;
    }
    let parsed = null;
    try {
        parsed = JSON.parse(trimmed);
    }
    catch {
        return null;
    }
    const timestamp = formatTimestamp(parsed.timestamp);
    const payload = parsed.payload || {};
    if (parsed.type === "event_msg") {
        const eventType = payload.type;
        if (eventType === "user_message") {
            return `${timestamp} Phone: ${previewText(payload.message)}`;
        }
        if (eventType === "agent_message") {
            return `${timestamp} CodeRover: ${previewText(payload.message)}`;
        }
        if (eventType === "task_started") {
            return `${timestamp} Task started`;
        }
        if (eventType === "task_complete") {
            return `${timestamp} Task complete`;
        }
    }
    return null;
}
function formatTimestamp(value) {
    if (!value || typeof value !== "string") {
        return "[time?]";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return "[time?]";
    }
    return `[${date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}]`;
}
function previewText(value) {
    if (typeof value !== "string") {
        return "";
    }
    const normalized = value.replace(/\s+/g, " ").trim();
    if (normalized.length <= 120) {
        return normalized;
    }
    return `${normalized.slice(0, 117)}...`;
}
function readFileSize(filePath, fsModule = fs) {
    return fsModule.statSync(filePath).size;
}
function isRetryableFilesystemError(error) {
    return ["ENOENT", "EACCES", "EPERM", "EBUSY"].includes(error?.code);
}
module.exports = {
    watchThreadRollout,
    createThreadRolloutActivityWatcher,
    readLatestContextWindowUsage,
    resolveSessionsRoot,
    findRolloutFileForThread,
};
