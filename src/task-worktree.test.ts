import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  commitTaskWorktree,
  createTaskWorktree,
  inspectTaskWorktree,
  sanitizeTaskWorktreeName
} from "./task-worktree.js";

test("creates an isolated task branch without changing the source checkout", async () => {
  const fixture = await createGitFixture();
  const sourceHead = await git(fixture.repo, ["rev-parse", "HEAD"]);

  const result = await createTaskWorktree({
    sourcePath: fixture.repo,
    taskName: "Task: Add / Status!",
    worktreeRoot: fixture.worktreeRoot
  });

  assert.equal(result.available, true);
  if (!result.available) return;
  assert.equal(result.worktree.branch, "devbot/task/task-add-status");
  assert.equal(result.worktree.path, path.join(await realpath(fixture.worktreeRoot), "task-add-status"));
  assert.equal(await git(result.worktree.path, ["branch", "--show-current"]), result.worktree.branch);
  assert.equal(await git(fixture.repo, ["rev-parse", "HEAD"]), sourceHead);
  assert.equal(await git(fixture.repo, ["status", "--porcelain"]), "");
  if (process.platform !== "win32") assert.equal((await stat(fixture.worktreeRoot)).mode & 0o777, 0o700);
});

test("inspects changed files and commits only changes in the isolated worktree", async () => {
  const fixture = await createGitFixture();
  const created = await createTaskWorktree({
    sourcePath: fixture.repo,
    taskName: "Fix formatter",
    worktreeRoot: fixture.worktreeRoot
  });
  assert.equal(created.available, true);
  if (!created.available) return;

  await writeFile(path.join(created.worktree.path, "tracked.txt"), "changed\n");
  await writeFile(path.join(created.worktree.path, "new file.txt"), "new\n");
  const inspection = await inspectTaskWorktree(created.worktree);

  assert.equal(inspection.available, true);
  if (!inspection.available) return;
  assert.deepEqual(
    inspection.changes.map((change) => [change.path, change.kind]).sort(),
    [["new file.txt", "untracked"], ["tracked.txt", "tracked"]]
  );
  assert.match(inspection.diff.unstaged, /changed/);

  const commit = await commitTaskWorktree(created.worktree, {
    message: "Update task files",
    files: ["tracked.txt", "new file.txt"]
  });
  assert.equal(commit.available, true);
  if (!commit.available) return;
  assert.equal(commit.committed, true);
  assert.ok(commit.revision);
  assert.equal(await git(created.worktree.path, ["status", "--porcelain"]), "");
  assert.equal(await readFile(path.join(fixture.repo, "tracked.txt"), "utf8"), "original\n");
  assert.equal(await git(fixture.repo, ["log", "-1", "--pretty=%s"]), "Initial commit");
});

test("task commits include both sides of a reported rename", async () => {
  const fixture = await createGitFixture();
  const created = await createTaskWorktree({
    sourcePath: fixture.repo,
    taskName: "Rename tracked file",
    worktreeRoot: fixture.worktreeRoot
  });
  assert.equal(created.available, true);
  if (!created.available) return;
  await git(created.worktree.path, ["mv", "tracked.txt", "renamed.txt"]);
  const inspection = await inspectTaskWorktree(created.worktree, 0);
  assert.equal(inspection.available, true);
  if (!inspection.available) return;
  const renamed = inspection.changes.find((change) => change.previousPath);
  assert.ok(renamed);

  const commit = await commitTaskWorktree(created.worktree, {
    message: "Rename tracked file",
    files: [renamed.path, renamed.previousPath!]
  });
  assert.equal(commit.available && commit.committed, true);
  assert.equal(await git(created.worktree.path, ["status", "--porcelain"]), "");
  assert.equal(await git(created.worktree.path, ["ls-files"]), "renamed.txt");
});

test("reports unavailable isolation without creating paths or branches", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-task-worktree-unavailable-"));
  const result = await createTaskWorktree({
    sourcePath: root,
    taskName: "No repo",
    worktreeRoot: path.join(root, "worktrees")
  });

  assert.deepEqual(result, {
    available: false,
    reason: "not_a_git_repository",
    message: `Cannot isolate this task because ${root} is not a Git repository.`
  });
  assert.equal(sanitizeTaskWorktreeName(" ../ A Strange TASK !!! "), "a-strange-task");
  assert.equal(sanitizeTaskWorktreeName("///"), undefined);
});

test("rejects a worktree root nested inside the source checkout", async () => {
  const fixture = await createGitFixture();
  const result = await createTaskWorktree({
    sourcePath: fixture.repo,
    taskName: "unsafe",
    worktreeRoot: path.join(fixture.repo, ".devbot", "worktrees")
  });

  assert.equal(result.available, false);
  if (result.available) return;
  assert.equal(result.reason, "unsafe_worktree_path");
  assert.equal(await git(fixture.repo, ["branch", "--list", "devbot/task/unsafe"]), "");
});

test("refuses repository-configured checkout filters", async () => {
  const fixture = await createGitFixture();
  await git(fixture.repo, ["config", "filter.exfiltrate.process", "/tmp/not-allowed"]);

  const result = await createTaskWorktree({
    sourcePath: fixture.repo,
    taskName: "filter-check",
    worktreeRoot: fixture.worktreeRoot
  });

  assert.equal(result.available, false);
  if (result.available) return;
  assert.equal(result.reason, "unsafe_git_config");
  assert.equal(await git(fixture.repo, ["branch", "--list", "devbot/task/filter-check"]), "");
});

test("caps retained task worktrees before creating another checkout", async () => {
  const fixture = await createGitFixture();
  await mkdir(path.join(fixture.worktreeRoot, "retained"), { recursive: true });

  const result = await createTaskWorktree({
    sourcePath: fixture.repo,
    taskName: "over-limit",
    worktreeRoot: fixture.worktreeRoot,
    maxWorktrees: 1
  });

  assert.equal(result.available, false);
  if (result.available) return;
  assert.equal(result.reason, "worktree_limit_reached");
  assert.equal(await git(fixture.repo, ["branch", "--list", "devbot/task/over-limit"]), "");
});

async function createGitFixture(): Promise<{ repo: string; worktreeRoot: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-task-worktree-"));
  const repo = path.join(root, "source");
  await git(root, ["init", "source"]);
  await git(repo, ["config", "user.name", "Devbot Test"]);
  await git(repo, ["config", "user.email", "devbot-test@example.invalid"]);
  await writeFile(path.join(repo, "tracked.txt"), "original\n");
  await git(repo, ["add", "tracked.txt"]);
  await git(repo, ["commit", "-m", "Initial commit"]);
  return { repo, worktreeRoot: path.join(root, "worktrees") };
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
