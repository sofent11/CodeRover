#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const projectRoot = path.resolve(__dirname, "..");
const localTscPath = path.join(projectRoot, "node_modules", "typescript", "bin", "tsc");

function commandExists(command, args = ["--version"]) {
  const result = spawnSync(command, args, {
    stdio: "ignore",
  });
  return result.status === 0;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  process.exit(result.status ?? 1);
}

function runBuild() {
  if (!fs.existsSync(localTscPath)) {
    console.error("[coderover] Missing local TypeScript compiler. Run `bun install` or `npm install` first.");
    process.exit(1);
  }
  const result = spawnSync(process.execPath, [localTscPath, "-p", "tsconfig.json"], {
    cwd: projectRoot,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function runStart() {
  runBuild();
  if (commandExists("bun")) {
    run("bun", ["./bin/coderover.js", "up"]);
    return;
  }
  run(process.execPath, ["./bin/coderover.js", "up"]);
}

function runTests() {
  runBuild();
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "coderover-test-home-"));
  run(
    process.execPath,
    ["--test", "./dist/test/*.test.js"],
    {
      env: {
        ...process.env,
        HOME: tempHome,
        CODEROVER_DISABLE_KEYCHAIN: "1",
      },
    }
  );
}

const mode = process.argv[2];

try {
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
} catch (error) {
  console.error(`[coderover] ${(error && error.message) || "Runtime command failed."}`);
  process.exit(1);
}
