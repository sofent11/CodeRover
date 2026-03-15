"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// FILE: runtime-manager/managed-provider-runtime.ts
// Purpose: Shared managed-provider thread shaping helpers for runtime-manager.
function buildProviderMetadata(provider, getRuntimeProvider) {
    return {
        providerTitle: getRuntimeProvider(provider).title,
    };
}
function resolveProviderId(value, normalizeOptionalString) {
    const candidate = normalizeOptionalString(typeof value === "object" && value
        ? value.provider || value.id
        : value);
    if (candidate === "claude" || candidate === "gemini" || candidate === "codex") {
        return candidate;
    }
    return "codex";
}
function stripProviderField(params) {
    if (!params || typeof params !== "object") {
        return params;
    }
    const { provider, ...rest } = params;
    return rest;
}
function buildManagedThreadObject(threadMeta, turns, getRuntimeProvider) {
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
        ...(turns == null ? {} : { turns }),
    };
}
function buildThreadListResult(payload, normalizePositiveInteger) {
    const threads = Array.isArray(payload) ? payload : payload?.threads || [];
    return {
        data: threads,
        items: threads,
        threads,
        ...(Array.isArray(payload)
            ? {}
            : {
                nextCursor: payload?.nextCursor ?? null,
                hasMore: Boolean(payload?.hasMore),
                pageSize: normalizePositiveInteger(payload?.pageSize) || threads.length,
            }),
    };
}
function threadObjectToMeta(threadObject, { asObject, firstNonEmptyString, getRuntimeProvider, normalizeOptionalString, resolveProviderId, }) {
    return {
        id: normalizeOptionalString(threadObject.id),
        provider: resolveProviderId(threadObject),
        providerSessionId: normalizeOptionalString(threadObject.providerSessionId) || normalizeOptionalString(threadObject.id),
        title: normalizeOptionalString(threadObject.title),
        name: normalizeOptionalString(threadObject.name),
        preview: normalizeOptionalString(threadObject.preview),
        cwd: firstNonEmptyString([
            threadObject.cwd,
            threadObject.current_working_directory,
            threadObject.working_directory,
        ]),
        metadata: {
            ...(asObject(threadObject.metadata) || {}),
            providerTitle: getRuntimeProvider(resolveProviderId(threadObject)).title,
        },
        capabilities: threadObject.capabilities || getRuntimeProvider(resolveProviderId(threadObject)).supports,
        createdAt: threadObject.createdAt || threadObject.created_at || new Date().toISOString(),
        updatedAt: threadObject.updatedAt || threadObject.updated_at || new Date().toISOString(),
        archived: Boolean(threadObject.archived),
    };
}
module.exports = {
    buildManagedThreadObject,
    buildProviderMetadata,
    buildThreadListResult,
    resolveProviderId,
    stripProviderField,
    threadObjectToMeta,
};
