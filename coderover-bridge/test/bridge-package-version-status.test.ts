// FILE: bridge-package-version-status.test.ts
// Purpose: Verifies installed bridge version lookup works from both source and built dist paths.

import { test } from "bun:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { readInstalledBridgeVersion } from "../src/bridge-package-version-status";

test("readInstalledBridgeVersion resolves package.json from src directory", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coderover-package-version-src-"));
  const srcDir = path.join(tempRoot, "src");

  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(
    path.join(tempRoot, "package.json"),
    JSON.stringify({ version: "1.2.3" }),
    "utf8"
  );

  assert.equal(readInstalledBridgeVersion(srcDir), "1.2.3");
});

test("readInstalledBridgeVersion resolves package.json from built dist/src directory", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coderover-package-version-dist-"));
  const distSrcDir = path.join(tempRoot, "dist", "src");

  fs.mkdirSync(distSrcDir, { recursive: true });
  fs.writeFileSync(
    path.join(tempRoot, "package.json"),
    JSON.stringify({ version: "2.3.4" }),
    "utf8"
  );

  assert.equal(readInstalledBridgeVersion(distSrcDir), "2.3.4");
});
