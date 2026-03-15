// FILE: runtime-manager/codex-observer.ts
// Purpose: Typed watcher helpers for observed Codex-thread eviction.

export interface ObservedCodexThreadWatcher {
  threadId: string;
  lastObservedAt: number;
}

export function sortObservedThreadEvictionCandidates(
  watchers: Map<string, ObservedCodexThreadWatcher>,
  preserveThreadId: string | null = null
): ObservedCodexThreadWatcher[] {
  return [...watchers.values()]
    .filter((entry) => entry.threadId !== preserveThreadId)
    .sort((left, right) => left.lastObservedAt - right.lastObservedAt);
}
