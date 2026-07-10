import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  RollbackRefusedError,
  createCheckpoint,
  diffSinceCheckpoint,
  hashWorkingTree,
  pruneCheckpoints,
  restoreCheckpoint
} from "./checkpoint.js";
import { createTaskWorktree, inspectTaskWorktree } from "./task-worktree.js";
import { TaskStore, type TaskRecord } from "./task-store.js";
import { taskHasRestorableCheckpoint } from "./task-controls.js";
import { captureWorkerIdentity, recoverInterruptedTasks, type TaskRecoveryDeps } from "./task-recovery.js";
import { hardenedGitEnvironment } from "./security.js";

const execFileAsync = promisify(execFile);

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@localhost",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@localhost"
};

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repo, ...args], { env: GIT_ENV });
  return stdout.trim();
}

async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "devbot-cp-test-"));
  await git(repo, ["init", "-q", "-b", "main"]);
  return repo;
}

async function write(repo: string, relativePath: string, content: string): Promise<void> {
  const absolute = path.join(repo, relativePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

async function workingTree(repo: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "devbot-cp-verify-"));
  const indexFile = path.join(dir, "index");
  try {
    await execFileAsync("git", ["-C", repo, "add", "-A"], { env: { ...GIT_ENV, GIT_INDEX_FILE: indexFile } });
    const { stdout } = await execFileAsync("git", ["-C", repo, "write-tree"], {
      env: { ...GIT_ENV, GIT_INDEX_FILE: indexFile }
    });
    return stdout.trim();
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

test("checkpoint restores a dirty tree exactly (tracked edit, untracked add, deletion)", async () => {
  const repo = await makeRepo();
  try {
    await write(repo, "keep.txt", "original keep\n");
    await write(repo, "gone.txt", "delete me\n");
    await write(repo, "nested/config.json", "{\"a\":1}\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "seed"]);

    const checkpoint = await createCheckpoint(repo, "task-cp-1");

    await write(repo, "keep.txt", "AGENT REWROTE THIS\n");
    await rm(path.join(repo, "gone.txt"));
    await write(repo, "created.txt", "agent created this\n");
    await write(repo, "nested/new.txt", "another agent file\n");

    const diff = await diffSinceCheckpoint(repo, checkpoint.ref);
    const byPath = new Map(diff.map((change) => [change.path, change.status]));
    assert.equal(byPath.get("keep.txt"), "modified");
    assert.equal(byPath.get("gone.txt"), "deleted");
    assert.equal(byPath.get("created.txt"), "added");
    assert.equal(byPath.get("nested/new.txt"), "added");

    const summary = await restoreCheckpoint(repo, checkpoint.ref, {
      expectedHeadSha: checkpoint.headSha,
      expectedBranch: checkpoint.branch
    });

    assert.equal(await workingTree(repo), checkpoint.tree);
    assert.equal(await readFile(path.join(repo, "keep.txt"), "utf8"), "original keep\n");
    assert.equal(await readFile(path.join(repo, "gone.txt"), "utf8"), "delete me\n");
    assert.equal(existsSync(path.join(repo, "created.txt")), false);
    assert.equal(existsSync(path.join(repo, "nested/new.txt")), false);
    assert.deepEqual(summary.restored.sort(), ["gone.txt", "keep.txt"]);
    assert.deepEqual(summary.deleted.sort(), ["created.txt", "nested/new.txt"]);
  } finally {
    await rm(repo, { force: true, recursive: true });
  }
});

test("checkpoint captures an untracked-only working tree and restore removes it", async () => {
  const repo = await makeRepo();
  try {
    await write(repo, "seed.txt", "seed\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "seed"]);

    const checkpoint = await createCheckpoint(repo, "task-cp-untracked");
    await write(repo, "scratch.txt", "temp\n");

    await restoreCheckpoint(repo, checkpoint.ref, {
      expectedHeadSha: checkpoint.headSha,
      expectedBranch: checkpoint.branch
    });

    assert.equal(existsSync(path.join(repo, "scratch.txt")), false);
    assert.equal(await workingTree(repo), checkpoint.tree);
  } finally {
    await rm(repo, { force: true, recursive: true });
  }
});

test("restore never deletes a file that existed before the checkpoint", async () => {
  const repo = await makeRepo();
  try {
    await write(repo, "preexisting.txt", "before\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "seed"]);

    const checkpoint = await createCheckpoint(repo, "task-cp-preexist");
    await write(repo, "preexisting.txt", "modified after checkpoint\n");
    await write(repo, "brand-new.txt", "new\n");

    await restoreCheckpoint(repo, checkpoint.ref, {
      expectedHeadSha: checkpoint.headSha,
      expectedBranch: checkpoint.branch
    });

    assert.equal(existsSync(path.join(repo, "preexisting.txt")), true);
    assert.equal(await readFile(path.join(repo, "preexisting.txt"), "utf8"), "before\n");
    assert.equal(existsSync(path.join(repo, "brand-new.txt")), false);
  } finally {
    await rm(repo, { force: true, recursive: true });
  }
});

test("restore refuses when HEAD moved since the checkpoint", async () => {
  const repo = await makeRepo();
  try {
    await write(repo, "a.txt", "one\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "seed"]);

    const checkpoint = await createCheckpoint(repo, "task-cp-head");
    await write(repo, "a.txt", "two\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "human commit"]);

    await assert.rejects(
      restoreCheckpoint(repo, checkpoint.ref, {
        expectedHeadSha: checkpoint.headSha,
        expectedBranch: checkpoint.branch
      }),
      (error: unknown) => error instanceof RollbackRefusedError && error.reason === "head-moved"
    );
  } finally {
    await rm(repo, { force: true, recursive: true });
  }
});

test("restore refuses when the branch changed since the checkpoint", async () => {
  const repo = await makeRepo();
  try {
    await write(repo, "a.txt", "one\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "seed"]);

    const checkpoint = await createCheckpoint(repo, "task-cp-branch");
    await git(repo, ["checkout", "-q", "-b", "feature"]);

    await assert.rejects(
      restoreCheckpoint(repo, checkpoint.ref, {
        expectedHeadSha: checkpoint.headSha,
        expectedBranch: checkpoint.branch
      }),
      (error: unknown) => error instanceof RollbackRefusedError && error.reason === "branch-moved"
    );
  } finally {
    await rm(repo, { force: true, recursive: true });
  }
});

test("restore refuses when a file the task changed was later deleted by a human", async () => {
  // Reproduces the exact gap an mtime heuristic misses: the guard used to skip
  // deleted paths entirely, so a post-task deletion would silently restore
  // the pre-task file instead of refusing. An exact tree-hash comparison
  // catches it because the deletion changes the tree.
  const repo = await makeRepo();
  try {
    await write(repo, "a.txt", "one\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "seed"]);

    const checkpoint = await createCheckpoint(repo, "task-cp-later-delete");
    await write(repo, "a.txt", "agent change\n");
    const postTaskTree = await hashWorkingTree(repo);

    await rm(path.join(repo, "a.txt"));

    await assert.rejects(
      restoreCheckpoint(repo, checkpoint.ref, {
        expectedHeadSha: checkpoint.headSha,
        expectedBranch: checkpoint.branch,
        expectedPostTaskTree: postTaskTree
      }),
      (error: unknown) =>
        error instanceof RollbackRefusedError &&
        error.reason === "workspace-changed" &&
        error.details.includes("a.txt")
    );
    assert.equal(existsSync(path.join(repo, "a.txt")), false, "a refused Undo must not touch the file");
  } finally {
    await rm(repo, { force: true, recursive: true });
  }
});

test("restore refuses on an edit that lands within the same second as the recorded post-task state", async () => {
  // An mtime-with-tolerance guard can miss an edit that happens within its
  // tolerance window. Comparing exact tree content has no such window.
  const repo = await makeRepo();
  try {
    await write(repo, "a.txt", "one\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "seed"]);

    const checkpoint = await createCheckpoint(repo, "task-cp-rapid-edit");
    await write(repo, "a.txt", "agent change\n");
    const postTaskTree = await hashWorkingTree(repo);

    await write(repo, "a.txt", "human edit moments later\n");

    await assert.rejects(
      restoreCheckpoint(repo, checkpoint.ref, {
        expectedHeadSha: checkpoint.headSha,
        expectedBranch: checkpoint.branch,
        expectedPostTaskTree: postTaskTree
      }),
      (error: unknown) =>
        error instanceof RollbackRefusedError &&
        error.reason === "workspace-changed" &&
        error.details.includes("a.txt")
    );
    assert.equal(await readFile(path.join(repo, "a.txt"), "utf8"), "human edit moments later\n");
  } finally {
    await rm(repo, { force: true, recursive: true });
  }
});

test("restore proceeds when the workspace exactly matches the recorded post-task tree", async () => {
  const repo = await makeRepo();
  try {
    await write(repo, "a.txt", "one\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "seed"]);

    const checkpoint = await createCheckpoint(repo, "task-cp-unchanged");
    await write(repo, "a.txt", "agent change\n");
    const postTaskTree = await hashWorkingTree(repo);

    const summary = await restoreCheckpoint(repo, checkpoint.ref, {
      expectedHeadSha: checkpoint.headSha,
      expectedBranch: checkpoint.branch,
      expectedPostTaskTree: postTaskTree
    });

    assert.equal(await readFile(path.join(repo, "a.txt"), "utf8"), "one\n");
    assert.deepEqual(summary.restored, ["a.txt"]);
  } finally {
    await rm(repo, { force: true, recursive: true });
  }
});

test("checkpoints work on an unborn branch with no commits", async () => {
  const repo = await makeRepo();
  try {
    await write(repo, "first.txt", "hello\n");
    const checkpoint = await createCheckpoint(repo, "task-cp-unborn");
    assert.equal(checkpoint.headSha, "");

    await write(repo, "first.txt", "changed\n");
    await write(repo, "second.txt", "new\n");

    await restoreCheckpoint(repo, checkpoint.ref, { expectedBranch: checkpoint.branch });
    assert.equal(await readFile(path.join(repo, "first.txt"), "utf8"), "hello\n");
    assert.equal(existsSync(path.join(repo, "second.txt")), false);
    assert.equal(await workingTree(repo), checkpoint.tree);
  } finally {
    await rm(repo, { force: true, recursive: true });
  }
});

test("pruneCheckpoints keeps the most recent refs", async () => {
  const repo = await makeRepo();
  try {
    await write(repo, "a.txt", "one\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "seed"]);

    for (let index = 0; index < 5; index += 1) {
      await createCheckpoint(repo, `task-cp-prune-${index}`);
    }

    const before = (await git(repo, ["for-each-ref", "refs/devbot/checkpoints"])).split("\n").filter(Boolean);
    assert.equal(before.length, 5);

    const pruned = await pruneCheckpoints(repo, 2);
    const after = (await git(repo, ["for-each-ref", "refs/devbot/checkpoints"])).split("\n").filter(Boolean);
    assert.equal(pruned.length, 3);
    assert.equal(after.length, 2);
  } finally {
    await rm(repo, { force: true, recursive: true });
  }
});

test("checkpoint git calls never inherit secret env vars or execute ambient global hooks", async () => {
  // Unit-level guarantee: the hardened environment builder strips secret-shaped vars outright.
  const dirtyEnv = { ...process.env, DEVBOT_TEST_API_KEY: "super-secret-value-should-not-leak" };
  assert.equal(hardenedGitEnvironment(dirtyEnv).DEVBOT_TEST_API_KEY, undefined);

  // Integration-level guarantee: an ambient hook configured on the *host* (a global
  // ~/.gitconfig outside the project repo, simulating a machine-level helper Devbot
  // does not control) must never fire. `update-ref` — used by both createCheckpoint
  // and pruneCheckpoints — invokes Git's `reference-transaction` hook by default;
  // confirmed empirically that an unhardened `update-ref` runs it and that
  // `GIT_CONFIG_GLOBAL`+`core.hooksPath` overrides suppress it.
  const repo = await makeRepo();
  const fakeHome = await mkdtemp(path.join(tmpdir(), "devbot-cp-home-"));
  const hooksDir = path.join(fakeHome, "ambient-hooks");
  const marker = path.join(fakeHome, "hook-ran.marker");
  await mkdir(hooksDir, { recursive: true });
  const hookScript = path.join(hooksDir, "reference-transaction");
  await writeFile(hookScript, `#!/bin/sh\nenv > "${marker}"\nexit 0\n`);
  await chmod(hookScript, 0o755);
  await writeFile(path.join(fakeHome, ".gitconfig"), `[core]\n\thooksPath = ${hooksDir}\n`);

  const previousHome = process.env.HOME;
  const previousSecret = process.env.DEVBOT_TEST_API_KEY;
  process.env.HOME = fakeHome;
  process.env.DEVBOT_TEST_API_KEY = "super-secret-value-should-not-leak";
  try {
    await write(repo, "a.txt", "one\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "seed"]);

    await createCheckpoint(repo, "task-cp-hook-guard");
    await pruneCheckpoints(repo, 0);

    assert.equal(existsSync(marker), false, "the ambient global hook must never execute");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousSecret === undefined) delete process.env.DEVBOT_TEST_API_KEY;
    else process.env.DEVBOT_TEST_API_KEY = previousSecret;
    await rm(fakeHome, { force: true, recursive: true });
    await rm(repo, { force: true, recursive: true });
  }
});

test("checkpoint metadata round-trips through a TaskStore restart and stays undo-eligible", async () => {
  const repo = await makeRepo();
  const root = await mkdtemp(path.join(tmpdir(), "devbot-cp-taskstore-"));
  try {
    await write(repo, "a.txt", "one\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "seed"]);

    const stateFile = path.join(root, "tasks.json");
    const store = new TaskStore(stateFile);
    const task = await store.start({
      source: "test",
      mode: "action",
      projectName: "demo",
      requester: "tester",
      text: "make a change"
    });

    const checkpoint = await createCheckpoint(repo, task.id);
    await store.attachCheckpoint(task.id, {
      ref: checkpoint.ref,
      headSha: checkpoint.headSha,
      branch: checkpoint.branch,
      createdAt: checkpoint.createdAt
    });
    await write(repo, "a.txt", "agent change\n");
    const postTaskTree = await hashWorkingTree(repo);
    await store.recordPostTaskTree(task.id, postTaskTree);
    await store.succeed(task.id, { resultPreview: "done" });

    // Simulate a bot restart: a brand-new TaskStore instance backed by the same file.
    const reloaded = new TaskStore(stateFile);
    const reloadedTask = await reloaded.get(task.id);

    assert.ok(reloadedTask);
    assert.equal(reloadedTask?.checkpointRef, checkpoint.ref);
    assert.equal(reloadedTask?.checkpointHeadSha, checkpoint.headSha);
    assert.equal(reloadedTask?.checkpointBranch, checkpoint.branch);
    assert.equal(reloadedTask?.checkpointCreatedAt, checkpoint.createdAt);
    assert.equal(reloadedTask?.checkpointPostTaskTree, postTaskTree);
    assert.equal(reloadedTask?.reverted, false);
    assert.equal(taskHasRestorableCheckpoint(reloadedTask!), true);

    const summary = await restoreCheckpoint(repo, reloadedTask!.checkpointRef!, {
      expectedHeadSha: reloadedTask!.checkpointHeadSha ?? "",
      expectedBranch: reloadedTask!.checkpointBranch ?? "HEAD",
      expectedPostTaskTree: reloadedTask!.checkpointPostTaskTree!
    });
    assert.deepEqual(summary.restored, ["a.txt"]);
    assert.equal(await readFile(path.join(repo, "a.txt"), "utf8"), "one\n");

    await reloaded.markReverted(task.id);
    assert.equal(taskHasRestorableCheckpoint((await reloaded.get(task.id))!), false);
  } finally {
    await rm(repo, { force: true, recursive: true });
    await rm(root, { force: true, recursive: true });
  }
});

test("end-to-end: checkpoint, mutate, and Undo an isolated task worktree without touching the source checkout", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-cp-worktree-"));
  const sourceRepo = path.join(root, "source");
  try {
    await git(root, ["init", "-q", "-b", "main", "source"]);
    await git(sourceRepo, ["config", "user.name", "Devbot Test"]);
    await git(sourceRepo, ["config", "user.email", "devbot-test@example.invalid"]);
    await write(sourceRepo, "tracked.txt", "original\n");
    await git(sourceRepo, ["add", "-A"]);
    await git(sourceRepo, ["commit", "-qm", "seed"]);
    const sourceHeadBefore = await git(sourceRepo, ["rev-parse", "HEAD"]);

    const created = await createTaskWorktree({
      sourcePath: sourceRepo,
      taskName: "task-e2e-undo",
      worktreeRoot: path.join(root, "worktrees")
    });
    assert.equal(created.available, true);
    if (!created.available) return;
    const worktree = created.worktree;

    const stateFile = path.join(root, "tasks.json");
    const store = new TaskStore(stateFile);
    const task = await store.start({
      source: "test",
      mode: "action",
      projectName: "demo",
      requester: "tester",
      text: "isolated write"
    });
    await store.setWorkspace(task.id, {
      workspacePath: worktree.path,
      branchName: worktree.branch,
      baseBranch: worktree.baseRevision,
      isolated: true
    });

    // Checkpoint targets the isolated worktree, not the source checkout.
    const checkpoint = await createCheckpoint(worktree.path, task.id);
    await store.attachCheckpoint(task.id, {
      ref: checkpoint.ref,
      headSha: checkpoint.headSha,
      branch: checkpoint.branch,
      createdAt: checkpoint.createdAt
    });

    // The task mutates a file only inside its isolated worktree.
    await write(worktree.path, "tracked.txt", "agent rewrote this\n");
    await write(worktree.path, "new-file.txt", "created by the task\n");
    const postTaskTree = await hashWorkingTree(worktree.path);
    await store.recordPostTaskTree(task.id, postTaskTree);
    await store.succeed(task.id, { resultPreview: "done" });

    // Resolve the task's actual workspace root through its stored metadata,
    // the same way the bot does before acting on Undo.
    const savedTask = await store.get(task.id);
    assert.ok(savedTask?.workspaceIsolated);
    assert.equal(savedTask?.workspacePath, worktree.path);
    const inspection = await inspectTaskWorktree({
      sourcePath: sourceRepo,
      path: savedTask!.workspacePath!,
      branch: savedTask!.branchName!,
      baseRevision: savedTask!.baseBranch!
    });
    assert.equal(inspection.available, true);
    const workspaceRoot = savedTask!.workspacePath!;

    assert.equal(taskHasRestorableCheckpoint(savedTask!), true);
    const summary = await restoreCheckpoint(workspaceRoot, savedTask!.checkpointRef!, {
      expectedHeadSha: savedTask!.checkpointHeadSha ?? "",
      expectedBranch: savedTask!.checkpointBranch ?? "HEAD",
      expectedPostTaskTree: savedTask!.checkpointPostTaskTree!
    });
    await store.markReverted(task.id);

    assert.deepEqual(summary.restored.sort(), ["tracked.txt"]);
    assert.deepEqual(summary.deleted.sort(), ["new-file.txt"]);
    assert.equal(await readFile(path.join(workspaceRoot, "tracked.txt"), "utf8"), "original\n");
    assert.equal(existsSync(path.join(workspaceRoot, "new-file.txt")), false);

    // The source checkout must never have been touched by any of this.
    assert.equal(await git(sourceRepo, ["rev-parse", "HEAD"]), sourceHeadBefore);
    assert.equal(await git(sourceRepo, ["status", "--porcelain"]), "");
    assert.equal(await readFile(path.join(sourceRepo, "tracked.txt"), "utf8"), "original\n");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("end-to-end: a canceled mid-write task stays undo-eligible and restores its isolated worktree without touching the source checkout", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-cp-cancel-"));
  const sourceRepo = path.join(root, "source");
  try {
    await git(root, ["init", "-q", "-b", "main", "source"]);
    await git(sourceRepo, ["config", "user.name", "Devbot Test"]);
    await git(sourceRepo, ["config", "user.email", "devbot-test@example.invalid"]);
    await write(sourceRepo, "tracked.txt", "original\n");
    await git(sourceRepo, ["add", "-A"]);
    await git(sourceRepo, ["commit", "-qm", "seed"]);
    const sourceHeadBefore = await git(sourceRepo, ["rev-parse", "HEAD"]);

    const created = await createTaskWorktree({
      sourcePath: sourceRepo,
      taskName: "task-cancel-undo",
      worktreeRoot: path.join(root, "worktrees")
    });
    assert.equal(created.available, true);
    if (!created.available) return;
    const worktree = created.worktree;

    const stateFile = path.join(root, "tasks.json");
    const store = new TaskStore(stateFile);
    const task = await store.start({
      source: "test",
      mode: "action",
      projectName: "demo",
      requester: "tester",
      text: "isolated write that gets canceled"
    });
    await store.setWorkspace(task.id, {
      workspacePath: worktree.path,
      branchName: worktree.branch,
      baseBranch: worktree.baseRevision,
      isolated: true
    });

    // The checkpoint is taken before the write-capable run starts.
    const checkpoint = await createCheckpoint(worktree.path, task.id);
    await store.attachCheckpoint(task.id, {
      ref: checkpoint.ref,
      headSha: checkpoint.headSha,
      branch: checkpoint.branch,
      createdAt: checkpoint.createdAt
    });

    // The worker leaves partial writes in the isolated worktree, then the run is
    // canceled. This mirrors the cancel path: the task is marked canceled and its
    // exact post-cancel tree is recorded once the worker has stopped.
    await write(worktree.path, "tracked.txt", "half-written by canceled agent\n");
    await write(worktree.path, "scratch.txt", "partial artifact\n");
    await store.cancel(task.id, "Canceled by user request.");
    const postCancelTree = await hashWorkingTree(worktree.path);
    await store.recordPostTaskTree(task.id, postCancelTree);

    // A canceled action task with a recorded post-task tree must be undo-eligible,
    // including after a bot restart (fresh TaskStore over the same state file).
    const reloaded = new TaskStore(stateFile);
    const savedTask = await reloaded.get(task.id);
    assert.ok(savedTask);
    assert.equal(savedTask?.status, "canceled");
    assert.equal(savedTask?.checkpointPostTaskTree, postCancelTree);
    assert.equal(taskHasRestorableCheckpoint(savedTask!), true);
    assert.equal(savedTask?.workspaceIsolated, true);
    assert.equal(savedTask?.workspacePath, worktree.path);

    const workspaceRoot = savedTask!.workspacePath!;
    const summary = await restoreCheckpoint(workspaceRoot, savedTask!.checkpointRef!, {
      expectedHeadSha: savedTask!.checkpointHeadSha ?? "",
      expectedBranch: savedTask!.checkpointBranch ?? "HEAD",
      expectedPostTaskTree: savedTask!.checkpointPostTaskTree!
    });
    await reloaded.markReverted(task.id);

    assert.deepEqual(summary.restored.sort(), ["tracked.txt"]);
    assert.deepEqual(summary.deleted.sort(), ["scratch.txt"]);
    assert.equal(await readFile(path.join(workspaceRoot, "tracked.txt"), "utf8"), "original\n");
    assert.equal(existsSync(path.join(workspaceRoot, "scratch.txt")), false);
    assert.equal(taskHasRestorableCheckpoint((await reloaded.get(task.id))!), false);

    // Undo restores only the isolated worktree; the source checkout is untouched.
    assert.equal(await git(sourceRepo, ["rev-parse", "HEAD"]), sourceHeadBefore);
    assert.equal(await git(sourceRepo, ["status", "--porcelain"]), "");
    assert.equal(await readFile(path.join(sourceRepo, "tracked.txt"), "utf8"), "original\n");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

// Resolver that mirrors index.ts's projectForTaskWorkspace: it trusts a task's
// isolated worktree only when the worktree still validates, and returns undefined
// otherwise so finalization fails closed.
function recoveryResolver(sourceRepo: string): TaskRecoveryDeps["resolveWorkspaceRoot"] {
  return async (task: TaskRecord): Promise<string | undefined> => {
    if (!task.workspaceIsolated || !task.workspacePath || !task.branchName || !task.baseBranch) {
      return undefined;
    }
    const inspection = await inspectTaskWorktree({
      sourcePath: sourceRepo,
      path: task.workspacePath,
      branch: task.branchName,
      baseRevision: task.baseBranch
    });
    return inspection.available ? task.workspacePath : undefined;
  };
}

test("end-to-end: restart recovery finalizes a task interrupted mid-write through the production path, leaving Undo usable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-cp-recover-"));
  const sourceRepo = path.join(root, "source");
  try {
    await git(root, ["init", "-q", "-b", "main", "source"]);
    await git(sourceRepo, ["config", "user.name", "Devbot Test"]);
    await git(sourceRepo, ["config", "user.email", "devbot-test@example.invalid"]);
    await write(sourceRepo, "tracked.txt", "original\n");
    await git(sourceRepo, ["add", "-A"]);
    await git(sourceRepo, ["commit", "-qm", "seed"]);
    const sourceHeadBefore = await git(sourceRepo, ["rev-parse", "HEAD"]);

    const created = await createTaskWorktree({
      sourcePath: sourceRepo,
      taskName: "task-recover-undo",
      worktreeRoot: path.join(root, "worktrees")
    });
    assert.equal(created.available, true);
    if (!created.available) return;
    const worktree = created.worktree;

    // Runtime A: a write-capable task starts, checkpoints, and begins writing, then
    // the process dies mid-write. No post-task tree is ever recorded and the task
    // stays "running" in the persisted state file — exactly a crash mid-write.
    const stateFile = path.join(root, "tasks.json");
    const runtimeA = new TaskStore(stateFile);
    const task = await runtimeA.start({
      source: "test",
      mode: "action",
      projectName: "demo",
      requester: "tester",
      text: "isolated write interrupted by a crash"
    });
    await runtimeA.setWorkspace(task.id, {
      workspacePath: worktree.path,
      branchName: worktree.branch,
      baseBranch: worktree.baseRevision,
      isolated: true
    });
    const checkpoint = await createCheckpoint(worktree.path, task.id);
    await runtimeA.attachCheckpoint(task.id, {
      ref: checkpoint.ref,
      headSha: checkpoint.headSha,
      branch: checkpoint.branch,
      createdAt: checkpoint.createdAt
    });
    await write(worktree.path, "tracked.txt", "half-written before the crash\n");
    await write(worktree.path, "scratch.txt", "partial artifact\n");

    const crashed = await runtimeA.get(task.id);
    assert.equal(crashed?.status, "running");
    assert.equal(crashed?.checkpointPostTaskTree, undefined);
    // The dangerous middle state must never be reachable: a checkpointed task with
    // no post-task tree is not undo-eligible, so no Undo control is offered.
    assert.equal(taskHasRestorableCheckpoint(crashed!), false);

    // Runtime B: a fresh TaskStore over the same state file runs the real recovery
    // path, which cancels the interrupted task and finalizes it (hash + record).
    const runtimeB = new TaskStore(stateFile);
    const recovered = await recoverInterruptedTasks({
      store: runtimeB,
      hashWorkingTree,
      resolveWorkspaceRoot: recoveryResolver(sourceRepo),
      // The previous runtime's worker is proven gone, so recovery is free to hash
      // the now-quiescent worktree and record the post-cancel tree.
      probeWorkerTermination: async () => "terminated"
    });
    assert.equal(recovered, 1);

    const savedTask = await runtimeB.get(task.id);
    assert.equal(savedTask?.status, "canceled");

    // The code guarantees Undo is exposed only when it will actually run. Assert
    // exactly that contract: either it is eligible and restores end-to-end, or it
    // is absent — never eligible-but-refusing.
    if (taskHasRestorableCheckpoint(savedTask!)) {
      assert.ok(savedTask?.checkpointPostTaskTree);
      const summary = await restoreCheckpoint(savedTask!.workspacePath!, savedTask!.checkpointRef!, {
        expectedHeadSha: savedTask!.checkpointHeadSha ?? "",
        expectedBranch: savedTask!.checkpointBranch ?? "HEAD",
        expectedPostTaskTree: savedTask!.checkpointPostTaskTree!
      });
      await runtimeB.markReverted(task.id);
      assert.deepEqual(summary.restored.sort(), ["tracked.txt"]);
      assert.deepEqual(summary.deleted.sort(), ["scratch.txt"]);
      assert.equal(await readFile(path.join(savedTask!.workspacePath!, "tracked.txt"), "utf8"), "original\n");
      assert.equal(existsSync(path.join(savedTask!.workspacePath!, "scratch.txt")), false);
      assert.equal(taskHasRestorableCheckpoint((await runtimeB.get(task.id))!), false);
    } else {
      assert.equal(savedTask?.checkpointPostTaskTree, undefined);
    }

    // Recovery must never touch the source checkout.
    assert.equal(await git(sourceRepo, ["rev-parse", "HEAD"]), sourceHeadBefore);
    assert.equal(await git(sourceRepo, ["status", "--porcelain"]), "");
    assert.equal(await readFile(path.join(sourceRepo, "tracked.txt"), "utf8"), "original\n");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("end-to-end: restart recovery hides Undo when an interrupted task's workspace can no longer be trusted", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-cp-recover-closed-"));
  const sourceRepo = path.join(root, "source");
  try {
    await git(root, ["init", "-q", "-b", "main", "source"]);
    await git(sourceRepo, ["config", "user.name", "Devbot Test"]);
    await git(sourceRepo, ["config", "user.email", "devbot-test@example.invalid"]);
    await write(sourceRepo, "tracked.txt", "original\n");
    await git(sourceRepo, ["add", "-A"]);
    await git(sourceRepo, ["commit", "-qm", "seed"]);

    const created = await createTaskWorktree({
      sourcePath: sourceRepo,
      taskName: "task-recover-closed",
      worktreeRoot: path.join(root, "worktrees")
    });
    assert.equal(created.available, true);
    if (!created.available) return;
    const worktree = created.worktree;

    const stateFile = path.join(root, "tasks.json");
    const runtimeA = new TaskStore(stateFile);
    const task = await runtimeA.start({
      source: "test",
      mode: "action",
      projectName: "demo",
      requester: "tester",
      text: "isolated write whose worktree is lost before recovery"
    });
    await runtimeA.setWorkspace(task.id, {
      workspacePath: worktree.path,
      branchName: worktree.branch,
      baseBranch: worktree.baseRevision,
      isolated: true
    });
    const checkpoint = await createCheckpoint(worktree.path, task.id);
    await runtimeA.attachCheckpoint(task.id, {
      ref: checkpoint.ref,
      headSha: checkpoint.headSha,
      branch: checkpoint.branch,
      createdAt: checkpoint.createdAt
    });
    await write(worktree.path, "tracked.txt", "half-written before the crash\n");

    // The isolated worktree is gone by the time the runtime comes back (cleaned up,
    // pruned, or on a volume that did not survive the restart).
    await rm(worktree.path, { force: true, recursive: true });

    const runtimeB = new TaskStore(stateFile);
    const recovered = await recoverInterruptedTasks({
      store: runtimeB,
      hashWorkingTree,
      resolveWorkspaceRoot: recoveryResolver(sourceRepo),
      // The worker is gone; here it is the lost workspace, not a live worker, that
      // must keep Undo hidden.
      probeWorkerTermination: async () => "terminated"
    });
    assert.equal(recovered, 1);

    const savedTask = await runtimeB.get(task.id);
    assert.equal(savedTask?.status, "canceled");
    // Finalization could not capture a post-task tree, so Undo must stay absent
    // rather than appearing and then refusing.
    assert.equal(savedTask?.checkpointPostTaskTree, undefined);
    assert.equal(taskHasRestorableCheckpoint(savedTask!), false);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("runtime-crash recovery keeps Undo unavailable when the previous runtime's detached worker survives and writes later", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-cp-survivor-"));
  const sourceRepo = path.join(root, "source");
  let workerPid: number | undefined;
  try {
    await git(root, ["init", "-q", "-b", "main", "source"]);
    await git(sourceRepo, ["config", "user.name", "Devbot Test"]);
    await git(sourceRepo, ["config", "user.email", "devbot-test@example.invalid"]);
    await write(sourceRepo, "tracked.txt", "original\n");
    await git(sourceRepo, ["add", "-A"]);
    await git(sourceRepo, ["commit", "-qm", "seed"]);

    const created = await createTaskWorktree({
      sourcePath: sourceRepo,
      taskName: "task-survivor",
      worktreeRoot: path.join(root, "worktrees")
    });
    assert.equal(created.available, true);
    if (!created.available) return;
    const worktree = created.worktree;

    // Runtime A: a write-capable task starts, checkpoints, and spawns a DETACHED
    // worker that keeps running past the crash. The worker delays a write into the
    // isolated worktree so the tree is still being mutated after the runtime is back.
    const stateFile = path.join(root, "tasks.json");
    const runtimeA = new TaskStore(stateFile);
    const task = await runtimeA.start({
      source: "test",
      mode: "action",
      projectName: "demo",
      requester: "tester",
      text: "detached worker survives a crash and writes late"
    });
    await runtimeA.setWorkspace(task.id, {
      workspacePath: worktree.path,
      branchName: worktree.branch,
      baseBranch: worktree.baseRevision,
      isolated: true
    });
    const checkpoint = await createCheckpoint(worktree.path, task.id);
    await runtimeA.attachCheckpoint(task.id, {
      ref: checkpoint.ref,
      headSha: checkpoint.headSha,
      branch: checkpoint.branch,
      createdAt: checkpoint.createdAt
    });

    const delayedFile = path.join(worktree.path, "delayed-write.txt");
    const workerScript = `const fs = require("fs"); setTimeout(() => { try { fs.writeFileSync(process.argv[1], "written after recovery\\n"); } catch {} }, 1500);`;
    const workerChild = spawn(process.execPath, ["-e", workerScript, delayedFile], {
      cwd: worktree.path,
      detached: true,
      stdio: "ignore"
    });
    workerChild.unref();
    workerPid = workerChild.pid;
    assert.ok(workerPid, "worker must have a pid");

    // Persist the worker's strong identity exactly as the production spawn path does.
    const identity = await captureWorkerIdentity(workerPid);
    assert.ok(identity, "worker identity must be captured on this platform");
    await runtimeA.recordWorker(task.id, identity!);

    // The crash: the task is still "running", no post-task tree, and the worker is alive.
    const crashed = await runtimeA.get(task.id);
    assert.equal(crashed?.status, "running");
    assert.equal(crashed?.checkpointPostTaskTree, undefined);
    assert.equal(existsSync(delayedFile), false);

    // Runtime B recovers with the REAL process-group probe, its grace window kept
    // short so it resolves well before the worker's delayed write fires.
    const runtimeB = new TaskStore(stateFile);
    const recovered = await recoverInterruptedTasks({
      store: runtimeB,
      hashWorkingTree,
      resolveWorkspaceRoot: recoveryResolver(sourceRepo),
      workerTerminationGraceMs: 300
    });
    assert.equal(recovered, 1);

    // The worker was still alive during recovery, so termination could not be
    // proven: no post-task tree was recorded and Undo is not offered. Crucially,
    // the worktree was never hashed while it could still change.
    const savedTask = await runtimeB.get(task.id);
    assert.equal(savedTask?.status, "canceled");
    assert.equal(savedTask?.checkpointPostTaskTree, undefined);
    assert.equal(taskHasRestorableCheckpoint(savedTask!), false);
    // Recovery finished before the delayed write landed — proof the worker outlived it.
    assert.equal(existsSync(delayedFile), false);

    // The surviving worker now performs its delayed write. Because no tree was ever
    // recorded, Undo stays unavailable rather than pointing at a mid-write snapshot.
    await new Promise((resolve) => setTimeout(resolve, 1600));
    assert.equal(existsSync(delayedFile), true);
    assert.equal(await readFile(delayedFile, "utf8"), "written after recovery\n");
    const afterWrite = await runtimeB.get(task.id);
    assert.equal(afterWrite?.checkpointPostTaskTree, undefined);
    assert.equal(taskHasRestorableCheckpoint(afterWrite!), false);
  } finally {
    if (workerPid) {
      try {
        process.kill(-workerPid, "SIGKILL");
      } catch {
        // Already exited.
      }
    }
    await rm(root, { force: true, recursive: true });
  }
});
