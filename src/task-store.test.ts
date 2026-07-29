import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { formatTaskDetail, formatTaskList, formatTaskLogs, TaskStore, type TaskRecord } from "./task-store.js";

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

test("review publication state is durable, bounded, and rendered in task details", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-task-review-"));
  const stateFile = path.join(root, ".devbot", "tasks.json");
  const store = new TaskStore(stateFile);
  const task = await store.start({
    source: "test",
    mode: "action",
    projectName: "demo",
    requester: "tester",
    text: "Publish the parser fix"
  });
  const review = await store.setReview(task.id, {
    provider: "github",
    repository: "example/devbot",
    number: 42,
    url: "https://github.com/example/devbot/pull/42",
    branch: "devbot/task/parser",
    baseBranch: "main",
    commitSha: "a".repeat(40),
    status: "draft",
    draft: true,
    checks: { total: 3, pending: 1, passed: 2, failed: 0 },
    unresolvedThreads: 1,
    mergeable: "BLOCKED",
    lastSyncedAt: "2026-07-29T12:00:00.000Z"
  });
  assert.equal(review?.review?.number, 42);

  const reloaded = await new TaskStore(stateFile).get(task.id);
  assert.deepEqual(reloaded?.review?.checks, { total: 3, pending: 1, passed: 2, failed: 0 });
  const detail = formatTaskDetail(reloaded!);
  assert.match(detail, /example\/devbot#42 \(draft\)/);
  assert.match(detail, /Checks: 2 passed, 0 failed, 1 pending/);
  assert.match(detail, /Unresolved review threads: 1/);

  review!.review!.checks.passed = 99;
  assert.equal((await store.get(task.id))?.review?.checks.passed, 2);
});

test("loading drops malformed review publication state without dropping the task", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-task-review-load-"));
  const stateFile = path.join(root, ".devbot", "tasks.json");
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify({
    version: 1,
    tasks: [{
      id: "task-review-invalid",
      status: "succeeded",
      source: "test",
      mode: "action",
      projectName: "demo",
      requester: "tester",
      text: "Publish safely",
      includePatterns: [],
      review: {
        provider: "github",
        repository: "example/devbot",
        number: 42,
        url: "https://evil.example/pull/42",
        checks: { total: 1, pending: 0, passed: 9, failed: 0 }
      },
      startedAt: "2026-07-29T12:00:00.000Z",
      updatedAt: "2026-07-29T12:00:00.000Z"
    }]
  }, null, 2));

  const task = await new TaskStore(stateFile).get("task-review-invalid");
  assert.ok(task);
  assert.equal(task.review, undefined);
});

function hostileTask(): TaskRecord {
  const now = new Date().toISOString();
  return {
    id: "task-hostile",
    status: "failed",
    source: "mention",
    mode: "action",
    projectName: "web",
    requester: "@everyone <@111>",
    text: "ping @everyone plus <@222> and <@&333> immediately",
    includePatterns: [],
    approvalStatus: "approved",
    approvalActor: "@here <@444>",
    resultPreview: "posted to @everyone via <@555>",
    error: "failed while notifying <@&666> and @everyone",
    startedAt: now,
    updatedAt: now,
    finishedAt: now
  };
}

function assertMentionSafe(output: string): void {
  assert.doesNotMatch(output, /@everyone/);
  assert.doesNotMatch(output, /@here/);
  assert.doesNotMatch(output, /<@\d/);
  assert.doesNotMatch(output, /<@&\d/);
  assert.match(output, /@\u200beveryone/);
}

test("task list output neutralizes stored mentions", () => {
  assertMentionSafe(formatTaskList([hostileTask()]));
});

test("task detail output neutralizes stored mentions including approval actor, result, and error", () => {
  const output = formatTaskDetail(hostileTask());
  assertMentionSafe(output);
  assert.match(output, /Approval: approved by @\u200bhere/);
  assert.match(output, /Result preview:/);
  assert.match(output, /Error:/);
});

test("task log output neutralizes stored mentions in request, result, and error", () => {
  assertMentionSafe(formatTaskLogs(hostileTask()));
});

test("task detail and logs hide paths from stored model results and failures", () => {
  const task = {
    ...hostileTask(),
    resultPreview: "Changed /Users/bernard/private/result.ts",
    error: "ENOENT C:\\Users\\bernard\\private\\missing.ts",
    verification: ["failed at /tmp/devbot-check/output.log"]
  };
  const output = `${formatTaskDetail(task)}\n${formatTaskLogs(task)}`;
  assert.doesNotMatch(output, /\/Users\/bernard|C:\\Users|\/tmp\/devbot-check/);
  assert.match(output, /\[local path\]/);
});
