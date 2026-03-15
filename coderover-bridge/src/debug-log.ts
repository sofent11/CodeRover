// @ts-nocheck
export {};

"use strict";

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

module.exports = {
  isDebugLoggingEnabled,
  debugLog,
  debugError,
};
