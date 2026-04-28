// FILE: runtime-manager/turn-interrupt-resolution.ts
// Purpose: Pure helpers for resolving turn/interrupt requests across runtime session metadata.

import type { RuntimeThreadShape } from "../bridge-types";
import type { ThreadSessionIndex } from "../runtime-engine/thread-session-index";

export function findThreadIdBySessionActiveTurn(
  threadSessionIndex: ThreadSessionIndex,
  turnId: unknown
): string | null {
  const normalizedTurnId = normalizeOptionalString(turnId);
  if (!normalizedTurnId) {
    return null;
  }
  for (const session of threadSessionIndex.list()) {
    if (session.activeTurnId === normalizedTurnId) {
      return session.threadId;
    }
  }
  return null;
}

export function listLikelyRunningCodexSessionThreadIds(
  threadSessionIndex: ThreadSessionIndex
): string[] {
  return threadSessionIndex.list()
    .filter((session) =>
      session.provider === "codex"
      && (session.ownerState === "running" || session.ownerState === "waiting_for_client")
    )
    .map((session) => session.threadId)
    .filter(Boolean);
}

export function threadContainsTurnId(threadObject: RuntimeThreadShape, turnId: unknown): boolean {
  const normalizedTurnId = normalizeOptionalString(turnId);
  return Boolean(normalizedTurnId)
    && Array.isArray(threadObject.turns)
    && threadObject.turns.some((turn) =>
      normalizeOptionalString(turn?.id || turn?.turnId || turn?.turn_id) === normalizedTurnId
    );
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
