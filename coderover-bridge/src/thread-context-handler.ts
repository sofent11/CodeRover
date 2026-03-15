// FILE: thread-context-handler.ts
// Purpose: Serves on-demand context-window usage reads from local Codex rollout files.

import { readLatestContextWindowUsage } from "./rollout-watch";

interface ThreadContextReadParams {
  threadId?: unknown;
  thread_id?: unknown;
  turnId?: unknown;
  turn_id?: unknown;
}

interface ThreadContextError extends Error {
  errorCode: string;
  userMessage: string;
}

type SendResponse = (rawMessage: string) => void;

export function handleThreadContextRequest(rawMessage: string, sendResponse: SendResponse): boolean {
  let parsed: {
    method?: unknown;
    id?: unknown;
    params?: ThreadContextReadParams;
  };
  try {
    parsed = JSON.parse(rawMessage);
  } catch {
    return false;
  }

  const method = typeof parsed?.method === "string" ? parsed.method.trim() : "";
  if (method !== "thread/contextWindow/read") {
    return false;
  }

  const id = parsed.id;
  const params = parsed.params || {};

  Promise.resolve()
    .then(() => handleThreadContextRead(params))
    .then((result) => {
      sendResponse(JSON.stringify({ id, result }));
    })
    .catch((error: ThreadContextError) => {
      sendResponse(JSON.stringify({
        id,
        error: {
          code: -32000,
          message: error.userMessage || error.message || "Unknown thread context error",
          data: {
            errorCode: error.errorCode || "thread_context_error",
          },
        },
      }));
    });

  return true;
}

async function handleThreadContextRead(params: ThreadContextReadParams) {
  const threadId = readString(params.threadId) || readString(params.thread_id);
  if (!threadId) {
    throw threadContextError("missing_thread_id", "thread/contextWindow/read requires a threadId.");
  }

  const turnId = readString(params.turnId) || readString(params.turn_id);
  const result = readLatestContextWindowUsage({
    threadId,
    ...(turnId ? { turnId } : {}),
  });

  return {
    threadId,
    usage: result?.usage ?? null,
    rolloutPath: result?.rolloutPath ?? null,
  };
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function threadContextError(errorCode: string, userMessage: string): ThreadContextError {
  const error = new Error(userMessage) as ThreadContextError;
  error.errorCode = errorCode;
  error.userMessage = userMessage;
  return error;
}
