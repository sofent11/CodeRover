// FILE: runtime-engine/mobile-protocol-projector.ts
// Purpose: Projects normalized bridge runtime events back onto the existing mobile JSON-RPC protocol.

import type { RuntimeEvent } from "./types";

export interface ProjectedMobileNotification {
  kind: "notification";
  method: string;
  params: Record<string, unknown>;
}

export interface ProjectedMobileRequest {
  kind: "request";
  method: string;
  params: Record<string, unknown>;
}

export type ProjectedMobileProtocolMessage =
  | ProjectedMobileNotification
  | ProjectedMobileRequest;

export function projectRuntimeEventToMobileProtocol(
  event: RuntimeEvent
): ProjectedMobileProtocolMessage {
  switch (event.kind) {
    case "thread_started":
      return {
        kind: "notification",
        method: "thread/started",
        params: {
          thread: event.thread,
        },
      };

    case "turn_started":
      return {
        kind: "notification",
        method: "turn/started",
        params: {
          threadId: event.threadId,
          turnId: event.turnId,
        },
      };

    case "turn_completed":
      return {
        kind: "notification",
        method: "turn/completed",
        params: {
          threadId: event.threadId,
          turnId: event.turnId,
          status: event.status,
        },
      };

    case "assistant_delta":
      return {
        kind: "notification",
        method: "item/agentMessage/delta",
        params: {
          threadId: event.threadId,
          turnId: event.turnId,
          itemId: event.itemId,
          delta: event.delta,
        },
      };

    case "reasoning_delta":
      return {
        kind: "notification",
        method: "item/reasoning/textDelta",
        params: {
          threadId: event.threadId,
          turnId: event.turnId,
          itemId: event.itemId,
          delta: event.delta,
        },
      };

    case "plan_update":
      return {
        kind: "notification",
        method: "turn/plan/updated",
        params: {
          threadId: event.threadId,
          turnId: event.turnId,
          itemId: event.itemId,
          explanation: event.explanation,
          summary: event.summary,
          plan: event.plan,
          delta: event.delta,
        },
      };

    case "tool_delta":
      return {
        kind: "notification",
        method: event.completed ? "item/toolCall/completed" : "item/toolCall/outputDelta",
        params: {
          threadId: event.threadId,
          turnId: event.turnId,
          itemId: event.itemId,
          delta: event.delta,
          toolName: event.toolName,
          changes: event.changes,
        },
      };

    case "command_delta":
      return {
        kind: "notification",
        method: "item/commandExecution/outputDelta",
        params: {
          threadId: event.threadId,
          turnId: event.turnId,
          itemId: event.itemId,
          command: event.command,
          cwd: event.cwd,
          status: event.status,
          exitCode: event.exitCode,
          durationMs: event.durationMs,
          delta: event.delta,
        },
      };

    case "approval_request":
      return {
        kind: "request",
        method: event.method,
        params: {
          threadId: event.threadId,
          turnId: event.turnId,
          itemId: event.itemId,
          command: event.command,
          reason: event.reason,
          toolName: event.toolName,
        },
      };

    case "user_input_request":
      return {
        kind: "request",
        method: "item/tool/requestUserInput",
        params: {
          threadId: event.threadId,
          turnId: event.turnId,
          itemId: event.itemId,
          questions: event.questions,
        },
      };

    case "token_usage":
      return {
        kind: "notification",
        method: "thread/tokenUsage/updated",
        params: {
          threadId: event.threadId,
          usage: event.usage,
        },
      };

    case "runtime_error":
      return {
        kind: "notification",
        method: "error",
        params: {
          threadId: event.threadId,
          turnId: event.turnId,
          message: event.message,
        },
      };
  }
}
