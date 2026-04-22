// FILE: bridge-message-router.ts
// Purpose: Provides a testable bridge-side message router for local handlers and runtime fallback.

type SendResponse = (response: string) => void;
type JsonRecord = Record<string, unknown>;

export interface BridgeRouterError {
  code: number;
  errorCode: string;
  message: string;
}

export interface BridgeMessageDispatcher {
  name: string;
  handle(rawMessage: string, sendResponse: SendResponse): boolean;
}

export interface BridgeRuntimeClient {
  handleClientMessage(rawMessage: string): Promise<boolean>;
}

export interface BridgeMessageRouterOptions {
  dispatchers: BridgeMessageDispatcher[];
  runtimeClient: BridgeRuntimeClient;
  sendResponse: SendResponse;
  onBeforeRuntime?(rawMessage: string): void;
  onError?(error: BridgeRouterError & { source: string }): void;
}

export async function routeBridgeApplicationMessage(
  rawMessage: string,
  {
    dispatchers,
    runtimeClient,
    sendResponse,
    onBeforeRuntime,
    onError,
  }: BridgeMessageRouterOptions
): Promise<boolean> {
  for (const dispatcher of dispatchers) {
    if (dispatcher.handle(rawMessage, sendResponse)) {
      return true;
    }
  }

  onBeforeRuntime?.(rawMessage);

  try {
    return await runtimeClient.handleClientMessage(rawMessage);
  } catch (error) {
    const normalized = normalizeBridgeRouterError(error);
    onError?.({
      ...normalized,
      source: "runtime_manager",
    });
    const requestId = extractRequestId(rawMessage);
    if (requestId != null) {
      sendResponse(JSON.stringify({
        id: requestId,
        error: {
          code: normalized.code,
          message: normalized.message,
          data: {
            errorCode: normalized.errorCode,
          },
        },
      }));
    }
    return true;
  }
}

export function normalizeBridgeRouterError(error: unknown): BridgeRouterError {
  const record = asRecord(error);
  const message = normalizeOptionalString(record?.message)
    || (error instanceof Error ? error.message : null)
    || "Internal bridge error";
  const code = Number.isInteger(record?.code) ? Number(record?.code) : -32000;
  const errorCode = normalizeOptionalString(record?.errorCode)
    || normalizeOptionalString(record?.codeName)
    || "bridge_runtime_error";
  return {
    code,
    errorCode,
    message,
  };
}

function extractRequestId(rawMessage: string): string | number | null {
  const parsed = safeParseJSON(rawMessage);
  if (!parsed || parsed.id == null) {
    return null;
  }
  if (typeof parsed.id === "string" || typeof parsed.id === "number") {
    return parsed.id;
  }
  return null;
}

function safeParseJSON(rawMessage: string): JsonRecord | null {
  try {
    const parsed = JSON.parse(rawMessage) as unknown;
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
