import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTimelapseGif,
  computeGifPageLayout,
  decideSizeCap,
  deriveFlowSteps,
  isUiRelatedTask,
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
