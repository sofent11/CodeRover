"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// FILE: runtime-manager/types.ts
// Purpose: Shared constants and boundary typedefs for the runtime-manager module tree.
const ERROR_METHOD_NOT_FOUND = -32601;
const ERROR_INVALID_PARAMS = -32602;
const ERROR_INTERNAL = -32603;
const ERROR_THREAD_NOT_FOUND = -32004;
const EXTERNAL_SYNC_INTERVAL_MS = 10_000;
const DEFAULT_HISTORY_WINDOW_LIMIT = 50;
const DEFAULT_THREAD_LIST_PAGE_SIZE = 60;
const CODEX_HISTORY_CACHE_THREAD_LIMIT = 20;
const CODEX_HISTORY_CACHE_MESSAGE_LIMIT = 50;
const HISTORY_CURSOR_VERSION = 1;
const CODEX_OBSERVED_THREAD_POLL_INTERVAL_MS = 2_000;
const CODEX_OBSERVED_THREAD_IDLE_TTL_MS = 10 * 60 * 1000;
const CODEX_OBSERVED_THREAD_ERROR_BACKOFF_MS = 5_000;
const CODEX_OBSERVED_THREAD_LIMIT = 3;
/**
 * @typedef {{
 *   jsonrpc?: string;
 *   id?: string | number | null;
 *   method?: string | null;
 *   params?: Record<string, unknown> | null;
 *   result?: unknown;
 *   error?: { code?: number; message?: string; data?: unknown } | null;
 * }} RuntimeRpcEnvelope
 */
/**
 * @typedef {{
 *   mode: "tail" | "before" | "after";
 *   limit: number;
 *   cursor?: RuntimeHistoryCursor | null;
 * }} RuntimeHistoryRequest
 */
/**
 * @typedef {{
 *   threadId: string;
 *   createdAt: string;
 *   itemId?: string | null;
 *   turnId?: string | null;
 *   ordinal?: number | null;
 * }} RuntimeHistoryCursor
 */
module.exports = {
    CODEX_HISTORY_CACHE_MESSAGE_LIMIT,
    CODEX_HISTORY_CACHE_THREAD_LIMIT,
    CODEX_OBSERVED_THREAD_ERROR_BACKOFF_MS,
    CODEX_OBSERVED_THREAD_IDLE_TTL_MS,
    CODEX_OBSERVED_THREAD_LIMIT,
    CODEX_OBSERVED_THREAD_POLL_INTERVAL_MS,
    DEFAULT_HISTORY_WINDOW_LIMIT,
    DEFAULT_THREAD_LIST_PAGE_SIZE,
    ERROR_INTERNAL,
    ERROR_INVALID_PARAMS,
    ERROR_METHOD_NOT_FOUND,
    ERROR_THREAD_NOT_FOUND,
    EXTERNAL_SYNC_INTERVAL_MS,
    HISTORY_CURSOR_VERSION,
};
