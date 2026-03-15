"use strict";
// FILE: runtime-manager/normalizers.ts
// Purpose: Typed normalization helpers for runtime-manager payload parsing and shaping.
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeInputItems = normalizeInputItems;
exports.normalizeInputItem = normalizeInputItem;
exports.normalizeInputType = normalizeInputType;
exports.normalizePlanState = normalizePlanState;
exports.buildCommandPreview = buildCommandPreview;
exports.normalizeOptionalString = normalizeOptionalString;
exports.normalizeNonEmptyString = normalizeNonEmptyString;
exports.firstNonEmptyString = firstNonEmptyString;
exports.asObject = asObject;
exports.normalizeTimestampString = normalizeTimestampString;
exports.normalizePositiveInteger = normalizePositiveInteger;
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : null;
}
function normalizeStringField(record, keys) {
    for (const key of keys) {
        const normalized = normalizeOptionalString(record[key]);
        if (normalized) {
            return normalized;
        }
    }
    return null;
}
function normalizeInputItems(input) {
    if (!Array.isArray(input)) {
        return [];
    }
    return input
        .map((entry) => normalizeInputItem(entry))
        .filter((entry) => entry !== null);
}
function normalizeInputItem(entry) {
    const record = asRecord(entry);
    if (!record) {
        return null;
    }
    const type = normalizeInputType(record.type);
    if (type === "text") {
        const text = normalizeStringField(record, ["text", "message", "content"]);
        return text ? { type: "text", text } : null;
    }
    if (type === "image") {
        const url = normalizeStringField(record, ["image_url", "url", "path"]);
        const path = normalizeOptionalString(record.path);
        if (!url) {
            return null;
        }
        return path
            ? { type: "local_image", path }
            : { type: "image", image_url: url, url };
    }
    if (type === "skill") {
        const id = normalizeOptionalString(record.id);
        if (!id) {
            return null;
        }
        const skill = {
            type: "skill",
            id,
        };
        const name = normalizeOptionalString(record.name);
        const path = normalizeOptionalString(record.path);
        if (name) {
            skill.name = name;
        }
        if (path) {
            skill.path = path;
        }
        return skill;
    }
    return {
        type,
        ...record,
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
    const record = asRecord(planState);
    if (!record) {
        return {
            explanation: null,
            steps: [],
        };
    }
    const explanation = normalizeStringField(record, ["explanation", "summary"]);
    const rawSteps = Array.isArray(record.steps) ? record.steps : [];
    const steps = rawSteps
        .map((entry) => {
        const stepRecord = asRecord(entry);
        if (!stepRecord) {
            return null;
        }
        const step = normalizeOptionalString(stepRecord.step);
        const status = normalizeOptionalString(stepRecord.status);
        if (!step || !status) {
            return null;
        }
        return { step, status };
    })
        .filter((entry) => entry !== null);
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
    return typeof exitCode === "number"
        ? `${label} ${shortCommand} (exit ${exitCode})`
        : `${label} ${shortCommand}`;
}
function normalizeOptionalString(value) {
    const normalized = normalizeNonEmptyString(value);
    return normalized || null;
}
function normalizeNonEmptyString(value) {
    return typeof value === "string" ? value.trim() : "";
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
    return asRecord(value) || {};
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
