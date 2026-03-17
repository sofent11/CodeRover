// FILE: runtime-manager/managed-provider-runtime.ts
// Purpose: Typed session/provider shaping helpers for managed runtimes.

import type {
  ManagedSessionMeta,
  RuntimeSessionMetaHelpers,
} from "./types";
import type { RuntimeThreadShape } from "../bridge-types";

type ProviderDefinition = ReturnType<RuntimeSessionMetaHelpers["getRuntimeProvider"]>;
const THREAD_LIST_PREVIEW_LIMIT = 600;

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

export function buildManagedSessionObject(
  sessionMeta: ManagedSessionMeta,
  turns: unknown,
  getRuntimeProvider: (providerId: unknown) => ProviderDefinition
): RuntimeThreadShape {
  const providerDefinition = getRuntimeProvider(sessionMeta.provider);
  return {
    id: sessionMeta.id,
    title: sessionMeta.title,
    name: sessionMeta.name,
    archived: Boolean(sessionMeta.archived),
    preview: truncateThreadPreview(sessionMeta.preview),
    createdAt: sessionMeta.createdAt,
    updatedAt: sessionMeta.updatedAt,
    cwd: sessionMeta.cwd,
    provider: sessionMeta.provider,
    providerSessionId: sessionMeta.providerSessionId,
    capabilities: sessionMeta.capabilities || providerDefinition.supports,
    metadata: {
      ...(sessionMeta.metadata || {}),
      providerTitle: providerDefinition.title,
    },
    ...(Array.isArray(turns) ? { turns } : {}),
  };
}

export function truncateThreadPreview(preview: unknown): string | null {
  if (typeof preview !== "string") {
    return null;
  }
  const normalized = preview.trim();
  if (!normalized) {
    return null;
  }
  if (normalized.length <= THREAD_LIST_PREVIEW_LIMIT) {
    return normalized;
  }
  return `${normalized.slice(0, THREAD_LIST_PREVIEW_LIMIT - 1)}…`;
}

export function sessionObjectToMeta(
  sessionObject: Record<string, unknown>,
  helpers: RuntimeSessionMetaHelpers
): ManagedSessionMeta {
  const providerId = helpers.resolveProviderId(sessionObject);
  return {
    id: helpers.normalizeOptionalString(sessionObject.id) || "",
    provider: providerId as ManagedSessionMeta["provider"],
    providerSessionId: helpers.normalizeOptionalString(sessionObject.providerSessionId)
      || helpers.normalizeOptionalString(sessionObject.id),
    title: helpers.normalizeOptionalString(sessionObject.title),
    name: helpers.normalizeOptionalString(sessionObject.name),
    preview: helpers.normalizeOptionalString(sessionObject.preview),
    cwd: helpers.firstNonEmptyString([sessionObject.cwd]),
    model: helpers.normalizeOptionalString(sessionObject.model),
    metadata: {
      ...(helpers.asObject(sessionObject.metadata) as Record<string, unknown>),
      providerTitle: helpers.getRuntimeProvider(providerId).title,
    },
    capabilities: (sessionObject.capabilities as Record<string, unknown> | null)
      || helpers.getRuntimeProvider(providerId).supports,
    createdAt: String(sessionObject.createdAt || new Date().toISOString()),
    updatedAt: String(sessionObject.updatedAt || new Date().toISOString()),
    archived: Boolean(sessionObject.archived),
  };
}
