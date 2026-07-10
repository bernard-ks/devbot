import assert from "node:assert/strict";
import test from "node:test";
import { safeReportedUrl } from "./project-screenshot.js";
import {
  buildTimelapseGif,
  computeGifPageLayout,
  decideSizeCap,
  deriveFlowSteps,
  isAllowedWebSocketUrl,
  isNavigationHref,
  isolatedProofNote,
  isUiRelatedTask,
  planCompletionProof,
  pushBoundedFrame,
  selectRecentFrames,
  DISCORD_MAX_ATTACHMENT_BYTES,
  WATCH_MAX_FRAMES
} from "./project-video.js";
import sharp from "sharp";

test("decideSizeCap accepts files within Discord's attachment limit", () => {
  assert.equal(decideSizeCap(1_000, 1), "accept");
  assert.equal(decideSizeCap(DISCORD_MAX_ATTACHMENT_BYTES, 1), "accept");
});

test("decideSizeCap shrinks on the first oversized attempt and falls back on the second", () => {
  assert.equal(decideSizeCap(DISCORD_MAX_ATTACHMENT_BYTES + 1, 1), "shrink");
  assert.equal(decideSizeCap(DISCORD_MAX_ATTACHMENT_BYTES + 1, 2), "fallback");
});

test("deriveFlowSteps extracts a bounded, deduplicated list of actions", () => {
  const steps = deriveFlowSteps("click the sign in button, then scroll down, then click sign in button", "open settings");
  assert.ok(steps.length > 0);
  assert.ok(steps.length <= 4);
  assert.equal(new Set(steps.map((step) => step.toLowerCase())).size, steps.length);
});

test("deriveFlowSteps caps the number of steps at maxSteps", () => {
  const steps = deriveFlowSteps("click a, click b, click c, click d, click e, click f", undefined, 4);
  assert.equal(steps.length, 4);
});

test("deriveFlowSteps returns nothing useful for empty input", () => {
  assert.deepEqual(deriveFlowSteps("   ", ""), []);
});

test("isUiRelatedTask matches UI vocabulary in the task text", () => {
  assert.equal(isUiRelatedTask("Fix the button color on the settings page", []), true);
  assert.equal(isUiRelatedTask("Refactor the database migration script", []), false);
});

test("isUiRelatedTask matches UI-flavored changed file paths even with neutral task text", () => {
  assert.equal(isUiRelatedTask("Fix the bug", ["src/components/Header.tsx"]), true);
  assert.equal(isUiRelatedTask("Fix the bug", ["src/server/db.ts"]), false);
  assert.equal(isUiRelatedTask("Fix the bug", ["src/styles/theme.css"]), true);
});

test("selectRecentFrames keeps only the most recent frames up to the cap", () => {
  const frames = Array.from({ length: 20 }, (_, index) => index);
  const recent = selectRecentFrames(frames);
  assert.equal(recent.length, WATCH_MAX_FRAMES);
  assert.deepEqual(recent, frames.slice(-WATCH_MAX_FRAMES));
});

test("selectRecentFrames returns everything when under the cap", () => {
  const frames = [1, 2, 3];
  assert.deepEqual(selectRecentFrames(frames), frames);
});

test("pushBoundedFrame keeps the buffer capped at the frame limit as frames arrive", () => {
  const frames: number[] = [];
  for (let index = 0; index < WATCH_MAX_FRAMES + 8; index += 1) {
    pushBoundedFrame(frames, index);
    assert.ok(frames.length <= WATCH_MAX_FRAMES);
  }
  assert.equal(frames.length, WATCH_MAX_FRAMES);
  assert.deepEqual(frames, Array.from({ length: WATCH_MAX_FRAMES }, (_, i) => i + 8));
});

test("pushBoundedFrame respects a custom cap and mutates in place", () => {
  const frames: string[] = [];
  const returned = pushBoundedFrame(frames, "a", 2);
  pushBoundedFrame(frames, "b", 2);
  pushBoundedFrame(frames, "c", 2);
  assert.equal(returned, frames);
  assert.deepEqual(frames, ["b", "c"]);
});

test("isolatedProofNote is honest that the recording would show unchanged source and points to /clip", () => {
  const withBranch = isolatedProofNote("devbot/task-123");
  assert.match(withBranch, /isolated worktree/i);
  assert.match(withBranch, /not served by the running dev server/i);
  assert.match(withBranch, /devbot\/task-123/);
  assert.match(withBranch, /\/clip/);

  const withoutBranch = isolatedProofNote();
  assert.match(withoutBranch, /isolated worktree/i);
  assert.doesNotMatch(withoutBranch, /branch/i);
});

test("planCompletionProof emits the isolated skip note for neutral wording with UI-only isolated changes", () => {
  const plan = planCompletionProof("Fix the bug", {
    isolated: true,
    branch: "devbot/task-42",
    changedFiles: ["src/components/Header.tsx"]
  });
  assert.equal(plan.action, "isolated-note");
  assert.match((plan as { note: string }).note, /isolated worktree/i);
  assert.match((plan as { note: string }).note, /devbot\/task-42/);
});

test("planCompletionProof skips proof entirely for neutral wording with non-UI isolated changes", () => {
  assert.deepEqual(
    planCompletionProof("Fix the bug", { isolated: true, changedFiles: ["src/server/db.ts"] }),
    { action: "none" }
  );
});

test("planCompletionProof records only for non-isolated UI tasks", () => {
  assert.deepEqual(
    planCompletionProof("Fix the button color", { isolated: false, changedFiles: [] }),
    { action: "record" }
  );
  assert.deepEqual(
    planCompletionProof("Fix the bug", { isolated: false, changedFiles: ["src/styles/theme.css"] }),
    { action: "record" }
  );
  assert.equal(planCompletionProof("Fix the button color", { isolated: true, changedFiles: [] }).action, "isolated-note");
});

test("isAllowedWebSocketUrl permits only loopback sockets on approved origins", () => {
  const allowed = new Set(["http://127.0.0.1:3000"]);
  assert.equal(isAllowedWebSocketUrl("ws://127.0.0.1:3000/live", allowed), true);
  assert.equal(isAllowedWebSocketUrl("ws://127.0.0.1:4000/live", allowed), false);
  assert.equal(isAllowedWebSocketUrl("wss://example.com/socket", allowed), false);
  assert.equal(isAllowedWebSocketUrl("ws://user:pass@127.0.0.1:3000/live", allowed), false);
  assert.equal(isAllowedWebSocketUrl("http://127.0.0.1:3000/", allowed), false);
  assert.equal(isAllowedWebSocketUrl("not a url", allowed), false);
});

test("isNavigationHref accepts document links and rejects script-scheme or empty targets", () => {
  assert.equal(isNavigationHref("/settings"), true);
  assert.equal(isNavigationHref("http://127.0.0.1:3000/detail"), true);
  assert.equal(isNavigationHref(""), false);
  assert.equal(isNavigationHref("#"), false);
  assert.equal(isNavigationHref("javascript:doThing()"), false);
  assert.equal(isNavigationHref("data:text/html,hi"), false);
});

test("safeReportedUrl strips credentials, query, and fragment from reported URLs", () => {
  assert.equal(
    safeReportedUrl("http://user:secret@127.0.0.1:3000/reset?token=abc123#step"),
    "http://127.0.0.1:3000/reset"
  );
});

test("computeGifPageLayout stacks frames vertically and caps pages at the max", () => {
  assert.deepEqual(computeGifPageLayout(5, 640, 360), { pages: 5, pageWidth: 640, pageHeight: 360, canvasHeight: 1800 });
  assert.deepEqual(computeGifPageLayout(30, 640, 360, 12), { pages: 12, pageWidth: 640, pageHeight: 360, canvasHeight: 4320 });
  assert.deepEqual(computeGifPageLayout(0, 640, 360), { pages: 0, pageWidth: 640, pageHeight: 360, canvasHeight: 0 });
});

test("buildTimelapseGif composes real frame buffers into a playable animated GIF", async () => {
  const frame = (color: { r: number; g: number; b: number }) =>
    sharp({ create: { width: 32, height: 24, channels: 3, background: color } }).png().toBuffer();
  const frames = await Promise.all([
    frame({ r: 255, g: 0, b: 0 }),
    frame({ r: 0, g: 255, b: 0 }),
    frame({ r: 0, g: 0, b: 255 })
  ]);

  const gif = await buildTimelapseGif(frames);
  assert.ok(gif);
  assert.equal(gif?.subarray(0, 6).toString("ascii"), "GIF89a");

  const metadata = await sharp(gif, { animated: true }).metadata();
  assert.equal(metadata.pages, 3);
});

test("buildTimelapseGif returns undefined for no frames", async () => {
  assert.equal(await buildTimelapseGif([]), undefined);
});
