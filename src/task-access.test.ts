import assert from "node:assert/strict";
import test from "node:test";
import { canAccessTaskRecord, isTaskListVisible } from "./task-access.js";
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
