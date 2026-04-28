// FILE: codex-transport.ts
// Purpose: Abstracts the Codex-side transport so the bridge can talk to either a spawned app-server or an existing WebSocket endpoint.

import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { WebSocket } from "ws";

type MessageHandler = (message: string) => void;
type CloseHandler = (...args: unknown[]) => void;
type ErrorHandler = (error: Error) => void;

const MAX_PENDING_WEBSOCKET_MESSAGES = 1000;

interface CodexTransport {
  mode: "spawn" | "websocket";
  describe(): string;
  send(message: string): void;
  onMessage(handler: MessageHandler): void;
  onClose(handler: CloseHandler): void;
  onError(handler: ErrorHandler): void;
  shutdown(): Promise<void>;
}

interface CodexLaunchPlan {
  command: string;
  args: string[];
  options: {
    stdio: ["pipe", "pipe", "pipe"];
    env: NodeJS.ProcessEnv;
    windowsHide?: boolean;
  };
  description: string;
}

interface ListenerBag {
  onMessage: MessageHandler | null;
  onClose: CloseHandler | null;
  onError: ErrorHandler | null;
  emitMessage(message: string): void;
  emitClose(...args: unknown[]): void;
  emitError(error: Error): void;
}

export function createCodexTransport(
  { endpoint = "", env = process.env }: { endpoint?: string; env?: NodeJS.ProcessEnv } = {}
): CodexTransport {
  if (endpoint) {
    return createWebSocketTransport({ endpoint });
  }

  return createSpawnTransport({ env });
}

function createSpawnTransport({ env }: { env: NodeJS.ProcessEnv }): CodexTransport {
  const launch = createCodexLaunchPlan({ env });
  const codex = spawn(launch.command, launch.args, launch.options);

  let stdoutBuffer = "";
  let stderrBuffer = "";
  let didRequestShutdown = false;
  let didReportError = false;
  let shutdownPromise: Promise<void> | null = null;
  const listeners = createListenerBag();

  codex.on("error", (error) => {
    didReportError = true;
    listeners.emitError(error);
  });
  codex.on("close", (code, signal) => {
    if (!didRequestShutdown && !didReportError && code !== 0) {
      didReportError = true;
      listeners.emitError(createCodexCloseError({
        code,
        signal,
        stderrBuffer,
        launchDescription: launch.description,
      }));
      return;
    }

    listeners.emitClose(code, signal);
  });

  codex.stderr.on("data", (chunk) => {
    stderrBuffer = appendOutputBuffer(stderrBuffer, chunk.toString("utf8"));
  });

  codex.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() || "";

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (trimmedLine) {
        listeners.emitMessage(trimmedLine);
      }
    }
  });

  return {
    mode: "spawn",
    describe() {
      return launch.description;
    },
    send(message: string) {
      if (!codex.stdin.writable) {
        return;
      }

      codex.stdin.write(message.endsWith("\n") ? message : `${message}\n`);
    },
    onMessage(handler: MessageHandler) {
      listeners.onMessage = handler;
    },
    onClose(handler: CloseHandler) {
      listeners.onClose = handler;
    },
    onError(handler: ErrorHandler) {
      listeners.onError = handler;
    },
    shutdown() {
      if (shutdownPromise) {
        return shutdownPromise;
      }
      didRequestShutdown = true;
      if (codex.killed || codex.exitCode !== null) {
        shutdownPromise = Promise.resolve();
        return shutdownPromise;
      }
      shutdownPromise = new Promise((resolve) => {
        const finish = () => resolve();
        codex.once("close", finish);
        codex.once("error", finish);
        shutdownCodexProcess(codex);
        const timer = setTimeout(() => {
          finish();
        }, 1_500);
        timer.unref?.();
        codex.once("close", () => clearTimeout(timer));
        codex.once("error", () => clearTimeout(timer));
      });
      return shutdownPromise;
    },
  };
}

function createCodexLaunchPlan({ env }: { env: NodeJS.ProcessEnv }): CodexLaunchPlan {
  const sharedOptions: CodexLaunchPlan["options"] = {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...env },
  };

  if (process.platform === "win32") {
    return {
      command: env.ComSpec || "cmd.exe",
      args: ["/d", "/c", "codex app-server"],
      options: {
        ...sharedOptions,
        windowsHide: true,
      },
      description: "`cmd.exe /d /c codex app-server`",
    };
  }

  return {
    command: "codex",
    args: ["app-server"],
    options: sharedOptions,
    description: "`codex app-server`",
  };
}

function shutdownCodexProcess(codex: ChildProcessWithoutNullStreams): void {
  if (codex.killed || codex.exitCode !== null) {
    return;
  }

  if (process.platform === "win32" && codex.pid) {
    const killer = spawn("taskkill", ["/pid", String(codex.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.on("error", () => {
      codex.kill();
    });
    return;
  }

  codex.kill("SIGTERM");
}

function createCodexCloseError({
  code,
  signal,
  stderrBuffer,
  launchDescription,
}: {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderrBuffer: string;
  launchDescription: string;
}): Error {
  const details = stderrBuffer.trim();
  const reason = details || `Process exited with code ${code}${signal ? ` (signal: ${signal})` : ""}.`;
  return new Error(`Codex launcher ${launchDescription} failed: ${reason}`);
}

function appendOutputBuffer(buffer: string, chunk: string): string {
  const next = `${buffer}${chunk}`;
  return next.slice(-4_096);
}

function createWebSocketTransport({ endpoint }: { endpoint: string }): CodexTransport {
  const socket = new WebSocket(endpoint);
  const listeners = createListenerBag();
  const pendingOutboundMessages: string[] = [];
  let didRequestShutdown = false;
  let shutdownPromise: Promise<void> | null = null;

  socket.on("open", () => {
    flushPendingOutboundMessages();
  });

  socket.on("message", (chunk) => {
    const message = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (message.trim()) {
      listeners.emitMessage(message);
    }
  });

  socket.on("close", (code, reason) => {
    const safeReason = reason ? reason.toString("utf8") : "no reason";
    if (!didRequestShutdown) {
      failPendingOutboundMessages(`closed before open (${code}: ${safeReason})`);
    } else {
      pendingOutboundMessages.length = 0;
    }
    listeners.emitClose(code, safeReason);
  });

  socket.on("error", (error) => {
    failPendingOutboundMessages(error.message || "connection error");
    listeners.emitError(error);
  });

  return {
    mode: "websocket",
    describe() {
      return endpoint;
    },
    send(message: string) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(message);
        return;
      }
      if (socket.readyState === WebSocket.CONNECTING) {
        if (pendingOutboundMessages.length >= MAX_PENDING_WEBSOCKET_MESSAGES) {
          const error = new Error("Codex WebSocket transport send queue is full before the socket opened");
          listeners.emitError(error);
          socket.close();
          return;
        }
        pendingOutboundMessages.push(message);
        return;
      }
      listeners.emitError(new Error("Codex WebSocket transport is not open"));
    },
    onMessage(handler: MessageHandler) {
      listeners.onMessage = handler;
    },
    onClose(handler: CloseHandler) {
      listeners.onClose = handler;
    },
    onError(handler: ErrorHandler) {
      listeners.onError = handler;
    },
    shutdown() {
      if (shutdownPromise) {
        return shutdownPromise;
      }
      if (socket.readyState === WebSocket.CLOSED) {
        pendingOutboundMessages.length = 0;
        shutdownPromise = Promise.resolve();
        return shutdownPromise;
      }
      shutdownPromise = new Promise((resolve) => {
        didRequestShutdown = true;
        pendingOutboundMessages.length = 0;
        const finish = () => resolve();
        socket.once("close", finish);
        socket.once("error", finish);
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close();
        } else {
          finish();
        }
        const timer = setTimeout(() => {
          finish();
        }, 1_500);
        timer.unref?.();
        socket.once("close", () => clearTimeout(timer));
        socket.once("error", () => clearTimeout(timer));
      });
      return shutdownPromise;
    },
  };

  function flushPendingOutboundMessages(): void {
    while (socket.readyState === WebSocket.OPEN && pendingOutboundMessages.length > 0) {
      const message = pendingOutboundMessages.shift();
      if (message == null) {
        continue;
      }
      try {
        socket.send(message);
      } catch (error) {
        listeners.emitError(error instanceof Error ? error : new Error(String(error)));
        socket.close();
        return;
      }
    }
  }

  function failPendingOutboundMessages(reason: string): void {
    const dropped = pendingOutboundMessages.length;
    pendingOutboundMessages.length = 0;
    if (dropped > 0) {
      listeners.emitError(
        new Error(`Codex WebSocket transport dropped ${dropped} queued message(s): ${reason}`)
      );
    }
  }
}

function createListenerBag(): ListenerBag {
  return {
    onMessage: null,
    onClose: null,
    onError: null,
    emitMessage(message: string) {
      this.onMessage?.(message);
    },
    emitClose(...args: unknown[]) {
      this.onClose?.(...args);
    },
    emitError(error: Error) {
      this.onError?.(error);
    },
  };
}
