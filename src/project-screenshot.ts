import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { ProjectEntry } from "./types.js";

const execFileAsync = promisify(execFile);
const DEFAULT_VIEWPORT = { width: 1440, height: 1000 };

export interface ProjectScreenshot {
  image: Buffer;
  fileName: string;
  url: string;
}

export async function captureProjectScreenshot(project: ProjectEntry): Promise<ProjectScreenshot | undefined> {
  const urls = await findProjectWebUrls(project);

  for (const url of urls) {
    if (!(await canReach(url))) {
      continue;
    }

    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: DEFAULT_VIEWPORT });
      await page.goto(url, { waitUntil: "networkidle", timeout: 20_000 });
      const image = await page.screenshot({ type: "png", fullPage: false });
      return {
        image,
        fileName: `${sanitizeFilePart(project.name)}-ui-screenshot.png`,
        url
      };
    } finally {
      await browser.close();
    }
  }

  return undefined;
}

export async function findProjectWebUrls(project: ProjectEntry): Promise<string[]> {
  const configured = configuredProjectUrls(project);
  const detected = await detectRunningProjectWebUrls(project);
  return uniqueUrls([...configured, ...detected]);
}

export function detectLocalWebUrlsFromPs(psOutput: string, project: ProjectEntry): string[] {
  const root = path.resolve(project.root);
  const urls: string[] = [];

  for (const command of psOutput.split("\n")) {
    if (!command.includes(root)) {
      continue;
    }

    urls.push(...extractExplicitUrls(command));

    const port = detectKnownDevServerPort(command);
    if (port) {
      urls.push(localhostUrl(port));
    }
  }

  return uniqueUrls(urls);
}

async function detectRunningProjectWebUrls(project: ProjectEntry): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "command="], { maxBuffer: 2_000_000 });
    return detectLocalWebUrlsFromPs(stdout, project);
  } catch {
    return [];
  }
}

function configuredProjectUrls(project: ProjectEntry): string[] {
  const urls: string[] = [];
  const directUrl = process.env.PROJECT_SCREENSHOT_URL?.trim();
  if (directUrl) {
    urls.push(directUrl);
  }

  const rawMap = process.env.PROJECT_SCREENSHOT_URLS_JSON?.trim();
  if (!rawMap) {
    return urls;
  }

  try {
    const parsed = JSON.parse(rawMap) as Record<string, string>;
    const projectUrl = parsed[project.name]?.trim();
    if (projectUrl) {
      urls.push(projectUrl);
    }
  } catch {
    // Ignore bad optional screenshot configuration and fall back to process detection.
  }

  return urls;
}

function extractExplicitUrls(command: string): string[] {
  return [...command.matchAll(/\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/[^\s]*)?/gi)].map((match) =>
    normalizeLocalUrl(match[0] ?? "")
  );
}

function detectKnownDevServerPort(command: string): number | undefined {
  const normalized = command.toLowerCase();

  if (/\bnext(?:\.js)?\b/.test(normalized) && /\bdev\b/.test(normalized)) {
    return extractPort(command) ?? 3000;
  }

  if (/\bvite\b/.test(normalized)) {
    return extractPort(command) ?? 5173;
  }

  if (/\breact-scripts\b/.test(normalized) && /\bstart\b/.test(normalized)) {
    return extractPort(command) ?? 3000;
  }

  if (/\bastro\b/.test(normalized) && /\bdev\b/.test(normalized)) {
    return extractPort(command) ?? 4321;
  }

  if (/\bnuxt\b/.test(normalized) && /\bdev\b/.test(normalized)) {
    return extractPort(command) ?? 3000;
  }

  return undefined;
}

function extractPort(command: string): number | undefined {
  const portPatterns = [
    /(?:^|\s)-p\s+(\d{2,5})(?:\s|$)/,
    /(?:^|\s)--port(?:=|\s+)(\d{2,5})(?:\s|$)/,
    /(?:^|\s)PORT=(\d{2,5})(?:\s|$)/
  ];

  for (const pattern of portPatterns) {
    const match = command.match(pattern);
    const value = match?.[1] ? Number(match[1]) : undefined;
    if (value && value > 0 && value <= 65_535) {
      return value;
    }
  }

  return undefined;
}

async function canReach(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_000);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal
    });
    return response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function localhostUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function normalizeLocalUrl(url: string): string {
  return url.replace("localhost", "127.0.0.1").replace("[::1]", "127.0.0.1");
}

function uniqueUrls(urls: string[]): string[] {
  return [...new Set(urls.map((url) => normalizeLocalUrl(url.trim())).filter(Boolean))];
}

function sanitizeFilePart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}
