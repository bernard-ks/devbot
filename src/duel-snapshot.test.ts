import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  captureDuelSnapshot,
  cleanupDuelSnapshotRefs,
  deleteDuelSnapshotRef,
  duelSnapshotRef,
  verifyDuelSnapshot
} from "./duel-snapshot.js";
import { createTaskWorktree } from "./task-worktree.js";

test("snapshot ref encoding accepts only exact duel conversation IDs", () => {
  assert.equal(duelSnapshotRef("collab-abc123-def456"), "refs/devbot/duels/collab-abc123-def456");
  assert.equal(duelSnapshotRef("collab-abc123-def456:extra"), undefined);
  assert.equal(duelSnapshotRef("collab-abc123-def456/../../heads/main"), undefined);
  assert.equal(duelSnapshotRef("task-123"), undefined);
  assert.equal(duelSnapshotRef(""), undefined);
});

test("capture refuses an ID that cannot be encoded as a snapshot ref", async () => {
  const fixture = await createGitFixture();
  const captured = await captureDuelSnapshot(fixture.repo, "not-a-duel-id");
  assert.equal(captured.ok, false);
});

// One fixture is shared across this test's assertions (rather than one per assertion) to keep
// the suite's child-process load down, since each fixture costs a couple dozen real git spawns.
test("snapshot pins committed, staged, unstaged, and bounded untracked state, excludes sensitive paths, and never touches the working tree", async () => {
  const fixture = await createGitFixture();
  const duelId = "collab-snap1-cover1";

  await writeFile(path.join(fixture.repo, "tracked.txt"), "committed change\n");
  await git(fixture.repo, ["add", "tracked.txt"]);
  await git(fixture.repo, ["commit", "-m", "Committed change"]);
  await writeFile(path.join(fixture.repo, "staged.txt"), "staged\n");
  await git(fixture.repo, ["add", "staged.txt"]);
  await writeFile(path.join(fixture.repo, "tracked.txt"), "committed change\nplus unstaged\n");
  await writeFile(path.join(fixture.repo, "new-file.txt"), "brand new untracked file\n");
  await writeFile(path.join(fixture.repo, ".env"), "SECRET=do-not-leak\n");
  await writeFile(path.join(fixture.repo, "huge.bin"), "x".repeat(600_000));
  const statusBefore = await git(fixture.repo, ["status", "--porcelain"]);

  const captured = await captureDuelSnapshot(fixture.repo, duelId);
  assert.equal(captured.ok, true);
  if (!captured.ok) return;
  assert.equal(captured.snapshot.ref, `refs/devbot/duels/${duelId}`);
  assert.match(captured.snapshot.commit, /^[0-9a-f]{40,64}$/);
  assert.match(captured.snapshot.tree, /^[0-9a-f]{40,64}$/);

  const statusAfter = await git(fixture.repo, ["status", "--porcelain"]);
  assert.equal(statusAfter, statusBefore, "capturing a snapshot must not mutate the working tree or the real index");

  const snapshotFiles = await git(fixture.repo, ["ls-tree", "-r", "--name-only", captured.snapshot.ref]);
  assert.ok(snapshotFiles.includes("staged.txt"), "staged file must be in the snapshot");
  assert.ok(snapshotFiles.includes("new-file.txt"), "untracked file must be in the snapshot");
  assert.ok(!snapshotFiles.includes(".env"), "sensitive paths must be excluded from the snapshot");
  assert.ok(!snapshotFiles.includes("huge.bin"), "untracked files beyond the size bound must be excluded");
  const trackedInSnapshot = await git(fixture.repo, ["show", `${captured.snapshot.ref}:tracked.txt`]);
  assert.equal(trackedInSnapshot, "committed change\nplus unstaged");

  assert.equal(await verifyDuelSnapshot(fixture.repo, captured.snapshot), true);
  assert.equal(
    await verifyDuelSnapshot(fixture.repo, { ...captured.snapshot, tree: "0".repeat(40) }),
    false,
    "a recorded tree hash that no longer matches must fail verification"
  );

  const headCommit = await git(fixture.repo, ["rev-parse", "HEAD"]);
  await git(fixture.repo, ["update-ref", captured.snapshot.ref, headCommit]);
  assert.equal(await verifyDuelSnapshot(fixture.repo, captured.snapshot), false, "a moved ref must fail verification");

  assert.equal(await deleteDuelSnapshotRef(fixture.repo, duelId), true);
  assert.equal(await verifyDuelSnapshot(fixture.repo, captured.snapshot), false, "a missing ref must fail verification");
});

test("verification fails closed on malformed recorded identities", async () => {
  const fixture = await createGitFixture();
  assert.equal(await verifyDuelSnapshot(fixture.repo, { ref: "refs/heads/main", commit: "a".repeat(40), tree: "b".repeat(40) }), false);
  assert.equal(await verifyDuelSnapshot(fixture.repo, { ref: "refs/devbot/duels/collab-a1-b2", commit: "HEAD", tree: "b".repeat(40) }), false);
});

// Bernard's stage-2 gate, end to end: task A creates an UNTRACKED file in its isolated worktree;
// the duel snapshot pins it; "Accept & fix" seeds a fresh isolated worktree from that snapshot
// where the file is present and modifiable; the source checkout is untouched throughout.
test("an untracked file from task A is present and modifiable in a fix worktree seeded from the snapshot, with the source checkout untouched", async () => {
  const fixture = await createGitFixture();
  const worktreeRoot = path.join(fixture.root, "worktrees");
  const duelId = "collab-e2e1-seed1";

  const taskA = await createTaskWorktree({ sourcePath: fixture.repo, taskName: "task-a", worktreeRoot });
  assert.equal(taskA.available, true);
  if (!taskA.available) return;
  await writeFile(path.join(taskA.worktree.path, "untracked-from-task-a.txt"), "created by task A, never committed\n");

  const captured = await captureDuelSnapshot(taskA.worktree.path, duelId);
  assert.equal(captured.ok, true);
  if (!captured.ok) return;
  assert.equal(
    await verifyDuelSnapshot(fixture.repo, captured.snapshot),
    true,
    "the snapshot ref must resolve from the source repository, not just the task worktree"
  );

  const fix = await createTaskWorktree({
    sourcePath: fixture.repo,
    taskName: "fix-from-snapshot",
    baseRef: captured.snapshot.commit,
    worktreeRoot
  });
  assert.equal(fix.available, true);
  if (!fix.available) return;
  assert.equal(fix.worktree.baseRevision, captured.snapshot.commit);

  const seededPath = path.join(fix.worktree.path, "untracked-from-task-a.txt");
  assert.equal(await readFile(seededPath, "utf8"), "created by task A, never committed\n");
  await writeFile(seededPath, "modified by the fix task\n");
  assert.equal(await readFile(seededPath, "utf8"), "modified by the fix task\n");

  assert.equal(await git(fixture.repo, ["status", "--porcelain"]), "", "the source checkout must stay clean throughout");
  await assert.rejects(readFile(path.join(fixture.repo, "untracked-from-task-a.txt")), "the file must never appear in the source checkout");
  assert.equal(
    await readFile(path.join(taskA.worktree.path, "untracked-from-task-a.txt"), "utf8"),
    "created by task A, never committed\n",
    "the original task worktree must be untouched"
  );
  assert.equal(
    await git(taskA.worktree.path, ["status", "--porcelain"]),
    "?? untracked-from-task-a.txt",
    "the file must still be untracked in the original task worktree"
  );
});

test("ref cleanup deletes pruned, unknown, and malformed refs and bounds the survivors", async () => {
  const fixture = await createGitFixture();
  await writeFile(path.join(fixture.repo, "change.txt"), "change\n");

  const keepId = "collab-keep1-keep1";
  const dropId = "collab-drop1-drop1";
  const oldId = "collab-old1-old1";
  for (const duelId of [oldId, dropId, keepId]) {
    const captured = await captureDuelSnapshot(fixture.repo, duelId);
    assert.equal(captured.ok, true);
  }
  const headCommit = await git(fixture.repo, ["rev-parse", "HEAD"]);
  await git(fixture.repo, ["update-ref", "refs/devbot/duels/not-a-duel-id", headCommit]);

  const deleted = await cleanupDuelSnapshotRefs(fixture.repo, new Set([keepId, oldId]));
  assert.equal(deleted, 2, "the unknown duel ref and the malformed ref must be deleted");
  const remaining = await git(fixture.repo, ["for-each-ref", "--format=%(refname)", "refs/devbot/duels"]);
  assert.deepEqual(remaining.split("\n").filter(Boolean).sort(), [`refs/devbot/duels/${keepId}`, `refs/devbot/duels/${oldId}`]);

  const bounded = await cleanupDuelSnapshotRefs(fixture.repo, new Set([keepId, oldId]), 1);
  assert.equal(bounded, 1, "survivors beyond the retention bound must be deleted, oldest first");
  const afterBound = await git(fixture.repo, ["for-each-ref", "--format=%(refname)", "refs/devbot/duels"]);
  assert.equal(afterBound.split("\n").filter(Boolean).length, 1);
});

async function createGitFixture(): Promise<{ root: string; repo: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-duel-snap-"));
  const repo = path.join(root, "source");
  await git(root, ["init", "source"]);
  await git(repo, ["config", "user.name", "Devbot Test"]);
  await git(repo, ["config", "user.email", "devbot-test@example.invalid"]);
  await writeFile(path.join(repo, "tracked.txt"), "original\n");
  await git(repo, ["add", "tracked.txt"]);
  await git(repo, ["commit", "-m", "Initial commit"]);
  return { root, repo };
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
