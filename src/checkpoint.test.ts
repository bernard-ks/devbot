import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  RollbackRefusedError,
  createCheckpoint,
  diffSinceCheckpoint,
  pruneCheckpoints,
  restoreCheckpoint
} from "./checkpoint.js";

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

test("restore refuses when a covered file changed after the task finished", async () => {
  const repo = await makeRepo();
  try {
    await write(repo, "a.txt", "one\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "seed"]);

    const checkpoint = await createCheckpoint(repo, "task-cp-newer");
    await write(repo, "a.txt", "agent change\n");
    const taskFinishedMs = Date.now();

    const future = new Date(taskFinishedMs + 60_000);
    await utimes(path.join(repo, "a.txt"), future, future);

    await assert.rejects(
      restoreCheckpoint(repo, checkpoint.ref, {
        expectedHeadSha: checkpoint.headSha,
        expectedBranch: checkpoint.branch,
        guardMs: taskFinishedMs
      }),
      (error: unknown) =>
        error instanceof RollbackRefusedError &&
        error.reason === "newer-changes" &&
        error.details.includes("a.txt")
    );
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
