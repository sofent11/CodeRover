// FILE: atomic-json-file.ts
// Purpose: Shared local JSON persistence with atomic replacement and backup recovery.

import * as fs from "fs";
import * as path from "path";

export interface AtomicJsonWriteOptions {
  backup?: boolean;
  directoryMode?: number;
  fileMode?: number;
}

const DEFAULT_DIRECTORY_MODE = 0o700;
const DEFAULT_FILE_MODE = 0o600;

export function readJsonFileWithBackup(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (primaryError) {
    const backupPath = backupFilePath(filePath);
    if (!fs.existsSync(backupPath)) {
      throw primaryError;
    }
    return JSON.parse(fs.readFileSync(backupPath, "utf8"));
  }
}

export function writeJsonFileAtomic(
  filePath: string,
  value: unknown,
  {
    backup = true,
    directoryMode = DEFAULT_DIRECTORY_MODE,
    fileMode = DEFAULT_FILE_MODE,
  }: AtomicJsonWriteOptions = {}
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: directoryMode });
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  const backupPath = backupFilePath(filePath);

  const fd = fs.openSync(tempPath, "w", fileMode);
  try {
    fs.writeFileSync(fd, payload);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  if (backup && fs.existsSync(filePath)) {
    try {
      fs.copyFileSync(filePath, backupPath);
      fs.chmodSync(backupPath, fileMode);
    } catch {
      // Backup creation should not block the primary state write.
    }
  }

  fs.renameSync(tempPath, filePath);
  try {
    fs.chmodSync(filePath, fileMode);
  } catch {
    // Best-effort on filesystems that do not support POSIX modes.
  }
  fsyncDirectoryBestEffort(path.dirname(filePath));
}

function backupFilePath(filePath: string): string {
  return `${filePath}.bak`;
}

function fsyncDirectoryBestEffort(directoryPath: string): void {
  let directoryFd: number | null = null;
  try {
    directoryFd = fs.openSync(directoryPath, "r");
    fs.fsyncSync(directoryFd);
  } catch {
    // Directory fsync is not available on every filesystem/platform.
  } finally {
    if (directoryFd != null) {
      try {
        fs.closeSync(directoryFd);
      } catch {
        // Ignore close failures for best-effort durability.
      }
    }
  }
}
