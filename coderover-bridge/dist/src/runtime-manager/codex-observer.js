"use strict";
// FILE: runtime-manager/codex-observer.ts
// Purpose: Typed watcher helpers for observed Codex-thread eviction.
Object.defineProperty(exports, "__esModule", { value: true });
exports.sortObservedThreadEvictionCandidates = sortObservedThreadEvictionCandidates;
function sortObservedThreadEvictionCandidates(watchers, preserveThreadId = null) {
    return [...watchers.values()]
        .filter((entry) => entry.threadId !== preserveThreadId)
        .sort((left, right) => left.lastObservedAt - right.lastObservedAt);
}
