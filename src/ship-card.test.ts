import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { CARD_HEIGHT, CARD_WIDTH, composeShipCard, containSize, truncateShipSummary } from "./ship-card.js";

test("truncateShipSummary collapses whitespace and truncates cleanly with an ellipsis", () => {
  assert.equal(truncateShipSummary("  Fix   the   header   spacing  "), "Fix the header spacing");
  assert.equal(truncateShipSummary("short", 140), "short");

  const long = "Add a completely new onboarding flow that walks new users through account setup, billing, and their first project.";
  const truncated = truncateShipSummary(long, 40);
  assert.equal(truncated.length, 40);
  assert.ok(truncated.endsWith("…"));
  assert.equal(truncated, `${long.slice(0, 39)}…`);
});

test("containSize scales to fit while preserving aspect ratio", () => {
  assert.deepEqual(containSize({ width: 1000, height: 500 }, { width: 500, height: 500 }), { width: 500, height: 250 });
  assert.deepEqual(containSize({ width: 400, height: 800 }, { width: 500, height: 500 }), { width: 250, height: 500 });
  assert.deepEqual(containSize({ width: 0, height: 100 }, { width: 500, height: 500 }), { width: 0, height: 0 });
});

test("composeShipCard renders a fixed-size social card with an embedded screenshot", async () => {
  const screenshot = await sharp({
    create: { width: 400, height: 300, channels: 3, background: { r: 20, g: 120, b: 200 } }
  })
    .png()
    .toBuffer();

  const card = await composeShipCard({
    projectName: "PullPrice",
    summary: "Add set completion tracker to the collection page",
    image: screenshot,
    changedPercent: 12.34
  });
  const meta = await sharp(card).metadata();
  assert.equal(meta.width, CARD_WIDTH);
  assert.equal(meta.height, CARD_HEIGHT);
  assert.equal(meta.format, "png");
});

test("composeShipCard renders a text-only card when no screenshot is available", async () => {
  const card = await composeShipCard({
    projectName: "devbot",
    summary: "Refactor the router config parser"
  });
  const meta = await sharp(card).metadata();
  assert.equal(meta.width, CARD_WIDTH);
  assert.equal(meta.height, CARD_HEIGHT);
});
