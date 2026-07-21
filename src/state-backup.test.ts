import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createStateBackup, verifyStateBackup } from "./state-backup.js";

test("state backup creates a private integrity-checked snapshot", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-state-backup-"));
  const source = path.join(root, "state");
  const backup = path.join(root, "backup");
  await mkdir(path.join(source, "memory"), { recursive: true });
  await writeFile(path.join(source, "tasks.json"), '{"version":1}\n');
  await writeFile(path.join(source, "memory", "project.jsonl"), '{"id":"memory-1"}\n');

  const created = await createStateBackup(backup, {
    sourceRoot: source,
    runtimeLock: path.join(root, "runtime.pid")
  });
  assert.deepEqual(created.entries.map((entry) => entry.path), ["memory/project.jsonl", "tasks.json"]);
  assert.equal((await verifyStateBackup(backup)).entries.length, 2);
  assert.equal(await readFile(path.join(backup, "tasks.json"), "utf8"), '{"version":1}\n');
});

test("state backup verification detects tampering and unexpected files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-state-tamper-"));
  const source = path.join(root, "state");
  const backup = path.join(root, "backup");
  await mkdir(source);
  await writeFile(path.join(source, "tasks.json"), "original");
  await createStateBackup(backup, { sourceRoot: source, runtimeLock: path.join(root, "runtime.pid") });
  await writeFile(path.join(backup, "tasks.json"), "changed");
  await assert.rejects(verifyStateBackup(backup), /integrity check failed/);
});

test("state backup refuses symlinked entries", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-state-symlink-"));
  const source = path.join(root, "state");
  await mkdir(source);
  await writeFile(path.join(root, "outside"), "private");
  await symlink(path.join(root, "outside"), path.join(source, "linked"));
  await assert.rejects(
    createStateBackup(path.join(root, "backup"), { sourceRoot: source, runtimeLock: path.join(root, "runtime.pid") }),
    /symlinked runtime entry/
  );
});

test("state backup rejects a destination whose symlinked parent resolves inside live state", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-state-parent-symlink-"));
  const source = path.join(root, "state");
  const linkedParent = path.join(root, "linked-state");
  await mkdir(source);
  await writeFile(path.join(source, "tasks.json"), "private");
  await symlink(source, linkedParent);

  await assert.rejects(
    createStateBackup(path.join(linkedParent, "backup"), {
      sourceRoot: source,
      runtimeLock: path.join(root, "runtime.pid")
    }),
    /must not contain one another/
  );
});

test("state backup fails closed when individual stores are outside the unified state root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-state-override-"));
  const source = path.join(root, "state");
  await mkdir(source);

  await assert.rejects(
    createStateBackup(path.join(root, "backup"), {
      sourceRoot: source,
      runtimeLock: path.join(root, "runtime.pid"),
      environment: { DEVBOT_TASK_STORE: path.join(root, "custom-tasks.json") }
    }),
    /requires one unified DEVBOT_STATE_DIR.*DEVBOT_TASK_STORE/
  );
});

test("state backup verification rejects a symlinked backup root", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-state-verify-symlink-"));
  const source = path.join(root, "state");
  const backup = path.join(root, "backup");
  const linkedBackup = path.join(root, "linked-backup");
  await mkdir(source);
  await writeFile(path.join(source, "tasks.json"), "private");
  await createStateBackup(backup, { sourceRoot: source, runtimeLock: path.join(root, "runtime.pid") });
  await symlink(backup, linkedBackup);

  await assert.rejects(verifyStateBackup(linkedBackup), /must be a real directory/);
});
