"use strict";
// FILE: bridge.ts
// Purpose: Runs CodeRover locally, serves a stable local bridge socket, and coordinates desktop refreshes for CodeRover.app.
Object.defineProperty(exports, "__esModule", { value: true });
exports.startBridge = startBridge;
const coderover_desktop_refresher_1 = require("./coderover-desktop-refresher");
const codex_transport_1 = require("./codex-transport");
const qr_1 = require("./qr");
const session_state_1 = require("./session-state");
const git_handler_1 = require("./git-handler");
const thread_context_handler_1 = require("./thread-context-handler");
const workspace_handler_1 = require("./workspace-handler");
const secure_device_state_1 = require("./secure-device-state");
const debug_log_1 = require("./debug-log");
const runtime_manager_1 = require("./runtime-manager");
const local_bridge_server_1 = require("./local-bridge-server");
const secure_transport_1 = require("./secure-transport");
const PAIRING_QR_REPRINT_INTERVAL_MS = 4 * 60 * 1000;
function startBridge() {
    const config = (0, coderover_desktop_refresher_1.readBridgeConfig)();
    const deviceState = (0, secure_device_state_1.loadOrCreateBridgeDeviceState)();
    const bridgeId = deviceState.bridgeId || deviceState.macDeviceId;
    const desktopRefresher = new coderover_desktop_refresher_1.CodeRoverDesktopRefresher({
        enabled: config.refreshEnabled,
        debounceMs: config.refreshDebounceMs,
        refreshCommand: config.refreshCommand,
        bundleId: config.coderoverBundleId,
        appPath: config.coderoverAppPath,
    });
    let isShuttingDown = false;
    let codexTransport = null;
    let codexRestartTimer = null;
    let codexRestartAttempt = 0;
    let pairingQRRefreshTimer = null;
    let secureTransport = null;
    const runtimeManager = (0, runtime_manager_1.createRuntimeManager)({
        sendApplicationMessage(rawMessage) {
            sendApplicationResponse(rawMessage);
        },
        logPrefix: "[coderover]",
    });
    const localServer = (0, local_bridge_server_1.startLocalBridgeServer)({
        bridgeId,
        host: config.localHost,
        port: config.localPort,
        logPrefix: "[coderover]",
        onClientClose({ transportId }) {
            secureTransport?.handleTransportClosed(transportId);
        },
        onError(error) {
            console.error(`[coderover] Failed to start local bridge server on ${config.localHost}:${config.localPort}.`);
            console.error(error.message);
            process.exit(1);
        },
        onMessage(message, transport) {
            if (!secureTransport) {
                return;
            }
            secureTransport.handleIncomingWireMessage(message, {
                ...transport,
                onApplicationMessage(plaintextMessage) {
                    handleApplicationMessage(plaintextMessage);
                },
            });
        },
    });
    const transportCandidates = (0, local_bridge_server_1.buildTransportCandidates)({
        bridgeId,
        localPort: config.localPort,
        tailnetUrl: config.tailnetUrl,
        relayUrls: config.relayUrls,
    });
    console.log(`[coderover] Local bridge listening on ws://<this-mac>:${config.localPort}/bridge/${bridgeId}`);
    secureTransport = (0, secure_transport_1.createBridgeSecureTransport)({
        sessionId: bridgeId,
        deviceState,
        transportCandidates,
    });
    printFreshPairingQR();
    pairingQRRefreshTimer = setInterval(() => {
        if (!isShuttingDown) {
            printFreshPairingQR();
        }
    }, PAIRING_QR_REPRINT_INTERVAL_MS);
    launchCodexTransport();
    process.on("SIGINT", () => shutdownBridge(() => {
        isShuttingDown = true;
        localServer.stop();
    }));
    process.on("SIGTERM", () => shutdownBridge(() => {
        isShuttingDown = true;
        localServer.stop();
    }));
    function handleApplicationMessage(rawMessage) {
        logBridgeFlow("phone->bridge", rawMessage);
        if ((0, thread_context_handler_1.handleThreadContextRequest)(rawMessage, sendApplicationResponse)) {
            return;
        }
        if ((0, workspace_handler_1.handleWorkspaceRequest)(rawMessage, sendApplicationResponse)) {
            return;
        }
        if ((0, git_handler_1.handleGitRequest)(rawMessage, sendApplicationResponse)) {
            return;
        }
        maybeTrackPhoneThread(rawMessage);
        void runtimeManager.handleClientMessage(rawMessage).catch((error) => {
            console.error(`[coderover] ${error.message}`);
        });
    }
    function sendApplicationResponse(rawMessage) {
        logBridgeFlow("bridge->phone", rawMessage);
        secureTransport?.queueOutboundApplicationMessage(rawMessage);
    }
    function rememberThreadFromMessage(source, rawMessage) {
        const threadId = extractThreadId(rawMessage);
        if (!threadId || threadId.startsWith("claude:") || threadId.startsWith("gemini:")) {
            return;
        }
        (0, session_state_1.rememberActiveThread)(threadId, source);
    }
    function maybeTrackPhoneThread(rawMessage) {
        const parsed = safeParseJSON(rawMessage);
        if (!parsed) {
            return;
        }
        const provider = readString(asRecord(parsed.params)?.provider);
        if (provider && provider !== "codex") {
            return;
        }
        desktopRefresher.handleInbound(rawMessage);
        rememberThreadFromMessage("phone", rawMessage);
    }
    function launchCodexTransport() {
        const transport = (0, codex_transport_1.createCodexTransport)({
            endpoint: config.coderoverEndpoint,
            env: process.env,
        });
        codexTransport = transport;
        runtimeManager.attachCodexTransport(transport);
        transport.onError((error) => {
            if (codexTransport === transport) {
                handleCodexTransportFailure(error);
            }
        });
        transport.onMessage((message) => {
            if (codexTransport !== transport) {
                return;
            }
            logBridgeFlow("codex->bridge", message);
            codexRestartAttempt = 0;
            desktopRefresher.handleOutbound(message);
            rememberThreadFromMessage("codex", message);
            runtimeManager.handleCodexTransportMessage(message);
        });
        transport.onClose(() => {
            if (codexTransport !== transport) {
                return;
            }
            if (isShuttingDown) {
                desktopRefresher.handleTransportReset();
                localServer.stop();
                return;
            }
            handleCodexTransportFailure(new Error("Codex app-server transport closed unexpectedly."));
        });
    }
    function handleCodexTransportFailure(error) {
        if (isShuttingDown) {
            return;
        }
        console.error(`[coderover] ${error.message || "Unknown Codex transport failure"}`);
        desktopRefresher.handleTransportReset();
        localServer.disconnectAllClients();
        runtimeManager.handleCodexTransportClosed(error.message);
        printFreshPairingQR();
        if (codexTransport) {
            const failedTransport = codexTransport;
            codexTransport = null;
            failedTransport.shutdown();
        }
        scheduleCodexRestart();
    }
    function scheduleCodexRestart() {
        if (codexRestartTimer || isShuttingDown) {
            return;
        }
        const delayMs = Math.min(4_000, 500 * (2 ** Math.min(codexRestartAttempt, 3)));
        codexRestartAttempt += 1;
        console.log(`[coderover] Restarting Codex transport in ${delayMs}ms...`);
        codexRestartTimer = setTimeout(() => {
            codexRestartTimer = null;
            launchCodexTransport();
        }, delayMs);
    }
    function printFreshPairingQR() {
        if (secureTransport) {
            (0, qr_1.printQR)(secureTransport.createPairingPayload());
        }
    }
    function shutdownBridge(beforeExit = () => { }) {
        beforeExit();
        if (codexRestartTimer) {
            clearTimeout(codexRestartTimer);
            codexRestartTimer = null;
        }
        if (pairingQRRefreshTimer) {
            clearInterval(pairingQRRefreshTimer);
            pairingQRRefreshTimer = null;
        }
        codexTransport?.shutdown();
        runtimeManager.shutdown();
        setTimeout(() => process.exit(0), 100);
    }
}
function extractThreadId(rawMessage) {
    const parsed = safeParseJSON(rawMessage);
    if (!parsed) {
        return null;
    }
    const method = readString(parsed.method);
    const params = asRecord(parsed.params);
    if (method === "turn/start") {
        return readString(params?.threadId) || readString(params?.thread_id);
    }
    if (method === "thread/start" || method === "thread/started") {
        const thread = asRecord(params?.thread);
        return (readString(params?.threadId)
            || readString(params?.thread_id)
            || readString(thread?.id)
            || readString(thread?.threadId)
            || readString(thread?.thread_id));
    }
    if (method === "turn/completed") {
        const turn = asRecord(params?.turn);
        return (readString(params?.threadId)
            || readString(params?.thread_id)
            || readString(turn?.threadId)
            || readString(turn?.thread_id));
    }
    return null;
}
function readString(value) {
    return typeof value === "string" && value ? value : null;
}
function logBridgeFlow(stage, rawMessage) {
    const summary = summarizeBridgeMessage(rawMessage);
    if (summary) {
        (0, debug_log_1.debugLog)(`[coderover] [bridge-flow] stage=${stage} ${summary}`);
    }
}
function summarizeBridgeMessage(rawMessage) {
    const parsed = safeParseJSON(rawMessage);
    if (!parsed) {
        return `non-json bytes=${rawMessage.length}`;
    }
    const method = readString(parsed.method);
    const id = readString(parsed.id) || (typeof parsed.id === "number" ? String(parsed.id) : null);
    const params = asRecord(parsed.params);
    const threadId = extractBridgeMessageThreadId(parsed);
    const turnId = extractBridgeMessageTurnId(params);
    const itemId = extractBridgeMessageItemId(params);
    const parts = [];
    if (method) {
        parts.push(`method=${method}`);
    }
    else if (id) {
        parts.push(`response=${id}`);
    }
    else {
        parts.push("message=unknown");
    }
    if (threadId) {
        parts.push(`thread=${threadId}`);
    }
    if (turnId) {
        parts.push(`turn=${turnId}`);
    }
    if (itemId) {
        parts.push(`item=${itemId}`);
    }
    const error = asRecord(parsed.error);
    if (error?.message) {
        parts.push(`error=${JSON.stringify(error.message)}`);
    }
    return parts.join(" ");
}
function extractBridgeMessageThreadId(parsed) {
    const params = asRecord(parsed.params);
    const thread = asRecord(params?.thread);
    const turn = asRecord(params?.turn);
    const item = asRecord(params?.item);
    return (extractThreadId(JSON.stringify(parsed))
        || readString(params?.threadId)
        || readString(params?.thread_id)
        || readString(thread?.id)
        || readString(turn?.threadId)
        || readString(turn?.thread_id)
        || readString(item?.threadId)
        || readString(item?.thread_id));
}
function extractBridgeMessageTurnId(params) {
    const turn = asRecord(params?.turn);
    const item = asRecord(params?.item);
    return (readString(params?.turnId)
        || readString(params?.turn_id)
        || readString(turn?.id)
        || readString(item?.turnId)
        || readString(item?.turn_id));
}
function extractBridgeMessageItemId(params) {
    const item = asRecord(params?.item);
    return (readString(params?.itemId)
        || readString(params?.item_id)
        || readString(item?.id)
        || readString(params?.messageId)
        || readString(params?.message_id));
}
function safeParseJSON(value) {
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed
            : null;
    }
    catch {
        return null;
    }
}
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : null;
}
