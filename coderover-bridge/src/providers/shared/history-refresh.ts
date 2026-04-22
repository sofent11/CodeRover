// FILE: providers/shared/history-refresh.ts
// Purpose: Shares provider history refresh heuristics across adapters.

import { normalizeOptionalString, type ProviderRecord } from "./provider-utils";

export function normalizeMetadataTimestamp(
  metadata: ProviderRecord | null | undefined,
  key: string
): string | null {
  if (!metadata || typeof metadata[key] !== "string") {
    return null;
  }

  return normalizeOptionalString(metadata[key]);
}

export function shouldRefreshHistoryByTimestamp(
  existingTurns: unknown[] | null | undefined,
  historySyncedAt: string | null,
  sourceUpdatedAt: string | null
): boolean {
  if (!existingTurns?.length) {
    return true;
  }
  if (!sourceUpdatedAt) {
    return false;
  }
  if (!historySyncedAt) {
    return true;
  }
  return Date.parse(historySyncedAt) < Date.parse(sourceUpdatedAt);
}

export function shouldRefreshHistoryByAge(
  existingTurns: unknown[] | null | undefined,
  historySyncedAt: string | null,
  maxAgeMs: number,
  now = Date.now()
): boolean {
  if (!existingTurns?.length) {
    return true;
  }
  if (!historySyncedAt) {
    return true;
  }
  return now - Date.parse(historySyncedAt) > maxAgeMs;
}
