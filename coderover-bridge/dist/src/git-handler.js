"use strict";
// FILE: git-handler.ts
// Purpose: Intercepts git/* JSON-RPC methods and executes git commands locally on the Mac.
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleGitRequest = handleGitRequest;
exports.gitStatus = gitStatus;
const child_process_1 = require("child_process");
const fs = require("fs");
const GIT_TIMEOUT_MS = 30_000;
const EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
function handleGitRequest(rawMessage, sendResponse) {
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
        .catch((error) => {
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
function parseGitRequest(rawMessage) {
    try {
        return JSON.parse(rawMessage);
    }
    catch {
        return null;
    }
}
async function handleGitMethod(method, params) {
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
async function gitStatus(cwd) {
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
async function gitDiff(cwd) {
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
async function gitCommit(cwd, params) {
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
async function gitPush(cwd) {
    try {
        const branch = (await git(cwd, "rev-parse", "--abbrev-ref", "HEAD")).trim();
        try {
            await git(cwd, "push");
        }
        catch (error) {
            const message = asError(error).message;
            if (message.includes("no upstream") || message.includes("has no upstream branch")) {
                await git(cwd, "push", "--set-upstream", "origin", branch);
            }
            else {
                throw error;
            }
        }
        const status = await gitStatus(cwd);
        return { branch, remote: "origin", status };
    }
    catch (error) {
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
async function gitPull(cwd) {
    try {
        await git(cwd, "pull", "--rebase");
        const status = await gitStatus(cwd);
        return { success: true, status };
    }
    catch (error) {
        try {
            await git(cwd, "rebase", "--abort");
        }
        catch {
            // ignore abort errors
        }
        if (isGitHandlerError(error)) {
            throw error;
        }
        throw gitError("pull_conflict", "Pull failed due to conflicts. Rebase aborted.");
    }
}
async function gitBranches(cwd) {
    const output = await git(cwd, "branch", "-a", "--no-color");
    const lines = output
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => line.trim());
    let current = "";
    const branchSet = new Set();
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
        }
        else {
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
async function gitCheckout(cwd, params) {
    const branch = readNonEmptyString(params.branch);
    if (!branch) {
        throw gitError("missing_branch", "Branch name is required.");
    }
    try {
        await git(cwd, "checkout", "--", branch);
    }
    catch (error) {
        const message = asError(error).message;
        if (message.includes("would be overwritten")) {
            throw gitError("checkout_conflict_dirty_tree", "Cannot switch branches: you have uncommitted changes.");
        }
        throw gitError("checkout_failed", message || "Checkout failed.");
    }
    const status = await gitStatus(cwd);
    return { current: branch, tracking: status.tracking, status };
}
async function gitLog(cwd) {
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
async function gitCreateBranch(cwd, params) {
    const name = readNonEmptyString(params.name);
    if (!name) {
        throw gitError("missing_branch_name", "Branch name is required.");
    }
    try {
        await git(cwd, "checkout", "-b", name);
    }
    catch (error) {
        const message = asError(error).message;
        if (message.includes("already exists")) {
            throw gitError("branch_exists", `Branch '${name}' already exists.`);
        }
        throw gitError("create_branch_failed", message || "Failed to create branch.");
    }
    const status = await gitStatus(cwd);
    return { branch: name, status };
}
async function gitStash(cwd) {
    const output = await git(cwd, "stash");
    const saved = !output.includes("No local changes");
    return { success: saved, message: output.trim() };
}
async function gitStashPop(cwd) {
    try {
        const output = await git(cwd, "stash", "pop");
        return { success: true, message: output.trim() };
    }
    catch (error) {
        throw gitError("stash_pop_conflict", asError(error).message || "Stash pop failed due to conflicts.");
    }
}
async function gitResetToRemote(cwd, params) {
    if (params.confirm !== "discard_runtime_changes") {
        throw gitError("confirmation_required", 'This action requires params.confirm === "discard_runtime_changes".');
    }
    let hasUpstream = true;
    try {
        await git(cwd, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
    }
    catch {
        hasUpstream = false;
    }
    if (hasUpstream) {
        await git(cwd, "fetch");
        await git(cwd, "reset", "--hard", "@{u}");
    }
    else {
        await git(cwd, "checkout", "--", ".");
    }
    await git(cwd, "clean", "-fd");
    const status = await gitStatus(cwd);
    return { success: true, status };
}
async function gitRemoteUrl(cwd) {
    const url = (await git(cwd, "config", "--get", "remote.origin.url")).trim();
    return { url, ownerRepo: parseOwnerRepo(url) };
}
function parseOwnerRepo(remoteUrl) {
    const match = remoteUrl.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    return match?.[1] ?? null;
}
async function gitBranchesWithStatus(cwd) {
    const [branchResult, statusResult] = await Promise.all([
        gitBranches(cwd),
        gitStatus(cwd),
    ]);
    return { ...branchResult, status: statusResult };
}
async function repoDiffTotals(cwd, context) {
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
async function resolveRepoDiffBase(cwd, tracking) {
    if (tracking) {
        try {
            return (await git(cwd, "merge-base", "HEAD", "@{u}")).trim();
        }
        catch {
            // Fall through to local-only commit scan if upstream metadata is stale.
        }
    }
    const firstLocalOnlyCommit = (await git(cwd, "rev-list", "--reverse", "--topo-order", "HEAD", "--not", "--remotes"))
        .trim()
        .split("\n")
        .find(Boolean);
    if (!firstLocalOnlyCommit) {
        return "HEAD";
    }
    try {
        return (await git(cwd, "rev-parse", `${firstLocalOnlyCommit}^`)).trim();
    }
    catch {
        return EMPTY_TREE_HASH;
    }
}
async function diffTotalsAgainstBase(cwd, baseRef) {
    return parseNumstatTotals(await git(cwd, "diff", "--numstat", baseRef));
}
async function gitDiffAgainstBase(cwd, baseRef) {
    return git(cwd, "diff", "--binary", "--find-renames", baseRef);
}
async function diffTotalsForUntrackedFiles(cwd, filePaths) {
    if (!filePaths.length) {
        return { additions: 0, deletions: 0, binaryFiles: 0 };
    }
    const totals = await Promise.all(filePaths.map(async (filePath) => {
        return parseNumstatTotals(await gitDiffNoIndexNumstat(cwd, filePath));
    }));
    return totals.reduce((aggregate, current) => ({
        additions: aggregate.additions + current.additions,
        deletions: aggregate.deletions + current.deletions,
        binaryFiles: aggregate.binaryFiles + current.binaryFiles,
    }), { additions: 0, deletions: 0, binaryFiles: 0 });
}
function parseNumstatTotals(output) {
    return output
        .trim()
        .split("\n")
        .filter(Boolean)
        .reduce((aggregate, line) => {
        const [rawAdditions, rawDeletions] = line.split("\t");
        const additions = Number.parseInt(rawAdditions ?? "", 10);
        const deletions = Number.parseInt(rawDeletions ?? "", 10);
        const isBinary = !Number.isFinite(additions) || !Number.isFinite(deletions);
        return {
            additions: aggregate.additions + (Number.isFinite(additions) ? additions : 0),
            deletions: aggregate.deletions + (Number.isFinite(deletions) ? deletions : 0),
            binaryFiles: aggregate.binaryFiles + (isBinary ? 1 : 0),
        };
    }, { additions: 0, deletions: 0, binaryFiles: 0 });
}
async function gitDiffNoIndexNumstat(cwd, filePath) {
    try {
        const result = await execFileAsync("git", ["diff", "--no-index", "--numstat", "--", "/dev/null", filePath], cwd);
        return result.stdout;
    }
    catch (error) {
        const execError = error;
        if (typeof execError.code === "number" && execError.code === 1) {
            return readExecOutput(execError.stdout);
        }
        throw new Error(readExecOutput(execError.stderr) || execError.message || "git diff --no-index failed");
    }
}
async function diffPatchForUntrackedFiles(cwd, filePaths) {
    if (!filePaths.length) {
        return "";
    }
    const patches = await Promise.all(filePaths.map((filePath) => gitDiffNoIndexPatch(cwd, filePath)));
    return patches.filter(Boolean).join("\n\n");
}
async function gitDiffNoIndexPatch(cwd, filePath) {
    try {
        const result = await execFileAsync("git", ["diff", "--no-index", "--binary", "--", "/dev/null", filePath], cwd);
        return result.stdout;
    }
    catch (error) {
        const execError = error;
        if (typeof execError.code === "number" && execError.code === 1) {
            return readExecOutput(execError.stdout);
        }
        throw new Error(readExecOutput(execError.stderr) || execError.message || "git diff --no-index failed");
    }
}
async function git(cwd, ...args) {
    try {
        const result = await execFileAsync("git", args, cwd);
        return result.stdout;
    }
    catch (error) {
        const execError = error;
        const message = readExecOutput(execError.stderr) || execError.message || "git command failed";
        throw new Error(message.trim() || "git command failed");
    }
}
async function revListCounts(cwd) {
    const output = await git(cwd, "rev-list", "--left-right", "--count", "HEAD...@{u}");
    const parts = output.trim().split(/\s+/);
    return {
        ahead: Number.parseInt(parts[0] ?? "", 10) || 0,
        behind: Number.parseInt(parts[1] ?? "", 10) || 0,
    };
}
function parseBranchFromStatus(line) {
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
function parseTrackingFromStatus(line) {
    const match = line.match(/\.{3}(.+?)(?:\s|$)/);
    return match?.[1]?.trim() ?? null;
}
function computeState(dirty, ahead, behind, detached, noUpstream) {
    if (detached)
        return "detached_head";
    if (noUpstream)
        return "no_upstream";
    if (dirty && behind > 0)
        return "dirty_and_behind";
    if (dirty)
        return "dirty";
    if (ahead > 0 && behind > 0)
        return "diverged";
    if (behind > 0)
        return "behind_only";
    if (ahead > 0)
        return "ahead_only";
    return "up_to_date";
}
async function detectDefaultBranch(cwd, branches) {
    try {
        const ref = await git(cwd, "symbolic-ref", "refs/remotes/origin/HEAD");
        const defaultBranch = ref.trim().replace("refs/remotes/origin/", "");
        if (defaultBranch && branches.includes(defaultBranch)) {
            return defaultBranch;
        }
    }
    catch {
        // ignore
    }
    if (branches.includes("main"))
        return "main";
    if (branches.includes("master"))
        return "master";
    return branches[0] || null;
}
function gitError(errorCode, userMessage) {
    const error = new Error(userMessage);
    error.errorCode = errorCode;
    error.userMessage = userMessage;
    return error;
}
async function resolveGitCwd(params) {
    const requestedCwd = firstNonEmptyString([params.cwd, params.currentWorkingDirectory]);
    if (!requestedCwd) {
        throw gitError("missing_working_directory", "Git actions require a bound local working directory.");
    }
    if (!isExistingDirectory(requestedCwd)) {
        throw gitError("missing_working_directory", "The requested local working directory does not exist on this Mac.");
    }
    return requestedCwd;
}
function firstNonEmptyString(candidates) {
    for (const candidate of candidates) {
        const value = readNonEmptyString(candidate);
        if (value) {
            return value;
        }
    }
    return null;
}
function readNonEmptyString(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}
function isExistingDirectory(candidatePath) {
    try {
        return fs.statSync(candidatePath).isDirectory();
    }
    catch {
        return false;
    }
}
async function resolveRepoRoot(cwd) {
    const repoRoot = (await git(cwd, "rev-parse", "--show-toplevel")).trim();
    return repoRoot || null;
}
function readExecOutput(value) {
    if (typeof value === "string") {
        return value;
    }
    if (Buffer.isBuffer(value)) {
        return value.toString("utf8");
    }
    return "";
}
function execFileAsync(command, args, cwd) {
    return new Promise((resolve, reject) => {
        (0, child_process_1.execFile)(command, args, { cwd, timeout: GIT_TIMEOUT_MS }, (error, stdout, stderr) => {
            if (error) {
                const execError = error;
                execError.stdout = stdout;
                execError.stderr = stderr;
                reject(execError);
                return;
            }
            resolve({ stdout, stderr });
        });
    });
}
function isGitHandlerError(error) {
    return Boolean(error
        && typeof error === "object"
        && typeof error.errorCode === "string");
}
function asError(error) {
    return error instanceof Error ? error : new Error(String(error));
}
