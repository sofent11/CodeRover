// FILE: bridge-keep-awake.ts
// Purpose: Keeps the local Mac awake while the bridge is running when the user enables the preference.

import { spawn, type ChildProcess } from "child_process";

interface BridgeKeepAwakeControllerOptions {
  enabled?: boolean;
  logPrefix?: string;
}

export class BridgeKeepAwakeController {
  private child: ChildProcess | null = null;
  private enabled: boolean;
  private logPrefix: string;
  private shuttingDown = false;

  constructor({
    enabled = true,
    logPrefix = "[coderover]",
  }: BridgeKeepAwakeControllerOptions = {}) {
    this.enabled = enabled;
    this.logPrefix = logPrefix;
    if (this.enabled) {
      this.start();
    }
  }

  get isActive(): boolean {
    return Boolean(this.child) && this.child?.killed !== true;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) {
      return;
    }

    this.enabled = enabled;
    if (enabled) {
      this.start();
    } else {
      this.stop();
    }
  }

  shutdown(): void {
    this.shuttingDown = true;
    this.enabled = false;
    this.stop();
  }

  private start(): void {
    if (!this.enabled || this.child || process.platform !== "darwin") {
      return;
    }

    const child = spawn("caffeinate", ["-dimsu", "-w", String(process.pid)], {
      stdio: "ignore",
    });
    this.child = child;

    child.on("error", (error) => {
      console.error(`${this.logPrefix} keep-awake unavailable: ${error.message}`);
      this.child = null;
    });

    child.on("exit", () => {
      this.child = null;
      if (this.enabled && !this.shuttingDown) {
        this.start();
      }
    });
  }

  private stop(): void {
    const child = this.child;
    this.child = null;
    if (!child || child.killed) {
      return;
    }
    child.kill("SIGTERM");
  }
}
