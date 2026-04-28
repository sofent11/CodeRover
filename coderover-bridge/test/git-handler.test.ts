// FILE: git-handler.test.ts
// Purpose: Covers branch parsing, managed worktree flows, and checkout regressions for the local git bridge.

import { test } from "bun:test";
import { strict as assert } from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "node:child_process";

import { __test, handleGitRequest } from "../src/git-handler";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
  }).trim();
}

function makeTempRepo(): string {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "coderover-git-handler-"));
  git(repoDir, "init", "-b", "main");
  git(repoDir, "config", "user.name", "CodeRover Tests");
  git(repoDir, "config", "user.email", "tests@example.com");
  fs.writeFileSync(path.join(repoDir, "README.md"), "# Test\n");
  fs.mkdirSync(path.join(repoDir, "coderover-bridge", "src"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "coderover-bridge", "src", "index.ts"), "export const ready = true;\n");
  git(repoDir, "add", "README.md");
  git(repoDir, "add", "coderover-bridge/src/index.ts");
  git(repoDir, "commit", "-m", "Initial commit");
  git(repoDir, "branch", "feature/clean-switch");
  return repoDir;
}

function canonicalPath(candidatePath: string): string {
  return fs.realpathSync.native(candidatePath);
}

function cleanupPaths(...pathsToDelete: string[]) {
  for (const targetPath of pathsToDelete) {
    fs.rmSync(targetPath, { recursive: true, force: true });
  }
}

function callGitRequest(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const handled = handleGitRequest(
      JSON.stringify({
        id: `${method}-${Date.now()}-${Math.random()}`,
        method,
        params,
      }),
      (response) => {
        const parsed = JSON.parse(response) as Record<string, unknown>;
        if (parsed.error) {
          reject(parsed.error);
          return;
        }
        resolve(parsed.result as Record<string, unknown>);
      }
    );
    if (!handled) {
      reject(new Error(`Request was not handled: ${method}`));
    }
  });
}

test("normalizeBranchListEntry strips linked-worktree markers from branch labels", () => {
  assert.deepEqual(__test.normalizeBranchListEntry("+ main"), {
    isCurrent: false,
    isCheckedOutElsewhere: true,
    name: "main",
  });
  assert.deepEqual(__test.normalizeBranchListEntry("* feature/mobile"), {
    isCurrent: true,
    isCheckedOutElsewhere: false,
    name: "feature/mobile",
  });
});

test("normalizeCreatedBranchName normalizes bare names into coderover/*", () => {
  assert.equal(__test.normalizeCreatedBranchName("new branch"), "coderover/new-branch");
  assert.equal(__test.normalizeCreatedBranchName("codex/feature"), "coderover/feature");
  assert.equal(__test.normalizeCreatedBranchName("coderover/feature"), "coderover/feature");
});

test("gitBranches marks branches that are checked out in another worktree", async () => {
  const repoDir = makeTempRepo();
  const siblingWorktree = path.join(path.dirname(repoDir), `${path.basename(repoDir)}-wt-feature`);

  try {
    git(repoDir, "worktree", "add", siblingWorktree, "feature/clean-switch");

    const result = await __test.gitBranches(repoDir);

    assert.deepEqual(result.branchesCheckedOutElsewhere, ["feature/clean-switch"]);
    assert.ok(result.branches.includes("feature/clean-switch"));
    assert.equal(result.worktreePathByBranch["feature/clean-switch"], canonicalPath(siblingWorktree));
  } finally {
    cleanupPaths(repoDir, siblingWorktree);
  }
});

test("gitBranches scopes worktree and local checkout paths to the current subdirectory", async () => {
  const repoDir = makeTempRepo();
  const projectDir = path.join(repoDir, "coderover-bridge");
  const siblingWorktree = path.join(path.dirname(repoDir), `${path.basename(repoDir)}-wt-feature`);
  const siblingProjectDir = path.join(siblingWorktree, "coderover-bridge");

  try {
    git(repoDir, "worktree", "add", siblingWorktree, "feature/clean-switch");

    const result = await __test.gitBranches(siblingProjectDir);

    assert.equal(result.worktreePathByBranch["feature/clean-switch"], canonicalPath(siblingProjectDir));
    assert.equal(result.localCheckoutPath, canonicalPath(projectDir));
  } finally {
    cleanupPaths(repoDir, siblingWorktree);
  }
});

test("gitCheckout surfaces a specific error when the branch is open in another worktree", async () => {
  const repoDir = makeTempRepo();
  const siblingWorktree = path.join(path.dirname(repoDir), `${path.basename(repoDir)}-wt-feature`);

  try {
    git(repoDir, "worktree", "add", siblingWorktree, "feature/clean-switch");

    await assert.rejects(
      __test.gitCheckout(repoDir, { branch: "feature/clean-switch" }),
      (error: any) =>
        error?.errorCode === "checkout_branch_in_other_worktree"
          && error?.userMessage === "Cannot switch branches: this branch is already open in another worktree."
    );
  } finally {
    cleanupPaths(repoDir, siblingWorktree);
  }
});

test("gitCreateBranch checks out a normalized branch name", async () => {
  const repoDir = makeTempRepo();

  try {
    const result = await __test.gitCreateBranch(repoDir, { name: "new branch" });

    assert.equal(result.branch, "coderover/new-branch");
    assert.equal(result.status.branch, "coderover/new-branch");
    assert.equal(git(repoDir, "rev-parse", "--abbrev-ref", "HEAD"), "coderover/new-branch");
  } finally {
    cleanupPaths(repoDir);
  }
});

test("gitCommit refuses implicit project commits when other repo changes are dirty", async () => {
  const repoDir = makeTempRepo();
  const projectDir = path.join(repoDir, "coderover-bridge");

  try {
    fs.writeFileSync(path.join(projectDir, "src", "index.ts"), "export const ready = false;\n");
    fs.writeFileSync(path.join(repoDir, "README.md"), "# Dirty outside project\n");

    await assert.rejects(
      __test.gitCommit(projectDir, { message: "Scoped commit" }),
      (error: any) => error?.errorCode === "commit_scope_conflict"
    );

    assert.equal(git(repoDir, "status", "--porcelain").split("\n").filter(Boolean).length, 2);
  } finally {
    cleanupPaths(repoDir);
  }
});

test("gitCommit with explicit paths commits only the requested files", async () => {
  const repoDir = makeTempRepo();
  const projectDir = path.join(repoDir, "coderover-bridge");

  try {
    fs.writeFileSync(path.join(projectDir, "src", "index.ts"), "export const ready = false;\n");
    fs.writeFileSync(path.join(repoDir, "README.md"), "# Dirty outside project\n");

    const result = await __test.gitCommit(projectDir, {
      message: "Commit project file",
      paths: ["src/index.ts"],
    });

    assert.match(result.hash, /^[a-f0-9]+$/);
    assert.equal(git(repoDir, "status", "--porcelain"), "M README.md");
    assert.equal(git(repoDir, "show", "--name-only", "--format=", "HEAD"), "coderover-bridge/src/index.ts");
  } finally {
    cleanupPaths(repoDir);
  }
});

test("mutating git requests for one repo are serialized at the bridge entrypoint", async () => {
  const repoDir = makeTempRepo();

  try {
    fs.writeFileSync(path.join(repoDir, "README.md"), "# Concurrent commit\n");

    const results = await Promise.allSettled([
      callGitRequest("git/commit", {
        cwd: repoDir,
        message: "Concurrent commit",
        changeScope: "repo",
        confirm: "commit_all_repo_changes",
      }),
      callGitRequest("git/commit", {
        cwd: repoDir,
        message: "Concurrent commit duplicate",
        changeScope: "repo",
        confirm: "commit_all_repo_changes",
      }),
    ]);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal(git(repoDir, "status", "--porcelain"), "");
  } finally {
    cleanupPaths(repoDir);
  }
});

test("gitResetToRemote discards staged, unstaged, and untracked changes without an upstream", async () => {
  const repoDir = makeTempRepo();
  const trackedPath = path.join(repoDir, "README.md");
  const projectPath = path.join(repoDir, "coderover-bridge", "src", "index.ts");
  const untrackedPath = path.join(repoDir, "scratch.txt");

  try {
    fs.writeFileSync(trackedPath, "# Staged change\n");
    git(repoDir, "add", "README.md");
    fs.writeFileSync(projectPath, "export const ready = false;\n");
    fs.writeFileSync(untrackedPath, "temporary\n");

    const result = await callGitRequest("git/resetToRemote", {
      cwd: repoDir,
      confirm: "discard_runtime_changes",
    });

    assert.equal((result.status as Record<string, unknown>).dirty, false);
    assert.equal(git(repoDir, "status", "--porcelain"), "");
    assert.equal(fs.readFileSync(trackedPath, "utf8"), "# Test\n");
    assert.equal(fs.readFileSync(projectPath, "utf8"), "export const ready = true;\n");
    assert.equal(fs.existsSync(untrackedPath), false);
  } finally {
    cleanupPaths(repoDir);
  }
});

test("gitCreateManagedWorktree creates a detached worktree under CODEX_HOME/worktrees", async () => {
  const repoDir = makeTempRepo();
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "coderover-codex-home-"));
  const previousCodexHome = process.env.CODEX_HOME;

  try {
    process.env.CODEX_HOME = codexHome;
    const result = await __test.gitCreateManagedWorktree(repoDir, {
      baseBranch: "main",
      changeTransfer: "none",
    });

    assert.equal(result.alreadyExisted, false);
    assert.equal(result.baseBranch, "main");
    assert.equal(result.headMode, "detached");
    assert.equal(result.transferredChanges, false);
    assert.ok(result.worktreePath.includes(path.join(".codex", "worktrees")) || result.worktreePath.includes(path.join(codexHome, "worktrees")));
    assert.ok(fs.existsSync(result.worktreePath));
  } finally {
    process.env.CODEX_HOME = previousCodexHome;
    cleanupPaths(repoDir, codexHome);
  }
});

test("gitTransferManagedHandoff moves tracked changes into the target project", async () => {
  const repoDir = makeTempRepo();
  const managedWorktree = path.join(path.dirname(repoDir), `${path.basename(repoDir)}-managed`);

  try {
    git(repoDir, "worktree", "add", "--detach", managedWorktree, "main");
    fs.writeFileSync(path.join(managedWorktree, "README.md"), "# Updated\n");

    const result = await __test.gitTransferManagedHandoff(managedWorktree, {
      targetProjectPath: repoDir,
    });

    assert.equal(result.success, true);
    assert.equal(result.transferredChanges, true);
    assert.match(fs.readFileSync(path.join(repoDir, "README.md"), "utf8"), /Updated/);
  } finally {
    cleanupPaths(repoDir, managedWorktree);
  }
});

test("gitRemoveWorktree removes managed worktrees but refuses the main checkout", async () => {
  const repoDir = makeTempRepo();
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "coderover-codex-home-"));
  const previousCodexHome = process.env.CODEX_HOME;

  try {
    process.env.CODEX_HOME = codexHome;
    const created = await __test.gitCreateManagedWorktree(repoDir, {
      baseBranch: "main",
      changeTransfer: "none",
    });

    const result = await __test.gitRemoveWorktree(created.worktreePath, {});
    assert.equal(result.success, true);
    assert.equal(fs.existsSync(created.worktreePath), false);

    await assert.rejects(
      __test.gitRemoveWorktree(repoDir, {}),
      (error: any) => error?.errorCode === "cannot_remove_local_checkout"
    );
  } finally {
    process.env.CODEX_HOME = previousCodexHome;
    cleanupPaths(repoDir, codexHome);
  }
});
