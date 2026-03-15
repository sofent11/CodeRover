"use strict";
// FILE: runtime-manager/client-routing.ts
// Purpose: Typed request/response plumbing helpers for runtime-manager.
Object.defineProperty(exports, "__esModule", { value: true });
exports.defaultInitializeParams = defaultInitializeParams;
exports.createRuntimeError = createRuntimeError;
exports.createMethodError = createMethodError;
exports.encodeRequestId = encodeRequestId;
function defaultInitializeParams() {
    return {
        clientInfo: {
            name: "coderover_bridge",
            title: "Codex Bridge",
            version: "1.0.0",
        },
        capabilities: {
            experimentalApi: true,
        },
    };
}
function createRuntimeError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}
function createMethodError(code, message) {
    return createRuntimeError(code, message);
}
function encodeRequestId(value) {
    if (value == null) {
        return "";
    }
    return JSON.stringify(value);
}
