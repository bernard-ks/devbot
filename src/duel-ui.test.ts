import assert from "node:assert/strict";
import test from "node:test";
import { duelDecisionRow, duelReviewButton, isBoundDuelControl, parseDuelControl } from "./duel-ui.js";

test("the default decision row exposes only read-only controls: copy fix prompt and dismiss", () => {
  const row = duelDecisionRow("collab-abc123-def456").toJSON();
  const customIds = row.components.map((component) => ("custom_id" in component ? component.custom_id : undefined));
  assert.deepEqual(customIds, ["devbot:duel-control:prompt:collab-abc123-def456", "devbot:duel-control:dismiss:collab-abc123-def456"]);
});

test("Accept & fix is only present when the caller explicitly verified the reviewed snapshot", () => {
  const withAccept = duelDecisionRow("collab-abc123-def456", { acceptAndFix: true }).toJSON();
  const customIds = withAccept.components.map((component) => ("custom_id" in component ? component.custom_id : undefined));
  assert.deepEqual(customIds, [
    "devbot:duel-control:accept:collab-abc123-def456",
    "devbot:duel-control:prompt:collab-abc123-def456",
    "devbot:duel-control:dismiss:collab-abc123-def456"
  ]);
  const withoutAccept = duelDecisionRow("collab-abc123-def456", { acceptAndFix: false }).toJSON();
  assert.equal(withoutAccept.components.length, 2);
});

test("control encoding refuses values that are not well-formed ids", () => {
  assert.throws(() => duelDecisionRow("collab-abc123-def456:extra"));
  assert.throws(() => duelReviewButton("not a task id"));
});

test("control parsing accepts only known actions with matching id shapes", () => {
  assert.deepEqual(parseDuelControl("devbot:duel-control:prompt:collab-abc123-def456"), {
    action: "prompt",
    targetId: "collab-abc123-def456"
  });
  assert.deepEqual(parseDuelControl("devbot:duel-control:dismiss:collab-abc123-def456"), {
    action: "dismiss",
    targetId: "collab-abc123-def456"
  });
  assert.deepEqual(parseDuelControl("devbot:duel-control:accept:collab-abc123-def456"), {
    action: "accept",
    targetId: "collab-abc123-def456"
  });
  assert.equal(parseDuelControl("devbot:duel-control:accept:task-123"), undefined);
  assert.equal(parseDuelControl("devbot:duel-control:prompt:task-123"), undefined);
  assert.equal(parseDuelControl("devbot:duel-control:prompt:collab-abc123-def456:extra"), undefined);
  assert.equal(parseDuelControl("devbot:other-control:prompt:collab-abc123-def456"), undefined);
});

test("decision controls are bound to the exact recorded control message and channel", () => {
  const binding = { controlMessageId: "message-1", controlChannelId: "channel-1" };
  assert.equal(isBoundDuelControl(binding, "message-1", "channel-1"), true);
  assert.equal(isBoundDuelControl(binding, "message-2", "channel-1"), false, "wrong message must be rejected");
  assert.equal(isBoundDuelControl(binding, "message-1", "channel-2"), false, "wrong channel must be rejected");
  assert.equal(isBoundDuelControl(binding, undefined, "channel-1"), false, "missing message must be rejected");
  assert.equal(isBoundDuelControl({}, "message-1", "channel-1"), false, "an unbound duel accepts no controls");
});

test("binding falls back to the thread and then the origin channel when no control channel was recorded", () => {
  assert.equal(isBoundDuelControl({ controlMessageId: "m", threadId: "thread-1" }, "m", "thread-1"), true);
  assert.equal(isBoundDuelControl({ controlMessageId: "m", threadId: "thread-1" }, "m", "channel-9"), false);
  assert.equal(isBoundDuelControl({ controlMessageId: "m", channelId: "channel-1" }, "m", "channel-1"), true);
});
