// FILE: coderover-context-window-handler.ts
// Purpose: Serves `_coderover/context_window/read` from local rollout files using ACP session ids.

import { readLatestContextWindowUsage } from "./rollout-watch";

interface ContextWindowReadParams {
  sessionId?: unknown;
  turnId?: unknown;
}

interface ContextWindowError extends Error {
  errorCode: string;
  userMessage: string;
}

type SendResponse = (rawMessage: string) => void;

export function handleContextWindowReadRequest(rawMessage: string, sendResponse: SendResponse): boolean {
  let parsed: {
    method?: unknown;
    id?: unknown;
    params?: ContextWindowReadParams;
  };
  try {
    parsed = JSON.parse(rawMessage);
  } catch {
    return false;
  }

  if (normalizeContextWindowMethod(parsed?.method) !== "_coderover/context_window/read") {
    return false;
  }

  const id = parsed.id;
  const params = parsed.params || {};

  Promise.resolve()
    .then(() => handleContextWindowRead(params))
    .then((result) => {
      sendResponse(JSON.stringify({ id, result }));
    })
    .catch((error: ContextWindowError) => {
      sendResponse(JSON.stringify({
        id,
        error: {
          code: -32000,
          message: error.userMessage || error.message || "Unknown context window error",
          data: {
            errorCode: error.errorCode || "context_window_error",
          },
        },
      }));
    });

  return true;
}

function normalizeContextWindowMethod(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : null;
}

async function handleContextWindowRead(params: ContextWindowReadParams) {
  const sessionId = readString(params.sessionId);
  if (!sessionId) {
    throw contextWindowError("missing_session_id", "_coderover/context_window/read requires a sessionId.");
  }

  const turnId = readString(params.turnId);
  const result = readLatestContextWindowUsage({
    sessionId,
    ...(turnId ? { turnId } : {}),
  });

  return {
    sessionId,
    usage: result?.usage ?? null,
    rolloutPath: result?.rolloutPath ?? null,
  };
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function contextWindowError(errorCode: string, userMessage: string): ContextWindowError {
  const error = new Error(userMessage) as ContextWindowError;
  error.errorCode = errorCode;
  error.userMessage = userMessage;
  return error;
}
