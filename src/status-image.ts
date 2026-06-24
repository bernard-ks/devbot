import sharp from "sharp";

const WIDTH = 1200;
const HORIZONTAL_PADDING = 48;
const TOP_PADDING = 40;
const LINE_HEIGHT = 28;
const MAX_TEXT_WIDTH = 92;
const MAX_LINES = 34;

export async function renderStatusImage(text: string, title = "Devbot Status"): Promise<Buffer> {
  const lines = wrapText(text, MAX_TEXT_WIDTH).slice(0, MAX_LINES);
  const truncated = wrapText(text, MAX_TEXT_WIDTH).length > MAX_LINES;
  if (truncated) {
    lines[MAX_LINES - 1] = "...";
  }

  const height = TOP_PADDING + 52 + lines.length * LINE_HEIGHT + 48;
  const svg = [
    `<svg width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" xmlns="http://www.w3.org/2000/svg">`,
    "<rect width=\"100%\" height=\"100%\" fill=\"#0f1115\"/>",
    "<rect x=\"24\" y=\"24\" width=\"1152\" height=\"" + (height - 48) + "\" rx=\"14\" fill=\"#171a21\" stroke=\"#303642\"/>",
    `<text x="${HORIZONTAL_PADDING}" y="66" fill="#f6f7fb" font-family="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" font-size="24" font-weight="700">${escapeXml(title)}</text>`,
    `<text x="${HORIZONTAL_PADDING}" y="108" fill="#c8d0dc" font-family="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" font-size="18">`
  ];

  lines.forEach((line, index) => {
    svg.push(`<tspan x="${HORIZONTAL_PADDING}" dy="${index === 0 ? 0 : LINE_HEIGHT}">${escapeXml(line)}</tspan>`);
  });

  svg.push("</text></svg>");
  return sharp(Buffer.from(svg.join(""), "utf8")).png().toBuffer();
}

function wrapText(text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const rawLine of text.replace(/\r/g, "").split("\n")) {
    if (!rawLine) {
      lines.push("");
      continue;
    }

    let remaining = rawLine;
    while (remaining.length > maxWidth) {
      const breakAt = findBreakPoint(remaining, maxWidth);
      lines.push(remaining.slice(0, breakAt).trimEnd());
      remaining = remaining.slice(breakAt).trimStart();
    }

    lines.push(remaining);
  }

  return lines;
}

function findBreakPoint(value: string, maxWidth: number): number {
  const space = value.lastIndexOf(" ", maxWidth);
  return space > maxWidth * 0.5 ? space : maxWidth;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}
