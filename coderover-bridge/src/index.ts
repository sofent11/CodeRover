// FILE: index.ts
// Purpose: Small entrypoint wrapper for the bridge runtime.

const bridgeModule = require("./bridge") as { startBridge: () => void };
const sessionStateModule = require("./session-state") as {
  openLastActiveThread: (...args: unknown[]) => unknown;
};
const rolloutWatchModule = require("./rollout-watch") as {
  watchThreadRollout: (...args: unknown[]) => void;
};

export const startBridge = bridgeModule.startBridge;
export const openLastActiveThread = sessionStateModule.openLastActiveThread;
export const watchThreadRollout = rolloutWatchModule.watchThreadRollout;
