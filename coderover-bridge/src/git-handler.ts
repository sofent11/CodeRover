// FILE: git-handler.ts
// Purpose: Intercepts git/* JSON-RPC methods and executes git commands locally on the Mac.

import { execFile, type ExecFileException } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomBytes } from "crypto";

const GIT_TIMEOUT_MS = 30_000;
const EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MUTATING_GIT_METHODS = new Set([
  "git/commit",
  "git/push",
  "git/pull",
  "git/checkout",
  "git/createBranch",
  "git/createWorktree",
  "git/createManagedWorktree",
  "git/transferManagedHandoff",
  "git/removeWorktree",
  "git/stash",
  "git/stashPop",
  "git/resetToRemote",
]);
const repoMutationLocks = new Map<string, Promise<void>>();

type SendResponse = (response: string) => void;

type JsonObject = Record<string, unknown>;

interface GitRequestParams extends JsonObject {
  cwd?: unknown;
  currentWorkingDirectory?: unknown;
  message?: unknown;
  branch?: unknown;
  name?: unknown;
  baseBranch?: unknown;
  changeTransfer?: unknown;
  changeScope?: unknown;
  paths?: unknown;
  targetPath?: unknown;
  targetProjectPath?: unknown;
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
  localOnlyCommitCount: number;
  publishedToRemote: boolean;
  state: string;
  canPush: boolean;
  files: GitChangedFile[];
  diff: GitDiffTotals;
}

interface GitBranchesResult {
  branches: string[];
  branchesCheckedOutElsewhere: string[];
  worktreePathByBranch: Record<string, string>;
  localCheckoutPath: string | null;
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
  | { success: boolean }
  | GitBranchesResult
  | { current: string; tracking: string | null; status: GitStatusResult }
  | { commits: GitLogEntry[] }
  | { success: boolean; message: string }
  | { branch: string; status: GitStatusResult }
  | { branch: string; worktreePath: string; alreadyExisted: boolean }
  | { worktreePath: string; alreadyExisted: boolean; baseBranch: string; headMode: "detached"; transferredChanges: boolean }
  | { success: boolean; targetPath: string; transferredChanges: boolean }
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
  if (MUTATING_GIT_METHODS.has(method)) {
    const repoRoot = await resolveRepoRoot(cwd);
    if (!repoRoot) {
      throw gitError("missing_working_directory", "The requested local working directory is not inside a Git repository.");
    }
    return withRepoMutationLock(repoRoot, () => handleGitMethodUnlocked(method, cwd, params));
  }

  return handleGitMethodUnlocked(method, cwd, params);
}

async function handleGitMethodUnlocked(method: string, cwd: string, params: GitRequestParams): Promise<GitMethodResult> {
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
    case "git/createWorktree":
      return gitCreateWorktree(cwd, params);
    case "git/createManagedWorktree":
      return gitCreateManagedWorktree(cwd, params);
    case "git/transferManagedHandoff":
      return gitTransferManagedHandoff(cwd, params);
    case "git/removeWorktree":
      return gitRemoveWorktree(cwd, params);
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
  const publishedToRemote = !detached && !!branch && await remoteBranchExists(cwd, branch).catch(() => false);
  const localOnlyCommitCount = await countLocalOnlyCommits(cwd, { detached }).catch(() => 0);
  const state = computeState(dirty, ahead, behind, detached, noUpstream);
  const canPush = (ahead > 0 || noUpstream) && !detached;
  const diff = await repoDiffTotals(cwd, {
    tracking,
    fileLines,
  }).catch(() => ({ additions: 0, deletions: 0, binaryFiles: 0 }));

  return {
    repoRoot,
    branch,
    tracking,
    dirty,
    ahead,
    behind,
    localOnlyCommitCount,
    publishedToRemote,
    state,
    canPush,
    files,
    diff,
  };
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
  const repoRoot = await resolveRepoRoot(cwd);
  if (!repoRoot) {
    throw gitError("missing_working_directory", "The selected local folder is not inside a Git repository.");
  }
  const pathspec = await resolveCommitPathspec(cwd, params);
  const statusCheck = await git(repoRoot, "status", "--porcelain", "--", ...pathspec);
  if (!statusCheck.trim()) {
    throw gitError("nothing_to_commit", "Nothing to commit.");
  }

  if (!hasExplicitCommitPaths(params) && !isRepoWidePathspec(pathspec)) {
    const outOfScopeChanges = await findOutOfScopeStatusPaths(repoRoot, pathspec);
    if (outOfScopeChanges.length > 0) {
      throw gitError(
        "commit_scope_conflict",
        "Cannot commit safely because there are uncommitted changes outside the current project scope."
      );
    }
  }

  await git(repoRoot, "add", "-A", "--", ...pathspec);
  const output = await git(repoRoot, "commit", "-m", message, "--", ...pathspec);

  const hashMatch = output.match(/\[(\S+)\s+([a-f0-9]+)\]/);
  const hash = hashMatch?.[2] ?? "";
  const branch = hashMatch?.[1] ?? "";
  const summaryMatch = output.match(/\d+ files? changed/);
  const summary = summaryMatch ? summaryMatch[0] : output.split("\n").pop()?.trim() || "";

  return { hash, branch, summary };
}

async function resolveCommitPathspec(cwd: string, params: GitRequestParams): Promise<string[]> {
  const explicitPaths = normalizeCommitPaths(params.paths);
  if (explicitPaths.length > 0) {
    const repoRoot = await resolveRepoRoot(cwd);
    return explicitPaths.map((candidatePath) => normalizeCommitPathspec(repoRoot || cwd, cwd, candidatePath));
  }

  const changeScope = readNonEmptyString(params.changeScope);
  if (changeScope === "repo" || changeScope === "repository") {
    if (params.confirm !== "commit_all_repo_changes") {
      throw gitError(
        "confirmation_required",
        'Repository-wide commits require params.confirm === "commit_all_repo_changes".'
      );
    }
    return ["."];
  }

  const repoRoot = await resolveRepoRoot(cwd);
  if (!repoRoot) {
    throw gitError("missing_working_directory", "The selected local folder is not inside a Git repository.");
  }
  const projectRelativePath = resolveProjectRelativePath(cwd, repoRoot);
  return projectRelativePath ? [projectRelativePath] : ["."];
}

function normalizeCommitPaths(rawPaths: unknown): string[] {
  const candidates = Array.isArray(rawPaths)
    ? rawPaths
    : typeof rawPaths === "string"
      ? rawPaths.split(/\n|,/)
      : [];
  return [...new Set(candidates
    .map((value) => readNonEmptyString(value))
    .filter((value): value is string => Boolean(value)))];
}

function normalizeCommitPathspec(repoRoot: string, cwd: string, candidatePath: string): string {
  const normalizedRepoRoot = normalizeExistingPath(repoRoot) || path.resolve(repoRoot);
  const normalizedCwd = normalizeExistingPath(cwd) || path.resolve(cwd);
  const rawResolvedPath = path.isAbsolute(candidatePath)
    ? candidatePath
    : path.resolve(normalizedCwd, candidatePath);
  const resolvedPath = normalizeExistingPath(rawResolvedPath) || rawResolvedPath;
  const relativePath = path.relative(normalizedRepoRoot, resolvedPath);
  if (!relativePath || relativePath === ".") {
    return ".";
  }
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw gitError("path_outside_repo", `Commit path '${candidatePath}' is outside the selected repository.`);
  }
  return relativePath;
}

function hasExplicitCommitPaths(params: GitRequestParams): boolean {
  return normalizeCommitPaths(params.paths).length > 0;
}

function isRepoWidePathspec(pathspec: string[]): boolean {
  return pathspec.length === 1 && pathspec[0] === ".";
}

async function findOutOfScopeStatusPaths(cwd: string, pathspec: string[]): Promise<string[]> {
  const allStatus = await git(cwd, "status", "--porcelain=v1");
  const allPaths = parsePorcelainStatusPaths(allStatus);
  if (allPaths.length === 0) {
    return [];
  }

  return allPaths.filter((filePath) => !isPathCoveredByPathspec(filePath, pathspec));
}

function parsePorcelainStatusPaths(output: string): string[] {
  return output
    .trim()
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter(Boolean)
    .map((line) => {
      const value = line.slice(3).trim();
      const renameTarget = value.split(" -> ").pop() || value;
      return unquoteGitPath(renameTarget);
    })
    .filter(Boolean);
}

function unquoteGitPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) {
    return trimmed;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed.slice(1, -1);
  }
}

function isPathCoveredByPathspec(filePath: string, pathspec: string[]): boolean {
  if (isRepoWidePathspec(pathspec)) {
    return true;
  }
  return pathspec.some((scopePath) => {
    const normalizedScope = scopePath.replace(/\/+$/g, "");
    return filePath === normalizedScope || filePath.startsWith(`${normalizedScope}/`);
  });
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
  const [output, repoRoot, localCheckoutRoot] = await Promise.all([
    git(cwd, "branch", "--no-color"),
    resolveRepoRoot(cwd).catch(() => null),
    resolveLocalCheckoutRoot(cwd).catch(() => null),
  ]);
  const projectRelativePath = resolveProjectRelativePath(cwd, repoRoot);
  const worktreePathByBranch = await gitWorktreePathByBranch(cwd, { projectRelativePath }).catch(() => ({}));
  const localCheckoutPath = scopedLocalCheckoutPath(localCheckoutRoot || repoRoot, projectRelativePath);
  const lines = output.trim().split("\n").filter(Boolean);

  let current = "";
  const branchSet = new Set<string>();
  const branchesCheckedOutElsewhere = new Set<string>();

  for (const line of lines) {
    const entry = normalizeBranchListEntry(line);
    if (!entry) {
      continue;
    }

    const { isCurrent, isCheckedOutElsewhere, name } = entry;

    if (name.includes("HEAD detached") || name === "(no branch)") {
      if (isCurrent) {
        current = "HEAD";
      }
      continue;
    }

    branchSet.add(name);
    if (isCheckedOutElsewhere) {
      branchesCheckedOutElsewhere.add(name);
    }
    if (isCurrent) {
      current = name;
    }
  }

  const branches = [...branchSet].sort();
  const defaultBranch = await detectDefaultBranch(cwd, branches);

  return {
    branches,
    branchesCheckedOutElsewhere: [...branchesCheckedOutElsewhere].sort(),
    worktreePathByBranch,
    localCheckoutPath,
    current,
    default: defaultBranch,
  };
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
    await git(cwd, "switch", branch);
  } catch (error) {
    const message = asError(error).message;
    if (message.includes("untracked working tree files would be overwritten")) {
      throw gitError(
        "checkout_conflict_untracked_collision",
        "Cannot switch branches: untracked files would be overwritten."
      );
    }
    if (message.includes("local changes to the following files would be overwritten")) {
      throw gitError(
        "checkout_conflict_dirty_tree",
        "Cannot switch branches: tracked local changes would be overwritten."
      );
    }
    if (message.includes("already used by worktree") || message.includes("already checked out at")) {
      throw gitError(
        "checkout_branch_in_other_worktree",
        "Cannot switch branches: this branch is already open in another worktree."
      );
    }
    if (message.includes("invalid reference") || message.includes("unknown revision")) {
      throw gitError("branch_not_found", `Branch '${branch}' does not exist locally.`);
    }
    throw gitError("checkout_failed", message || "Checkout failed.");
  }

  const status = await gitStatus(cwd);
  return { current: status.branch || branch, tracking: status.tracking, status };
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
  const name = normalizeCreatedBranchName(params.name);
  if (!name) {
    throw gitError("missing_branch_name", "Branch name is required.");
  }
  await assertValidCreatedBranchName(cwd, name);

  if (!(await localBranchExists(cwd, name)) && await remoteBranchExists(cwd, name)) {
    throw gitError(
      "branch_exists",
      `Branch '${name}' already exists on origin. Check it out locally instead of creating a new branch.`
    );
  }

  try {
    await git(cwd, "switch", "-c", name);
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

async function gitCreateWorktree(
  cwd: string,
  params: GitRequestParams
): Promise<{ branch: string; worktreePath: string; alreadyExisted: boolean }> {
  const branch = normalizeCreatedBranchName(params.name);
  if (!branch) {
    throw gitError("missing_branch_name", "Branch name is required.");
  }
  await assertValidCreatedBranchName(cwd, branch);

  const branchResult = await gitBranches(cwd);
  const repoRoot = await resolveRepoRoot(cwd);
  const status = await gitStatus(cwd);
  const projectRelativePath = resolveProjectRelativePath(cwd, repoRoot);
  const changeScope = await scopedProjectChanges(repoRoot, projectRelativePath);
  const baseBranch = resolveBaseBranchName(params.baseBranch, branchResult.default);
  const changeTransfer = resolveWorktreeChangeTransfer(params.changeTransfer);
  if (!baseBranch) {
    throw gitError("missing_base_branch", "Base branch is required.");
  }
  if (!(await localBranchExists(cwd, baseBranch))) {
    throw gitError(
      "missing_base_branch",
      `Base branch '${baseBranch}' is not available locally. Create or check out that branch first.`
    );
  }

  const currentBranch = typeof status.branch === "string" ? status.branch.trim() : "";
  const canCarryLocalChanges = changeScope.dirty && !!currentBranch && currentBranch === baseBranch;
  if (changeScope.dirty && changeTransfer !== "none" && !canCarryLocalChanges) {
    const currentBranchLabel = currentBranch || "the current branch";
    const transferVerb = changeTransfer === "copy" ? "copy" : "move";
    throw gitError(
      "dirty_worktree_base_mismatch",
      `Uncommitted changes can ${transferVerb} into a new worktree only from ${currentBranchLabel}. Switch the base branch to match or clean up local changes first.`
    );
  }

  const existingWorktreePath = branchResult.worktreePathByBranch[branch];
  if (existingWorktreePath) {
    if (sameFilePath(existingWorktreePath, cwd)) {
      throw gitError("branch_already_open_here", `Branch '${branch}' is already open in this project.`);
    }
    return {
      branch,
      worktreePath: existingWorktreePath,
      alreadyExisted: true,
    };
  }

  if (await localBranchExists(cwd, branch)) {
    throw gitError(
      "branch_exists",
      `Branch '${branch}' already exists locally. Choose another name or open that branch instead.`
    );
  }

  const worktreeRootPath = allocateManagedWorktreePath(repoRoot);
  let handoffStashRef: string | null = null;
  let copiedLocalChangesPatch = "";
  let didCreateWorktree = false;

  try {
    if (canCarryLocalChanges) {
      if (changeTransfer === "copy") {
        copiedLocalChangesPatch = await captureLocalChangesPatch(repoRoot, changeScope.pathspecArgs);
      } else if (changeTransfer === "move") {
        handoffStashRef = await stashChangesForWorktreeHandoff(repoRoot, changeScope.pathspecArgs);
      }
    }

    await git(repoRoot, "worktree", "add", "-b", branch, worktreeRootPath, baseBranch);
    didCreateWorktree = true;

    if (handoffStashRef) {
      await applyWorktreeHandoffStash(worktreeRootPath, handoffStashRef);
    }
    if (copiedLocalChangesPatch) {
      await applyCopiedLocalChangesToWorktree(worktreeRootPath, copiedLocalChangesPatch);
    }
  } catch (error) {
    const message = asError(error).message;
    if (didCreateWorktree) {
      await cleanupManagedWorktree(repoRoot, worktreeRootPath, branch);
    } else {
      fs.rmSync(path.dirname(worktreeRootPath), { recursive: true, force: true });
    }
    if (handoffStashRef) {
      await restoreWorktreeHandoffStash(repoRoot, handoffStashRef);
    }

    if (message.includes("invalid reference")) {
      throw gitError("missing_base_branch", `Base branch '${baseBranch}' does not exist.`);
    }
    if (message.includes("already exists")) {
      throw gitError("branch_exists", `Branch '${branch}' already exists.`);
    }
    if (message.includes("already used by worktree") || message.includes("already checked out at")) {
      throw gitError("branch_in_other_worktree", `Branch '${branch}' is already open in another worktree.`);
    }
    throw gitError("create_worktree_failed", message || "Failed to create worktree.");
  }

  return {
    branch,
    worktreePath: scopedWorktreePath(worktreeRootPath, projectRelativePath),
    alreadyExisted: false,
  };
}

async function gitCreateManagedWorktree(
  cwd: string,
  params: GitRequestParams
): Promise<{ worktreePath: string; alreadyExisted: boolean; baseBranch: string; headMode: "detached"; transferredChanges: boolean }> {
  const branchResult = await gitBranches(cwd);
  const repoRoot = await resolveRepoRoot(cwd);
  const status = await gitStatus(cwd);
  const projectRelativePath = resolveProjectRelativePath(cwd, repoRoot);
  const changeScope = await scopedProjectChanges(repoRoot, projectRelativePath);
  const baseBranch = resolveBaseBranchName(params.baseBranch, branchResult.default);
  const changeTransfer = resolveWorktreeChangeTransfer(params.changeTransfer);
  if (!baseBranch) {
    throw gitError("missing_base_branch", "Base branch is required.");
  }
  if (!(await localBranchExists(cwd, baseBranch))) {
    throw gitError(
      "missing_base_branch",
      `Base branch '${baseBranch}' is not available locally. Create or check out that branch first.`
    );
  }

  const currentBranch = typeof status.branch === "string" ? status.branch.trim() : "";
  const canCarryLocalChanges = changeScope.dirty && !!currentBranch && currentBranch === baseBranch;
  if (changeScope.dirty && changeTransfer !== "none" && !canCarryLocalChanges) {
    const currentBranchLabel = currentBranch || "the current branch";
    const transferVerb = changeTransfer === "copy" ? "copy" : "move";
    throw gitError(
      "dirty_worktree_base_mismatch",
      `Uncommitted changes can ${transferVerb} into a managed worktree only from ${currentBranchLabel}. Switch the base branch to match or clean up local changes first.`
    );
  }

  const worktreeRootPath = allocateManagedWorktreePath(repoRoot);
  let handoffStashRef: string | null = null;
  let copiedLocalChangesPatch = "";
  let didCreateWorktree = false;

  try {
    if (canCarryLocalChanges) {
      if (changeTransfer === "copy") {
        copiedLocalChangesPatch = await captureLocalChangesPatch(repoRoot, changeScope.pathspecArgs);
      } else if (changeTransfer === "move") {
        handoffStashRef = await stashChangesForWorktreeHandoff(repoRoot, changeScope.pathspecArgs);
      }
    }

    await git(repoRoot, "worktree", "add", "--detach", worktreeRootPath, baseBranch);
    didCreateWorktree = true;

    if (handoffStashRef) {
      await applyWorktreeHandoffStash(worktreeRootPath, handoffStashRef);
    }
    if (copiedLocalChangesPatch) {
      await applyCopiedLocalChangesToWorktree(worktreeRootPath, copiedLocalChangesPatch);
    }
  } catch (error) {
    const message = asError(error).message;
    if (didCreateWorktree) {
      await cleanupManagedWorktree(repoRoot, worktreeRootPath);
    } else {
      fs.rmSync(path.dirname(worktreeRootPath), { recursive: true, force: true });
    }
    if (handoffStashRef) {
      await restoreWorktreeHandoffStash(repoRoot, handoffStashRef);
    }
    if (message.includes("invalid reference")) {
      throw gitError("missing_base_branch", `Base branch '${baseBranch}' does not exist.`);
    }
    throw gitError("create_worktree_failed", message || "Failed to create managed worktree.");
  }

  return {
    worktreePath: scopedWorktreePath(worktreeRootPath, projectRelativePath),
    alreadyExisted: false,
    baseBranch,
    headMode: "detached",
    transferredChanges: Boolean(handoffStashRef || copiedLocalChangesPatch),
  };
}

async function gitTransferManagedHandoff(
  cwd: string,
  params: GitRequestParams
): Promise<{ success: boolean; targetPath: string; transferredChanges: boolean }> {
  const targetPath = firstNonEmptyString([params.targetPath, params.targetProjectPath]);
  if (!targetPath) {
    throw gitError("missing_handoff_target", "A handoff target path is required.");
  }
  if (!isExistingDirectory(cwd)) {
    throw gitError("missing_handoff_source", "The current handoff source is not available on this Mac.");
  }
  if (!isExistingDirectory(targetPath)) {
    throw gitError("missing_handoff_target", "The destination for this handoff is not available on this Mac.");
  }

  const [sourceRepoRoot, sourceLocalCheckoutRoot, targetRepoRoot, targetLocalCheckoutRoot] = await Promise.all([
    resolveRepoRoot(cwd),
    resolveLocalCheckoutRoot(cwd),
    resolveRepoRoot(targetPath),
    resolveLocalCheckoutRoot(targetPath),
  ]);

  const sourceCheckoutRoot = sourceLocalCheckoutRoot || sourceRepoRoot;
  const targetCheckoutRoot = targetLocalCheckoutRoot || targetRepoRoot;
  if (!sameFilePath(sourceCheckoutRoot, targetCheckoutRoot)) {
    throw gitError("handoff_target_mismatch", "The selected handoff destination belongs to a different checkout.");
  }

  if (sameFilePath(cwd, targetPath)) {
    return {
      success: true,
      targetPath: normalizeExistingPath(targetPath) ?? targetPath,
      transferredChanges: false,
    };
  }

  const sourceProjectRelativePath = resolveProjectRelativePath(cwd, sourceRepoRoot);
  const targetProjectRelativePath = resolveProjectRelativePath(targetPath, targetRepoRoot);
  const [sourceChangeScope, targetChangeScope] = await Promise.all([
    scopedProjectChanges(sourceRepoRoot, sourceProjectRelativePath),
    scopedProjectChanges(targetRepoRoot, targetProjectRelativePath),
  ]);

  if (!sourceChangeScope.dirty) {
    return {
      success: true,
      targetPath: normalizeExistingPath(targetPath) ?? targetPath,
      transferredChanges: false,
    };
  }

  if (targetChangeScope.dirty) {
    throw gitError(
      "handoff_target_dirty",
      "The handoff destination already has uncommitted changes. Clean it up before moving this thread there."
    );
  }

  const stashRef = await stashChangesForWorktreeHandoff(sourceRepoRoot, sourceChangeScope.pathspecArgs);
  if (!stashRef) {
    return {
      success: true,
      targetPath: normalizeExistingPath(targetPath) ?? targetPath,
      transferredChanges: false,
    };
  }

  try {
    await applyWorktreeHandoffStash(targetRepoRoot, stashRef, { dropAfterApply: true });
  } catch (error) {
    await rollbackFailedHandoffTransfer(targetRepoRoot, targetChangeScope.pathspecArgs);
    await restoreWorktreeHandoffStash(sourceRepoRoot, stashRef);
    const gitHandlerError = error as Partial<GitHandlerError>;
    throw gitError(
      "handoff_transfer_failed",
      gitHandlerError.userMessage || asError(error).message || "Could not move local changes into the handoff destination."
    );
  }

  return {
    success: true,
    targetPath: normalizeExistingPath(targetPath) ?? targetPath,
    transferredChanges: true,
  };
}

async function gitRemoveWorktree(cwd: string, params: GitRequestParams): Promise<{ success: boolean }> {
  const worktreeRootPath = await resolveRepoRoot(cwd).catch(() => null);
  const localCheckoutRoot = await resolveLocalCheckoutRoot(cwd).catch(() => null);
  const branch = readNonEmptyString(params.branch) ?? "";

  if (!worktreeRootPath || !localCheckoutRoot) {
    throw gitError("missing_working_directory", "Could not resolve the worktree roots for cleanup.");
  }
  if (sameFilePath(worktreeRootPath, localCheckoutRoot)) {
    throw gitError("cannot_remove_local_checkout", "Cannot remove the main local checkout.");
  }
  if (!isManagedWorktreePath(worktreeRootPath)) {
    throw gitError("unmanaged_worktree", "Only managed worktrees can be removed automatically.");
  }

  await cleanupManagedWorktree(localCheckoutRoot, worktreeRootPath, branch || null);
  if (branch && await localBranchExists(localCheckoutRoot, branch)) {
    throw gitError(
      "worktree_cleanup_failed",
      `The temporary worktree was removed, but branch '${branch}' could not be deleted automatically.`
    );
  }
  return { success: true };
}

async function gitStash(cwd: string): Promise<{ success: boolean; message: string }> {
  const output = await git(cwd, "stash", "push", "--include-untracked");
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
    await git(cwd, "reset", "--hard", "HEAD");
  }
  await git(cwd, "clean", "-fd");

  const status = await gitStatus(cwd);
  return { success: true, status };
}

async function gitRemoteUrl(cwd: string): Promise<{ url: string; ownerRepo: string | null }> {
  const raw = (await git(cwd, "config", "--get", "remote.origin.url")).trim();
  const ownerRepo = parseOwnerRepo(raw);
  return { url: raw, ownerRepo };
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

async function withRepoMutationLock<T>(repoRoot: string, callback: () => Promise<T>): Promise<T> {
  const lockKey = normalizeExistingPath(repoRoot) || path.resolve(repoRoot);
  const previous = repoMutationLocks.get(lockKey) || Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const chained = previous.then(() => current);
  repoMutationLocks.set(lockKey, chained);

  await previous;
  try {
    return await callback();
  } finally {
    releaseCurrent();
    if (repoMutationLocks.get(lockKey) === chained) {
      repoMutationLocks.delete(lockKey);
    }
  }
}

async function gitWorktreePathByBranch(cwd: string, options: { projectRelativePath?: string } = {}): Promise<Record<string, string>> {
  const output = await git(cwd, "worktree", "list", "--porcelain");
  return parseWorktreePathByBranch(output, options);
}

async function stashChangesForWorktreeHandoff(cwd: string, pathspecArgs: string[] = []): Promise<string | null> {
  const stashLabel = `coderover-worktree-handoff-${randomBytes(6).toString("hex")}`;
  const output = await git(cwd, "stash", "push", "--include-untracked", "--message", stashLabel, ...pathspecArgs);
  if (output.includes("No local changes")) {
    return null;
  }

  const stashRef = await findStashRefByLabel(cwd, stashLabel);
  if (!stashRef) {
    throw gitError("create_worktree_failed", "Could not prepare local changes for the worktree handoff.");
  }

  return stashRef;
}

async function captureLocalChangesPatch(cwd: string, pathspecArgs: string[] = []): Promise<string> {
  const trackedPatch = await git(cwd, "diff", "--binary", "--find-renames", "HEAD", ...pathspecArgs);
  const porcelain = await git(cwd, "status", "--porcelain=v1", ...pathspecArgs);
  const untrackedPaths = porcelain
    .trim()
    .split("\n")
    .filter((line) => line.startsWith("?? "))
    .map((line) => line.substring(3).trim())
    .filter(Boolean);
  const untrackedPatch = await diffPatchForUntrackedFiles(cwd, untrackedPaths);
  return [trackedPatch, untrackedPatch]
    .filter((patchContents) => typeof patchContents === "string" && patchContents.trim())
    .map(ensureTrailingNewline)
    .join("\n");
}

async function findStashRefByLabel(cwd: string, stashLabel: string): Promise<string | null> {
  const output = await git(cwd, "stash", "list", "--format=%gd%x00%s");
  const records = output
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const record of records) {
    const [ref, summary] = record.split("\0");
    if (ref && summary?.includes(stashLabel)) {
      return ref.trim();
    }
  }

  return null;
}

async function applyWorktreeHandoffStash(
  cwd: string,
  stashRef: string,
  options: { dropAfterApply?: boolean } = {}
): Promise<void> {
  const dropAfterApply = options.dropAfterApply === true;
  try {
    if (dropAfterApply) {
      await git(cwd, "stash", "apply", stashRef);
      await git(cwd, "stash", "drop", stashRef);
    } else {
      await git(cwd, "stash", "pop", stashRef);
    }
  } catch (error) {
    throw gitError(
      "create_worktree_failed",
      asError(error).message || "Could not apply local changes in the new worktree."
    );
  }
}

async function applyCopiedLocalChangesToWorktree(cwd: string, patchContents: string): Promise<void> {
  if (!patchContents.trim()) {
    return;
  }

  const patchFilePath = path.join(os.tmpdir(), `coderover-worktree-copy-${randomBytes(6).toString("hex")}.patch`);
  fs.writeFileSync(patchFilePath, ensureTrailingNewline(patchContents), "utf8");

  try {
    await git(cwd, "apply", "--binary", "--whitespace=nowarn", patchFilePath);
  } catch (error) {
    throw gitError(
      "create_worktree_failed",
      asError(error).message || "Could not copy local changes into the new worktree."
    );
  } finally {
    fs.rmSync(patchFilePath, { force: true });
  }
}

async function restoreWorktreeHandoffStash(cwd: string, stashRef: string): Promise<void> {
  try {
    await git(cwd, "stash", "pop", stashRef);
  } catch {
    // Best effort only.
  }
}

async function rollbackFailedHandoffTransfer(cwd: string, pathspecArgs: string[] = []): Promise<void> {
  if (pathspecArgs.length > 0) {
    try {
      await git(cwd, "restore", "--source=HEAD", "--staged", "--worktree", ...pathspecArgs);
    } catch {}
    try {
      await git(cwd, "clean", "-fd", ...pathspecArgs);
    } catch {}
    return;
  }

  try {
    await git(cwd, "reset", "--hard", "HEAD");
  } catch {}
  try {
    await git(cwd, "clean", "-fd");
  } catch {}
}

async function cleanupManagedWorktree(repoRoot: string, worktreeRootPath: string, branchName: string | null = null): Promise<void> {
  try {
    await git(repoRoot, "worktree", "remove", "--force", worktreeRootPath);
  } catch {
    // Fall back to directory cleanup.
  }

  if (branchName) {
    try {
      await git(repoRoot, "branch", "-D", branchName);
    } catch {
      // Best effort only.
    }
  }

  fs.rmSync(path.dirname(worktreeRootPath), { recursive: true, force: true });
}

function parseWorktreePathByBranch(output: string, options: { projectRelativePath?: string } = {}): Record<string, string> {
  const worktreePathByBranch: Record<string, string> = {};
  const records = typeof output === "string" ? output.split("\n\n") : [];
  const projectRelativePath = typeof options.projectRelativePath === "string"
    ? options.projectRelativePath
    : "";

  for (const record of records) {
    const lines = record
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    if (!lines.length) {
      continue;
    }

    const worktreeLine = lines.find((line) => line.startsWith("worktree "));
    const branchLine = lines.find((line) => line.startsWith("branch "));
    const worktreePath = worktreeLine?.slice("worktree ".length).trim();
    const branchName = normalizeWorktreeBranchRef(branchLine?.slice("branch ".length).trim());

    if (!worktreePath || !branchName) {
      continue;
    }

    worktreePathByBranch[branchName] = scopedWorktreePath(worktreePath, projectRelativePath);
  }

  return worktreePathByBranch;
}

function normalizeBranchListEntry(rawLine: string): { isCurrent: boolean; isCheckedOutElsewhere: boolean; name: string } | null {
  const trimmed = typeof rawLine === "string" ? rawLine.trim() : "";
  if (!trimmed) {
    return null;
  }

  const isCurrent = trimmed.startsWith("* ");
  const isCheckedOutElsewhere = trimmed.startsWith("+ ");
  const name = trimmed.replace(/^[*+]\s+/, "").trim();

  if (!name) {
    return null;
  }

  return { isCurrent, isCheckedOutElsewhere, name };
}

function normalizeWorktreeBranchRef(rawRef: string | undefined): string | null {
  const trimmed = typeof rawRef === "string" ? rawRef.trim() : "";
  if (!trimmed.startsWith("refs/heads/")) {
    return null;
  }

  const branchName = trimmed.slice("refs/heads/".length).trim();
  return branchName || null;
}

function normalizeCreatedBranchName(rawName: unknown): string {
  const trimmed = typeof rawName === "string" ? rawName.trim() : "";
  if (!trimmed) {
    return "";
  }

  const normalized = trimmed
    .split("/")
    .map((segment) => segment.trim().replace(/\s+/g, "-"))
    .join("/");

  if (normalized.startsWith("codex/")) {
    return normalized.replace(/^codex\//, "coderover/");
  }
  if (normalized.startsWith("coderover/")) {
    return normalized;
  }
  return `coderover/${normalized}`;
}

function resolveBaseBranchName(rawBaseBranch: unknown, fallbackBranch: string | null): string {
  const trimmedBaseBranch = typeof rawBaseBranch === "string" ? rawBaseBranch.trim() : "";
  if (trimmedBaseBranch) {
    return trimmedBaseBranch;
  }

  return typeof fallbackBranch === "string" && fallbackBranch.trim() ? fallbackBranch.trim() : "";
}

function resolveWorktreeChangeTransfer(rawValue: unknown): "none" | "copy" | "move" {
  switch (readNonEmptyString(rawValue)) {
    case "copy":
      return "copy";
    case "move":
      return "move";
    default:
      return "none";
  }
}

function allocateManagedWorktreePath(repoRoot: string): string {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const worktreesRoot = path.join(codexHome, "worktrees");
  fs.mkdirSync(worktreesRoot, { recursive: true });

  const repoName = path.basename(repoRoot) || "repo";
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const token = randomBytes(2).toString("hex");
    const tokenDirectory = path.join(worktreesRoot, token);
    const worktreePath = path.join(tokenDirectory, repoName);
    if (fs.existsSync(tokenDirectory) || fs.existsSync(worktreePath)) {
      continue;
    }
    fs.mkdirSync(tokenDirectory, { recursive: true });
    return worktreePath;
  }

  throw gitError("create_worktree_failed", "Could not allocate a managed worktree path.");
}

async function localBranchExists(cwd: string, branchName: string): Promise<boolean> {
  try {
    await git(cwd, "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`);
    return true;
  } catch {
    return false;
  }
}

async function assertValidCreatedBranchName(cwd: string, branchName: string): Promise<void> {
  try {
    await git(cwd, "check-ref-format", "--branch", branchName);
  } catch {
    throw gitError("invalid_branch_name", `Branch '${branchName}' is not a valid Git branch name.`);
  }
}

async function remoteBranchExists(cwd: string, branchName: string): Promise<boolean> {
  try {
    await git(cwd, "show-ref", "--verify", "--quiet", `refs/remotes/origin/${branchName}`);
    return true;
  } catch {
    return false;
  }
}

function sameFilePath(leftPath: string | null | undefined, rightPath: string | null | undefined): boolean {
  const normalizedLeft = normalizeExistingPath(leftPath);
  const normalizedRight = normalizeExistingPath(rightPath);
  return normalizedLeft !== null && normalizedLeft === normalizedRight;
}

function normalizeExistingPath(candidatePath: string | null | undefined): string | null {
  if (typeof candidatePath !== "string") {
    return null;
  }

  const trimmedPath = candidatePath.trim();
  if (!trimmedPath) {
    return null;
  }

  try {
    return fs.realpathSync.native(trimmedPath);
  } catch {
    return path.resolve(trimmedPath);
  }
}

function managedWorktreesRoot(): string | null {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return normalizeExistingPath(path.join(codexHome, "worktrees"));
}

function isManagedWorktreePath(candidatePath: string): boolean {
  const normalizedCandidate = normalizeExistingPath(candidatePath);
  const normalizedRoot = managedWorktreesRoot();
  if (!normalizedCandidate || !normalizedRoot) {
    return false;
  }

  const relativePath = path.relative(normalizedRoot, normalizedCandidate);
  return !!relativePath && relativePath !== "." && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

function resolveProjectRelativePath(cwd: string, repoRoot: string | null): string {
  const normalizedCwd = normalizeExistingPath(cwd);
  const normalizedRepoRoot = normalizeExistingPath(repoRoot);
  if (!normalizedCwd || !normalizedRepoRoot) {
    return "";
  }

  const relativePath = path.relative(normalizedRepoRoot, normalizedCwd);
  if (!relativePath || relativePath === ".") {
    return "";
  }

  return relativePath;
}

function scopedWorktreePath(worktreeRootPath: string, projectRelativePath: string): string {
  const normalizedWorktreeRootPath = normalizeExistingPath(worktreeRootPath);
  if (!normalizedWorktreeRootPath) {
    return worktreeRootPath;
  }
  if (!projectRelativePath) {
    return normalizedWorktreeRootPath;
  }

  const candidatePath = path.join(normalizedWorktreeRootPath, projectRelativePath);
  return isExistingDirectory(candidatePath) ? normalizeExistingPath(candidatePath) ?? candidatePath : normalizedWorktreeRootPath;
}

function scopedLocalCheckoutPath(checkoutRootPath: string | null, projectRelativePath: string): string | null {
  const normalizedCheckoutRootPath = normalizeExistingPath(checkoutRootPath);
  if (!normalizedCheckoutRootPath) {
    return null;
  }
  if (!projectRelativePath) {
    return normalizedCheckoutRootPath;
  }

  const candidatePath = path.join(normalizedCheckoutRootPath, projectRelativePath);
  return isExistingDirectory(candidatePath) ? normalizeExistingPath(candidatePath) ?? candidatePath : null;
}

async function scopedProjectChanges(repoRoot: string, projectRelativePath: string): Promise<{ dirty: boolean; pathspecArgs: string[] }> {
  const pathspecArgs = projectRelativePath ? ["--", projectRelativePath] : [];
  const porcelain = await git(repoRoot, "status", "--porcelain=v1", ...pathspecArgs);
  return {
    dirty: porcelain.trim().length > 0,
    pathspecArgs,
  };
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
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

  const firstLocalOnlyCommit = (
    await git(cwd, "rev-list", "--reverse", "--topo-order", "HEAD", "--not", "--remotes")
  ).trim().split("\n").find(Boolean);

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
  const output = await git(cwd, "diff", "--numstat", baseRef);
  return parseNumstatTotals(output);
}

async function gitDiffAgainstBase(cwd: string, baseRef: string): Promise<string> {
  return git(cwd, "diff", "--binary", baseRef);
}

async function diffTotalsForUntrackedFiles(cwd: string, filePaths: string[]): Promise<GitDiffTotals> {
  if (!filePaths.length) {
    return { additions: 0, deletions: 0, binaryFiles: 0 };
  }

  const totals = await Promise.all(filePaths.map((filePath) => gitDiffNoIndexNumstat(cwd, filePath)));
  return totals
    .map(parseNumstatTotals)
    .reduce<GitDiffTotals>(
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

async function countLocalOnlyCommits(cwd: string, { detached = false }: { detached?: boolean } = {}): Promise<number> {
  if (detached) {
    return 0;
  }

  const output = await git(cwd, "rev-list", "HEAD", "--not", "--remotes");
  return output.trim().split("\n").filter(Boolean).length;
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

async function resolveLocalCheckoutRoot(cwd: string): Promise<string | null> {
  const gitDir = (await git(cwd, "rev-parse", "--absolute-git-dir")).trim();
  if (!gitDir) {
    return null;
  }

  const worktreeMarker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
  const normalizedGitDir = normalizeExistingPath(gitDir) ?? gitDir;
  const worktreeIndex = normalizedGitDir.indexOf(worktreeMarker);
  if (worktreeIndex === -1) {
    return await resolveRepoRoot(cwd);
  }

  return normalizeExistingPath(normalizedGitDir.slice(0, worktreeIndex));
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

export const __test = {
  normalizeBranchListEntry,
  normalizeCreatedBranchName,
  gitBranches,
  gitCheckout,
  gitCommit,
  gitCreateBranch,
  gitCreateManagedWorktree,
  gitCreateWorktree,
  gitRemoveWorktree,
  gitStash,
  gitTransferManagedHandoff,
  gitStatus,
};
