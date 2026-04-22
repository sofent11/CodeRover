import { test } from "bun:test";
import { strict as assert } from "node:assert";

import { runBridgeShutdownTasks } from "../src/bridge-shutdown";

test("bridge shutdown waits for async cleanup tasks", async () => {
  const calls: string[] = [];
  const result = await runBridgeShutdownTasks([
    {
      label: "first",
      async run() {
        await new Promise((resolve) => setTimeout(resolve, 10));
        calls.push("first");
      },
    },
    {
      label: "second",
      async run() {
        await new Promise((resolve) => setTimeout(resolve, 1));
        calls.push("second");
      },
    },
  ], {
    timeoutMs: 200,
  });

  assert.equal(result.timedOut, false);
  assert.equal(calls.length, 2);
  assert.deepEqual([...result.completedLabels].sort(), ["first", "second"]);
});

test("bridge shutdown reports timed out tasks", async () => {
  const pendingLabels: string[][] = [];
  const result = await runBridgeShutdownTasks([
    {
      label: "hung",
      async run() {
        await new Promise((resolve) => setTimeout(resolve, 100));
      },
    },
  ], {
    timeoutMs: 10,
    onTimeout(labels) {
      pendingLabels.push(labels);
    },
  });

  assert.equal(result.timedOut, true);
  assert.deepEqual(pendingLabels[0], ["hung"]);
});
