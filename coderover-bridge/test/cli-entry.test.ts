import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";

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
