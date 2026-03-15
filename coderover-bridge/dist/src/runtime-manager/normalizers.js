"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// FILE: runtime-manager/normalizers.ts
// Purpose: Shared normalization helpers for runtime-manager request parsing and payload shaping.
function normalizeInputItems(input) {
    if (!Array.isArray(input)) {
        return [];
    }
    return input
        .map((entry) => normalizeInputItem(entry))
        .filter(Boolean);
}
function normalizeInputItem(entry) {
    if (!entry || typeof entry !== "object") {
        return null;
    }
    const type = normalizeInputType(entry.type);
    if (type === "text") {
        const text = normalizeOptionalString(entry.text || entry.message || entry.content);
        return text ? { type: "text", text } : null;
    }
    if (type === "image") {
        const url = normalizeOptionalString(entry.image_url || entry.url || entry.path);
        if (!url) {
            return null;
        }
        return {
            type: entry.path ? "local_image" : "image",
            ...(entry.path ? { path: entry.path } : { image_url: url }),
            ...(entry.path ? {} : { url }),
        };
    }
    if (type === "skill") {
        const id = normalizeOptionalString(entry.id);
        if (!id) {
            return null;
        }
        return {
            type: "skill",
            id,
            ...(normalizeOptionalString(entry.name) ? { name: entry.name.trim() } : {}),
            ...(normalizeOptionalString(entry.path) ? { path: entry.path.trim() } : {}),
        };
    }
    return {
        type,
        ...entry,
    };
}
function normalizeInputType(value) {
    const normalized = normalizeNonEmptyString(value).toLowerCase().replace(/[_-]/g, "");
    if (normalized === "image" || normalized === "localimage" || normalized === "inputimage") {
        return "image";
    }
    if (normalized === "skill") {
        return "skill";
    }
    return "text";
}
function normalizePlanState(planState) {
    if (!planState || typeof planState !== "object") {
        return {
            explanation: null,
            steps: [],
        };
    }
    const explanation = normalizeOptionalString(planState.explanation || planState.summary);
    const steps = Array.isArray(planState.steps)
        ? planState.steps
            .map((entry) => {
            if (!entry || typeof entry !== "object") {
                return null;
            }
            const step = normalizeOptionalString(entry.step);
            const status = normalizeOptionalString(entry.status);
            if (!step || !status) {
                return null;
            }
            return { step, status };
        })
            .filter(Boolean)
        : [];
    return {
        explanation,
        steps,
    };
}
function buildCommandPreview(command, status, exitCode) {
    const shortCommand = normalizeOptionalString(command) || "command";
    const normalizedStatus = normalizeOptionalString(status) || "running";
    const label = normalizedStatus === "completed"
        ? "Completed"
        : normalizedStatus === "failed"
            ? "Failed"
            : normalizedStatus === "stopped"
                ? "Stopped"
                : "Running";
    if (typeof exitCode === "number") {
        return `${label} ${shortCommand} (exit ${exitCode})`;
    }
    return `${label} ${shortCommand}`;
}
function normalizeOptionalString(value) {
    const normalized = normalizeNonEmptyString(value);
    return normalized || null;
}
function normalizeNonEmptyString(value) {
    if (typeof value !== "string") {
        return "";
    }
    return value.trim();
}
function firstNonEmptyString(values) {
    for (const value of values) {
        const normalized = normalizeOptionalString(value);
        if (normalized) {
            return normalized;
        }
    }
    return null;
}
function asObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return {};
    }
    return value;
}
function normalizeTimestampString(value) {
    if (value == null) {
        return null;
    }
    if (typeof value === "number") {
        return new Date(value > 10_000_000_000 ? value : value * 1000).toISOString();
    }
    if (typeof value !== "string") {
        return null;
    }
    const normalized = value.trim();
    if (!normalized) {
        return null;
    }
    const asNumber = Number(normalized);
    if (Number.isFinite(asNumber)) {
        return normalizeTimestampString(asNumber);
    }
    const parsed = Date.parse(normalized);
    if (Number.isNaN(parsed)) {
        return null;
    }
    return new Date(parsed).toISOString();
}
function normalizePositiveInteger(value) {
    const numeric = Number(value);
    if (!Number.isInteger(numeric) || numeric <= 0) {
        return null;
    }
    return numeric;
}
module.exports = {
    asObject,
    buildCommandPreview,
    firstNonEmptyString,
    normalizeInputItem,
    normalizeInputItems,
    normalizeInputType,
    normalizeNonEmptyString,
    normalizeOptionalString,
    normalizePlanState,
    normalizePositiveInteger,
    normalizeTimestampString,
};
