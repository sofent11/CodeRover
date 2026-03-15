"use strict";
// FILE: codex-transport.ts
// Purpose: Abstracts the Codex-side transport so the bridge can talk to either a spawned app-server or an existing WebSocket endpoint.
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCodexTransport = createCodexTransport;
const child_process_1 = require("child_process");
const ws_1 = require("ws");
function createCodexTransport({ endpoint = "", env = process.env } = {}) {
    if (endpoint) {
        return createWebSocketTransport({ endpoint });
    }
    return createSpawnTransport({ env });
}
function createSpawnTransport({ env }) {
    const launch = createCodexLaunchPlan({ env });
    const codex = (0, child_process_1.spawn)(launch.command, launch.args, launch.options);
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let didRequestShutdown = false;
    let didReportError = false;
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
        send(message) {
            if (!codex.stdin.writable) {
                return;
            }
            codex.stdin.write(message.endsWith("\n") ? message : `${message}\n`);
        },
        onMessage(handler) {
            listeners.onMessage = handler;
        },
        onClose(handler) {
            listeners.onClose = handler;
        },
        onError(handler) {
            listeners.onError = handler;
        },
        shutdown() {
            didRequestShutdown = true;
            shutdownCodexProcess(codex);
        },
    };
}
function createCodexLaunchPlan({ env }) {
    const sharedOptions = {
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
function shutdownCodexProcess(codex) {
    if (codex.killed || codex.exitCode !== null) {
        return;
    }
    if (process.platform === "win32" && codex.pid) {
        const killer = (0, child_process_1.spawn)("taskkill", ["/pid", String(codex.pid), "/t", "/f"], {
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
function createCodexCloseError({ code, signal, stderrBuffer, launchDescription, }) {
    const details = stderrBuffer.trim();
    const reason = details || `Process exited with code ${code}${signal ? ` (signal: ${signal})` : ""}.`;
    return new Error(`Codex launcher ${launchDescription} failed: ${reason}`);
}
function appendOutputBuffer(buffer, chunk) {
    const next = `${buffer}${chunk}`;
    return next.slice(-4_096);
}
function createWebSocketTransport({ endpoint }) {
    const socket = new ws_1.WebSocket(endpoint);
    const listeners = createListenerBag();
    socket.on("message", (chunk) => {
        const message = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        if (message.trim()) {
            listeners.emitMessage(message);
        }
    });
    socket.on("close", (code, reason) => {
        const safeReason = reason ? reason.toString("utf8") : "no reason";
        listeners.emitClose(code, safeReason);
    });
    socket.on("error", (error) => listeners.emitError(error));
    return {
        mode: "websocket",
        describe() {
            return endpoint;
        },
        send(message) {
            if (socket.readyState !== ws_1.WebSocket.OPEN) {
                return;
            }
            socket.send(message);
        },
        onMessage(handler) {
            listeners.onMessage = handler;
        },
        onClose(handler) {
            listeners.onClose = handler;
        },
        onError(handler) {
            listeners.onError = handler;
        },
        shutdown() {
            if (socket.readyState === ws_1.WebSocket.OPEN || socket.readyState === ws_1.WebSocket.CONNECTING) {
                socket.close();
            }
        },
    };
}
function createListenerBag() {
    return {
        onMessage: null,
        onClose: null,
        onError: null,
        emitMessage(message) {
            this.onMessage?.(message);
        },
        emitClose(...args) {
            this.onClose?.(...args);
        },
        emitError(error) {
            this.onError?.(error);
        },
    };
}
