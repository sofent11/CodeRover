"use strict";
// FILE: runtime-manager/managed-provider-runtime.ts
// Purpose: Typed thread/provider shaping helpers for managed runtimes.
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildProviderMetadata = buildProviderMetadata;
exports.resolveProviderId = resolveProviderId;
exports.stripProviderField = stripProviderField;
exports.buildManagedThreadObject = buildManagedThreadObject;
exports.buildThreadListResult = buildThreadListResult;
exports.threadObjectToMeta = threadObjectToMeta;
function buildProviderMetadata(provider, getRuntimeProvider) {
    return {
        providerTitle: getRuntimeProvider(provider).title,
    };
}
function resolveProviderId(value, normalizeOptionalString) {
    const candidate = normalizeOptionalString(typeof value === "object" && value
        ? value.provider ?? value.id
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
    const { provider: _provider, ...rest } = params;
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
        ...(Array.isArray(turns) ? { turns } : {}),
    };
}
function buildThreadListResult(payload, normalizePositiveInteger) {
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
function threadObjectToMeta(threadObject, helpers) {
    const providerId = helpers.resolveProviderId(threadObject);
    return {
        id: helpers.normalizeOptionalString(threadObject.id) || "",
        provider: providerId,
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
        metadata: {
            ...helpers.asObject(threadObject.metadata),
            providerTitle: helpers.getRuntimeProvider(providerId).title,
        },
        capabilities: threadObject.capabilities
            || helpers.getRuntimeProvider(providerId).supports,
        createdAt: String(threadObject.createdAt || threadObject.created_at || new Date().toISOString()),
        updatedAt: String(threadObject.updatedAt || threadObject.updated_at || new Date().toISOString()),
        archived: Boolean(threadObject.archived),
    };
}
