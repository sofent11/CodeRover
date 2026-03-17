// FILE: runtime-manager/normalizers.ts
// Purpose: Typed normalization helpers for runtime-manager payload parsing and shaping.

import type {
  PlanModeStateShape,
  RuntimeInputItem,
  RuntimeSkillInputItem,
} from "../bridge-types";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function normalizeStringField(record: UnknownRecord, keys: string[]): string | null {
  for (const key of keys) {
    const normalized = normalizeOptionalString(record[key]);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

export function normalizeInputItems(input: unknown): RuntimeInputItem[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map((entry) => normalizeInputItem(entry))
    .filter((entry): entry is RuntimeInputItem => entry !== null);
}

export function normalizeInputItem(entry: unknown): RuntimeInputItem | null {
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
    const skill: RuntimeSkillInputItem = {
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
  } as RuntimeInputItem;
}

export function normalizeInputType(value: unknown): string {
  const normalized = normalizeNonEmptyString(value).toLowerCase().replace(/[_-]/g, "");
  if (normalized === "image" || normalized === "localimage" || normalized === "inputimage") {
    return "image";
  }
  if (normalized === "skill") {
    return "skill";
  }
  return "text";
}

export function normalizePlanState(planState: unknown): PlanModeStateShape {
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
    .filter((entry): entry is { step: string; status: string } => entry !== null);

  return {
    explanation,
    steps,
  };
}

export function buildCommandPreview(
  command: unknown,
  status: unknown,
  exitCode: unknown
): string {
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

export function normalizeOptionalString(value: unknown): string | null {
  const normalized = normalizeNonEmptyString(value);
  return normalized || null;
}

export function normalizeNonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function firstNonEmptyString(values: unknown[]): string | null {
  for (const value of values) {
    const normalized = normalizeOptionalString(value);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

export function asObject(value: unknown): UnknownRecord {
  return asRecord(value) || {};
}

export function extractArray(
  value: unknown,
  candidatePaths: string[],
  readPath: (root: unknown, path: string) => unknown
): unknown[] {
  if (!value) {
    return [];
  }

  for (const candidatePath of candidatePaths) {
    const candidateValue = readPath(value, candidatePath);
    if (Array.isArray(candidateValue)) {
      return candidateValue;
    }
  }

  return [];
}

export function readPath(root: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = root;
  for (const part of parts) {
    if (!current || typeof current !== "object") {
      return null;
    }
    current = (current as UnknownRecord)[part];
  }
  return current;
}

export function normalizeTimestampString(value: unknown): string | null {
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

export function normalizePositiveInteger(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return null;
  }
  return numeric;
}
