import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { captureProjectScreenshot, findProjectWebUrls, type ProjectScreenshot } from "./project-screenshot.js";
import { isScreenshotBlocked, screenshotRequiresApproval } from "./safety.js";
import type { TaskRecord } from "./task-store.js";
import type { ProjectEntry } from "./types.js";
import { composeBeforeAfter, diffImages, shouldAttachDiffCard } from "./visual-diff.js";

export const DEFAULT_CAPTURE_ROOT = path.resolve(".devbot", "captures");

export interface VisualCaptureSession {
  before: ProjectScreenshot;
}

export interface VisualCaptureMetadata {
  captureBeforeUrl: string;
  captureBeforeAt: string;
  captureAfterUrl: string;
  captureAfterAt: string;
  captureChangedPercent: number;
  captureAfterFile: string;
  captureCardFile?: string;
}

export interface VisualDiffOutcome {
  changedPercent: number;
  cardBuffer?: Buffer;
  cardFileName?: string;
  metadata: VisualCaptureMetadata;
}

export function canAutoCaptureProject(project: ProjectEntry): boolean {
  return !isScreenshotBlocked(project) && !screenshotRequiresApproval(project);
}

export function captureFileName(taskId: string, suffix: string): string {
  return `${taskId}-${suffix}.png`;
}

export async function beginVisualCapture(project: ProjectEntry, requestText: string): Promise<VisualCaptureSession | undefined> {
  if (!canAutoCaptureProject(project)) {
    return undefined;
  }

  const urls = await findProjectWebUrls(project);
  if (urls.length === 0) {
    return undefined;
  }

  const before = await captureProjectScreenshot(project, { requestText });
  return before ? { before } : undefined;
}

export async function finishVisualCapture(
  session: VisualCaptureSession,
  project: ProjectEntry,
  taskId: string,
  captureRoot = DEFAULT_CAPTURE_ROOT
): Promise<VisualDiffOutcome | undefined> {
  const after = await captureProjectScreenshot(project, { requestText: session.before.url });
  if (!after) {
    return undefined;
  }

  const diff = await diffImages(session.before.image, after.image);
  const afterFile = captureFileName(taskId, "after");
  await saveCaptureImage(afterFile, after.image, captureRoot);

  const metadata: VisualCaptureMetadata = {
    captureBeforeUrl: session.before.url,
    captureBeforeAt: session.before.metadata.capturedAt,
    captureAfterUrl: after.url,
    captureAfterAt: after.metadata.capturedAt,
    captureChangedPercent: diff.changedPixelPercent,
    captureAfterFile: afterFile
  };

  if (!shouldAttachDiffCard(diff.changedPixelPercent)) {
    return { changedPercent: diff.changedPixelPercent, metadata };
  }

  const cardBuffer = await composeBeforeAfter(session.before.image, after.image, diff.regions);
  const cardFile = captureFileName(taskId, "diff-card");
  await saveCaptureImage(cardFile, cardBuffer, captureRoot);

  return {
    changedPercent: diff.changedPixelPercent,
    cardBuffer,
    cardFileName: `devbot-visual-diff-${taskId}.png`,
    metadata: { ...metadata, captureCardFile: cardFile }
  };
}

export interface ShipImage {
  image: Buffer;
  changedPercent?: number;
  isLiveFallback: boolean;
}

export async function resolveShipImage(
  task: TaskRecord,
  project: ProjectEntry,
  captureRoot = DEFAULT_CAPTURE_ROOT
): Promise<ShipImage | undefined> {
  if (task.captureCardFile) {
    const image = await loadCaptureImage(task.captureCardFile, captureRoot);
    if (image) {
      return { image, isLiveFallback: false, ...(task.captureChangedPercent !== undefined ? { changedPercent: task.captureChangedPercent } : {}) };
    }
  }

  if (task.captureAfterFile) {
    const image = await loadCaptureImage(task.captureAfterFile, captureRoot);
    if (image) {
      return { image, isLiveFallback: false, ...(task.captureChangedPercent !== undefined ? { changedPercent: task.captureChangedPercent } : {}) };
    }
  }

  if (!canAutoCaptureProject(project)) {
    return undefined;
  }

  const live = await captureProjectScreenshot(project, { requestText: task.text }).catch(() => undefined);
  return live ? { image: live.image, isLiveFallback: true } : undefined;
}

async function saveCaptureImage(fileName: string, buffer: Buffer, captureRoot: string): Promise<void> {
  await mkdir(captureRoot, { recursive: true });
  const targetPath = path.join(captureRoot, fileName);
  const tempPath = `${targetPath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(tempPath, buffer);
  await rename(tempPath, targetPath);
}

async function loadCaptureImage(fileName: string, captureRoot: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path.join(captureRoot, fileName));
  } catch {
    return undefined;
  }
}
