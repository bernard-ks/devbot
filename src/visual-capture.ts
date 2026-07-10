import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { captureProjectScreenshot } from "./project-screenshot.js";
import { hardenPrivateDirectoryPermissions, PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE } from "./security.js";
import { isScreenshotBlocked, screenshotRequiresApproval } from "./safety.js";
import type { TaskRecord } from "./task-store.js";
import type { ProjectEntry } from "./types.js";

export const DEFAULT_CAPTURE_ROOT = path.resolve(".devbot", "captures");
const MAX_RETAINED_CAPTURES = 200;
const CAPTURE_FILE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,78}\.png$/i;

export function canAutoCaptureProject(project: ProjectEntry): boolean {
  return !isScreenshotBlocked(project) && !screenshotRequiresApproval(project);
}

export function captureFileName(taskId: string, suffix: string): string {
  return `${taskId}-${suffix}.png`;
}

/** Rejects anything but a plain, extensionless-traversal-free basename before it ever reaches a path.join. */
export function isSafeCaptureFileName(fileName: string): boolean {
  return (
    CAPTURE_FILE_NAME_PATTERN.test(fileName) &&
    !fileName.includes("..") &&
    !path.isAbsolute(fileName) &&
    fileName === path.basename(fileName)
  );
}

export interface ShipCaptureLive {
  isolated: false;
  image: Buffer;
}

export interface ShipCaptureUnavailable {
  isolated: true;
  branch?: string;
}

export type ShipImageResult = ShipCaptureLive | ShipCaptureUnavailable;

/**
 * `/ship` is the only remaining visual-evidence surface (see HANDOFF "Review
 * round 1"): action tasks always run in an isolated Git worktree
 * (task-worktree.ts), and Devbot has no managed preview of that isolated
 * workspace. The project's dev server only ever serves the source checkout,
 * so screenshotting it for an isolated task would misrepresent someone
 * else's (or no) change as this task's result. Isolated tasks therefore get
 * an explicit "unavailable" result instead of a screenshot attempt.
 */
export async function resolveShipImage(
  task: TaskRecord,
  project: ProjectEntry,
  captureRoot = DEFAULT_CAPTURE_ROOT
): Promise<ShipImageResult | undefined> {
  if (task.workspaceIsolated) {
    return { isolated: true, ...(task.branchName ? { branch: task.branchName } : {}) };
  }

  if (!canAutoCaptureProject(project)) {
    return undefined;
  }

  const live = await captureProjectScreenshot(project, { requestText: task.text }).catch(() => undefined);
  if (!live) {
    return undefined;
  }

  await persistShipCapture(task.id, live.image, captureRoot).catch((error) => {
    console.warn(`Unable to persist ship capture for task ${task.id}: ${(error as Error).message}`);
  });
  return { isolated: false, image: live.image };
}

async function persistShipCapture(taskId: string, image: Buffer, captureRoot = DEFAULT_CAPTURE_ROOT): Promise<void> {
  const fileName = captureFileName(taskId, "ship");
  if (!isSafeCaptureFileName(fileName)) {
    return;
  }

  await mkdir(captureRoot, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await hardenPrivateDirectoryPermissions(captureRoot);
  const targetPath = path.join(captureRoot, fileName);
  const tempPath = `${targetPath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(tempPath, image, { mode: PRIVATE_FILE_MODE });
  await rename(tempPath, targetPath);
  await pruneCaptures(captureRoot);
}

/** Caps `.devbot/captures` to the most recently written files; captured UI can contain sensitive product data and must not accumulate forever. */
export async function pruneCaptures(captureRoot = DEFAULT_CAPTURE_ROOT, maxRetained = MAX_RETAINED_CAPTURES): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(captureRoot);
  } catch {
    return;
  }

  const candidates = entries.filter((entry) => isSafeCaptureFileName(entry));
  const withStats = await Promise.all(
    candidates.map(async (name) => {
      try {
        const info = await stat(path.join(captureRoot, name));
        return { name, mtimeMs: info.mtimeMs };
      } catch {
        return undefined;
      }
    })
  );
  const sorted = withStats
    .filter((entry): entry is { name: string; mtimeMs: number } => Boolean(entry))
    .sort((a, b) => a.mtimeMs - b.mtimeMs);

  const excess = sorted.length - Math.max(0, maxRetained);
  for (let i = 0; i < excess; i++) {
    await rm(path.join(captureRoot, sorted[i]!.name), { force: true }).catch(() => undefined);
  }
}
