import { test } from "bun:test";
import { strict as assert } from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { shouldRefreshHistoryByAge, shouldRefreshHistoryByTimestamp } from "../src/providers/shared/history-refresh";
import { buildPathPromptFromInputItems } from "../src/providers/shared/prompt-input";
import { asProviderRecord, normalizeOptionalString, toIsoDateString } from "../src/providers/shared/provider-utils";

test("provider shared utils normalize strings, records, and timestamps", () => {
  assert.equal(normalizeOptionalString("  hello  "), "hello");
  assert.equal(normalizeOptionalString("   "), null);
  assert.deepEqual(asProviderRecord({ ok: true }), { ok: true });
  assert.equal(asProviderRecord(null), null);
  assert.equal(toIsoDateString(1_700_000_000).includes("T"), true);
});

test("provider shared history refresh helpers compare timestamps and age", () => {
  assert.equal(shouldRefreshHistoryByTimestamp([], null, null), true);
  assert.equal(
    shouldRefreshHistoryByTimestamp([{}], "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"),
    true
  );
  assert.equal(
    shouldRefreshHistoryByAge([{}], "2026-01-01T00:00:00.000Z", 5_000, Date.parse("2026-01-01T00:00:03.000Z")),
    false
  );
});

test("provider shared prompt builder materializes data-url images and preserves text/skills", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "coderover-provider-shared-"));
  try {
    const prompt = await buildPathPromptFromInputItems([
      { type: "text", text: "hello" },
      { type: "skill", id: "checks" },
      {
        type: "image",
        image_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=",
      },
    ], {
      cwd,
      imageTempDirName: "shared-images",
    });

    assert.match(prompt, /hello/);
    assert.match(prompt, /\$checks/);
    assert.match(prompt, /\[Images provided at paths\]/);
    const lines = prompt.split("\n").filter(Boolean);
    const imagePath = lines[lines.length - 1];
    assert.ok(imagePath);
    assert.equal(fs.existsSync(imagePath), true);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
