// FILE: bridge-logger.ts
// Purpose: Emits lightweight structured bridge logs without introducing external logging dependencies.

import { debugLog } from "./debug-log";

type JsonRecord = Record<string, unknown>;
type BridgeLogLevel = "debug" | "info" | "warn" | "error";

export interface NormalizedBridgeError {
  message: string;
  name: string;
  code: string | null;
}

export function logBridgeEvent(
  level: BridgeLogLevel,
  event: string,
  fields: JsonRecord = {}
): void {
  const payload = JSON.stringify({
    ts: new Date().toISOString(),
    scope: "bridge",
    level,
    event,
    ...fields,
  });

  if (level === "debug") {
    debugLog(payload);
    return;
  }

  if (level === "error") {
    console.error(payload);
    return;
  }

  if (level === "warn") {
    console.warn(payload);
    return;
  }

  console.log(payload);
}

export function normalizeBridgeError(error: unknown): NormalizedBridgeError {
  const record = asRecord(error);
  const message = normalizeOptionalString(record?.message)
    || (error instanceof Error ? error.message : null)
    || "Unknown bridge error";
  const name = normalizeOptionalString(record?.name)
    || (error instanceof Error ? error.name : null)
    || "Error";
  const code = normalizeOptionalString(record?.errorCode)
    || normalizeOptionalString(record?.code);

  return {
    message,
    name,
    code,
  };
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
