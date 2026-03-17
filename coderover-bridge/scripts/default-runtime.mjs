#!/usr/bin/env bun

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const localTscPath = path.join(projectRoot, "node_modules", "typescript", "bin", "tsc");
const bunBinary = process.execPath;

function runBun(args, options = {}) {
  const result = Bun.spawnSync([bunBinary, ...args], {
    cwd: projectRoot,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      ...(options.env ?? {}),
    },
  });
  process.exit(result.exitCode ?? 1);
}

function ensureLocalTypeScript() {
  if (!fs.existsSync(localTscPath)) {
    console.error("[coderover] Missing local TypeScript compiler. Run `bun install` first.");
    process.exit(1);
  }
}

function cleanDist() {
  fs.rmSync(path.join(projectRoot, "dist"), { recursive: true, force: true });
}

function runBuild() {
  ensureLocalTypeScript();
  cleanDist();
  const result = Bun.spawnSync([bunBinary, localTscPath, "-p", "tsconfig.json"], {
    cwd: projectRoot,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  if ((result.exitCode ?? 1) !== 0) {
    process.exit(result.exitCode ?? 1);
  }
}

function runStart() {
  runBuild();
  runBun(["./bin/coderover.js", "up"]);
}

function runTests() {
  runBuild();
  const sourceTestDir = path.join(projectRoot, "test");
  const sourceTestFiles = fs.existsSync(sourceTestDir)
    ? fs.readdirSync(sourceTestDir)
        .filter((entry) => entry.endsWith(".test.ts"))
        .sort()
        .map((entry) => path.join("test", entry))
    : [];

  if (sourceTestFiles.length === 0) {
    console.error(`[coderover] Could not find bridge tests in ${sourceTestDir}`);
    process.exit(1);
  }

  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "coderover-test-home-"));
  runBun(["test", ...sourceTestFiles], {
    env: {
      HOME: tempHome,
      CODEROVER_DISABLE_KEYCHAIN: "1",
    },
  });
}

const mode = process.argv[2];

if (mode === "build") {
  runBuild();
  process.exit(0);
}

if (mode === "start") {
  runStart();
}

if (mode === "test") {
  runTests();
}

console.error("[coderover] Unknown runtime command.");
process.exit(1);
