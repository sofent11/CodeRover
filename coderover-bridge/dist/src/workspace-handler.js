"use strict";
// FILE: workspace-handler.ts
// Purpose: Executes workspace-scoped reverse patch previews/applies without touching unrelated repo changes.
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleWorkspaceRequest = handleWorkspaceRequest;
const child_process_1 = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const git_handler_1 = require("./git-handler");
const GIT_TIMEOUT_MS = 30_000;
const repoMutationLocks = new Map();
function handleWorkspaceRequest(rawMessage, sendResponse) {
    const parsed = parseWorkspaceRequest(rawMessage);
    if (!parsed) {
        return false;
    }
    const method = typeof parsed.method === "string" ? parsed.method.trim() : "";
    if (!method.startsWith("workspace/")) {
        return false;
    }
    const id = parsed.id;
    const params = parsed.params || {};
    handleWorkspaceMethod(method, params)
        .then((result) => {
        sendResponse(JSON.stringify({ id, result }));
    })
        .catch((error) => {
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
function parseWorkspaceRequest(rawMessage) {
    try {
        return JSON.parse(rawMessage);
    }
    catch {
        return null;
    }
}
async function handleWorkspaceMethod(method, params) {
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
async function workspaceRevertPatchPreview(repoRoot, params) {
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
async function workspaceRevertPatchApply(repoRoot, params) {
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
            status: await (0, git_handler_1.gitStatus)(repoRoot).catch(() => null),
        };
    }
    return {
        success: true,
        revertedFiles: preview.affectedFiles,
        conflicts: [],
        unsupportedReasons: [],
        stagedFiles: [],
        status: await (0, git_handler_1.gitStatus)(repoRoot).catch(() => null),
    };
}
function resolveForwardPatch(params) {
    const forwardPatch = typeof params.forwardPatch === "string" ? params.forwardPatch : "";
    if (!forwardPatch.trim()) {
        throw workspaceError("missing_patch", "The request must include a non-empty forwardPatch.");
    }
    return forwardPatch.endsWith("\n") ? forwardPatch : `${forwardPatch}\n`;
}
function analyzeUnifiedPatch(rawPatch) {
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
    const affectedFiles = [];
    const unsupportedReasons = new Set();
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
function splitPatchIntoChunks(patch) {
    const lines = patch.split("\n");
    if (!lines.length) {
        return [];
    }
    const chunks = [];
    let current = [];
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
function analyzePatchChunk(lines) {
    const pathValue = extractPatchPath(lines);
    const isBinary = lines.some((line) => line.startsWith("Binary files ") || line === "GIT binary patch");
    const isRenameOrModeOnly = lines.some((line) => line.startsWith("rename from ")
        || line.startsWith("rename to ")
        || line.startsWith("copy from ")
        || line.startsWith("copy to ")
        || line.startsWith("old mode ")
        || line.startsWith("new mode ")
        || line.startsWith("similarity index ")
        || line.startsWith("new file mode 120")
        || line.startsWith("deleted file mode 120"));
    let additions = 0;
    let deletions = 0;
    for (const line of lines) {
        if (line.startsWith("+") && !line.startsWith("+++")) {
            additions += 1;
        }
        else if (line.startsWith("-") && !line.startsWith("---")) {
            deletions += 1;
        }
    }
    const unsupportedReasons = [];
    if (isBinary) {
        unsupportedReasons.push("Binary changes are not auto-revertable in v1.");
    }
    if (isRenameOrModeOnly) {
        unsupportedReasons.push("Rename, mode-only, or symlink changes are not auto-revertable in v1.");
    }
    if (!pathValue
        || (!additions && !deletions && !lines.includes("--- /dev/null") && !lines.includes("+++ /dev/null"))) {
        if (!isBinary && !isRenameOrModeOnly) {
            unsupportedReasons.push("No exact patch was captured.");
        }
    }
    return { path: pathValue, unsupportedReasons };
}
function extractPatchPath(lines) {
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
                return normalizeDiffPath(components[3]);
            }
        }
    }
    return "";
}
function normalizeDiffPath(rawPath) {
    if (!rawPath) {
        return "";
    }
    if (rawPath.startsWith("a/") || rawPath.startsWith("b/")) {
        return rawPath.slice(2);
    }
    return rawPath;
}
async function findStagedTargetedFiles(cwd, affectedFiles) {
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
    }
    catch {
        return [];
    }
}
async function runGitApply(cwd, args, patchText) {
    const tempPatchPath = await writeTempPatchFile(patchText);
    try {
        const result = await execFileAsync("git", [...args, tempPatchPath], cwd);
        return { ok: true, stdout: result.stdout, stderr: result.stderr };
    }
    catch (error) {
        const execError = error;
        return {
            ok: false,
            stdout: readExecOutput(execError.stdout),
            stderr: readExecOutput(execError.stderr) || execError.message || "",
        };
    }
    finally {
        try {
            fs.unlinkSync(tempPatchPath);
        }
        catch {
            // Ignore temp cleanup failures.
        }
    }
}
async function writeTempPatchFile(patchText) {
    const tempPatchPath = path.join(os.tmpdir(), `coderover-revert-${Date.now()}-${Math.random().toString(16).slice(2)}.patch`);
    await fs.promises.writeFile(tempPatchPath, patchText, "utf8");
    return tempPatchPath;
}
function parseApplyConflicts(stderr) {
    const lines = String(stderr || "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    const conflictsByPath = new Map();
    for (const line of lines) {
        let filePath = "unknown";
        const patchFailedMatch = line.match(/^error:\s+patch failed:\s+(.+?):\d+$/i);
        const doesNotApplyMatch = line.match(/^error:\s+(.+?):\s+patch does not apply$/i);
        if (patchFailedMatch) {
            filePath = patchFailedMatch[1];
        }
        else if (doesNotApplyMatch) {
            filePath = doesNotApplyMatch[1];
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
async function withRepoMutationLock(cwd, callback) {
    const previous = repoMutationLocks.get(cwd) || Promise.resolve();
    let releaseCurrent;
    const current = new Promise((resolve) => {
        releaseCurrent = resolve;
    });
    const releaseLock = releaseCurrent;
    const chained = previous.then(() => current);
    repoMutationLocks.set(cwd, chained);
    await previous;
    try {
        return await callback();
    }
    finally {
        releaseLock();
        if (repoMutationLocks.get(cwd) === chained) {
            repoMutationLocks.delete(cwd);
        }
    }
}
async function resolveWorkspaceCwd(params) {
    const requestedCwd = firstNonEmptyString([params.cwd, params.currentWorkingDirectory]);
    if (!requestedCwd) {
        throw workspaceError("missing_working_directory", "Workspace actions require a bound local working directory.");
    }
    if (!isExistingDirectory(requestedCwd)) {
        throw workspaceError("missing_working_directory", "The requested local working directory does not exist on this Mac.");
    }
    return requestedCwd;
}
async function resolveRepoRoot(cwd) {
    try {
        const repoRoot = (await git(cwd, "rev-parse", "--show-toplevel")).trim();
        if (repoRoot) {
            return repoRoot;
        }
    }
    catch {
        // Fall through to user-facing error below.
    }
    throw workspaceError("missing_working_directory", "The selected local folder is not inside a Git repository.");
}
function firstNonEmptyString(candidates) {
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
function isExistingDirectory(candidatePath) {
    try {
        return fs.statSync(candidatePath).isDirectory();
    }
    catch {
        return false;
    }
}
function workspaceError(errorCode, userMessage) {
    const error = new Error(userMessage);
    error.errorCode = errorCode;
    error.userMessage = userMessage;
    return error;
}
async function git(cwd, ...args) {
    try {
        return (await execFileAsync("git", args, cwd)).stdout;
    }
    catch (error) {
        const execError = error;
        throw new Error(readExecOutput(execError.stderr) || execError.message || "git command failed");
    }
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
function readExecOutput(value) {
    if (typeof value === "string") {
        return value;
    }
    if (Buffer.isBuffer(value)) {
        return value.toString("utf8");
    }
    return "";
}
