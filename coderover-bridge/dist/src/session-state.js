"use strict";
// FILE: session-state.ts
// Purpose: Persists the latest active CodeRover thread so the user can reopen it on the Mac for handoff.
Object.defineProperty(exports, "__esModule", { value: true });
exports.readLastActiveThread = void 0;
exports.rememberActiveThread = rememberActiveThread;
exports.openLastActiveThread = openLastActiveThread;
const fs = require("fs");
const os = require("os");
const path = require("path");
const child_process_1 = require("child_process");
const STATE_DIR = path.join(os.homedir(), ".coderover");
const STATE_FILE = path.join(STATE_DIR, "last-thread.json");
const DEFAULT_BUNDLE_ID = "com.sofent.CodeRover";
function rememberActiveThread(threadId, source) {
    if (!threadId || typeof threadId !== "string") {
        return false;
    }
    const payload = {
        threadId,
        source: typeof source === "string" && source ? source : "unknown",
        updatedAt: new Date().toISOString(),
    };
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2));
    return true;
}
function openLastActiveThread({ bundleId = DEFAULT_BUNDLE_ID } = {}) {
    const state = readState();
    const threadId = state?.threadId;
    if (!threadId) {
        throw new Error("No remembered CodeRover thread found yet.");
    }
    const targetUrl = `coderover://threads/${threadId}`;
    (0, child_process_1.execFileSync)("open", ["-b", bundleId, targetUrl], { stdio: "ignore" });
    return state;
}
function readState() {
    if (!fs.existsSync(STATE_FILE)) {
        return null;
    }
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    return JSON.parse(raw);
}
exports.readLastActiveThread = readState;
