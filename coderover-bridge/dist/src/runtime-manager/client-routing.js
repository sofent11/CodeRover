"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// FILE: runtime-manager/client-routing.ts
// Purpose: Shared helpers for runtime-manager request/response plumbing.
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
module.exports = {
    createMethodError,
    createRuntimeError,
    defaultInitializeParams,
    encodeRequestId,
};
