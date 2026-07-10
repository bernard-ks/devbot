import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { formatTaskDetail, formatTaskList, TaskStore } from "./task-store.js";

test("branch merged state is durable and survives a reload", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-task-store-"));
  const stateFile = path.join(root, ".devbot", "tasks.json");
  const store = new TaskStore(stateFile);
  const task = await store.start({
    source: "test",
    mode: "action",
    projectName: "demo",
    requester: "tester",
    text: "Sync the parser branch"
  });
  await store.setWorkspace(task.id, {
    workspacePath: path.join(root, "worktree"),
    branchName: `devbot/task/${task.id}`,
    baseBranch: "0123456789abcdef0123456789abcdef01234567",
    isolated: true
  });

  const marked = await store.setBranchSync(task.id, { merged: true, baseBranch: "fedcba9876543210fedcba9876543210fedcba98" });
  assert.equal(marked?.branchMerged, true);
  assert.equal(marked?.baseBranch, "fedcba9876543210fedcba9876543210fedcba98");

  const reloaded = await new TaskStore(stateFile).get(task.id);
  assert.equal(reloaded?.branchMerged, true);
  assert.match(formatTaskList([reloaded!]), /\(branch merged\)/);
  assert.match(formatTaskDetail(reloaded!), /merged into the default branch/);
  assert.match(formatTaskDetail(reloaded!), /eligible for pruning/);

  const cleared = await store.setBranchSync(task.id, { merged: false });
  assert.equal(cleared?.branchMerged, undefined);
  assert.equal((await new TaskStore(stateFile).get(task.id))?.branchMerged, undefined);
});

test("loading rejects non-boolean branch merged values", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-task-store-load-"));
  const stateFile = path.join(root, ".devbot", "tasks.json");
  await mkdir(path.dirname(stateFile), { recursive: true });
  const record = {
    id: "task-load-check",
    status: "succeeded",
    source: "test",
    mode: "action",
    projectName: "demo",
    requester: "tester",
    text: "Check load validation",
    includePatterns: [],
    branchMerged: "yes",
    startedAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z"
  };
  await writeFile(stateFile, JSON.stringify({ version: 1, tasks: [record] }, null, 2));

  const loaded = await new TaskStore(stateFile).get("task-load-check");
  assert.ok(loaded);
  assert.equal("branchMerged" in loaded, false);

  const marked = await new TaskStore(stateFile).setBranchSync("task-load-check", { merged: true });
  assert.equal(marked?.branchMerged, true);
  const persisted = JSON.parse(await readFile(stateFile, "utf8")) as { tasks: Array<{ branchMerged?: unknown }> };
  assert.equal(persisted.tasks[0]?.branchMerged, true);
});
