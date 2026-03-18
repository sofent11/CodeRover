// FILE: index.ts
// Purpose: Small entrypoint wrapper for the bridge runtime.

export { startBridge } from "./bridge";
export { startBridgeDaemon, readBridgeStatus, printBridgeStatus, stopBridgeDaemon } from "./bridge-daemon";
export { openLastActiveThread } from "./session-state";
export { watchThreadRollout } from "./rollout-watch";
