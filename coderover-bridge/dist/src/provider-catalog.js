"use strict";
// FILE: provider-catalog.ts
// Purpose: Shared provider capability and static model catalog for multi-runtime support.
Object.defineProperty(exports, "__esModule", { value: true });
exports.listRuntimeProviders = listRuntimeProviders;
exports.getRuntimeProvider = getRuntimeProvider;
exports.listStaticModelsForProvider = listStaticModelsForProvider;
exports.normalizeProvider = normalizeProvider;
const ACCESS_MODE_ON_REQUEST = {
    id: "on-request",
    title: "On-Request",
};
const ACCESS_MODE_FULL_ACCESS = {
    id: "full-access",
    title: "Full access",
};
const SHARED_ACCESS_MODES = [
    ACCESS_MODE_ON_REQUEST,
    ACCESS_MODE_FULL_ACCESS,
];
const PROVIDERS = {
    codex: {
        id: "codex",
        title: "Codex",
        defaultModelId: null,
        supports: {
            planMode: true,
            structuredUserInput: true,
            inlineApproval: true,
            turnSteer: true,
            reasoningOptions: true,
            desktopRefresh: true,
        },
        accessModes: SHARED_ACCESS_MODES,
    },
    claude: {
        id: "claude",
        title: "Claude Code",
        defaultModelId: "sonnet",
        supports: {
            planMode: true,
            structuredUserInput: true,
            inlineApproval: true,
            turnSteer: false,
            reasoningOptions: true,
            desktopRefresh: false,
        },
        accessModes: SHARED_ACCESS_MODES,
    },
    gemini: {
        id: "gemini",
        title: "Gemini CLI",
        defaultModelId: "gemini-2.5-flash",
        supports: {
            planMode: false,
            structuredUserInput: false,
            inlineApproval: false,
            turnSteer: false,
            reasoningOptions: false,
            desktopRefresh: false,
        },
        accessModes: SHARED_ACCESS_MODES,
    },
};
const STATIC_MODELS = {
    claude: [
        buildModel({
            id: "sonnet",
            title: "Sonnet",
            isDefault: true,
            efforts: ["low", "medium", "high"],
            defaultReasoningEffort: "medium",
            description: "Balanced Claude Code model.",
        }),
        buildModel({
            id: "opus",
            title: "Opus",
            efforts: ["low", "medium", "high", "max"],
            defaultReasoningEffort: "high",
            description: "Higher capability Claude model.",
        }),
        buildModel({
            id: "haiku",
            title: "Haiku",
            efforts: ["low", "medium"],
            defaultReasoningEffort: "low",
            description: "Faster Claude model.",
        }),
        buildModel({
            id: "opusplan",
            model: "opusplan",
            title: "Opus Plan",
            efforts: ["low", "medium", "high"],
            defaultReasoningEffort: "medium",
            description: "Plan-oriented Claude configuration.",
        }),
        buildModel({
            id: "sonnet[1m]",
            model: "sonnet[1m]",
            title: "Sonnet [1M]",
            efforts: ["medium", "high"],
            defaultReasoningEffort: "medium",
            description: "Claude Sonnet with 1M-context mode.",
        }),
    ],
    gemini: [
        buildModel({
            id: "gemini-3.1-pro-preview",
            title: "Gemini 3.1 Pro Preview",
            description: "Latest Gemini Pro preview model.",
        }),
        buildModel({
            id: "gemini-3-pro-preview",
            title: "Gemini 3 Pro Preview",
            description: "Gemini Pro preview model.",
        }),
        buildModel({
            id: "gemini-3-flash-preview",
            title: "Gemini 3 Flash Preview",
            description: "Fast Gemini preview model.",
        }),
        buildModel({
            id: "gemini-2.5-flash",
            title: "Gemini 2.5 Flash",
            isDefault: true,
            description: "Default Gemini CLI model.",
        }),
        buildModel({
            id: "gemini-2.5-pro",
            title: "Gemini 2.5 Pro",
            description: "Higher capability Gemini model.",
        }),
        buildModel({
            id: "gemini-2.0-flash-lite",
            title: "Gemini 2.0 Flash Lite",
            description: "Lower-latency Gemini model.",
        }),
        buildModel({
            id: "gemini-2.0-flash",
            title: "Gemini 2.0 Flash",
            description: "Balanced Gemini Flash model.",
        }),
        buildModel({
            id: "gemini-2.0-pro-exp",
            title: "Gemini 2.0 Pro Experimental",
            description: "Experimental Gemini Pro model.",
        }),
    ],
};
function listRuntimeProviders() {
    return Object.values(PROVIDERS).map(cloneProvider);
}
function getRuntimeProvider(providerId) {
    const normalizedProvider = normalizeProvider(providerId);
    return cloneProvider(PROVIDERS[normalizedProvider]);
}
function listStaticModelsForProvider(providerId) {
    const normalizedProvider = normalizeProvider(providerId);
    const models = normalizedProvider === "codex" ? [] : STATIC_MODELS[normalizedProvider];
    return models.map((entry) => ({
        ...entry,
        supportedReasoningEfforts: entry.supportedReasoningEfforts.map(cloneReasoningEffort),
    }));
}
function normalizeProvider(value) {
    const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (normalized === "claude" || normalized === "gemini" || normalized === "codex") {
        return normalized;
    }
    return "codex";
}
function cloneProvider(provider) {
    return {
        ...provider,
        supports: { ...provider.supports },
        accessModes: provider.accessModes.map((entry) => ({ ...entry })),
    };
}
function cloneReasoningEffort(entry) {
    return { ...entry };
}
function buildModel({ id, model = id, title, description = "", isDefault = false, efforts = [], defaultReasoningEffort = null, }) {
    return {
        id,
        model,
        title,
        displayName: title,
        description,
        isDefault,
        supportedReasoningEfforts: efforts.map((effort) => ({
            reasoningEffort: effort,
            description: `${effort} reasoning`,
        })),
        defaultReasoningEffort,
    };
}
