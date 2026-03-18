#!/usr/bin/env bun
// FILE: coderover.js
// Purpose: CLI surface for foreground/daemon bridge control, latest-thread reopen, and rollout watching.
// Layer: CLI binary
// Exports: none
// Depends on: ../dist

const {
  startBridge,
  startBridgeDaemon,
  readBridgeStatus,
  printBridgeStatus,
  stopBridgeDaemon,
  openLastActiveThread,
  watchThreadRollout,
} = require("../dist");

const command = process.argv[2] || "up";

void run().catch((error) => {
  console.error(`[coderover] ${(error && error.message) || "Command failed."}`);
  process.exit(1);
});

async function run() {
  if (command === "up") {
    startBridge({ mode: "foreground", printQr: true });
    return;
  }

  if (command === "serve") {
    const isDaemonized = process.argv.includes("--daemonized");
    startBridge({ mode: isDaemonized ? "daemon" : "foreground", printQr: !isDaemonized });
    return;
  }

  if (command === "daemon") {
    const result = await startBridgeDaemon(__filename);
    console.log(`[coderover] Bridge daemon started (pid ${result.pid})`);
    console.log(`[coderover] Log: ${result.logFile}`);
    console.log(`[coderover] Error log: ${result.errorLogFile}`);
    console.log("[coderover] Run `coderover status` to print the current QR and transport info.");
    return;
  }

  if (command === "status") {
    const state = await readBridgeStatus({ refreshPairing: true });
    printBridgeStatus(state);
    if (!state || state.status !== "running") {
      process.exitCode = 1;
    }
    return;
  }

  if (command === "stop") {
    const stopped = await stopBridgeDaemon();
    if (!stopped) {
      console.error("[coderover] No running bridge daemon found.");
      process.exit(1);
      return;
    }
    console.log("[coderover] Bridge daemon stopped.");
    return;
  }

  if (command === "resume") {
    const state = openLastActiveThread();
    console.log(
      `[coderover] Opened last active thread: ${state.threadId} (${state.source || "unknown"})`
    );
    return;
  }

  if (command === "watch") {
    watchThreadRollout(process.argv[3] || "");
    return;
  }

  console.error(`Unknown command: ${command}`);
  console.error("Usage: coderover up | coderover daemon | coderover status | coderover stop | coderover resume | coderover watch [threadId]");
  process.exit(1);
}
