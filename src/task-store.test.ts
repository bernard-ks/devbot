import assert from "node:assert/strict";
import test from "node:test";
import { formatTaskDetail, formatTaskList, formatTaskLogs, type TaskRecord } from "./task-store.js";

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
