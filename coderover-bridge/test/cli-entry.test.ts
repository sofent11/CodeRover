// @ts-nocheck
export {};

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const BIN_PATH = path.join(process.cwd(), "bin", "coderover.js");

test("CLI shim loads dist output and preserves command surface", () => {
  const source = fs.readFileSync(BIN_PATH, "utf8");
  assert.match(source, /require\("\.\.\/dist"\)/);
  assert.match(source, /coderover up \| coderover resume \| coderover watch \[threadId\]/);
});

test("CLI shim still executes through dist without a source fallback", () => {
  const result = spawnSync(process.execPath, [BIN_PATH, "unknown"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command: unknown/);
  assert.match(result.stderr, /coderover up \| coderover resume \| coderover watch \[threadId\]/);
});
