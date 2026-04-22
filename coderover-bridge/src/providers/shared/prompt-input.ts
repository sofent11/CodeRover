// FILE: providers/shared/prompt-input.ts
// Purpose: Builds text-plus-image prompts from runtime input items and materializes inline images.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";

import type { RuntimeInputItem } from "../../bridge-types";
import { readFirstString } from "./provider-utils";

export async function buildPathPromptFromInputItems(
  inputItems: RuntimeInputItem[],
  {
    cwd,
    imageTempDirName,
  }: {
    cwd: string | null | undefined;
    imageTempDirName: string;
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
  }: {
    cwd: string | null | undefined;
    imageTempDirName: string;
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
    return source;
  }

  const extension = mimeType.split("/")[1] || "png";
  const tempDir = path.join(cwd || os.tmpdir(), ".coderover", imageTempDirName);
  fs.mkdirSync(tempDir, { recursive: true });
  const filePath = path.join(tempDir, `${Date.now()}-${randomUUID()}.${extension}`);
  fs.writeFileSync(filePath, Buffer.from(base64, "base64"));
  return filePath;
}

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
