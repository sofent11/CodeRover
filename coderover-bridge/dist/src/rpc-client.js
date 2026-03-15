"use strict";
// FILE: rpc-client.ts
// Purpose: Typed JSON-RPC helper around a line-oriented transport such as Codex app-server.
Object.defineProperty(exports, "__esModule", { value: true });
exports.createJsonRpcClient = createJsonRpcClient;
exports.buildRpcSuccess = buildRpcSuccess;
exports.buildRpcError = buildRpcError;
const crypto_1 = require("crypto");
function isObjectRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isJsonRpcEnvelope(value) {
    return isObjectRecord(value);
}
function createJsonRpcClient({ sendRawMessage, responseTimeoutMs = 30_000, onUnhandledMessage = null, }) {
    if (typeof sendRawMessage !== "function") {
        throw new Error("createJsonRpcClient requires sendRawMessage");
    }
    const pendingRequests = new Map();
    const rawListeners = new Set();
    function request(method, params) {
        const id = (0, crypto_1.randomUUID)();
        const payload = {
            jsonrpc: "2.0",
            id,
            method,
            ...(params === undefined ? {} : { params }),
        };
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                pendingRequests.delete(id);
                reject(new Error(`RPC request timed out for method ${method}`));
            }, responseTimeoutMs);
            timeout.unref?.();
            pendingRequests.set(id, {
                method,
                resolve: (value) => resolve(value),
                reject,
                timeout,
            });
            sendRawMessage(JSON.stringify(payload));
        });
    }
    function notify(method, params) {
        const payload = {
            jsonrpc: "2.0",
            method,
            ...(params === undefined ? {} : { params }),
        };
        sendRawMessage(JSON.stringify(payload));
    }
    function sendRaw(rawMessage) {
        sendRawMessage(rawMessage);
    }
    function handleIncomingRaw(rawMessage) {
        for (const listener of rawListeners) {
            listener(rawMessage);
        }
        let parsed = null;
        try {
            parsed = JSON.parse(rawMessage);
        }
        catch {
            onUnhandledMessage?.(rawMessage, null);
            return;
        }
        if (!isJsonRpcEnvelope(parsed)) {
            onUnhandledMessage?.(rawMessage, null);
            return;
        }
        if ("id" in parsed && parsed.id != null && ("result" in parsed || "error" in parsed)) {
            const pending = pendingRequests.get(String(parsed.id));
            if (!pending) {
                onUnhandledMessage?.(rawMessage, parsed);
                return;
            }
            pendingRequests.delete(String(parsed.id));
            clearTimeout(pending.timeout);
            if ("error" in parsed && parsed.error) {
                const rpcError = parsed.error;
                const error = new Error(rpcError.message || `RPC ${pending.method} failed`);
                error.code = rpcError.code;
                error.data = rpcError.data;
                pending.reject(error);
                return;
            }
            pending.resolve(("result" in parsed ? parsed.result : undefined));
            return;
        }
        onUnhandledMessage?.(rawMessage, parsed);
    }
    function close(error = new Error("RPC transport closed")) {
        for (const pending of pendingRequests.values()) {
            clearTimeout(pending.timeout);
            pending.reject(error);
        }
        pendingRequests.clear();
    }
    function onRawMessage(listener) {
        rawListeners.add(listener);
        return () => rawListeners.delete(listener);
    }
    return {
        close,
        handleIncomingRaw,
        notify,
        onRawMessage,
        request,
        sendRaw,
    };
}
function buildRpcSuccess(id, result) {
    return JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: result === undefined ? {} : result,
    });
}
function buildRpcError(id, code, message, data) {
    return JSON.stringify({
        jsonrpc: "2.0",
        id: id === undefined ? null : id,
        error: {
            code,
            message,
            ...(data === undefined ? {} : { data }),
        },
    });
}
