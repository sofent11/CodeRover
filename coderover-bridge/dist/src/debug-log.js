"use strict";
// FILE: debug-log.ts
// Purpose: Central debug logging helpers gated by the bridge debug env var.
Object.defineProperty(exports, "__esModule", { value: true });
exports.isDebugLoggingEnabled = isDebugLoggingEnabled;
exports.debugLog = debugLog;
exports.debugError = debugError;
function isDebugLoggingEnabled() {
    const value = String(process.env.CODEROVER_DEBUG_LOGS || "")
        .trim()
        .toLowerCase();
    return value === "1" || value === "true" || value === "yes" || value === "on";
}
function debugLog(message) {
    if (!isDebugLoggingEnabled()) {
        return;
    }
    console.log(message);
}
function debugError(message) {
    if (!isDebugLoggingEnabled()) {
        return;
    }
    console.error(message);
}
