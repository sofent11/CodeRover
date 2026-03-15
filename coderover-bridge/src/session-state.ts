// FILE: session-state.ts
// Purpose: Persists the latest active CodeRover thread so the user can reopen it on the Mac for handoff.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

export interface LastActiveThreadState {
  threadId: string;
  source: string;
  updatedAt: string;
}

export interface OpenLastActiveThreadOptions {
  bundleId?: string;
}

const STATE_DIR = path.join(os.homedir(), ".coderover");
const STATE_FILE = path.join(STATE_DIR, "last-thread.json");
const DEFAULT_BUNDLE_ID = "com.sofent.CodeRover";

export function rememberActiveThread(threadId: unknown, source: unknown): boolean {
  if (!threadId || typeof threadId !== "string") {
    return false;
  }

  const payload: LastActiveThreadState = {
    threadId,
    source: typeof source === "string" && source ? source : "unknown",
    updatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2));
  return true;
}

export function openLastActiveThread(
  { bundleId = DEFAULT_BUNDLE_ID }: OpenLastActiveThreadOptions = {}
): LastActiveThreadState {
  const state = readState();
  const threadId = state?.threadId;
  if (!threadId) {
    throw new Error("No remembered CodeRover thread found yet.");
  }

  const targetUrl = `coderover://threads/${threadId}`;
  execFileSync("open", ["-b", bundleId, targetUrl], { stdio: "ignore" });
  return state;
}

function readState(): LastActiveThreadState | null {
  if (!fs.existsSync(STATE_FILE)) {
    return null;
  }

  const raw = fs.readFileSync(STATE_FILE, "utf8");
  return JSON.parse(raw) as LastActiveThreadState;
}

export const readLastActiveThread = readState;
