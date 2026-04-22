import { test } from "bun:test";
import { strict as assert } from "node:assert";

import { routeBridgeApplicationMessage } from "../src/bridge-message-router";

test("bridge message router preserves dispatcher order and skips runtime fallback when handled", async () => {
  const calls: string[] = [];
  const responses: Array<Record<string, unknown>> = [];

  const handled = await routeBridgeApplicationMessage(JSON.stringify({
    id: "req-1",
    method: "bridge/test",
    params: {},
  }), {
    dispatchers: [
      {
        name: "first",
        handle() {
          calls.push("first");
          return false;
        },
      },
      {
        name: "second",
        handle(rawMessage, sendResponse) {
          calls.push("second");
          sendResponse(JSON.stringify({ id: "req-1", result: { ok: true, rawMessage } }));
          return true;
        },
      },
    ],
    runtimeClient: {
      async handleClientMessage() {
        calls.push("runtime");
        return true;
      },
    },
    sendResponse(response) {
      responses.push(JSON.parse(response) as Record<string, unknown>);
    },
  });

  assert.equal(handled, true);
  assert.deepEqual(calls, ["first", "second"]);
  assert.equal(responses[0]?.result?.ok, true);
});

test("bridge message router normalizes runtime errors into JSON-RPC errors", async () => {
  const responses: Array<Record<string, unknown>> = [];
  const errors: Array<Record<string, unknown>> = [];

  const handled = await routeBridgeApplicationMessage(JSON.stringify({
    id: "req-2",
    method: "thread/read",
    params: {},
  }), {
    dispatchers: [],
    runtimeClient: {
      async handleClientMessage() {
        const error = new Error("runtime exploded") as Error & { errorCode?: string; code?: number };
        error.errorCode = "runtime_exploded";
        error.code = -32042;
        throw error;
      },
    },
    sendResponse(response) {
      responses.push(JSON.parse(response) as Record<string, unknown>);
    },
    onError(error) {
      errors.push(error as unknown as Record<string, unknown>);
    },
  });

  assert.equal(handled, true);
  assert.equal(errors[0]?.errorCode, "runtime_exploded");
  assert.equal(responses[0]?.error?.code, -32042);
  assert.equal(responses[0]?.error?.data?.errorCode, "runtime_exploded");
});
