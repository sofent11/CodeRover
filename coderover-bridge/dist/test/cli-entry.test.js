"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const node_assert_1 = require("node:assert");
const fs = require("fs");
const path = require("path");
const child_process_1 = require("child_process");
const BIN_PATH = path.join(process.cwd(), "bin", "coderover.js");
(0, node_test_1.test)("CLI shim loads dist output and preserves command surface", () => {
    const source = fs.readFileSync(BIN_PATH, "utf8");
    node_assert_1.strict.match(source, /require\("\.\.\/dist"\)/);
    node_assert_1.strict.match(source, /coderover up \| coderover resume \| coderover watch \[threadId\]/);
});
(0, node_test_1.test)("CLI shim still executes through dist without a source fallback", () => {
    const result = (0, child_process_1.spawnSync)(process.execPath, [BIN_PATH, "unknown"], {
        encoding: "utf8",
    });
    node_assert_1.strict.equal(result.status, 1);
    node_assert_1.strict.match(result.stderr, /Unknown command: unknown/);
    node_assert_1.strict.match(result.stderr, /coderover up \| coderover resume \| coderover watch \[threadId\]/);
});
