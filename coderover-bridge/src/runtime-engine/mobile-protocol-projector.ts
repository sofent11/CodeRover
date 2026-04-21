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
        method: "timeline/turnUpdated",
        params: {
          threadId: event.threadId,
          turnId: event.turnId,
          state: "running",
        },
      };

    case "turn_completed":
      return {
        kind: "notification",
        method: "timeline/turnUpdated",
        params: {
          threadId: event.threadId,
          turnId: event.turnId,
          state: event.status || "completed",
        },
      };

    case "assistant_delta":
      return {
        kind: "notification",
        method: "timeline/itemTextUpdated",
        params: {
          threadId: event.threadId,
          turnId: event.turnId,
          timelineItemId: event.itemId,
          providerItemId: event.itemId,
          kind: "chat",
          role: "assistant",
          status: "streaming",
          text: event.delta,
          textMode: "append",
        },
      };

    case "reasoning_delta":
      return {
        kind: "notification",
        method: "timeline/itemTextUpdated",
        params: {
          threadId: event.threadId,
          turnId: event.turnId,
          timelineItemId: event.itemId,
          providerItemId: event.itemId,
          kind: "thinking",
          role: "system",
          status: "streaming",
          text: event.delta,
          textMode: "append",
        },
      };

    case "plan_update":
      return {
        kind: "notification",
        method: "timeline/itemTextUpdated",
        params: {
          threadId: event.threadId,
          turnId: event.turnId,
          timelineItemId: event.itemId,
          providerItemId: event.itemId,
          kind: "plan",
          role: "system",
          status: "streaming",
          text: event.delta || event.explanation || "",
          textMode: "replace",
          planState: {
            explanation: event.explanation,
            steps: Array.isArray(event.plan) ? event.plan : [],
          },
        },
      };

    case "tool_delta": {
      const kind = Array.isArray(event.changes) && event.changes.length > 0
        ? "fileChange"
        : "toolActivity";
      return {
        kind: "notification",
        method: event.completed ? "timeline/itemCompleted" : "timeline/itemTextUpdated",
        params: {
          threadId: event.threadId,
          turnId: event.turnId,
          timelineItemId: event.itemId,
          providerItemId: event.itemId,
          kind,
          role: "system",
          status: event.completed ? "completed" : "streaming",
          text: event.delta,
          textMode: "append",
          toolName: event.toolName,
          changes: event.changes,
        },
      };
    }

    case "command_delta":
      return {
        kind: "notification",
        method: "timeline/itemTextUpdated",
        params: {
          threadId: event.threadId,
          turnId: event.turnId,
          timelineItemId: event.itemId,
          providerItemId: event.itemId,
          kind: "commandExecution",
          role: "system",
          status: event.status || "running",
          text: event.delta,
          textMode: "replace",
          command: event.command,
          cwd: event.cwd,
          exitCode: event.exitCode,
          durationMs: event.durationMs,
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
