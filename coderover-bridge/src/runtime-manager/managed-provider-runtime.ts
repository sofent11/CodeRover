// FILE: runtime-manager/managed-provider-runtime.ts
// Purpose: Typed thread/provider shaping helpers for managed runtimes.

import type {
  ManagedThreadMeta,
  RuntimeThreadListPayload,
  RuntimeThreadMetaHelpers,
} from "./types";
import type { RuntimeThreadShape } from "../bridge-types";

type ProviderDefinition = ReturnType<RuntimeThreadMetaHelpers["getRuntimeProvider"]>;
type ProviderResolver = (value: unknown) => string;
type NormalizePositiveInteger = (value: unknown) => number | null;

export function buildProviderMetadata(
  provider: unknown,
  getRuntimeProvider: (providerId: unknown) => ProviderDefinition
): { providerTitle: string } {
  return {
    providerTitle: getRuntimeProvider(provider).title,
  };
}

export function resolveProviderId(
  value: unknown,
  normalizeOptionalString: (value: unknown) => string | null
): string {
  const candidate = normalizeOptionalString(
    typeof value === "object" && value
      ? (value as Record<string, unknown>).provider ?? (value as Record<string, unknown>).id
      : value
  );
  if (candidate === "claude" || candidate === "gemini" || candidate === "codex") {
    return candidate;
  }
  return "codex";
}

export function stripProviderField<TValue>(params: TValue): Omit<TValue, "provider"> | TValue {
  if (!params || typeof params !== "object") {
    return params;
  }
  const { provider: _provider, ...rest } = params as TValue & { provider?: unknown };
  return rest as Omit<TValue, "provider">;
}

export function buildManagedThreadObject(
  threadMeta: ManagedThreadMeta,
  turns: unknown,
  getRuntimeProvider: (providerId: unknown) => ProviderDefinition
): RuntimeThreadShape {
  const providerDefinition = getRuntimeProvider(threadMeta.provider);
  return {
    id: threadMeta.id,
    title: threadMeta.title,
    name: threadMeta.name,
    preview: threadMeta.preview,
    createdAt: threadMeta.createdAt,
    updatedAt: threadMeta.updatedAt,
    cwd: threadMeta.cwd,
    provider: threadMeta.provider,
    providerSessionId: threadMeta.providerSessionId,
    capabilities: threadMeta.capabilities || providerDefinition.supports,
    metadata: {
      ...(threadMeta.metadata || {}),
      providerTitle: providerDefinition.title,
    },
    ...(Array.isArray(turns) ? { turns } : {}),
  };
}

export function buildThreadListResult(
  payload: RuntimeThreadListPayload | RuntimeThreadShape[],
  normalizePositiveInteger: NormalizePositiveInteger
): {
  data: RuntimeThreadShape[];
  items: RuntimeThreadShape[];
  threads: RuntimeThreadShape[];
  nextCursor?: string | number | null;
  hasMore?: boolean;
  pageSize?: number;
} {
  const threads = Array.isArray(payload) ? payload : payload.threads || [];
  return {
    data: threads,
    items: threads,
    threads,
    ...(Array.isArray(payload)
      ? {}
      : {
        nextCursor: payload.nextCursor ?? null,
        hasMore: Boolean(payload.hasMore),
        pageSize: normalizePositiveInteger(payload.pageSize) || threads.length,
      }),
  };
}

export function threadObjectToMeta(
  threadObject: Record<string, unknown>,
  helpers: RuntimeThreadMetaHelpers
): ManagedThreadMeta {
  const providerId = helpers.resolveProviderId(threadObject);
  return {
    id: helpers.normalizeOptionalString(threadObject.id) || "",
    provider: providerId as ManagedThreadMeta["provider"],
    providerSessionId: helpers.normalizeOptionalString(threadObject.providerSessionId)
      || helpers.normalizeOptionalString(threadObject.id),
    title: helpers.normalizeOptionalString(threadObject.title),
    name: helpers.normalizeOptionalString(threadObject.name),
    preview: helpers.normalizeOptionalString(threadObject.preview),
    cwd: helpers.firstNonEmptyString([
      threadObject.cwd,
      threadObject.current_working_directory,
      threadObject.working_directory,
    ]),
    model: helpers.normalizeOptionalString(threadObject.model),
    metadata: {
      ...(helpers.asObject(threadObject.metadata) as Record<string, unknown>),
      providerTitle: helpers.getRuntimeProvider(providerId).title,
    },
    capabilities: (threadObject.capabilities as Record<string, unknown> | null)
      || helpers.getRuntimeProvider(providerId).supports,
    createdAt: String(threadObject.createdAt || threadObject.created_at || new Date().toISOString()),
    updatedAt: String(threadObject.updatedAt || threadObject.updated_at || new Date().toISOString()),
    archived: Boolean(threadObject.archived),
  };
}
