"use strict";
// FILE: index.ts
// Purpose: Small entrypoint wrapper for the bridge runtime.
Object.defineProperty(exports, "__esModule", { value: true });
exports.watchThreadRollout = exports.openLastActiveThread = exports.startBridge = void 0;
const bridgeModule = require("./bridge");
const sessionStateModule = require("./session-state");
const rolloutWatchModule = require("./rollout-watch");
exports.startBridge = bridgeModule.startBridge;
exports.openLastActiveThread = sessionStateModule.openLastActiveThread;
exports.watchThreadRollout = rolloutWatchModule.watchThreadRollout;
