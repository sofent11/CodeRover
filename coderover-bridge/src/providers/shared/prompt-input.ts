// FILE: providers/shared/prompt-input.ts
// Purpose: Builds text-plus-image prompts from runtime input items and materializes inline images.

import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

import type { RuntimeInputItem } from "../../bridge-types";
import { resolveCoderoverHome } from "../../bridge-daemon-state";
import { readFirstString } from "./provider-utils";

export async function buildPathPromptFromInputItems(
  inputItems: RuntimeInputItem[],
  {
    cwd,
    imageTempDirName,
    turnId = null,
  }: {
    cwd: string | null | undefined;
    imageTempDirName: string;
    turnId?: string | null;
  }
): Promise<string> {
  const textChunks: string[] = [];
  const imagePaths: string[] = [];

  for (const item of inputItems) {
    if (isTextInputItem(item)) {
      textChunks.push(item.text);
      continue;
    }

    if (isSkillInputItem(item)) {
      textChunks.push(`$${item.id}`);
      continue;
    }

    if (isImageInputItem(item)) {
      const source = readFirstString([item.path, item.url, item.image_url]);
      const imagePath = source
        ? await materializeImageInput(source, {
          cwd,
          imageTempDirName,
          turnId,
        })
        : null;
      if (imagePath) {
        imagePaths.push(imagePath);
      }
    }
  }

  let prompt = textChunks.join("\n").trim();
  if (imagePaths.length > 0) {
    prompt = `${prompt}\n\n[Images provided at paths]\n${imagePaths.join("\n")}`.trim();
  }
  return prompt;
}

export async function materializeImageInput(
  source: string,
  {
    cwd,
    imageTempDirName,
    turnId = null,
  }: {
    cwd: string | null | undefined;
    imageTempDirName: string;
    turnId?: string | null;
  }
): Promise<string | null> {
  if (!source.trim()) {
    return null;
  }

  if (path.isAbsolute(source) && fs.existsSync(source)) {
    return source;
  }

  const match = source.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    return source;
  }

  const mimeType = match[1];
  const base64 = match[2];
  if (!mimeType || !base64) {
    return null;
  }
  if (!isAllowedInlineImageMimeType(mimeType)) {
    return null;
  }

  const imageBytes = Buffer.from(base64, "base64");
  if (imageBytes.length === 0 || imageBytes.length > MAX_INLINE_IMAGE_BYTES) {
    return null;
  }

  const extension = extensionForMimeType(mimeType);
  const tempDir = materializedImageTempDir({ imageTempDirName, turnId });
  pruneOldMaterializedImages(path.dirname(tempDir));
  fs.mkdirSync(tempDir, { recursive: true, mode: 0o700 });
  const filePath = path.join(tempDir, `${Date.now()}-${randomUUID()}.${extension}`);
  fs.writeFileSync(filePath, imageBytes, { mode: 0o600 });
  return filePath;
}

export function cleanupMaterializedImageInputs({
  imageTempDirName,
  turnId,
}: {
  imageTempDirName: string;
  turnId?: string | null;
}): void {
  const normalizedTurnId = sanitizePathSegment(turnId || "unscoped");
  const targetDir = path.join(
    resolveCoderoverHome(),
    "tmp",
    "provider-images",
    sanitizePathSegment(imageTempDirName),
    normalizedTurnId
  );
  fs.rmSync(targetDir, { recursive: true, force: true });
}

const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;
const MATERIALIZED_IMAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ALLOWED_INLINE_IMAGE_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function isTextInputItem(item: RuntimeInputItem): item is Extract<RuntimeInputItem, { type: "text" }> {
  return item.type === "text" && typeof item.text === "string" && item.text.length > 0;
}

function isSkillInputItem(item: RuntimeInputItem): item is Extract<RuntimeInputItem, { type: "skill" }> {
  return item.type === "skill" && typeof item.id === "string" && item.id.length > 0;
}

function isImageInputItem(
  item: RuntimeInputItem
): item is Extract<RuntimeInputItem, { type: "image" | "local_image" }> {
  return (item.type === "image" || item.type === "local_image")
    && (typeof item.path === "string"
      || typeof item.url === "string"
      || typeof item.image_url === "string");
}

function materializedImageTempDir({
  imageTempDirName,
  turnId,
}: {
  imageTempDirName: string;
  turnId?: string | null;
}): string {
  return path.join(
    resolveCoderoverHome(),
    "tmp",
    "provider-images",
    sanitizePathSegment(imageTempDirName),
    sanitizePathSegment(turnId || "unscoped")
  );
}

function isAllowedInlineImageMimeType(mimeType: string): boolean {
  return ALLOWED_INLINE_IMAGE_MIME_TYPES.has(mimeType.trim().toLowerCase());
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType.trim().toLowerCase()) {
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "png";
  }
}

function sanitizePathSegment(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  const safe = normalized.replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-");
  return safe || "unscoped";
}

function pruneOldMaterializedImages(rootDir: string): void {
  const now = Date.now();
  for (const entry of safeReaddir(rootDir)) {
    const entryPath = path.join(rootDir, entry);
    const stats = safeStat(entryPath);
    if (!stats) {
      continue;
    }
    if ((now - stats.mtimeMs) > MATERIALIZED_IMAGE_MAX_AGE_MS) {
      fs.rmSync(entryPath, { recursive: true, force: true });
    }
  }
}

function safeReaddir(directory: string): string[] {
  try {
    return fs.readdirSync(directory);
  } catch {
    return [];
  }
}

function safeStat(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}
