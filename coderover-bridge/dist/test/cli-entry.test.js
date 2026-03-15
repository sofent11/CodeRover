"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const child_process_1 = require("child_process");
const BIN_PATH = path.join(process.cwd(), "bin", "coderover.js");
test("CLI shim loads dist output and preserves command surface", () => {
    const source = fs.readFileSync(BIN_PATH, "utf8");
    assert.match(source, /require\("\.\.\/dist"\)/);
    assert.match(source, /coderover up \| coderover resume \| coderover watch \[threadId\]/);
});
test("CLI shim still executes through dist without a source fallback", () => {
    const result = (0, child_process_1.spawnSync)(process.execPath, [BIN_PATH, "unknown"], {
        encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown command: unknown/);
    assert.match(result.stderr, /coderover up \| coderover resume \| coderover watch \[threadId\]/);
});
