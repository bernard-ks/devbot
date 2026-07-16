import assert from "node:assert/strict";
import test from "node:test";
import { canAccessTaskRecord, isTaskListVisible, taskRetryRefusal, taskSyncRefusal } from "./task-access.js";
import type { TaskRecord } from "./task-store.js";

test("workroom tasks are limited to their requester and project-authorized controllers", () => {
  const task = record({ accessScope: "workroom", requesterId: "requester" });
  assert.equal(canAccessTaskRecord(task, { userId: "requester", projectAllowed: true, controller: false }), true);
  assert.equal(canAccessTaskRecord(task, { userId: "controller", projectAllowed: true, controller: true }), true);
  assert.equal(canAccessTaskRecord(task, { userId: "viewer", projectAllowed: true, controller: false }), false);
  assert.equal(canAccessTaskRecord(task, { userId: "controller", projectAllowed: false, controller: true }), false);
});

test("internal seats never appear in task lists", () => {
  const internal = record({ internal: true, requesterId: "requester" });
  assert.equal(isTaskListVisible(internal, { userId: "requester", projectAllowed: true, controller: false }), false);
  assert.equal(canAccessTaskRecord(internal, { userId: "requester", projectAllowed: true, controller: false }), true);
});

test("ordinary project tasks retain project-level access", () => {
  const task = record({});
  assert.equal(canAccessTaskRecord(task, { userId: "viewer", projectAllowed: true, controller: false }), true);
  assert.equal(canAccessTaskRecord(task, { userId: "viewer", projectAllowed: false, controller: false }), false);
});

test("task branch sync is limited to a controller with project access", () => {
  const task = record({
    requesterId: "requester",
    workspaceIsolated: true,
    workspacePath: "/tmp/worktree",
    branchName: "devbot/task/task-access",
    baseBranch: "abc123"
  });
  assert.equal(taskSyncRefusal(task, { userId: "requester", projectAllowed: true, controller: false, safeMode: false }), "needs-controller");
  assert.equal(taskSyncRefusal(task, { userId: "controller", projectAllowed: true, controller: true, safeMode: false }), undefined);
  assert.equal(taskSyncRefusal(task, { userId: "viewer", projectAllowed: true, controller: false, safeMode: false }), "needs-controller");
  assert.equal(taskSyncRefusal(task, { userId: "requester", projectAllowed: false, controller: false, safeMode: false }), "access");
});

test("safe mode, missing branch evidence, and open tasks refuse branch sync", () => {
  const context = { userId: "controller", projectAllowed: true, controller: true, safeMode: false };
  const task = record({
    requesterId: "requester",
    workspaceIsolated: true,
    workspacePath: "/tmp/worktree",
    branchName: "devbot/task/task-access",
    baseBranch: "abc123"
  });
  assert.equal(taskSyncRefusal(task, { ...context, safeMode: true }), "safe-mode");
  assert.equal(taskSyncRefusal(record({ requesterId: "requester" }), context), "no-isolated-branch");
  assert.equal(
    taskSyncRefusal(record({ requesterId: "requester", workspaceIsolated: false, workspacePath: "/tmp/repo", baseBranch: "main" }), context),
    "no-isolated-branch"
  );
  assert.equal(taskSyncRefusal({ ...task, status: "running" }, context), "task-active");
  assert.equal(taskSyncRefusal({ ...task, status: "awaiting-approval" }, context), "task-active");
});

test("a write-task requester whose controller access was revoked cannot retry it", () => {
  const base = { globalAllowed: true, projectAllowed: true, controller: false, requester: true };
  assert.equal(taskRetryRefusal({ ...base, interrupted: true, writeCapable: true }), "needs-controller");
  assert.equal(taskRetryRefusal({ ...base, interrupted: false, writeCapable: true }), "needs-controller");
  assert.equal(taskRetryRefusal({ ...base, interrupted: true, writeCapable: true, controller: true }), undefined);
});

test("requester-only retry recovery is limited to read-only interrupted work", () => {
  const requester = { globalAllowed: true, projectAllowed: true, controller: false, requester: true, writeCapable: false };
  assert.equal(taskRetryRefusal({ ...requester, interrupted: true }), undefined);
  assert.equal(taskRetryRefusal({ ...requester, requester: false, interrupted: true }), "needs-requester-or-controller");
  assert.equal(taskRetryRefusal({ ...requester, interrupted: false }), undefined);
});

test("retry re-checks current global and project authorization", () => {
  const controller = { interrupted: true, writeCapable: true, controller: true, requester: true };
  assert.equal(taskRetryRefusal({ ...controller, globalAllowed: false, projectAllowed: true }), "not-allowed");
  assert.equal(taskRetryRefusal({ ...controller, globalAllowed: true, projectAllowed: false }), "not-project");
  assert.equal(taskRetryRefusal({ ...controller, globalAllowed: true, projectAllowed: true }), undefined);
});

function record(overrides: Partial<TaskRecord>): TaskRecord {
  return {
    id: "task-access",
    status: "succeeded",
    source: "test",
    mode: "answer",
    projectName: "demo",
    requester: "tester",
    text: "inspect task",
    includePatterns: [],
    startedAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    ...overrides
  };
}
