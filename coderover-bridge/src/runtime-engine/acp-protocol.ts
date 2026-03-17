// FILE: runtime-engine/acp-protocol.ts
// Purpose: Shared ACP wire-shaping helpers for session info, live updates, and history replay.

import type {
  RuntimeInputItem,
  RuntimeItemShape,
  RuntimeThreadShape,
  RuntimeTurnShape,
} from "../bridge-types";
import type { RuntimeEvent } from "./types";

type UnknownRecord = Record<string, unknown>;

export const ACP_PROTOCOL_VERSION = 1;

export interface ProjectedAcpNotification {
  kind: "notification";
  method: "session/update";
  params: {
    sessionId: string;
    update: UnknownRecord;
  };
}

export interface ProjectedAcpRequest {
  kind: "request";
  method: "session/request_permission" | "_coderover/session/request_input";
  params: UnknownRecord;
}

export type ProjectedAcpProtocolMessage =
  | ProjectedAcpNotification
  | ProjectedAcpRequest;

export function projectRuntimeEventToAcpProtocol(
  event: RuntimeEvent
): ProjectedAcpProtocolMessage {
  switch (event.kind) {
    case "turn_started": {
      const sessionId = readRuntimeEventSessionId(event);
      return sessionInfoUpdate(sessionId, {
        turnId: event.turnId,
        runState: "running",
      });
    }

    case "turn_completed": {
      const sessionId = readRuntimeEventSessionId(event);
      return sessionInfoUpdate(sessionId, {
        turnId: event.turnId,
        runState: normalizeRunState(event.status),
      });
    }

    case "assistant_delta": {
      const sessionId = readRuntimeEventSessionId(event);
      return sessionUpdate(sessionId, {
        sessionUpdate: "agent_message_chunk",
        messageId: event.itemId,
        content: textContent(event.delta),
        _meta: coderoverMeta({
          sessionId,
          turnId: event.turnId,
          itemId: event.itemId,
          role: "assistant",
        }),
      });
    }

    case "reasoning_delta": {
      const sessionId = readRuntimeEventSessionId(event);
      return sessionUpdate(sessionId, {
        sessionUpdate: "agent_thought_chunk",
        messageId: event.itemId,
        content: textContent(event.delta),
        _meta: coderoverMeta({
          sessionId,
          turnId: event.turnId,
          itemId: event.itemId,
          role: "system",
          kind: "thinking",
        }),
      });
    }

    case "plan_update": {
      const sessionId = readRuntimeEventSessionId(event);
      return sessionUpdate(sessionId, {
        sessionUpdate: "plan",
        entries: normalizePlanEntries(event.plan),
        _meta: coderoverMeta({
          sessionId,
          turnId: event.turnId,
          itemId: event.itemId,
          explanation: event.explanation,
          summary: event.summary,
          text: event.delta,
        }),
      });
    }

    case "tool_delta": {
      const sessionId = readRuntimeEventSessionId(event);
      return sessionUpdate(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: event.itemId,
        title: event.toolName || "Tool call",
        kind: "edit",
        status: event.completed ? "completed" : "in_progress",
        ...(event.delta
          ? {
            content: [{
              type: "content",
              content: textContent(event.delta),
            }],
          }
          : {}),
        ...(Array.isArray(event.changes) && event.changes.length > 0
          ? { rawOutput: { changes: event.changes } }
          : {}),
        _meta: coderoverMeta({
          sessionId,
          turnId: event.turnId,
          itemId: event.itemId,
          toolName: event.toolName,
          changes: event.changes,
          completed: event.completed,
        }),
      });
    }

    case "command_delta": {
      const sessionId = readRuntimeEventSessionId(event);
      return sessionUpdate(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: event.itemId,
        title: event.command || "Command",
        kind: "execute",
        status: normalizeToolStatus(event.status),
        ...(event.delta
          ? {
            content: [{
              type: "content",
              content: textContent(event.delta),
            }],
          }
          : {}),
        rawInput: {
          command: event.command,
          cwd: event.cwd,
        },
        rawOutput: {
          exitCode: event.exitCode,
          durationMs: event.durationMs,
          text: event.delta,
        },
        _meta: coderoverMeta({
          sessionId,
          turnId: event.turnId,
          itemId: event.itemId,
          command: event.command,
          cwd: event.cwd,
          status: event.status,
          exitCode: event.exitCode,
          durationMs: event.durationMs,
        }),
      });
    }

    case "approval_request": {
      const sessionId = readRuntimeEventSessionId(event);
      return {
        kind: "request",
        method: "session/request_permission",
        params: {
          sessionId,
          toolCall: {
            toolCallId: event.itemId,
            title: event.toolName || event.command || "Tool approval",
            kind: approvalToolKind(event),
            status: "pending",
            rawInput: {
              command: event.command,
              reason: event.reason,
              toolName: event.toolName,
            },
            _meta: coderoverMeta({
              sessionId,
              turnId: event.turnId,
              itemId: event.itemId,
              method: event.method,
              command: event.command,
              reason: event.reason,
              toolName: event.toolName,
            }),
          },
          options: [
            { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
            { optionId: "allow_always", kind: "allow_always", name: "Allow for session" },
            { optionId: "reject_once", kind: "reject_once", name: "Reject" },
            { optionId: "reject_always", kind: "reject_always", name: "Reject for session" },
          ],
        },
      };
    }

    case "user_input_request": {
      const sessionId = readRuntimeEventSessionId(event);
      return {
        kind: "request",
        method: "_coderover/session/request_input",
        params: {
          sessionId,
          questions: event.questions,
          _meta: coderoverMeta({
            sessionId,
            turnId: event.turnId,
            itemId: event.itemId,
          }),
        },
      };
    }

    case "token_usage": {
      const sessionId = readRuntimeEventSessionId(event);
      return sessionUpdate(sessionId, {
        sessionUpdate: "usage_update",
        ...(normalizeUsage(event.usage) ? { usage: normalizeUsage(event.usage) } : {}),
        _meta: coderoverMeta({
          sessionId,
          usage: event.usage,
        }),
      });
    }

    case "runtime_error": {
      const sessionId = readRuntimeEventSessionId(event);
      return sessionInfoUpdate(sessionId, {
        turnId: event.turnId,
        runState: "failed",
        errorMessage: event.message,
      });
    }
  }
}

function readRuntimeEventSessionId(event: RuntimeEvent): string {
  if ("sessionId" in event && typeof event.sessionId === "string" && event.sessionId) {
    return event.sessionId;
  }
  throw new Error(`Runtime event ${event.kind} is missing a sessionId`);
}

export function buildAcpReplayNotifications(
  threadObject: RuntimeThreadShape
): ProjectedAcpNotification[] {
  const sessionId = normalizeString(threadObject.id);
  if (!sessionId) {
    return [];
  }

  const notifications: ProjectedAcpNotification[] = [];
  notifications.push(projectSessionInfoFromSessionObject(threadObject));

  const turns = Array.isArray(threadObject.turns) ? threadObject.turns : [];
  turns.forEach((turn) => {
    const turnId = normalizeString(turn.id);
    notifications.push(sessionInfoUpdate(sessionId, {
      turnId,
      runState: "running",
    }));

    const items = Array.isArray(turn.items) ? turn.items : [];
    items.forEach((item) => {
      notifications.push(...buildReplayNotificationsForItem(sessionId, turnId, item));
    });

    notifications.push(sessionInfoUpdate(sessionId, {
      turnId,
      runState: normalizeRunState(turn.status),
    }));
  });

  return notifications;
}

function buildReplayNotificationsForItem(
  sessionId: string,
  turnId: string | null,
  item: RuntimeItemShape
): ProjectedAcpNotification[] {
  const itemId = normalizeString(item.id) || randomReplayId(sessionId, turnId, item.type);
  const itemType = normalizeString(item.type) || "unknown";

  if (itemType === "user_message") {
    const inputItems = Array.isArray(item.content) ? item.content : [];
    const blocks = inputItems
      .map((entry) => runtimeInputItemToContentBlock(entry as RuntimeInputItem | UnknownRecord))
      .filter((entry): entry is UnknownRecord => Boolean(entry));
    if (blocks.length === 0 && normalizeString(item.text)) {
      blocks.push(textContent(normalizeString(item.text) || ""));
    }
    return blocks.map((content) => sessionUpdate(sessionId, {
      sessionUpdate: "user_message_chunk",
      messageId: itemId,
      content,
      _meta: coderoverMeta({
        sessionId,
        turnId,
        itemId,
        role: "user",
      }),
    }));
  }

  if (itemType === "agent_message") {
    return [sessionUpdate(sessionId, {
      sessionUpdate: "agent_message_chunk",
      messageId: itemId,
      content: textContent(normalizeString(item.text) || ""),
      _meta: coderoverMeta({
        sessionId,
        turnId,
        itemId,
        role: "assistant",
      }),
    })];
  }

  if (itemType === "reasoning") {
    return [sessionUpdate(sessionId, {
      sessionUpdate: "agent_thought_chunk",
      messageId: itemId,
      content: textContent(normalizeString(item.text) || ""),
      _meta: coderoverMeta({
        sessionId,
        turnId,
        itemId,
        role: "system",
        kind: "thinking",
      }),
    })];
  }

  if (itemType === "plan") {
    return [sessionUpdate(sessionId, {
      sessionUpdate: "plan",
      entries: normalizePlanEntries(item.plan),
      _meta: coderoverMeta({
        sessionId,
        turnId,
        itemId,
        explanation: normalizeString(item.explanation) || normalizeString(item.summary),
        summary: normalizeString(item.summary),
        text: normalizeString(item.text),
      }),
    })];
  }

  if (itemType === "command_execution") {
    return [sessionUpdate(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: itemId,
      title: normalizeString(item.command) || "Command",
      kind: "execute",
      status: normalizeToolStatus(item.status),
      ...(normalizeString(item.text)
        ? {
          content: [{
            type: "content",
            content: textContent(normalizeString(item.text) || ""),
          }],
        }
        : {}),
      rawInput: {
        command: normalizeString(item.command),
        cwd: normalizeString((item as UnknownRecord).cwd),
      },
      rawOutput: {
        exitCode: typeof (item as UnknownRecord).exitCode === "number" ? (item as UnknownRecord).exitCode : null,
        durationMs: typeof (item as UnknownRecord).durationMs === "number" ? (item as UnknownRecord).durationMs : null,
        text: normalizeString(item.text),
      },
      _meta: coderoverMeta({
        sessionId,
        turnId,
        itemId,
      }),
    })];
  }

  if (itemType === "tool_call") {
    const changes = Array.isArray((item as UnknownRecord).changes)
      ? ((item as UnknownRecord).changes as unknown[])
      : null;
    return [sessionUpdate(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: itemId,
      title: normalizeString((item.metadata as UnknownRecord | null)?.toolName) || "Tool call",
      kind: "edit",
      status: normalizeToolStatus(item.status),
      ...(normalizeString(item.text)
        ? {
          content: [{
            type: "content",
            content: textContent(normalizeString(item.text) || ""),
          }],
        }
        : {}),
      ...(changes && changes.length > 0
        ? { rawOutput: { changes } }
        : {}),
      _meta: coderoverMeta({
        sessionId,
        turnId,
        itemId,
      }),
    })];
  }

  if (normalizeString(item.text)) {
    return [sessionUpdate(sessionId, {
      sessionUpdate: "agent_message_chunk",
      messageId: itemId,
      content: textContent(normalizeString(item.text) || ""),
      _meta: coderoverMeta({
        sessionId,
        turnId,
        itemId,
        role: normalizeString(item.role) || "assistant",
      }),
    })];
  }

  return [];
}

export function projectSessionInfoFromSessionObject(session: RuntimeThreadShape): ProjectedAcpNotification {
  const sessionId = normalizeString(session.id) || "";
  return sessionInfoUpdate(sessionId, {
    title: normalizeString(session.name) || normalizeString(session.title),
    updatedAt: normalizeString(session.updatedAt),
    runState: "idle",
    agentId: normalizeString(session.provider) || "codex",
    providerSessionId: normalizeString(session.providerSessionId),
    preview: normalizeString(session.preview),
    archived: Boolean(session.archived),
    cwd: normalizeString(session.cwd),
  });
}

function sessionInfoUpdate(
  sessionId: string,
  payload: {
    title?: string | null;
    updatedAt?: string | null;
    turnId?: string | null;
    runState?: string | null;
    errorMessage?: string | null;
    agentId?: string | null;
    providerSessionId?: string | null;
    preview?: string | null;
    archived?: boolean;
    cwd?: string | null;
  }
): ProjectedAcpNotification {
  return sessionUpdate(sessionId, {
    sessionUpdate: "session_info_update",
    ...(payload.title !== undefined ? { title: payload.title } : {}),
    ...(payload.updatedAt ? { updatedAt: payload.updatedAt } : {}),
    _meta: coderoverMeta({
      sessionId,
      turnId: payload.turnId,
      runState: payload.runState,
      errorMessage: payload.errorMessage,
      agentId: payload.agentId,
      providerSessionId: payload.providerSessionId,
      preview: payload.preview,
      archived: payload.archived,
      cwd: payload.cwd,
    }),
  });
}

function sessionUpdate(sessionId: string, update: UnknownRecord): ProjectedAcpNotification {
  return {
    kind: "notification",
    method: "session/update",
    params: {
      sessionId,
      update,
    },
  };
}

function coderoverMeta(value: UnknownRecord): UnknownRecord {
  return {
    coderover: value,
  };
}

function textContent(text: string): UnknownRecord {
  return {
    type: "text",
    text,
  };
}

function normalizePlanEntries(value: unknown): UnknownRecord[] {
  const steps = Array.isArray(value) ? value : [];
  return steps.map((entry) => {
    const stepRecord = (entry && typeof entry === "object" && !Array.isArray(entry))
      ? entry as UnknownRecord
      : {};
    return {
      content: normalizeString(stepRecord.step) || normalizeString(stepRecord.content) || "Step",
      status: normalizePlanStatus(stepRecord.status),
      priority: "medium",
    };
  });
}

function runtimeInputItemToContentBlock(input: RuntimeInputItem | UnknownRecord): UnknownRecord | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const type = normalizeString((input as UnknownRecord).type);
  if (type === "text") {
    const text = normalizeString((input as UnknownRecord).text);
    return text ? textContent(text) : null;
  }

  if (type === "image" || type === "local_image") {
    const source = normalizeString((input as UnknownRecord).image_url)
      || normalizeString((input as UnknownRecord).url);
    const parsedDataUrl = source ? parseDataUrl(source) : null;
    if (parsedDataUrl) {
      return {
        type: "image",
        data: parsedDataUrl.data,
        mimeType: parsedDataUrl.mimeType,
        ...(parsedDataUrl.uri ? { uri: parsedDataUrl.uri } : {}),
      };
    }
    const path = normalizeString((input as UnknownRecord).path);
    return path
      ? {
        type: "resource_link",
        uri: path,
        name: path.split("/").filter(Boolean).pop() || path,
        title: path,
        _meta: coderoverMeta({
          inputType: type,
          path,
        }),
      }
      : null;
  }

  if (type === "skill") {
    const skillId = normalizeString((input as UnknownRecord).id) || "skill";
    const name = normalizeString((input as UnknownRecord).name) || skillId;
    const path = normalizeString((input as UnknownRecord).path);
    return {
      type: "resource_link",
      uri: path || `skill://${skillId}`,
      name,
      title: name,
      _meta: coderoverMeta({
        inputType: "skill",
        id: skillId,
        path,
      }),
    };
  }

  return null;
}

function normalizeUsage(usage: unknown): UnknownRecord | null {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return null;
  }
  const record = usage as UnknownRecord;
  const inputTokens = normalizeNumber(record.inputTokens ?? record.input_tokens) || 0;
  const outputTokens = normalizeNumber(record.outputTokens ?? record.output_tokens) || 0;
  const cachedReadTokens = normalizeNumber(record.cachedReadTokens ?? record.cached_read_tokens);
  const cachedWriteTokens = normalizeNumber(record.cachedWriteTokens ?? record.cached_write_tokens);
  const thoughtTokens = normalizeNumber(record.thoughtTokens ?? record.reasoningTokens ?? record.thought_tokens);
  const totalTokens = normalizeNumber(record.totalTokens ?? record.total_tokens)
    || inputTokens + outputTokens + (cachedReadTokens || 0) + (cachedWriteTokens || 0) + (thoughtTokens || 0);

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cachedReadTokens != null ? { cachedReadTokens } : {}),
    ...(cachedWriteTokens != null ? { cachedWriteTokens } : {}),
    ...(thoughtTokens != null ? { thoughtTokens } : {}),
  };
}

export function normalizeRunState(value: unknown): string {
  const normalized = normalizeString(value)?.toLowerCase();
  if (!normalized) {
    return "completed";
  }
  if (normalized.includes("stop") || normalized.includes("cancel") || normalized.includes("interrupt")) {
    return "stopped";
  }
  if (normalized.includes("fail") || normalized.includes("error")) {
    return "failed";
  }
  if (normalized.includes("run") || normalized.includes("progress") || normalized.includes("pend")) {
    return "running";
  }
  return "completed";
}

function normalizeToolStatus(value: unknown): string {
  const runState = normalizeRunState(value);
  if (runState === "running") {
    return "in_progress";
  }
  if (runState === "failed") {
    return "failed";
  }
  if (runState === "stopped") {
    return "failed";
  }
  return "completed";
}

function normalizePlanStatus(value: unknown): string {
  const normalized = normalizeString(value)?.toLowerCase();
  if (normalized === "completed" || normalized === "in_progress" || normalized === "pending") {
    return normalized;
  }
  if (normalized?.includes("progress")) {
    return "in_progress";
  }
  if (normalized?.includes("done") || normalized?.includes("complete")) {
    return "completed";
  }
  return "pending";
}

function approvalToolKind(event: {
  method: string;
  command: string | null;
  toolName: string | null;
}): string {
  const method = event.method.toLowerCase();
  if (method.includes("command")) {
    return "execute";
  }
  if (method.includes("file")) {
    return "edit";
  }
  if (event.command) {
    return "execute";
  }
  return "other";
}

function parseDataUrl(value: string): { mimeType: string; data: string; uri: string | null } | null {
  const match = value.match(/^data:([^;,]+)?(?:;base64)?,(.*)$/i);
  if (!match) {
    return null;
  }
  const mimeType = normalizeString(match[1]) || "application/octet-stream";
  const encoded = match[2] || "";
  return {
    mimeType,
    data: encoded,
    uri: null,
  };
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function randomReplayId(sessionId: string, turnId: string | null, type: unknown): string {
  return [sessionId, turnId || "turn", normalizeString(type) || "item"]
    .filter(Boolean)
    .join(":");
}
