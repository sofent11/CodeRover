// FILE: workspace-handler.ts
// Purpose: Executes workspace-scoped reverse patch previews/applies without touching unrelated repo changes.

import { execFile, type ExecFileException } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { gitStatus } from "./git-handler";

const GIT_TIMEOUT_MS = 30_000;
const repoMutationLocks = new Map<string, Promise<void>>();

type SendResponse = (response: string) => void;

interface WorkspaceRequestParams extends Record<string, unknown> {
  cwd?: unknown;
  currentWorkingDirectory?: unknown;
  forwardPatch?: unknown;
}

interface ParsedWorkspaceRequest {
  method?: unknown;
  id?: unknown;
  params?: WorkspaceRequestParams;
}

interface WorkspaceHandlerError extends Error {
  errorCode: string;
  userMessage: string;
}

interface WorkspaceConflict {
  path: string;
  message: string;
}

interface WorkspacePatchAnalysis {
  affectedFiles: string[];
  unsupportedReasons: string[];
}

interface WorkspacePreviewResult {
  canRevert: boolean;
  affectedFiles: string[];
  conflicts: WorkspaceConflict[];
  unsupportedReasons: string[];
  stagedFiles: string[];
}

interface WorkspaceApplyResult {
  success: boolean;
  revertedFiles: string[];
  conflicts: WorkspaceConflict[];
  unsupportedReasons: string[];
  stagedFiles: string[];
  status?: Awaited<ReturnType<typeof gitStatus>> | null;
}

interface PatchApplyResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

type GitExecError = Error & {
  code?: ExecFileException["code"];
  stdout?: string | Buffer;
  stderr?: string | Buffer;
};

export function handleWorkspaceRequest(rawMessage: string, sendResponse: SendResponse): boolean {
  const parsed = parseWorkspaceRequest(rawMessage);
  if (!parsed) {
    return false;
  }

  const method = normalizeWorkspaceMethod(parsed.method);
  if (!method) {
    return false;
  }

  const id = parsed.id;
  const params = parsed.params || {};

  handleWorkspaceMethod(method, params)
    .then((result) => {
      sendResponse(JSON.stringify({ id, result }));
    })
    .catch((error: WorkspaceHandlerError) => {
      sendResponse(JSON.stringify({
        id,
        error: {
          code: -32000,
          message: error.userMessage || error.message || "Unknown workspace error",
          data: {
            errorCode: error.errorCode || "workspace_error",
          },
        },
      }));
    });

  return true;
}

function normalizeWorkspaceMethod(value: unknown): string | null {
  const method = typeof value === "string" ? value.trim() : "";
  if (!method) {
    return null;
  }
  if (method.startsWith("_coderover/workspace/")) {
    return method.replace(/^_coderover\//, "");
  }
  return null;
}

function parseWorkspaceRequest(rawMessage: string): ParsedWorkspaceRequest | null {
  try {
    return JSON.parse(rawMessage) as ParsedWorkspaceRequest;
  } catch {
    return null;
  }
}

async function handleWorkspaceMethod(
  method: string,
  params: WorkspaceRequestParams
): Promise<WorkspacePreviewResult | WorkspaceApplyResult> {
  const cwd = await resolveWorkspaceCwd(params);
  const repoRoot = await resolveRepoRoot(cwd);

  switch (method) {
    case "workspace/revertPatchPreview":
      return workspaceRevertPatchPreview(repoRoot, params);
    case "workspace/revertPatchApply":
      return withRepoMutationLock(repoRoot, () => workspaceRevertPatchApply(repoRoot, params));
    default:
      throw workspaceError("unknown_method", `Unknown workspace method: ${method}`);
  }
}

async function workspaceRevertPatchPreview(
  repoRoot: string,
  params: WorkspaceRequestParams
): Promise<WorkspacePreviewResult> {
  const forwardPatch = resolveForwardPatch(params);
  const analysis = analyzeUnifiedPatch(forwardPatch);
  const stagedFiles = await findStagedTargetedFiles(repoRoot, analysis.affectedFiles);

  if (analysis.unsupportedReasons.length || stagedFiles.length) {
    return {
      canRevert: false,
      affectedFiles: analysis.affectedFiles,
      conflicts: [],
      unsupportedReasons: analysis.unsupportedReasons,
      stagedFiles,
    };
  }

  const applyCheck = await runGitApply(repoRoot, ["apply", "--reverse", "--check"], forwardPatch);
  const conflicts = applyCheck.ok
    ? []
    : parseApplyConflicts(applyCheck.stderr || applyCheck.stdout || "Patch does not apply.");

  return {
    canRevert: applyCheck.ok && conflicts.length === 0,
    affectedFiles: analysis.affectedFiles,
    conflicts,
    unsupportedReasons: [],
    stagedFiles,
  };
}

async function workspaceRevertPatchApply(
  repoRoot: string,
  params: WorkspaceRequestParams
): Promise<WorkspaceApplyResult> {
  const preview = await workspaceRevertPatchPreview(repoRoot, params);
  if (!preview.canRevert) {
    return {
      success: false,
      revertedFiles: [],
      conflicts: preview.conflicts,
      unsupportedReasons: preview.unsupportedReasons,
      stagedFiles: preview.stagedFiles,
    };
  }

  const forwardPatch = resolveForwardPatch(params);
  const applyResult = await runGitApply(repoRoot, ["apply", "--reverse"], forwardPatch);
  if (!applyResult.ok) {
    return {
      success: false,
      revertedFiles: [],
      conflicts: parseApplyConflicts(applyResult.stderr || applyResult.stdout || "Patch does not apply."),
      unsupportedReasons: [],
      stagedFiles: [],
      status: await gitStatus(repoRoot).catch(() => null),
    };
  }

  return {
    success: true,
    revertedFiles: preview.affectedFiles,
    conflicts: [],
    unsupportedReasons: [],
    stagedFiles: [],
    status: await gitStatus(repoRoot).catch(() => null),
  };
}

function resolveForwardPatch(params: WorkspaceRequestParams): string {
  const forwardPatch = typeof params.forwardPatch === "string" ? params.forwardPatch : "";
  if (!forwardPatch.trim()) {
    throw workspaceError("missing_patch", "The request must include a non-empty forwardPatch.");
  }
  return forwardPatch.endsWith("\n") ? forwardPatch : `${forwardPatch}\n`;
}

function analyzeUnifiedPatch(rawPatch: string): WorkspacePatchAnalysis {
  const patch = rawPatch.trim();
  if (!patch) {
    return {
      affectedFiles: [],
      unsupportedReasons: ["No exact patch was captured."],
    };
  }

  const chunks = splitPatchIntoChunks(patch);
  if (!chunks.length) {
    return {
      affectedFiles: [],
      unsupportedReasons: ["No exact patch was captured."],
    };
  }

  const affectedFiles: string[] = [];
  const unsupportedReasons = new Set<string>();

  for (const chunk of chunks) {
    const analysis = analyzePatchChunk(chunk);
    if (analysis.path) {
      affectedFiles.push(analysis.path);
    }
    for (const reason of analysis.unsupportedReasons) {
      unsupportedReasons.add(reason);
    }
  }

  if (!affectedFiles.length) {
    unsupportedReasons.add("No exact patch was captured.");
  }

  return {
    affectedFiles: [...new Set(affectedFiles)].sort(),
    unsupportedReasons: [...unsupportedReasons].sort(),
  };
}

function splitPatchIntoChunks(patch: string): string[][] {
  const lines = patch.split("\n");
  if (!lines.length) {
    return [];
  }

  const chunks: string[][] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (line.startsWith("diff --git ") && current.length) {
      chunks.push(current);
      current = [];
    }
    current.push(line);
  }

  if (current.length) {
    chunks.push(current);
  }

  return chunks;
}

function analyzePatchChunk(lines: string[]): { path: string; unsupportedReasons: string[] } {
  const pathValue = extractPatchPath(lines);
  const isBinary = lines.some((line) => line.startsWith("Binary files ") || line === "GIT binary patch");
  const isRenameOrModeOnly = lines.some((line) =>
    line.startsWith("rename from ")
      || line.startsWith("rename to ")
      || line.startsWith("copy from ")
      || line.startsWith("copy to ")
      || line.startsWith("old mode ")
      || line.startsWith("new mode ")
      || line.startsWith("similarity index ")
      || line.startsWith("new file mode 120")
      || line.startsWith("deleted file mode 120")
  );

  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      additions += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions += 1;
    }
  }

  const unsupportedReasons: string[] = [];
  if (isBinary) {
    unsupportedReasons.push("Binary changes are not auto-revertable in v1.");
  }
  if (isRenameOrModeOnly) {
    unsupportedReasons.push("Rename, mode-only, or symlink changes are not auto-revertable in v1.");
  }
  if (
    !pathValue
    || (!additions && !deletions && !lines.includes("--- /dev/null") && !lines.includes("+++ /dev/null"))
  ) {
    if (!isBinary && !isRenameOrModeOnly) {
      unsupportedReasons.push("No exact patch was captured.");
    }
  }

  return { path: pathValue, unsupportedReasons };
}

function extractPatchPath(lines: string[]): string {
  for (const line of lines) {
    if (line.startsWith("+++ ")) {
      const normalized = normalizeDiffPath(line.slice(4).trim());
      if (normalized && normalized !== "/dev/null") {
        return normalized;
      }
    }
  }

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const components = line.trim().split(/\s+/);
      if (components.length >= 4) {
        return normalizeDiffPath(components[3] ?? "");
      }
    }
  }

  return "";
}

function normalizeDiffPath(rawPath: string): string {
  if (!rawPath) {
    return "";
  }

  if (rawPath.startsWith("a/") || rawPath.startsWith("b/")) {
    return rawPath.slice(2);
  }

  return rawPath;
}

async function findStagedTargetedFiles(cwd: string, affectedFiles: string[]): Promise<string[]> {
  if (!affectedFiles.length) {
    return [];
  }

  try {
    const output = await git(cwd, "diff", "--name-only", "--cached", "--", ...affectedFiles);
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}

async function runGitApply(cwd: string, args: string[], patchText: string): Promise<PatchApplyResult> {
  const tempPatchPath = await writeTempPatchFile(patchText);

  try {
    const result = await execFileAsync("git", [...args, tempPatchPath], cwd);
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const execError = error as GitExecError;
    return {
      ok: false,
      stdout: readExecOutput(execError.stdout),
      stderr: readExecOutput(execError.stderr) || execError.message || "",
    };
  } finally {
    try {
      fs.unlinkSync(tempPatchPath);
    } catch {
      // Ignore temp cleanup failures.
    }
  }
}

async function writeTempPatchFile(patchText: string): Promise<string> {
  const tempPatchPath = path.join(
    os.tmpdir(),
    `coderover-revert-${Date.now()}-${Math.random().toString(16).slice(2)}.patch`
  );
  await fs.promises.writeFile(tempPatchPath, patchText, "utf8");
  return tempPatchPath;
}

function parseApplyConflicts(stderr: string): WorkspaceConflict[] {
  const lines = String(stderr || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const conflictsByPath = new Map<string, WorkspaceConflict>();
  for (const line of lines) {
    let filePath = "unknown";
    const patchFailedMatch = line.match(/^error:\s+patch failed:\s+(.+?):\d+$/i);
    const doesNotApplyMatch = line.match(/^error:\s+(.+?):\s+patch does not apply$/i);

    if (patchFailedMatch) {
      filePath = patchFailedMatch[1] ?? filePath;
    } else if (doesNotApplyMatch) {
      filePath = doesNotApplyMatch[1] ?? filePath;
    }

    if (!conflictsByPath.has(filePath)) {
      conflictsByPath.set(filePath, { path: filePath, message: line });
    }
  }

  if (!conflictsByPath.size && lines.length) {
    return [{ path: "unknown", message: lines.join(" ") }];
  }

  return [...conflictsByPath.values()];
}

async function withRepoMutationLock<T>(cwd: string, callback: () => Promise<T>): Promise<T> {
  const previous = repoMutationLocks.get(cwd) || Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const releaseLock = releaseCurrent;
  const chained = previous.then(() => current);
  repoMutationLocks.set(cwd, chained);

  await previous;
  try {
    return await callback();
  } finally {
    releaseLock();
    if (repoMutationLocks.get(cwd) === chained) {
      repoMutationLocks.delete(cwd);
    }
  }
}

async function resolveWorkspaceCwd(params: WorkspaceRequestParams): Promise<string> {
  const requestedCwd = firstNonEmptyString([params.cwd, params.currentWorkingDirectory]);
  if (!requestedCwd) {
    throw workspaceError(
      "missing_working_directory",
      "Workspace actions require a bound local working directory."
    );
  }

  if (!isExistingDirectory(requestedCwd)) {
    throw workspaceError(
      "missing_working_directory",
      "The requested local working directory does not exist on this Mac."
    );
  }

  return requestedCwd;
}

async function resolveRepoRoot(cwd: string): Promise<string> {
  try {
    const repoRoot = (await git(cwd, "rev-parse", "--show-toplevel")).trim();
    if (repoRoot) {
      return repoRoot;
    }
  } catch {
    // Fall through to user-facing error below.
  }

  throw workspaceError(
    "missing_working_directory",
    "The selected local folder is not inside a Git repository."
  );
}

function firstNonEmptyString(candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    const trimmed = candidate.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

function isExistingDirectory(candidatePath: string): boolean {
  try {
    return fs.statSync(candidatePath).isDirectory();
  } catch {
    return false;
  }
}

function workspaceError(errorCode: string, userMessage: string): WorkspaceHandlerError {
  const error = new Error(userMessage) as WorkspaceHandlerError;
  error.errorCode = errorCode;
  error.userMessage = userMessage;
  return error;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  try {
    return (await execFileAsync("git", args, cwd)).stdout;
  } catch (error) {
    const execError = error as GitExecError;
    throw new Error(readExecOutput(execError.stderr) || execError.message || "git command failed");
  }
}

function execFileAsync(command: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, timeout: GIT_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error) {
        const execError = error as GitExecError;
        execError.stdout = stdout;
        execError.stderr = stderr;
        reject(execError);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function readExecOutput(value: string | Buffer | undefined): string {
  if (typeof value === "string") {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  return "";
}
