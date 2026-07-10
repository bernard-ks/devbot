import assert from "node:assert/strict";
import test from "node:test";
import { continuationPrompt, formatTaskProgress, parseTaskModal, taskRequestModal } from "./task-ui.js";
import type { TaskRecord } from "./task-store.js";

test("task progress reports human phases without raw model IDs", () => {
  const output = formatTaskProgress(
    {
      taskId: "task-abc",
      projectName: "pullprice",
      mode: "action",
      text: "Fix the failing test",
      requester: "tester",
      startedAt: "2026-07-10T00:00:00.000Z",
      phase: "running-codex",
      route: {
        tier: "standard",
        contextMode: "focused",
        model: "gpt-5.6-terra",
        reasoningEffort: "medium",
        reason: "Focused task",
        source: "model"
      },
      contextFileCount: 4
    },
    new Date("2026-07-10T00:01:05.000Z")
  );
  assert.match(output, /Terra is working with 4 context files/);
  assert.match(output, /1m 5s/);
  assert.doesNotMatch(output, /gpt-5\.6-terra|task-abc/);

  const longFailure = formatTaskProgress({
    taskId: "task-abc",
    projectName: "pullprice",
    mode: "answer",
    text: "Inspect the failure",
    requester: "tester",
    startedAt: "2026-07-10T00:00:00.000Z",
    phase: "failed",
    error: "x".repeat(5_000)
  });
  assert.ok(longFailure.length < 2_000);
});

test("task continuation modals and prompts preserve useful context", () => {
  const task = savedTask();
  assert.deepEqual(parseTaskModal("devbot:task-modal:followup:task-abc"), { action: "followup", taskId: "task-abc" });
  assert.equal(parseTaskModal("devbot:task-modal:followup:../../bad"), undefined);
  assert.equal(parseTaskModal(`devbot:task-modal:followup:task-${"a".repeat(65)}`), undefined);
  assert.equal(taskRequestModal("adjust", task).toJSON().custom_id, "devbot:task-modal:adjust:task-abc");

  const prompt = continuationPrompt("followup", task, "Which file should change?");
  assert.match(prompt, /Original request/);
  assert.match(prompt, /Previous result/);
  assert.match(prompt, /Which file should change/);
  assert.equal(continuationPrompt("adjust", task, "Try a smaller fix"), "Try a smaller fix");
});

function savedTask(): TaskRecord {
  return {
    id: "task-abc",
    status: "succeeded",
    source: "test",
    mode: "answer",
    projectName: "pullprice",
    requester: "tester",
    text: "Explain the pricing flow",
    includePatterns: [],
    resultPreview: "The pricing flow starts in the market service.",
    startedAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:01:00.000Z",
    finishedAt: "2026-07-10T00:01:00.000Z"
  };
}
