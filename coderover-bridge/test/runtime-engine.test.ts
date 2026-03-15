// FILE: runtime-engine.test.ts
// Purpose: Verifies the runtime engine projector, session index, and ACP engine lifecycle.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  createAcpEngine,
  type AcpTransport,
} from "../src/runtime-engine/acp-engine";
import { projectRuntimeEventToMobileProtocol } from "../src/runtime-engine/mobile-protocol-projector";
import { createThreadSessionIndex } from "../src/runtime-engine/thread-session-index";
import type {
  RuntimeApprovalRequestEvent,
  RuntimeEvent,
  RuntimeUserInputRequestEvent,
} from "../src/runtime-engine/types";

async function drainMicrotasks(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if ((Date.now() - startedAt) > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await drainMicrotasks();
  }
}

test("projectRuntimeEventToMobileProtocol preserves existing plan and approval message shapes", () => {
  const planProjection = projectRuntimeEventToMobileProtocol({
    kind: "plan_update",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "plan-1",
    explanation: "Inspect the failing path",
    summary: "Inspect the failing path",
    plan: [{ step: "Find the regression", status: "in_progress" }],
    delta: "Inspect the failing path",
  });
  assert.equal(planProjection.kind, "notification");
  assert.equal(planProjection.method, "turn/plan/updated");
  assert.deepEqual(planProjection.params.plan, [{ step: "Find the regression", status: "in_progress" }]);

  const approvalProjection = projectRuntimeEventToMobileProtocol({
    kind: "approval_request",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "approval-1",
    method: "item/commandExecution/requestApproval",
    command: "npm test",
    reason: "Run checks",
    toolName: null,
  });
  assert.equal(approvalProjection.kind, "request");
  assert.equal(approvalProjection.method, "item/commandExecution/requestApproval");
  assert.equal(approvalProjection.params.command, "npm test");
});

test("thread session index persists runtime owner state and provider session binding", () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "coderover-thread-session-index-"));
  try {
    const index = createThreadSessionIndex({ baseDir });
    index.upsert({
      threadId: "thread-1",
      provider: "claude",
      engineSessionId: "engine-1",
      providerSessionId: "provider-1",
      cwd: "/tmp/demo",
      model: "sonnet",
      ownerState: "running",
      activeTurnId: "turn-1",
    });
    index.shutdown();

    const reloaded = createThreadSessionIndex({ baseDir });
    const record = reloaded.get("thread-1");
    assert.ok(record);
    assert.equal(record?.engineSessionId, "engine-1");
    assert.equal(record?.providerSessionId, "provider-1");
    assert.equal(record?.ownerState, "running");
    assert.equal(record?.activeTurnId, "turn-1");
    reloaded.shutdown();
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test("ACP engine bridges prompt lifecycle, approval, and structured user input through runtime events", async () => {
  const emittedEvents: RuntimeEvent[] = [];
  const approvalRequests: RuntimeApprovalRequestEvent[] = [];
  const userInputRequests: RuntimeUserInputRequestEvent[] = [];
  const approvalResponses: unknown[] = [];
  const userInputResponses: unknown[] = [];

  const transport: AcpTransport = {
    async cancel() {},
    async initialize() {},
    async newSession() {
      return { sessionId: "acp-session-1" };
    },
    async prompt({ onUpdate }) {
      await onUpdate({
        type: "assistant_delta",
        itemId: "assistant-1",
        delta: "Investigating",
      });
      await onUpdate({
        type: "plan_update",
        itemId: "plan-1",
        explanation: "Check the server logs",
        plan: [{ step: "Read the logs", status: "completed" }],
      });
      await onUpdate({
        type: "approval_request",
        itemId: "approval-1",
        method: "item/commandExecution/requestApproval",
        command: "npm test",
        reason: "Run the targeted check",
        respond(decision) {
          approvalResponses.push(decision);
        },
      });
      await onUpdate({
        type: "user_input_request",
        itemId: "user-input-1",
        questions: [{ id: "scope", question: "Which scope?", options: [] }],
        respond(answer) {
          userInputResponses.push(answer);
        },
      });
      await onUpdate({
        type: "token_usage",
        usage: { outputTokens: 42 },
      });
      return { stopReason: "end_turn" };
    },
    shutdown() {},
  };

  const engine = createAcpEngine({
    provider: "claude-acp",
    transport,
    clientBridge: {
      emitRuntimeEvent(event) {
        emittedEvents.push(event);
      },
      async requestApproval(event) {
        approvalRequests.push(event);
        return "accept";
      },
      async requestStructuredInput(event) {
        userInputRequests.push(event);
        return {
          answers: {
            scope: {
              answers: ["current thread"],
            },
          },
        };
      },
    },
  });

  await engine.initialize({
    clientInfo: { name: "CodeRover", version: "1.0.0" },
  });
  const startResult = await engine.startTurn({
    threadId: "thread-1",
    input: [{ type: "text", text: "Inspect the issue" }],
    cwd: "/tmp/demo",
  });

  assert.equal(startResult.threadId, "thread-1");
  await waitFor(() =>
    emittedEvents.some((event) => event.kind === "turn_completed" && event.threadId === "thread-1")
  );

  assert.deepEqual(
    emittedEvents.map((event) => event.kind),
    ["turn_started", "assistant_delta", "plan_update", "token_usage", "turn_completed"]
  );
  assert.equal(approvalRequests.length, 1);
  assert.equal(approvalRequests[0]?.method, "item/commandExecution/requestApproval");
  assert.equal(userInputRequests.length, 1);
  assert.deepEqual(approvalResponses, ["accept"]);
  assert.deepEqual(userInputResponses, [{
    answers: {
      scope: {
        answers: ["current thread"],
      },
    },
  }]);
});

test("ACP engine interruptTurn aborts the in-flight turn and delegates cancel to the transport", async () => {
  const cancelCalls: Array<{ sessionId: string; turnId: string | null | undefined }> = [];
  const emittedEvents: RuntimeEvent[] = [];
  let releasePrompt: (() => void) | null = null;

  const transport: AcpTransport = {
    async cancel(sessionId, turnId) {
      cancelCalls.push({ sessionId, turnId });
    },
    async initialize() {},
    async newSession() {
      return { sessionId: "acp-session-2" };
    },
    async prompt({ signal }) {
      await new Promise<void>((resolve) => {
        releasePrompt = resolve;
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { stopReason: "cancelled" };
    },
    shutdown() {},
  };

  const engine = createAcpEngine({
    provider: "cursor-acp",
    transport,
    clientBridge: {
      emitRuntimeEvent(event) {
        emittedEvents.push(event);
      },
      async requestApproval() {
        throw new Error("unexpected approval request");
      },
      async requestStructuredInput() {
        throw new Error("unexpected user input request");
      },
    },
  });

  const startResult = await engine.startTurn({
    threadId: "thread-2",
    input: [{ type: "text", text: "Wait for interrupt" }],
  });
  await engine.interruptTurn("thread-2", startResult.turnId);
  releasePrompt?.();
  await waitFor(() =>
    emittedEvents.some((event) => event.kind === "turn_completed" && event.threadId === "thread-2")
  );

  assert.deepEqual(cancelCalls, [{
    sessionId: "acp-session-2",
    turnId: startResult.turnId,
  }]);
  assert.equal(
    emittedEvents.some((event) =>
      event.kind === "turn_completed"
      && event.threadId === "thread-2"
      && event.status === "cancelled"
    ),
    true
  );
});
