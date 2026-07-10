import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Page } from "playwright";
import {
  bestNavigationCandidate,
  canReach,
  findProjectWebUrls,
  isAllowedScreenshotResource,
  projectScreenshotOrigins,
  sanitizeFilePart
} from "./project-screenshot.js";
import type { ProjectEntry } from "./types.js";

const execFileAsync = promisify(execFile);

export const CLIP_VIEWPORT = { width: 1280, height: 720 } as const;
export const CLIP_VIEWPORT_REDUCED = { width: 960, height: 540 } as const;
export const CLIP_MAX_DURATION_MS = 30_000;
export const CLIP_REDUCED_DURATION_MS = 18_000;
export const DISCORD_MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const CLIP_STEP_DWELL_MS = 1_500;
export const CLIP_MAX_STEPS = 4;
export const WATCH_MAX_FRAMES = 12;

export interface ProjectVideoMetadata {
  startUrl: string;
  finalUrl: string;
  durationMs: number;
  width: number;
  height: number;
  stepsPerformed: string[];
  consoleErrors: string[];
  transcoded: boolean;
}

export interface ProjectVideoResult {
  kind: "video";
  video: Buffer;
  fileName: string;
  metadata: ProjectVideoMetadata;
}

export interface ProjectVideoUnavailable {
  kind: "unavailable" | "screenshot-fallback";
  reason: string;
}

export type ProjectVideoOutcome = ProjectVideoResult | ProjectVideoUnavailable;

export interface RecordProjectFlowOptions {
  extraSteps?: string;
}

export async function recordProjectFlow(
  project: ProjectEntry,
  requestText: string,
  options: RecordProjectFlowOptions = {}
): Promise<ProjectVideoOutcome> {
  const urls = await findProjectWebUrls(project);
  if (urls.length === 0) {
    return { kind: "unavailable", reason: `No running local web UI detected for \`${project.name}\`.` };
  }

  const first = await recordAttempt(project, urls, requestText, options, CLIP_VIEWPORT, CLIP_MAX_DURATION_MS);
  if (!first) {
    return { kind: "unavailable", reason: `Could not reach a local web UI for \`${project.name}\`.` };
  }

  if (decideSizeCap(first.video.length, 1) === "accept") {
    return { kind: "video", video: first.video, fileName: first.fileName, metadata: first.metadata };
  }

  const second = await recordAttempt(project, urls, requestText, options, CLIP_VIEWPORT_REDUCED, CLIP_REDUCED_DURATION_MS);
  if (second && decideSizeCap(second.video.length, 2) === "accept") {
    return { kind: "video", video: second.video, fileName: second.fileName, metadata: second.metadata };
  }

  return {
    kind: "screenshot-fallback",
    reason: "The recorded flow exceeded Discord's attachment size limit even after shrinking the viewport and duration."
  };
}

export type SizeCapDecision = "accept" | "shrink" | "fallback";

export function decideSizeCap(byteLength: number, attempt: 1 | 2, maxBytes = DISCORD_MAX_ATTACHMENT_BYTES): SizeCapDecision {
  if (byteLength <= maxBytes) {
    return "accept";
  }
  return attempt === 1 ? "shrink" : "fallback";
}

export function deriveFlowSteps(requestText: string, extraSteps?: string, maxSteps = CLIP_MAX_STEPS): string[] {
  const combined = [requestText, extraSteps ?? ""].join(", ");
  const phrases = combined
    .split(/[,;\n]+|\bthen\b/i)
    .map((phrase) => phrase.trim())
    .filter((phrase) => phrase.length >= 3);

  const steps: string[] = [];
  for (const phrase of phrases) {
    if (!looksActionable(phrase)) {
      continue;
    }
    if (!steps.some((existing) => existing.toLowerCase() === phrase.toLowerCase())) {
      steps.push(phrase);
    }
    if (steps.length >= maxSteps) {
      break;
    }
  }

  return steps;
}

function looksActionable(phrase: string): boolean {
  return /\b(click|open|go to|navigate|scroll|type|select|submit|toggle|expand|press|tap|view|show)\b/i.test(phrase) || phrase.split(/\s+/).length <= 6;
}

export function isolatedProofNote(branch?: string): string {
  const branchPart = branch ? ` (branch \`${branch}\`)` : "";
  return `Proof capture skipped: this action ran in an isolated worktree${branchPart} whose changes are not served by the running dev server, so a recording would show the unchanged source app. Run \`/clip\` after the change is merged to record the live UI.`;
}

export function isUiRelatedTask(taskText: string, changedFiles: string[]): boolean {
  if (UI_TEXT_PATTERN.test(taskText)) {
    return true;
  }
  return changedFiles.some((file) => UI_PATH_PATTERN.test(file) || UI_DIR_PATTERN.test(file));
}

const UI_TEXT_PATTERN =
  /\b(ui|button|page|screen|component|css|style|styling|layout|frontend|front-end|modal|navbar|nav|form|click|scroll|responsive|theme|colou?r|design|animation|widget|dialog|menu|dropdown|tooltip|icon)\b/i;
const UI_PATH_PATTERN = /\.(tsx|jsx|vue|svelte|css|scss|sass|less|html)$/i;
const UI_DIR_PATTERN = /(^|\/)(components?|pages?|views?|screens?|widgets?|styles?|public|frontend|client|web)\//i;

export function selectRecentFrames<T>(frames: T[], maxFrames = WATCH_MAX_FRAMES): T[] {
  return frames.length <= maxFrames ? frames : frames.slice(frames.length - maxFrames);
}

export function pushBoundedFrame<T>(frames: T[], frame: T, maxFrames = WATCH_MAX_FRAMES): T[] {
  frames.push(frame);
  if (frames.length > maxFrames) {
    frames.splice(0, frames.length - maxFrames);
  }
  return frames;
}

export interface GifPageLayout {
  pages: number;
  pageWidth: number;
  pageHeight: number;
  canvasHeight: number;
}

export function computeGifPageLayout(
  frameCount: number,
  width: number,
  height: number,
  maxFrames = WATCH_MAX_FRAMES
): GifPageLayout {
  const pages = Math.max(0, Math.min(frameCount, maxFrames));
  return { pages, pageWidth: width, pageHeight: height, canvasHeight: pages * height };
}

const TIMELAPSE_FRAME_WIDTH = 640;
const TIMELAPSE_FRAME_HEIGHT = 360;
const TIMELAPSE_FRAME_DELAY_MS = 700;

export async function buildTimelapseGif(frames: Buffer[]): Promise<Buffer | undefined> {
  const recent = selectRecentFrames(frames);
  if (recent.length === 0) {
    return undefined;
  }

  const { default: sharp } = await import("sharp");
  const layout = computeGifPageLayout(recent.length, TIMELAPSE_FRAME_WIDTH, TIMELAPSE_FRAME_HEIGHT);
  const pages = await Promise.all(
    recent.map((frame) =>
      sharp(frame)
        .resize(TIMELAPSE_FRAME_WIDTH, TIMELAPSE_FRAME_HEIGHT, { fit: "cover" })
        .ensureAlpha()
        .raw()
        .toBuffer()
    )
  );

  return sharp(Buffer.concat(pages), {
    raw: { width: layout.pageWidth, height: layout.canvasHeight, channels: 4, pageHeight: layout.pageHeight },
    animated: true
  })
    .gif({ delay: TIMELAPSE_FRAME_DELAY_MS, loop: 0 })
    .toBuffer();
}

export async function listChangedFiles(project: ProjectEntry): Promise<string[]> {
  try {
    const [{ stdout: tracked }, { stdout: untracked }] = await Promise.all([
      execFileAsync("git", ["-C", project.root, "diff", "--name-only", "HEAD"]),
      execFileAsync("git", ["-C", project.root, "ls-files", "--others", "--exclude-standard"])
    ]);
    return uniqueNonEmpty([...tracked.split("\n"), ...untracked.split("\n")]);
  } catch {
    return [];
  }
}

export async function ffmpegAvailable(): Promise<boolean> {
  try {
    await execFileAsync("ffmpeg", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

interface RecordAttemptResult {
  video: Buffer;
  fileName: string;
  metadata: ProjectVideoMetadata;
}

async function recordAttempt(
  project: ProjectEntry,
  urls: string[],
  requestText: string,
  options: RecordProjectFlowOptions,
  size: { width: number; height: number },
  maxDurationMs: number
): Promise<RecordAttemptResult | undefined> {
  const steps = deriveFlowSteps(requestText, options.extraSteps);
  const startedAt = Date.now();
  const allowedOrigins = projectScreenshotOrigins(project, urls);

  for (const startUrl of urls) {
    if (!(await canReach(startUrl, allowedOrigins))) {
      continue;
    }

    const videoDir = await mkdtemp(path.join(tmpdir(), "devbot-clip-"));
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: size, recordVideo: { dir: videoDir, size } });
      const page = await context.newPage();
      await page.route("**/*", async (route) => {
        if (isAllowedScreenshotResource(route.request().url(), allowedOrigins)) {
          await route.continue();
        } else {
          await route.abort("blockedbyclient");
        }
      });
      const consoleErrors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") {
          consoleErrors.push(truncate(message.text(), 220));
        }
      });

      await page.goto(startUrl, { waitUntil: "networkidle", timeout: 20_000 });
      if (!isAllowedScreenshotResource(page.url(), allowedOrigins)) {
        await context.close();
        continue;
      }
      await page.waitForTimeout(CLIP_STEP_DWELL_MS);

      const stepsPerformed: string[] = [];
      const deadline = startedAt + maxDurationMs - 3_000;
      for (const step of steps) {
        if (Date.now() >= deadline) {
          break;
        }
        const performed = await performFlowStep(page, step);
        if (performed) {
          stepsPerformed.push(step);
        }
        if (!isAllowedScreenshotResource(page.url(), allowedOrigins)) {
          break;
        }
        await page.waitForTimeout(CLIP_STEP_DWELL_MS);
      }

      const finalUrl = page.url();
      const videoHandle = page.video();
      await context.close();
      if (!videoHandle) {
        continue;
      }

      const videoPath = await videoHandle.path();
      let video = await readFile(videoPath);
      let transcoded = false;
      if (await ffmpegAvailable()) {
        const mp4 = await transcodeToMp4(videoPath).catch(() => undefined);
        if (mp4) {
          video = mp4;
          transcoded = true;
        }
      }

      return {
        video,
        fileName: `${sanitizeFilePart(project.name)}-clip.${transcoded ? "mp4" : "webm"}`,
        metadata: {
          startUrl,
          finalUrl,
          durationMs: Date.now() - startedAt,
          width: size.width,
          height: size.height,
          stepsPerformed,
          consoleErrors,
          transcoded
        }
      };
    } finally {
      await browser.close();
      await rm(videoDir, { recursive: true, force: true });
    }
  }

  return undefined;
}

async function performFlowStep(page: Page, step: string): Promise<boolean> {
  if (/\bscroll\b/i.test(step)) {
    const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
    await page.mouse.wheel(0, Math.round(viewport.height * 0.8));
    return true;
  }

  const clickable = page.locator("a, button, [role='link'], [role='button'], input[type='submit']");
  const candidates = await clickable.evaluateAll((elements) =>
    elements
      .map((element, index) => {
        const rect = element.getBoundingClientRect();
        const style = element.ownerDocument.defaultView?.getComputedStyle(element);
        const href = element.getAttribute("href") ?? element.getAttribute("data-href") ?? "";
        const text = [element.textContent ?? "", element.getAttribute("aria-label") ?? "", element.getAttribute("title") ?? "", href].join(
          " "
        );
        return {
          index,
          text,
          href,
          visible: rect.width > 0 && rect.height > 0 && style?.visibility !== "hidden" && style?.display !== "none"
        };
      })
      .filter((candidate) => candidate.visible)
      .map(({ index, text, href }) => ({ index, text, href }))
  );

  const target = bestNavigationCandidate(candidates, step);
  if (!target) {
    return false;
  }

  await clickable
    .nth(target.index)
    .click({ timeout: 5_000 })
    .catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
  return true;
}

async function transcodeToMp4(webmPath: string) {
  const outPath = `${webmPath}.mp4`;
  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-i",
      webmPath,
      "-movflags",
      "+faststart",
      "-pix_fmt",
      "yuv420p",
      outPath
    ]);
    return await readFile(outPath);
  } finally {
    await rm(outPath, { force: true });
  }
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function truncate(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact;
}
