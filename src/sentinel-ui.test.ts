import assert from "node:assert/strict";
import test from "node:test";
import {
  formatSentinelStatus,
  parseSentinelControl,
  sentinelAlertContent,
  sentinelAlertRow,
  sentinelFixTaskPrompt,
  sentinelRecoveryNote
} from "./sentinel-ui.js";
import type { WatchState } from "./sentinel-store.js";

test("sentinel button rows encode stable, parseable custom ids", () => {
  const row = sentinelAlertRow("demo", "url-abc123").toJSON();
  const [fix, mute] = row.components;
  assert.equal(fix && "custom_id" in fix ? fix.custom_id : undefined, "devbot:sentinel:fix:demo:url-abc123");
  assert.equal(mute && "custom_id" in mute ? mute.custom_id : undefined, "devbot:sentinel:mute:demo:url-abc123");

  assert.deepEqual(parseSentinelControl("devbot:sentinel:fix:demo:url-abc123"), {
    action: "fix",
    projectName: "demo",
    watchId: "url-abc123"
  });
  assert.deepEqual(parseSentinelControl("devbot:sentinel:mute:demo:cmd-test"), {
    action: "mute",
    projectName: "demo",
    watchId: "cmd-test"
  });
  assert.equal(parseSentinelControl("devbot:sentinel:delete:demo:url-abc123"), undefined);
  assert.equal(parseSentinelControl("devbot:task-control:details:task-abc"), undefined);
  assert.equal(parseSentinelControl("devbot:sentinel:fix:bad project:url-abc123"), undefined);
});

test("sentinel alert content surfaces status, error detail, and recent commits", () => {
  const watch = downWatch();
  const content = sentinelAlertContent({
    projectName: "demo",
    watch,
    recentCommits: ["abc123 fix routing", "def456 add tests"],
    consoleErrors: ["TypeError: cannot read foo of undefined"]
  });
  assert.match(content, /Sentinel alert: demo/);
  assert.match(content, /status 500/);
  assert.match(content, /abc123 fix routing/);
  assert.match(content, /TypeError/);
});

test("sentinel recovery note and fix task prompt describe the failure without noise", () => {
  const watch = downWatch();
  const note = sentinelRecoveryNote("2026-01-01T00:05:00.000Z", watch);
  assert.match(note, /Recovered/);
  assert.match(note, /healthy again/);

  const prompt = sentinelFixTaskPrompt(watch);
  assert.match(prompt, /http:\/\/127\.0\.0\.1:3000/);
  assert.match(prompt, /status 500/);
  assert.match(prompt, /Investigate and fix/);
});

test("sentinel status formatting lists configuration and per-watch state", () => {
  const output = formatSentinelStatus(
    "demo",
    { enabled: true, intervalSeconds: 45, manualPaths: ["/admin"], fastCommand: "test" },
    [downWatch()]
  );
  assert.match(output, /Enabled: yes/);
  assert.match(output, /Interval: 45s/);
  assert.match(output, /\/admin/);
  assert.match(output, /down/);
});

function downWatch(): WatchState {
  return {
    id: "url-abc",
    kind: "url",
    target: "http://127.0.0.1:3000",
    status: "down",
    consecutiveFailures: 2,
    lastCheckAt: "2026-01-01T00:00:00.000Z",
    lastOkAt: "2025-12-31T23:50:00.000Z",
    lastCode: 500,
    lastError: "server responded 500"
  };
}
