#!/usr/bin/env bun
// FILE: coderover.js
// Purpose: CLI surface for starting the local CodeRover bridge, reopening the latest active session, and tailing its rollout file.
// Layer: CLI binary
// Exports: none
// Depends on: ../dist

const { startBridge, openLastActiveSession, watchSessionRollout } = require("../dist");

const command = process.argv[2] || "up";

if (command === "up") {
  startBridge();
  return;
}

if (command === "resume") {
  try {
    const state = openLastActiveSession();
    console.log(
      `[coderover] Opened last active session: ${state.sessionId} (${state.source || "unknown"})`
    );
  } catch (error) {
    console.error(`[coderover] ${(error && error.message) || "Failed to reopen the last session."}`);
    process.exit(1);
  }
  return;
}

if (command === "watch") {
  try {
    watchSessionRollout(process.argv[3] || "");
  } catch (error) {
    console.error(`[coderover] ${(error && error.message) || "Failed to watch the session rollout."}`);
    process.exit(1);
  }
  return;
}

console.error(`Unknown command: ${command}`);
console.error("Usage: coderover up | coderover resume | coderover watch [sessionId]");
process.exit(1);
