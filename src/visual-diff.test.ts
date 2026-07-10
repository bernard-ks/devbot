import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import {
  clusterChangedCells,
  commonCanvasSize,
  composeBeforeAfter,
  diffImages,
  shouldAttachDiffCard
} from "./visual-diff.js";

test("commonCanvasSize picks the smallest shared dimensions", () => {
  assert.deepEqual(commonCanvasSize({ width: 100, height: 200 }, { width: 150, height: 150 }), { width: 100, height: 150 });
  assert.deepEqual(commonCanvasSize({ width: 0, height: 50 }, { width: 80, height: 50 }), { width: 0, height: 50 });
});

test("shouldAttachDiffCard applies an inclusive threshold", () => {
  assert.equal(shouldAttachDiffCard(0.5), true);
  assert.equal(shouldAttachDiffCard(0.49), false);
  assert.equal(shouldAttachDiffCard(5, 10), false);
  assert.equal(shouldAttachDiffCard(10, 10), true);
});

test("clusterChangedCells groups adjacent cells and clips edge cells to the image bounds", () => {
  const grid = [
    [false, false, false, false, false],
    [false, true, true, false, false],
    [false, true, true, false, false],
    [false, false, false, false, false],
    [false, false, false, false, true]
  ];
  const regions = clusterChangedCells(grid, 20, 20, 95, 95);
  assert.equal(regions.length, 2);
  const block = regions.find((region) => region.x === 20 && region.y === 20);
  assert.ok(block);
  assert.equal(block?.width, 40);
  assert.equal(block?.height, 40);
  const corner = regions.find((region) => region.x === 80 && region.y === 80);
  assert.ok(corner);
  assert.equal(corner?.width, 15);
  assert.equal(corner?.height, 15);
});

test("clusterChangedCells returns no regions for an all-clear grid", () => {
  const grid = [
    [false, false],
    [false, false]
  ];
  assert.deepEqual(clusterChangedCells(grid, 10, 10), []);
});

async function solidWithSquare(width: number, height: number, square: { x: number; y: number; size: number }): Promise<Buffer> {
  const base = sharp({
    create: { width, height, channels: 3, background: { r: 245, g: 245, b: 245 } }
  });
  const svgSquare = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect x="${square.x}" y="${square.y}" width="${square.size}" height="${square.size}" fill="#e0393e"/></svg>`
  );
  return base.composite([{ input: svgSquare, top: 0, left: 0 }]).png().toBuffer();
}

test("diffImages finds the moved region between a before and after screenshot", async () => {
  const width = 200;
  const height = 150;
  const before = await solidWithSquare(width, height, { x: 10, y: 10, size: 30 });
  const after = await solidWithSquare(width, height, { x: 160, y: 110, size: 30 });

  const result = await diffImages(before, after);
  assert.equal(result.width, width);
  assert.equal(result.height, height);
  assert.ok(result.changedPixelPercent > 1, `expected a noticeable change, got ${result.changedPixelPercent}`);
  assert.ok(result.changedPixelPercent < 20, `expected a bounded change, got ${result.changedPixelPercent}`);
  assert.ok(result.regions.length >= 1);

  const nearTopLeft = result.regions.some((region) => region.x < 60 && region.y < 60);
  const nearBottomRight = result.regions.some((region) => region.x > 120 && region.y > 80);
  assert.ok(nearTopLeft, "expected a changed region near the vacated square");
  assert.ok(nearBottomRight, "expected a changed region near the new square position");
});

test("diffImages reports no change for identical images", async () => {
  const image = await solidWithSquare(120, 100, { x: 20, y: 20, size: 20 });
  const result = await diffImages(image, image);
  assert.equal(result.changedPixelPercent, 0);
  assert.deepEqual(result.regions, []);
});

test("composeBeforeAfter renders a side-by-side card sized for the source screenshots", async () => {
  const before = await solidWithSquare(100, 80, { x: 5, y: 5, size: 20 });
  const after = await solidWithSquare(100, 80, { x: 60, y: 40, size: 20 });
  const diff = await diffImages(before, after);

  const card = await composeBeforeAfter(before, after, diff.regions);
  const meta = await sharp(card).metadata();
  assert.equal(meta.format, "png");
  assert.ok((meta.width ?? 0) > 200, "expected a side-by-side layout wider than one panel");
  assert.ok((meta.height ?? 0) > 80, "expected room for the BEFORE/AFTER labels above the panels");
});

test("composeBeforeAfter still renders a valid card with no highlighted regions", async () => {
  const before = await solidWithSquare(80, 60, { x: 5, y: 5, size: 10 });
  const card = await composeBeforeAfter(before, before, []);
  const meta = await sharp(card).metadata();
  assert.equal(meta.format, "png");
});
