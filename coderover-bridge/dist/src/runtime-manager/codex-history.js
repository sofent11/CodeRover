"use strict";
// FILE: runtime-manager/codex-history.ts
// Purpose: Typed history-window and cursor helpers for Codex-backed thread reads.
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractThreadArray = extractThreadArray;
exports.extractThreadFromResult = extractThreadFromResult;
exports.extractHistoryWindowFromResult = extractHistoryWindowFromResult;
exports.buildUpstreamCodexHistoryParams = buildUpstreamCodexHistoryParams;
exports.buildUpstreamHistoryWindowResponse = buildUpstreamHistoryWindowResponse;
exports.extractArray = extractArray;
exports.readPath = readPath;
exports.mergeThreadLists = mergeThreadLists;
exports.extractThreadListCursor = extractThreadListCursor;
function extractThreadArray(result, extractArray) {
    return extractArray(result, ["data", "items", "threads"]);
}
function extractThreadFromResult(result) {
    if (!result || typeof result !== "object") {
        return null;
    }
    const thread = result.thread;
    return thread && typeof thread === "object" ? thread : null;
}
function extractHistoryWindowFromResult(result) {
    if (!result || typeof result !== "object") {
        return null;
    }
    const windowObject = result.historyWindow
        ?? result.history_window;
    return windowObject && typeof windowObject === "object" && !Array.isArray(windowObject)
        ? windowObject
        : null;
}
function buildUpstreamCodexHistoryParams(params, historyRequest, stripProviderField) {
    const upstreamParams = {
        ...stripProviderField(params || {}),
    };
    if (!historyRequest) {
        return upstreamParams;
    }
    upstreamParams.history = {
        mode: historyRequest.mode,
        limit: historyRequest.limit,
    };
    if (historyRequest.mode !== "tail" && historyRequest.cursor) {
        upstreamParams.history.anchor = historyRequest.cursor;
        delete upstreamParams.history.cursor;
    }
    return upstreamParams;
}
function buildUpstreamHistoryWindowResponse(snapshot, historyRequest, upstreamHistoryWindow, thread, dependencies) {
    const records = [...(snapshot?.records || [])].sort(dependencies.compareHistoryRecord);
    const oldestRecord = records.length > 0 ? records[0] : null;
    const newestRecord = records.length > 0 ? records[records.length - 1] : null;
    return {
        thread,
        historyWindow: {
            mode: historyRequest.mode,
            olderCursor: oldestRecord ? dependencies.historyCursorForRecord(snapshot.threadId, oldestRecord) : null,
            newerCursor: newestRecord ? dependencies.historyCursorForRecord(snapshot.threadId, newestRecord) : null,
            oldestAnchor: oldestRecord ? dependencies.historyRecordAnchor(oldestRecord) : null,
            newestAnchor: newestRecord ? dependencies.historyRecordAnchor(newestRecord) : null,
            hasOlder: Boolean(upstreamHistoryWindow?.hasOlder),
            hasNewer: Boolean(upstreamHistoryWindow?.hasNewer),
            isPartial: true,
            servedFromCache: false,
            pageSize: records.length,
        },
    };
}
function extractArray(value, candidatePaths, readPath) {
    if (!value) {
        return [];
    }
    for (const candidatePath of candidatePaths) {
        const candidateValue = readPath(value, candidatePath);
        if (Array.isArray(candidateValue)) {
            return candidateValue;
        }
    }
    return [];
}
function readPath(root, path) {
    const parts = path.split(".");
    let current = root;
    for (const part of parts) {
        if (!current || typeof current !== "object") {
            return null;
        }
        current = current[part];
    }
    return current;
}
function mergeThreadLists(threads) {
    const seen = new Map();
    for (const thread of threads) {
        if (!thread || typeof thread !== "object" || !thread.id) {
            continue;
        }
        const previous = seen.get(thread.id);
        if (!previous) {
            seen.set(thread.id, thread);
            continue;
        }
        const previousUpdated = Date.parse(previous.updatedAt || "0") || 0;
        const nextUpdated = Date.parse(thread.updatedAt || "0") || 0;
        if (nextUpdated >= previousUpdated) {
            seen.set(thread.id, thread);
        }
    }
    return [...seen.values()].sort((left, right) => {
        const leftUpdated = Date.parse(left.updatedAt || "0") || 0;
        const rightUpdated = Date.parse(right.updatedAt || "0") || 0;
        if (leftUpdated !== rightUpdated) {
            return rightUpdated - leftUpdated;
        }
        return String(left.id).localeCompare(String(right.id));
    });
}
function extractThreadListCursor(result, normalizeOptionalString) {
    const record = result && typeof result === "object" ? result : null;
    const cursor = record?.nextCursor ?? record?.next_cursor ?? null;
    if (cursor == null) {
        return null;
    }
    if (typeof cursor === "string") {
        const normalized = normalizeOptionalString(cursor);
        return normalized || null;
    }
    return typeof cursor === "number" ? cursor : null;
}
