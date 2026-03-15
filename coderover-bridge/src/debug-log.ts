// FILE: debug-log.ts
// Purpose: Central debug logging helpers gated by the bridge debug env var.

export function isDebugLoggingEnabled(): boolean {
  const value = String(process.env.CODEROVER_DEBUG_LOGS || "")
    .trim()
    .toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function debugLog(message: string): void {
  if (!isDebugLoggingEnabled()) {
    return;
  }
  console.log(message);
}

export function debugError(message: string): void {
  if (!isDebugLoggingEnabled()) {
    return;
  }
  console.error(message);
}
