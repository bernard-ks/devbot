import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  backupRefForTask,
  describeBranchFreshness,
  inspectBranchFreshness,
  isSafeBranchName,
  syncTaskBranch
} from "./branch-freshness.js";
import { hardenedGitEnvironment } from "./security.js";
import { createTaskWorktree } from "./task-worktree.js";
import type { TaskWorktree } from "./task-worktree.js";

test("backup refs and branch names are exact-format validated", () => {
  assert.equal(backupRefForTask("task-mc6ju1-a1b2c3"), "refs/devbot/backup/task-mc6ju1-a1b2c3");
  assert.equal(backupRefForTask("task-UPPER"), undefined);
  assert.equal(backupRefForTask("../evil"), undefined);
  assert.equal(backupRefForTask("task-" + "a".repeat(53)), undefined);
  assert.equal(isSafeBranchName("devbot/task/task-abc"), true);
  assert.equal(isSafeBranchName("main"), true);
  assert.equal(isSafeBranchName("release/1.2"), true);
  assert.equal(isSafeBranchName("-option-injection"), false);
  assert.equal(isSafeBranchName("../escape"), false);
  assert.equal(isSafeBranchName("branch@{upstream}"), false);
  assert.equal(isSafeBranchName("branch.lock"), false);
  assert.equal(isSafeBranchName(""), false);
});

test("reports merged state for a task branch fully contained in the default branch", async () => {
  const fixture = await createGitFixture();
  const worktree = await createTaskBranch(fixture, "merge-me");
  await writeFile(path.join(worktree.path, "feature.txt"), "feature\n");
  await git(worktree.path, ["add", "feature.txt"]);
  await git(worktree.path, ["commit", "-m", "Task change"]);
  await git(fixture.repo, ["merge", "--no-ff", worktree.branch, "-m", "Merge task branch"]);

  const freshness = await inspectBranchFreshness({
    repositoryPath: fixture.repo,
    branch: worktree.branch,
    defaultBranch: "main"
  });
  assert.equal(freshness.available, true);
  if (!freshness.available) return;
  assert.equal(freshness.merged, true);
  assert.equal(freshness.ahead, 0);
  assert.match(describeBranchFreshness(freshness), /merged into main/);
  assert.match(describeBranchFreshness(freshness), /eligible for pruning/);

  const sync = await syncTaskBranch({ worktree, defaultBranch: "main", taskId: "task-merge-me" });
  assert.equal(sync.outcome, "already-merged");
});

test("reports behind and ahead counts against the default branch", async () => {
  const fixture = await createGitFixture();
  const worktree = await createTaskBranch(fixture, "diverged");
  await writeFile(path.join(worktree.path, "feature.txt"), "feature\n");
  await git(worktree.path, ["add", "feature.txt"]);
  await git(worktree.path, ["commit", "-m", "Task change"]);
  await writeFile(path.join(fixture.repo, "mainline.txt"), "mainline\n");
  await git(fixture.repo, ["add", "mainline.txt"]);
  await git(fixture.repo, ["commit", "-m", "Main change"]);

  const freshness = await inspectBranchFreshness({
    repositoryPath: fixture.repo,
    branch: worktree.branch,
    defaultBranch: "main"
  });
  assert.equal(freshness.available, true);
  if (!freshness.available) return;
  assert.equal(freshness.merged, false);
  assert.equal(freshness.behind, 1);
  assert.equal(freshness.ahead, 1);
  assert.equal(describeBranchFreshness(freshness), "behind main by 1, ahead by 1");

  const missing = await inspectBranchFreshness({ repositoryPath: fixture.repo, branch: "devbot/task/absent", defaultBranch: "main" });
  assert.equal(missing.available, false);
  if (!missing.available) assert.equal(missing.reason, "branch_missing");
  const noDefault = await inspectBranchFreshness({ repositoryPath: fixture.repo, branch: worktree.branch, defaultBranch: "trunk" });
  assert.equal(noDefault.available, false);
  if (!noDefault.available) assert.equal(noDefault.reason, "default_branch_missing");
  const invalid = await inspectBranchFreshness({ repositoryPath: fixture.repo, branch: "--exec=oops", defaultBranch: "main" });
  assert.equal(invalid.available, false);
  if (!invalid.available) assert.equal(invalid.reason, "invalid_branch_name");
});

test("cleanly syncs a stale branch in its isolated worktree with the tip preserved first", async () => {
  const fixture = await createGitFixture();
  const worktree = await createTaskBranch(fixture, "sync-clean");
  await writeFile(path.join(worktree.path, "feature.txt"), "feature\n");
  await git(worktree.path, ["add", "feature.txt"]);
  await git(worktree.path, ["commit", "-m", "Task change"]);
  await writeFile(path.join(fixture.repo, "mainline.txt"), "mainline\n");
  await git(fixture.repo, ["add", "mainline.txt"]);
  await git(fixture.repo, ["commit", "-m", "Main change"]);
  const previousTip = await git(fixture.repo, ["rev-parse", `refs/heads/${worktree.branch}`]);
  const mainTip = await git(fixture.repo, ["rev-parse", "refs/heads/main"]);

  const result = await syncTaskBranch({ worktree, defaultBranch: "main", taskId: "task-sync-clean" });
  assert.equal(result.outcome, "synced");
  if (result.outcome !== "synced") return;
  assert.equal(result.previousTip, previousTip);
  assert.equal(result.backupRef, "refs/devbot/backup/task-sync-clean");
  assert.equal(result.replayedCommits, 1);
  assert.equal(await git(fixture.repo, ["rev-parse", result.backupRef]), previousTip);
  assert.notEqual(result.newTip, previousTip);
  await git(fixture.repo, ["merge-base", "--is-ancestor", mainTip, result.newTip]);

  assert.equal(await git(fixture.repo, ["rev-parse", "refs/heads/main"]), mainTip);
  assert.equal(await git(fixture.repo, ["branch", "--show-current"]), "main");
  assert.equal(await git(fixture.repo, ["status", "--porcelain"]), "");
  assert.equal(await git(worktree.path, ["rev-parse", "HEAD"]), result.newTip);
  assert.equal(await git(worktree.path, ["status", "--porcelain"]), "");
  await stat(path.join(worktree.path, "mainline.txt"));

  const after = await inspectBranchFreshness({ repositoryPath: fixture.repo, branch: worktree.branch, defaultBranch: "main" });
  assert.equal(after.available, true);
  if (!after.available) return;
  assert.equal(after.behind, 0);
  assert.equal(after.ahead, 1);
});

test("aborts a conflicted sync, restores the pristine branch, and reports the conflicted files", async () => {
  const fixture = await createGitFixture();
  const worktree = await createTaskBranch(fixture, "sync-conflict");
  await writeFile(path.join(worktree.path, "tracked.txt"), "task version\n");
  await git(worktree.path, ["add", "tracked.txt"]);
  await git(worktree.path, ["commit", "-m", "Task change"]);
  await writeFile(path.join(fixture.repo, "tracked.txt"), "main version\n");
  await git(fixture.repo, ["add", "tracked.txt"]);
  await git(fixture.repo, ["commit", "-m", "Main change"]);
  const previousTip = await git(fixture.repo, ["rev-parse", `refs/heads/${worktree.branch}`]);

  const result = await syncTaskBranch({ worktree, defaultBranch: "main", taskId: "task-sync-conflict" });
  assert.equal(result.outcome, "conflict");
  if (result.outcome !== "conflict") return;
  assert.deepEqual(result.conflictedFiles, ["tracked.txt"]);
  assert.equal(result.conflictedFileCount, 1);
  assert.equal(result.restored, true);
  assert.equal(result.previousTip, previousTip);
  assert.match(result.message, /never auto-resolved/);

  assert.equal(await git(fixture.repo, ["rev-parse", `refs/heads/${worktree.branch}`]), previousTip);
  assert.equal(await git(fixture.repo, ["rev-parse", result.backupRef]), previousTip);
  assert.equal(await git(worktree.path, ["rev-parse", "HEAD"]), previousTip);
  assert.equal(await git(worktree.path, ["branch", "--show-current"]), worktree.branch);
  assert.equal(await git(worktree.path, ["status", "--porcelain"]), "");
  const rebaseState = await git(worktree.path, ["rev-parse", "--git-path", "rebase-merge"]);
  await assert.rejects(stat(path.resolve(worktree.path, rebaseState)), /ENOENT/);
});

test("refuses to sync a worktree with uncommitted changes", async () => {
  const fixture = await createGitFixture();
  const worktree = await createTaskBranch(fixture, "sync-dirty");
  await writeFile(path.join(worktree.path, "tracked.txt"), "uncommitted\n");
  await writeFile(path.join(fixture.repo, "mainline.txt"), "mainline\n");
  await git(fixture.repo, ["add", "mainline.txt"]);
  await git(fixture.repo, ["commit", "-m", "Main change"]);
  const previousTip = await git(fixture.repo, ["rev-parse", `refs/heads/${worktree.branch}`]);

  const result = await syncTaskBranch({ worktree, defaultBranch: "main", taskId: "task-sync-dirty" });
  assert.equal(result.outcome, "blocked");
  if (result.outcome !== "blocked") return;
  assert.equal(result.reason, "dirty_worktree");
  assert.equal(await git(fixture.repo, ["rev-parse", `refs/heads/${worktree.branch}`]), previousTip);
});

test("sync never executes repository hooks or inherits secret environment variables", async () => {
  if (process.platform === "win32") return;
  const fixture = await createGitFixture();
  const worktree = await createTaskBranch(fixture, "sync-hardened");
  await writeFile(path.join(worktree.path, "feature.txt"), "feature\n");
  await git(worktree.path, ["add", "feature.txt"]);
  await git(worktree.path, ["commit", "-m", "Task change"]);
  await writeFile(path.join(fixture.repo, "mainline.txt"), "mainline\n");
  await git(fixture.repo, ["add", "mainline.txt"]);
  await git(fixture.repo, ["commit", "-m", "Main change"]);

  const hookMarker = path.join(fixture.root, "hook-ran.txt");
  const hookScript = `#!/bin/sh\necho "$DEVBOT_SYNC_SECRET_TOKEN" > ${hookMarker}\n`;
  const builtInHooks = path.join(fixture.repo, ".git", "hooks");
  await mkdir(builtInHooks, { recursive: true });
  const configuredHooks = path.join(fixture.root, "configured-hooks");
  await mkdir(configuredHooks, { recursive: true });
  for (const hook of ["pre-rebase", "post-checkout", "post-rewrite", "post-commit"]) {
    await writeFile(path.join(builtInHooks, hook), hookScript);
    await chmod(path.join(builtInHooks, hook), 0o755);
    await writeFile(path.join(configuredHooks, hook), hookScript);
    await chmod(path.join(configuredHooks, hook), 0o755);
  }
  await git(fixture.repo, ["config", "core.hooksPath", configuredHooks]);

  process.env.DEVBOT_SYNC_SECRET_TOKEN = "sync-secret-value";
  try {
    const result = await syncTaskBranch({ worktree, defaultBranch: "main", taskId: "task-sync-hardened" });
    assert.equal(result.outcome, "synced");
  } finally {
    delete process.env.DEVBOT_SYNC_SECRET_TOKEN;
  }

  await assert.rejects(stat(hookMarker), /ENOENT/);
  const environment = hardenedGitEnvironment({ PATH: "/usr/bin", HOME: "/tmp/home", DEVBOT_SYNC_SECRET_TOKEN: "sync-secret-value" });
  assert.equal("DEVBOT_SYNC_SECRET_TOKEN" in environment, false);
});

interface GitFixture {
  root: string;
  repo: string;
  worktreeRoot: string;
}

async function createGitFixture(): Promise<GitFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-branch-freshness-"));
  const repo = path.join(root, "source");
  await git(root, ["init", "source"]);
  await git(repo, ["config", "user.name", "Devbot Test"]);
  await git(repo, ["config", "user.email", "devbot-test@example.invalid"]);
  await writeFile(path.join(repo, "tracked.txt"), "original\n");
  await git(repo, ["add", "tracked.txt"]);
  await git(repo, ["commit", "-m", "Initial commit"]);
  await git(repo, ["branch", "-M", "main"]);
  return { root, repo, worktreeRoot: path.join(root, "worktrees") };
}

async function createTaskBranch(fixture: GitFixture, name: string): Promise<TaskWorktree> {
  const created = await createTaskWorktree({
    sourcePath: fixture.repo,
    taskName: name,
    worktreeRoot: fixture.worktreeRoot
  });
  if (!created.available) throw new Error(created.message);
  return created.worktree;
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve(stdout.trim());
    });
  });
}
