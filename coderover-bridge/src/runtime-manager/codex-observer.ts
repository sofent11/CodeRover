// @ts-nocheck
export {};

// FILE: runtime-manager/codex-observer.ts
// Purpose: Shared watcher helpers for runtime-manager observed Codex threads.

function sortObservedThreadEvictionCandidates(watchers, preserveThreadId = null) {
  return [...watchers.values()]
    .filter((entry) => entry.threadId !== preserveThreadId)
    .sort((left, right) => left.lastObservedAt - right.lastObservedAt);
}

module.exports = {
  sortObservedThreadEvictionCandidates,
};
