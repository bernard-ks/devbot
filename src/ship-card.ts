import sharp from "sharp";
import type { Size } from "./visual-diff.js";

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 675;

export interface ShipCardInput {
  projectName: string;
  summary: string;
  image?: Buffer;
  changedPercent?: number;
}

export function truncateShipSummary(text: string, maxLength = 140): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function containSize(source: Size, box: Size): Size {
  if (source.width <= 0 || source.height <= 0 || box.width <= 0 || box.height <= 0) {
    return { width: 0, height: 0 };
  }
  const scale = Math.min(box.width / source.width, box.height / source.height);
  return {
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale))
  };
}

const CARD_BACKGROUND = "#0f1115";
const CARD_PANEL = "#171a21";
const CARD_BORDER = "#303642";
const CARD_TEXT = "#f6f7fb";
const CARD_MUTED = "#8b93a3";
const CARD_ACCENT = "#5cc8ff";
const CARD_FONT = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
const HEADER_HEIGHT = 132;
const WORDMARK = "devbot";
const IMAGE_PADDING = 24;

export async function composeShipCard(input: ShipCardInput): Promise<Buffer> {
  const summary = truncateShipSummary(input.summary);
  const changedLabel =
    input.changedPercent === undefined ? undefined : `${input.changedPercent.toFixed(1)}% of the UI changed`;

  const imageAreaBox: Size = {
    width: CARD_WIDTH - IMAGE_PADDING * 2,
    height: CARD_HEIGHT - HEADER_HEIGHT - IMAGE_PADDING * 2
  };

  let compositeImage: { input: Buffer; left: number; top: number } | undefined;
  if (input.image) {
    const meta = await sharp(input.image).metadata();
    const fitted = containSize({ width: meta.width ?? imageAreaBox.width, height: meta.height ?? imageAreaBox.height }, imageAreaBox);
    const resized = await sharp(input.image).resize(fitted.width, fitted.height, { fit: "fill" }).png().toBuffer();
    compositeImage = {
      input: resized,
      left: Math.round((CARD_WIDTH - fitted.width) / 2),
      top: HEADER_HEIGHT + IMAGE_PADDING + Math.round((imageAreaBox.height - fitted.height) / 2)
    };
  }

  const background = Buffer.from(
    [
      `<svg width="${CARD_WIDTH}" height="${CARD_HEIGHT}" xmlns="http://www.w3.org/2000/svg">`,
      `<rect width="100%" height="100%" fill="${CARD_BACKGROUND}"/>`,
      `<rect x="0" y="0" width="100%" height="${HEADER_HEIGHT}" fill="${CARD_PANEL}"/>`,
      `<rect x="0" y="${HEADER_HEIGHT - 1}" width="100%" height="1" fill="${CARD_BORDER}"/>`,
      `<text x="40" y="52" fill="${CARD_TEXT}" font-family="${CARD_FONT}" font-size="30" font-weight="700">${escapeXml(input.projectName)}</text>`,
      `<text x="40" y="86" fill="${CARD_MUTED}" font-family="${CARD_FONT}" font-size="20">${escapeXml(summary)}</text>`,
      changedLabel
        ? `<text x="40" y="114" fill="${CARD_ACCENT}" font-family="${CARD_FONT}" font-size="18" font-weight="700">${escapeXml(changedLabel)}</text>`
        : "",
      compositeImage
        ? ""
        : `<text x="${CARD_WIDTH / 2}" y="${HEADER_HEIGHT + (CARD_HEIGHT - HEADER_HEIGHT) / 2}" fill="${CARD_MUTED}" font-family="${CARD_FONT}" font-size="18" text-anchor="middle">No screenshot captured for this task.</text>`,
      `<text x="${CARD_WIDTH - 24}" y="${CARD_HEIGHT - 20}" fill="${CARD_MUTED}" font-family="${CARD_FONT}" font-size="16" text-anchor="end">${WORDMARK}</text>`,
      "</svg>"
    ].join(""),
    "utf8"
  );

  const composites = compositeImage ? [compositeImage] : [];
  return sharp(background)
    .composite(composites)
    .png()
    .toBuffer();
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}
