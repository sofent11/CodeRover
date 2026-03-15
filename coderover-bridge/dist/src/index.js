"use strict";
// FILE: index.ts
// Purpose: Small entrypoint wrapper for the bridge runtime.
Object.defineProperty(exports, "__esModule", { value: true });
exports.watchThreadRollout = exports.openLastActiveThread = exports.startBridge = void 0;
var bridge_1 = require("./bridge");
Object.defineProperty(exports, "startBridge", { enumerable: true, get: function () { return bridge_1.startBridge; } });
var session_state_1 = require("./session-state");
Object.defineProperty(exports, "openLastActiveThread", { enumerable: true, get: function () { return session_state_1.openLastActiveThread; } });
var rollout_watch_1 = require("./rollout-watch");
Object.defineProperty(exports, "watchThreadRollout", { enumerable: true, get: function () { return rollout_watch_1.watchThreadRollout; } });
