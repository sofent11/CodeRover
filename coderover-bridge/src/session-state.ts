// FILE: session-state.ts
// Purpose: Persists the latest active CodeRover session so the user can reopen it on the Mac for handoff.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

export interface LastActiveSessionState {
  sessionId: string;
  source: string;
  updatedAt: string;
}

export interface OpenLastActiveSessionOptions {
  bundleId?: string;
}

const STATE_DIR = path.join(os.homedir(), ".coderover");
const STATE_FILE = path.join(STATE_DIR, "last-session.json");
const LEGACY_STATE_FILE = path.join(STATE_DIR, "last-thread.json");
const DEFAULT_BUNDLE_ID = "com.sofent.CodeRover";

export function rememberActiveSession(sessionId: unknown, source: unknown): boolean {
  if (!sessionId || typeof sessionId !== "string") {
    return false;
  }

  const payload: LastActiveSessionState = {
    sessionId,
    source: typeof source === "string" && source ? source : "unknown",
    updatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2));
  return true;
}

export function openLastActiveSession(
  { bundleId = DEFAULT_BUNDLE_ID }: OpenLastActiveSessionOptions = {}
): LastActiveSessionState {
  const state = readState();
  const sessionId = state?.sessionId;
  if (!sessionId) {
    throw new Error("No remembered CodeRover session found yet.");
  }

  const targetUrl = `coderover://threads/${sessionId}`;
  execFileSync("open", ["-b", bundleId, targetUrl], { stdio: "ignore" });
  return state;
}

function readState(): LastActiveSessionState | null {
  const statePath = fs.existsSync(STATE_FILE)
    ? STATE_FILE
    : (fs.existsSync(LEGACY_STATE_FILE) ? LEGACY_STATE_FILE : null);
  if (!statePath) {
    return null;
  }

  const raw = fs.readFileSync(statePath, "utf8");
  const parsed = JSON.parse(raw) as {
    sessionId?: unknown;
    threadId?: unknown;
    source?: unknown;
    updatedAt?: unknown;
  };
  const sessionId = typeof parsed.sessionId === "string" && parsed.sessionId
    ? parsed.sessionId
    : (typeof parsed.threadId === "string" && parsed.threadId ? parsed.threadId : null);
  if (!sessionId) {
    return null;
  }
  return {
    sessionId,
    source: typeof parsed.source === "string" && parsed.source ? parsed.source : "unknown",
    updatedAt: typeof parsed.updatedAt === "string" && parsed.updatedAt ? parsed.updatedAt : new Date().toISOString(),
  };
}

export const readLastActiveSession = readState;
