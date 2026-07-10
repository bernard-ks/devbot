import sharp from "sharp";

export interface DiffRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DiffResult {
  width: number;
  height: number;
  changedPixelPercent: number;
  regions: DiffRegion[];
}

export interface DiffImagesOptions {
  pixelThreshold?: number;
  gridCellSize?: number;
  cellChangeRatio?: number;
}

export interface Size {
  width: number;
  height: number;
}

export const DEFAULT_PIXEL_THRESHOLD = 40;
export const DEFAULT_GRID_CELL_SIZE = 24;
export const DEFAULT_CELL_CHANGE_RATIO = 0.12;
export const DEFAULT_DIFF_ATTACH_THRESHOLD_PERCENT = 0.5;

export function commonCanvasSize(a: Size, b: Size): Size {
  return {
    width: Math.max(0, Math.min(a.width, b.width)),
    height: Math.max(0, Math.min(a.height, b.height))
  };
}

export function shouldAttachDiffCard(changedPixelPercent: number, threshold = DEFAULT_DIFF_ATTACH_THRESHOLD_PERCENT): boolean {
  return changedPixelPercent >= threshold;
}

export function clusterChangedCells(
  grid: boolean[][],
  cellWidth: number,
  cellHeight: number,
  imageWidth?: number,
  imageHeight?: number
): DiffRegion[] {
  const rows = grid.length;
  const cols = rows > 0 ? grid[0]!.length : 0;
  const maxWidth = imageWidth ?? cols * cellWidth;
  const maxHeight = imageHeight ?? rows * cellHeight;
  const visited = grid.map((row) => row.map(() => false));
  const regions: DiffRegion[] = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!grid[r]![c] || visited[r]![c]) {
        continue;
      }

      let minR = r;
      let maxR = r;
      let minC = c;
      let maxC = c;
      const stack: [number, number][] = [[r, c]];
      visited[r]![c] = true;

      while (stack.length > 0) {
        const [cr, cc] = stack.pop()!;
        minR = Math.min(minR, cr);
        maxR = Math.max(maxR, cr);
        minC = Math.min(minC, cc);
        maxC = Math.max(maxC, cc);

        const neighbors: [number, number][] = [
          [cr - 1, cc],
          [cr + 1, cc],
          [cr, cc - 1],
          [cr, cc + 1]
        ];
        for (const [nr, nc] of neighbors) {
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && grid[nr]![nc] && !visited[nr]![nc]) {
            visited[nr]![nc] = true;
            stack.push([nr, nc]);
          }
        }
      }

      const x = minC * cellWidth;
      const y = minR * cellHeight;
      regions.push({
        x,
        y,
        width: Math.min((maxC + 1) * cellWidth, maxWidth) - x,
        height: Math.min((maxR + 1) * cellHeight, maxHeight) - y
      });
    }
  }

  return regions;
}

export async function diffImages(beforePng: Buffer, afterPng: Buffer, options: DiffImagesOptions = {}): Promise<DiffResult> {
  const [beforeMeta, afterMeta] = await Promise.all([sharp(beforePng).metadata(), sharp(afterPng).metadata()]);
  const size = commonCanvasSize(
    { width: beforeMeta.width ?? 0, height: beforeMeta.height ?? 0 },
    { width: afterMeta.width ?? 0, height: afterMeta.height ?? 0 }
  );

  if (size.width === 0 || size.height === 0) {
    return { width: 0, height: 0, changedPixelPercent: 0, regions: [] };
  }

  const [beforeRaw, afterRaw] = await Promise.all([
    sharp(beforePng).resize(size.width, size.height, { fit: "fill" }).ensureAlpha().raw().toBuffer(),
    sharp(afterPng).resize(size.width, size.height, { fit: "fill" }).ensureAlpha().raw().toBuffer()
  ]);

  const pixelThreshold = options.pixelThreshold ?? DEFAULT_PIXEL_THRESHOLD;
  const cellSize = options.gridCellSize ?? DEFAULT_GRID_CELL_SIZE;
  const cellRatio = options.cellChangeRatio ?? DEFAULT_CELL_CHANGE_RATIO;

  const cols = Math.ceil(size.width / cellSize);
  const rows = Math.ceil(size.height / cellSize);
  const cellChangedCounts: number[][] = Array.from({ length: rows }, () => new Array(cols).fill(0) as number[]);
  const cellTotalCounts: number[][] = Array.from({ length: rows }, () => new Array(cols).fill(0) as number[]);

  let changedPixels = 0;
  const totalPixels = size.width * size.height;

  for (let y = 0; y < size.height; y++) {
    const cellRow = Math.floor(y / cellSize);
    const totalRow = cellTotalCounts[cellRow]!;
    const changedRow = cellChangedCounts[cellRow]!;
    for (let x = 0; x < size.width; x++) {
      const cellCol = Math.floor(x / cellSize);
      const idx = (y * size.width + x) * 4;
      const diff =
        Math.abs(beforeRaw[idx]! - afterRaw[idx]!) +
        Math.abs(beforeRaw[idx + 1]! - afterRaw[idx + 1]!) +
        Math.abs(beforeRaw[idx + 2]! - afterRaw[idx + 2]!);

      totalRow[cellCol] = (totalRow[cellCol] ?? 0) + 1;
      if (diff > pixelThreshold) {
        changedPixels += 1;
        changedRow[cellCol] = (changedRow[cellCol] ?? 0) + 1;
      }
    }
  }

  const grid = cellChangedCounts.map((rowCounts, r) =>
    rowCounts.map((count, c) => count / cellTotalCounts[r]![c]! >= cellRatio)
  );
  const regions = clusterChangedCells(grid, cellSize, cellSize, size.width, size.height);

  return {
    width: size.width,
    height: size.height,
    changedPixelPercent: totalPixels === 0 ? 0 : (changedPixels / totalPixels) * 100,
    regions
  };
}

const CARD_BACKGROUND = "#0f1115";
const CARD_LABEL_COLOR = "#f6f7fb";
const CARD_HIGHLIGHT_COLOR = "#ff5c5c";
const CARD_FONT = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
const MAX_PANEL_WIDTH = 560;

export async function composeBeforeAfter(before: Buffer, after: Buffer, regions: DiffRegion[]): Promise<Buffer> {
  const [beforeMeta, afterMeta] = await Promise.all([sharp(before).metadata(), sharp(after).metadata()]);
  const size = commonCanvasSize(
    { width: beforeMeta.width ?? 0, height: beforeMeta.height ?? 0 },
    { width: afterMeta.width ?? 0, height: afterMeta.height ?? 0 }
  );
  const scale = size.width > 0 ? Math.min(1, MAX_PANEL_WIDTH / size.width) : 1;
  const panelWidth = Math.max(1, Math.round(size.width * scale));
  const panelHeight = Math.max(1, Math.round(size.height * scale));

  const [beforeResized, afterResized] = await Promise.all([
    sharp(before).resize(panelWidth, panelHeight, { fit: "fill" }).png().toBuffer(),
    sharp(after).resize(panelWidth, panelHeight, { fit: "fill" }).png().toBuffer()
  ]);

  const highlightRects = regions
    .map((region) => {
      const rx = Math.round(region.x * scale);
      const ry = Math.round(region.y * scale);
      const rw = Math.max(1, Math.round(region.width * scale));
      const rh = Math.max(1, Math.round(region.height * scale));
      return `<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="none" stroke="${CARD_HIGHLIGHT_COLOR}" stroke-width="3" rx="4"/>`;
    })
    .join("");

  const afterWithHighlights =
    regions.length > 0
      ? await sharp(afterResized)
          .composite([
            {
              input: Buffer.from(`<svg width="${panelWidth}" height="${panelHeight}" xmlns="http://www.w3.org/2000/svg">${highlightRects}</svg>`),
              top: 0,
              left: 0
            }
          ])
          .png()
          .toBuffer()
      : afterResized;

  const padding = 24;
  const gap = 16;
  const labelHeight = 36;
  const canvasWidth = padding * 2 + panelWidth * 2 + gap;
  const canvasHeight = padding * 2 + labelHeight + panelHeight;
  const afterLeft = padding + panelWidth + gap;

  const background = Buffer.from(
    [
      `<svg width="${canvasWidth}" height="${canvasHeight}" xmlns="http://www.w3.org/2000/svg">`,
      `<rect width="100%" height="100%" fill="${CARD_BACKGROUND}"/>`,
      `<text x="${padding}" y="${padding + 22}" fill="${CARD_LABEL_COLOR}" font-family="${CARD_FONT}" font-size="20" font-weight="700">BEFORE</text>`,
      `<text x="${afterLeft}" y="${padding + 22}" fill="${CARD_LABEL_COLOR}" font-family="${CARD_FONT}" font-size="20" font-weight="700">AFTER</text>`,
      "</svg>"
    ].join(""),
    "utf8"
  );

  return sharp(background)
    .composite([
      { input: beforeResized, left: padding, top: padding + labelHeight },
      { input: afterWithHighlights, left: afterLeft, top: padding + labelHeight }
    ])
    .png()
    .toBuffer();
}
