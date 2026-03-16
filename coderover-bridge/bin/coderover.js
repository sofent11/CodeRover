#!/usr/bin/env bun
// FILE: coderover.js
// Purpose: CLI surface for starting the local CodeRover bridge, reopening the latest active thread, and tailing its rollout file.
// Layer: CLI binary
// Exports: none
// Depends on: ../dist

const { startBridge, openLastActiveThread, watchThreadRollout } = require("../dist");

const command = process.argv[2] || "up";

if (command === "up") {
  startBridge();
  return;
}

if (command === "resume") {
  try {
    const state = openLastActiveThread();
    console.log(
      `[coderover] Opened last active thread: ${state.threadId} (${state.source || "unknown"})`
    );
  } catch (error) {
    console.error(`[coderover] ${(error && error.message) || "Failed to reopen the last thread."}`);
    process.exit(1);
  }
  return;
}

if (command === "watch") {
  try {
    watchThreadRollout(process.argv[3] || "");
  } catch (error) {
    console.error(`[coderover] ${(error && error.message) || "Failed to watch the thread rollout."}`);
    process.exit(1);
  }
  return;
}

console.error(`Unknown command: ${command}`);
console.error("Usage: coderover up | coderover resume | coderover watch [threadId]");
process.exit(1);
