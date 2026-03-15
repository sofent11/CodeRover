// FILE: git-handler.ts
// Purpose: Intercepts git/* JSON-RPC methods and executes git commands locally on the Mac.

import { execFile, type ExecFileException } from "child_process";
import * as fs from "fs";

const GIT_TIMEOUT_MS = 30_000;
const EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

type SendResponse = (response: string) => void;

type JsonObject = Record<string, unknown>;

interface GitRequestParams extends JsonObject {
  cwd?: unknown;
  currentWorkingDirectory?: unknown;
  message?: unknown;
  branch?: unknown;
  name?: unknown;
  confirm?: unknown;
}

interface ParsedGitRequest {
  method?: unknown;
  id?: unknown;
  params?: GitRequestParams;
}

interface GitHandlerError extends Error {
  errorCode: string;
  userMessage: string;
}

interface GitChangedFile {
  path: string;
  status: string;
}

interface GitDiffTotals {
  additions: number;
  deletions: number;
  binaryFiles: number;
}

interface GitStatusResult {
  repoRoot: string | null;
  branch: string | null;
  tracking: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
  state: string;
  canPush: boolean;
  files: GitChangedFile[];
  diff: GitDiffTotals;
}

interface GitBranchesResult {
  branches: string[];
  current: string;
  default: string | null;
}

interface GitCommitResult {
  hash: string;
  branch: string;
  summary: string;
}

interface GitLogEntry {
  hash: string;
  message: string;
  author: string;
  date: string;
}

type GitExecError = Error & {
  code?: ExecFileException["code"];
  stdout?: string | Buffer;
  stderr?: string | Buffer;
};

interface RepoDiffContext {
  tracking: string | null;
  fileLines: string[];
}

type GitMethodResult =
  | GitStatusResult
  | { patch: string }
  | GitCommitResult
  | { branch: string; remote: string; status: GitStatusResult }
  | { success: boolean; status: GitStatusResult }
  | GitBranchesResult
  | { current: string; tracking: string | null; status: GitStatusResult }
  | { commits: GitLogEntry[] }
  | { success: boolean; message: string }
  | { branch: string; status: GitStatusResult }
  | { url: string; ownerRepo: string | null }
  | (GitBranchesResult & { status: GitStatusResult });

export function handleGitRequest(rawMessage: string, sendResponse: SendResponse): boolean {
  const parsed = parseGitRequest(rawMessage);
  if (!parsed) {
    return false;
  }

  const method = readNonEmptyString(parsed.method);
  if (!method || !method.startsWith("git/")) {
    return false;
  }

  const id = parsed.id;
  const params = parsed.params || {};

  handleGitMethod(method, params)
    .then((result) => {
      sendResponse(JSON.stringify({ id, result }));
    })
    .catch((error: GitHandlerError) => {
      sendResponse(JSON.stringify({
        id,
        error: {
          code: -32000,
          message: error.userMessage || error.message || "Unknown git error",
          data: {
            errorCode: error.errorCode || "git_error",
          },
        },
      }));
    });

  return true;
}

function parseGitRequest(rawMessage: string): ParsedGitRequest | null {
  try {
    return JSON.parse(rawMessage) as ParsedGitRequest;
  } catch {
    return null;
  }
}

async function handleGitMethod(method: string, params: GitRequestParams): Promise<GitMethodResult> {
  const cwd = await resolveGitCwd(params);

  switch (method) {
    case "git/status":
      return gitStatus(cwd);
    case "git/diff":
      return gitDiff(cwd);
    case "git/commit":
      return gitCommit(cwd, params);
    case "git/push":
      return gitPush(cwd);
    case "git/pull":
      return gitPull(cwd);
    case "git/branches":
      return gitBranches(cwd);
    case "git/checkout":
      return gitCheckout(cwd, params);
    case "git/log":
      return gitLog(cwd);
    case "git/createBranch":
      return gitCreateBranch(cwd, params);
    case "git/stash":
      return gitStash(cwd);
    case "git/stashPop":
      return gitStashPop(cwd);
    case "git/resetToRemote":
      return gitResetToRemote(cwd, params);
    case "git/remoteUrl":
      return gitRemoteUrl(cwd);
    case "git/branchesWithStatus":
      return gitBranchesWithStatus(cwd);
    default:
      throw gitError("unknown_method", `Unknown git method: ${method}`);
  }
}

export async function gitStatus(cwd: string): Promise<GitStatusResult> {
  const [porcelain, branchInfo, repoRoot] = await Promise.all([
    git(cwd, "status", "--porcelain=v1", "-b"),
    revListCounts(cwd).catch(() => ({ ahead: 0, behind: 0 })),
    resolveRepoRoot(cwd).catch(() => null),
  ]);

  const lines = porcelain.trim().split("\n").filter(Boolean);
  const branchLine = lines[0] || "";
  const fileLines = lines.slice(1);

  const branch = parseBranchFromStatus(branchLine);
  const tracking = parseTrackingFromStatus(branchLine);
  const files = fileLines.map((line) => ({
    path: line.substring(3).trim(),
    status: line.substring(0, 2).trim(),
  }));

  const dirty = files.length > 0;
  const { ahead, behind } = branchInfo;
  const detached = branchLine.includes("HEAD detached") || branchLine.includes("no branch");
  const noUpstream = tracking === null && !detached;
  const state = computeState(dirty, ahead, behind, detached, noUpstream);
  const canPush = (ahead > 0 || noUpstream) && !detached;
  const diff = await repoDiffTotals(cwd, {
    tracking,
    fileLines,
  }).catch(() => ({ additions: 0, deletions: 0, binaryFiles: 0 }));

  return { repoRoot, branch, tracking, dirty, ahead, behind, state, canPush, files, diff };
}

async function gitDiff(cwd: string): Promise<{ patch: string }> {
  const porcelain = await git(cwd, "status", "--porcelain=v1", "-b");
  const lines = porcelain.trim().split("\n").filter(Boolean);
  const branchLine = lines[0] || "";
  const fileLines = lines.slice(1);
  const tracking = parseTrackingFromStatus(branchLine);
  const baseRef = await resolveRepoDiffBase(cwd, tracking);
  const trackedPatch = await gitDiffAgainstBase(cwd, baseRef);
  const untrackedPaths = fileLines
    .filter((line) => line.startsWith("?? "))
    .map((line) => line.substring(3).trim())
    .filter(Boolean);
  const untrackedPatch = await diffPatchForUntrackedFiles(cwd, untrackedPaths);
  const patch = [trackedPatch.trim(), untrackedPatch.trim()].filter(Boolean).join("\n\n").trim();
  return { patch };
}

async function gitCommit(cwd: string, params: GitRequestParams): Promise<GitCommitResult> {
  const message = readNonEmptyString(params.message) || "Changes from CodeRover";
  const statusCheck = await git(cwd, "status", "--porcelain");
  if (!statusCheck.trim()) {
    throw gitError("nothing_to_commit", "Nothing to commit.");
  }

  await git(cwd, "add", "-A");
  const output = await git(cwd, "commit", "-m", message);

  const hashMatch = output.match(/\[(\S+)\s+([a-f0-9]+)\]/);
  const hash = hashMatch?.[2] ?? "";
  const branch = hashMatch?.[1] ?? "";
  const summaryMatch = output.match(/\d+ files? changed/);
  const summary = summaryMatch ? summaryMatch[0] : output.split("\n").pop()?.trim() || "";

  return { hash, branch, summary };
}

async function gitPush(cwd: string): Promise<{ branch: string; remote: string; status: GitStatusResult }> {
  try {
    const branch = (await git(cwd, "rev-parse", "--abbrev-ref", "HEAD")).trim();

    try {
      await git(cwd, "push");
    } catch (error) {
      const message = asError(error).message;
      if (message.includes("no upstream") || message.includes("has no upstream branch")) {
        await git(cwd, "push", "--set-upstream", "origin", branch);
      } else {
        throw error;
      }
    }

    const status = await gitStatus(cwd);
    return { branch, remote: "origin", status };
  } catch (error) {
    if (isGitHandlerError(error)) {
      throw error;
    }
    const message = asError(error).message;
    if (message.includes("rejected")) {
      throw gitError("push_rejected", "Push rejected. Pull changes first.");
    }
    throw gitError("push_failed", message || "Push failed.");
  }
}

async function gitPull(cwd: string): Promise<{ success: boolean; status: GitStatusResult }> {
  try {
    await git(cwd, "pull", "--rebase");
    const status = await gitStatus(cwd);
    return { success: true, status };
  } catch (error) {
    try {
      await git(cwd, "rebase", "--abort");
    } catch {
      // ignore abort errors
    }
    if (isGitHandlerError(error)) {
      throw error;
    }
    throw gitError("pull_conflict", "Pull failed due to conflicts. Rebase aborted.");
  }
}

async function gitBranches(cwd: string): Promise<GitBranchesResult> {
  const output = await git(cwd, "branch", "-a", "--no-color");
  const lines = output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.trim());

  let current = "";
  const branchSet = new Set<string>();

  for (const line of lines) {
    const isCurrent = line.startsWith("* ");
    const name = line.replace(/^\*\s*/, "").trim();

    if (name.includes("HEAD detached") || name === "(no branch)") {
      if (isCurrent) {
        current = "HEAD";
      }
      continue;
    }

    if (name.includes("->")) {
      continue;
    }

    if (name.startsWith("remotes/origin/")) {
      branchSet.add(name.replace("remotes/origin/", ""));
    } else {
      branchSet.add(name);
    }

    if (isCurrent) {
      current = name;
    }
  }

  const branches = [...branchSet].sort();
  const defaultBranch = await detectDefaultBranch(cwd, branches);

  return { branches, current, default: defaultBranch };
}

async function gitCheckout(
  cwd: string,
  params: GitRequestParams
): Promise<{ current: string; tracking: string | null; status: GitStatusResult }> {
  const branch = readNonEmptyString(params.branch);
  if (!branch) {
    throw gitError("missing_branch", "Branch name is required.");
  }

  try {
    await git(cwd, "checkout", "--", branch);
  } catch (error) {
    const message = asError(error).message;
    if (message.includes("would be overwritten")) {
      throw gitError(
        "checkout_conflict_dirty_tree",
        "Cannot switch branches: you have uncommitted changes."
      );
    }
    throw gitError("checkout_failed", message || "Checkout failed.");
  }

  const status = await gitStatus(cwd);
  return { current: branch, tracking: status.tracking, status };
}

async function gitLog(cwd: string): Promise<{ commits: GitLogEntry[] }> {
  const output = await git(cwd, "log", "-20", "--format=%H%x00%s%x00%an%x00%aI");
  const commits = output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, message, author, date] = line.split("\0");
      return {
        hash: hash?.substring(0, 7) || "",
        message: message || "",
        author: author || "",
        date: date || "",
      };
    });

  return { commits };
}

async function gitCreateBranch(
  cwd: string,
  params: GitRequestParams
): Promise<{ branch: string; status: GitStatusResult }> {
  const name = readNonEmptyString(params.name);
  if (!name) {
    throw gitError("missing_branch_name", "Branch name is required.");
  }

  try {
    await git(cwd, "checkout", "-b", name);
  } catch (error) {
    const message = asError(error).message;
    if (message.includes("already exists")) {
      throw gitError("branch_exists", `Branch '${name}' already exists.`);
    }
    throw gitError("create_branch_failed", message || "Failed to create branch.");
  }

  const status = await gitStatus(cwd);
  return { branch: name, status };
}

async function gitStash(cwd: string): Promise<{ success: boolean; message: string }> {
  const output = await git(cwd, "stash");
  const saved = !output.includes("No local changes");
  return { success: saved, message: output.trim() };
}

async function gitStashPop(cwd: string): Promise<{ success: boolean; message: string }> {
  try {
    const output = await git(cwd, "stash", "pop");
    return { success: true, message: output.trim() };
  } catch (error) {
    throw gitError("stash_pop_conflict", asError(error).message || "Stash pop failed due to conflicts.");
  }
}

async function gitResetToRemote(
  cwd: string,
  params: GitRequestParams
): Promise<{ success: boolean; status: GitStatusResult }> {
  if (params.confirm !== "discard_runtime_changes") {
    throw gitError(
      "confirmation_required",
      'This action requires params.confirm === "discard_runtime_changes".'
    );
  }

  let hasUpstream = true;
  try {
    await git(cwd, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
  } catch {
    hasUpstream = false;
  }

  if (hasUpstream) {
    await git(cwd, "fetch");
    await git(cwd, "reset", "--hard", "@{u}");
  } else {
    await git(cwd, "checkout", "--", ".");
  }
  await git(cwd, "clean", "-fd");

  const status = await gitStatus(cwd);
  return { success: true, status };
}

async function gitRemoteUrl(cwd: string): Promise<{ url: string; ownerRepo: string | null }> {
  const url = (await git(cwd, "config", "--get", "remote.origin.url")).trim();
  return { url, ownerRepo: parseOwnerRepo(url) };
}

function parseOwnerRepo(remoteUrl: string): string | null {
  const match = remoteUrl.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  return match?.[1] ?? null;
}

async function gitBranchesWithStatus(cwd: string): Promise<GitBranchesResult & { status: GitStatusResult }> {
  const [branchResult, statusResult] = await Promise.all([
    gitBranches(cwd),
    gitStatus(cwd),
  ]);
  return { ...branchResult, status: statusResult };
}

async function repoDiffTotals(cwd: string, context: RepoDiffContext): Promise<GitDiffTotals> {
  const baseRef = await resolveRepoDiffBase(cwd, context.tracking);
  const trackedTotals = await diffTotalsAgainstBase(cwd, baseRef);
  const untrackedPaths = context.fileLines
    .filter((line) => line.startsWith("?? "))
    .map((line) => line.substring(3).trim())
    .filter(Boolean);
  const untrackedTotals = await diffTotalsForUntrackedFiles(cwd, untrackedPaths);

  return {
    additions: trackedTotals.additions + untrackedTotals.additions,
    deletions: trackedTotals.deletions + untrackedTotals.deletions,
    binaryFiles: trackedTotals.binaryFiles + untrackedTotals.binaryFiles,
  };
}

async function resolveRepoDiffBase(cwd: string, tracking: string | null): Promise<string> {
  if (tracking) {
    try {
      return (await git(cwd, "merge-base", "HEAD", "@{u}")).trim();
    } catch {
      // Fall through to local-only commit scan if upstream metadata is stale.
    }
  }

  const firstLocalOnlyCommit = (await git(
    cwd,
    "rev-list",
    "--reverse",
    "--topo-order",
    "HEAD",
    "--not",
    "--remotes"
  ))
    .trim()
    .split("\n")
    .find(Boolean);

  if (!firstLocalOnlyCommit) {
    return "HEAD";
  }

  try {
    return (await git(cwd, "rev-parse", `${firstLocalOnlyCommit}^`)).trim();
  } catch {
    return EMPTY_TREE_HASH;
  }
}

async function diffTotalsAgainstBase(cwd: string, baseRef: string): Promise<GitDiffTotals> {
  return parseNumstatTotals(await git(cwd, "diff", "--numstat", baseRef));
}

async function gitDiffAgainstBase(cwd: string, baseRef: string): Promise<string> {
  return git(cwd, "diff", "--binary", "--find-renames", baseRef);
}

async function diffTotalsForUntrackedFiles(cwd: string, filePaths: string[]): Promise<GitDiffTotals> {
  if (!filePaths.length) {
    return { additions: 0, deletions: 0, binaryFiles: 0 };
  }

  const totals = await Promise.all(filePaths.map(async (filePath) => {
    return parseNumstatTotals(await gitDiffNoIndexNumstat(cwd, filePath));
  }));

  return totals.reduce<GitDiffTotals>(
    (aggregate, current) => ({
      additions: aggregate.additions + current.additions,
      deletions: aggregate.deletions + current.deletions,
      binaryFiles: aggregate.binaryFiles + current.binaryFiles,
    }),
    { additions: 0, deletions: 0, binaryFiles: 0 }
  );
}

function parseNumstatTotals(output: string): GitDiffTotals {
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
      .reduce<GitDiffTotals>(
      (aggregate, line) => {
        const [rawAdditions, rawDeletions] = line.split("\t");
        const additions = Number.parseInt(rawAdditions ?? "", 10);
        const deletions = Number.parseInt(rawDeletions ?? "", 10);
        const isBinary = !Number.isFinite(additions) || !Number.isFinite(deletions);

        return {
          additions: aggregate.additions + (Number.isFinite(additions) ? additions : 0),
          deletions: aggregate.deletions + (Number.isFinite(deletions) ? deletions : 0),
          binaryFiles: aggregate.binaryFiles + (isBinary ? 1 : 0),
        };
      },
      { additions: 0, deletions: 0, binaryFiles: 0 }
    );
}

async function gitDiffNoIndexNumstat(cwd: string, filePath: string): Promise<string> {
  try {
    const result = await execFileAsync("git", ["diff", "--no-index", "--numstat", "--", "/dev/null", filePath], cwd);
    return result.stdout;
  } catch (error) {
    const execError = error as GitExecError;
    if (typeof execError.code === "number" && execError.code === 1) {
      return readExecOutput(execError.stdout);
    }
    throw new Error(readExecOutput(execError.stderr) || execError.message || "git diff --no-index failed");
  }
}

async function diffPatchForUntrackedFiles(cwd: string, filePaths: string[]): Promise<string> {
  if (!filePaths.length) {
    return "";
  }

  const patches = await Promise.all(filePaths.map((filePath) => gitDiffNoIndexPatch(cwd, filePath)));
  return patches.filter(Boolean).join("\n\n");
}

async function gitDiffNoIndexPatch(cwd: string, filePath: string): Promise<string> {
  try {
    const result = await execFileAsync("git", ["diff", "--no-index", "--binary", "--", "/dev/null", filePath], cwd);
    return result.stdout;
  } catch (error) {
    const execError = error as GitExecError;
    if (typeof execError.code === "number" && execError.code === 1) {
      return readExecOutput(execError.stdout);
    }
    throw new Error(readExecOutput(execError.stderr) || execError.message || "git diff --no-index failed");
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", args, cwd);
    return result.stdout;
  } catch (error) {
    const execError = error as GitExecError;
    const message = readExecOutput(execError.stderr) || execError.message || "git command failed";
    throw new Error(message.trim() || "git command failed");
  }
}

async function revListCounts(cwd: string): Promise<{ ahead: number; behind: number }> {
  const output = await git(cwd, "rev-list", "--left-right", "--count", "HEAD...@{u}");
  const parts = output.trim().split(/\s+/);
  return {
    ahead: Number.parseInt(parts[0] ?? "", 10) || 0,
    behind: Number.parseInt(parts[1] ?? "", 10) || 0,
  };
}

function parseBranchFromStatus(line: string): string | null {
  const match = line.match(/^## (.+?)(?:\.{3}|$)/);
  if (!match) {
    return null;
  }
  const branch = (match[1] ?? "").trim();
  if (branch === "HEAD (no branch)" || branch.includes("HEAD detached")) {
    return null;
  }
  return branch;
}

function parseTrackingFromStatus(line: string): string | null {
  const match = line.match(/\.{3}(.+?)(?:\s|$)/);
  return match?.[1]?.trim() ?? null;
}

function computeState(
  dirty: boolean,
  ahead: number,
  behind: number,
  detached: boolean,
  noUpstream: boolean
): string {
  if (detached) return "detached_head";
  if (noUpstream) return "no_upstream";
  if (dirty && behind > 0) return "dirty_and_behind";
  if (dirty) return "dirty";
  if (ahead > 0 && behind > 0) return "diverged";
  if (behind > 0) return "behind_only";
  if (ahead > 0) return "ahead_only";
  return "up_to_date";
}

async function detectDefaultBranch(cwd: string, branches: string[]): Promise<string | null> {
  try {
    const ref = await git(cwd, "symbolic-ref", "refs/remotes/origin/HEAD");
    const defaultBranch = ref.trim().replace("refs/remotes/origin/", "");
    if (defaultBranch && branches.includes(defaultBranch)) {
      return defaultBranch;
    }
  } catch {
    // ignore
  }

  if (branches.includes("main")) return "main";
  if (branches.includes("master")) return "master";
  return branches[0] || null;
}

function gitError(errorCode: string, userMessage: string): GitHandlerError {
  const error = new Error(userMessage) as GitHandlerError;
  error.errorCode = errorCode;
  error.userMessage = userMessage;
  return error;
}

async function resolveGitCwd(params: GitRequestParams): Promise<string> {
  const requestedCwd = firstNonEmptyString([params.cwd, params.currentWorkingDirectory]);

  if (!requestedCwd) {
    throw gitError("missing_working_directory", "Git actions require a bound local working directory.");
  }

  if (!isExistingDirectory(requestedCwd)) {
    throw gitError(
      "missing_working_directory",
      "The requested local working directory does not exist on this Mac."
    );
  }

  return requestedCwd;
}

function firstNonEmptyString(candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    const value = readNonEmptyString(candidate);
    if (value) {
      return value;
    }
  }
  return null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isExistingDirectory(candidatePath: string): boolean {
  try {
    return fs.statSync(candidatePath).isDirectory();
  } catch {
    return false;
  }
}

async function resolveRepoRoot(cwd: string): Promise<string | null> {
  const repoRoot = (await git(cwd, "rev-parse", "--show-toplevel")).trim();
  return repoRoot || null;
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

function isGitHandlerError(error: unknown): error is GitHandlerError {
  return Boolean(
    error
      && typeof error === "object"
      && typeof (error as GitHandlerError).errorCode === "string"
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
