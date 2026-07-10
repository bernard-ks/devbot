import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { Page } from "playwright";
import { minimalChildEnvironment } from "./security.js";
import type { ProjectEntry } from "./types.js";

const execFileAsync = promisify(execFile);
const DEFAULT_VIEWPORT = { width: 1440, height: 1000 };
const MAX_CONCURRENT_SCREENSHOTS = 2;
const STABILITY_ATTEMPTS = 3;
const STABILITY_INTERVAL_MS = 200;
const DISABLE_MOTION_STYLE = [
  "*, *::before, *::after {",
  "  animation-play-state: paused !important;",
  "  animation-delay: 0s !important;",
  "  animation-duration: 0s !important;",
  "  transition-delay: 0s !important;",
  "  transition-duration: 0s !important;",
  "  caret-color: transparent !important;",
  "  scroll-behavior: auto !important;",
  "}"
].join("\n");
let activeScreenshots = 0;
const VIEWPORTS = {
  desktop: DEFAULT_VIEWPORT,
  tablet: { width: 820, height: 1180 },
  mobile: { width: 390, height: 844 }
} as const;

export interface ProjectScreenshot {
  image: Buffer;
  fileName: string;
  url: string;
  metadata: ProjectScreenshotMetadata;
}

export interface ProjectScreenshotMetadata {
  startUrl: string;
  finalUrl: string;
  viewport: keyof typeof VIEWPORTS;
  capturedAt: string;
  consoleErrors: string[];
  failedRequests: string[];
  badResponses: string[];
}

export interface ProjectScreenshotOptions {
  requestText?: string;
  viewport?: keyof typeof VIEWPORTS;
}

export async function captureProjectScreenshot(
  project: ProjectEntry,
  options: ProjectScreenshotOptions = {}
): Promise<ProjectScreenshot | undefined> {
  if (activeScreenshots >= MAX_CONCURRENT_SCREENSHOTS) {
    throw new Error("Devbot is at its screenshot execution limit. Try again after an active capture finishes.");
  }
  activeScreenshots += 1;
  try {
    const target = parseExplicitScreenshotTarget(options.requestText ?? "");
    const projectUrls = await findProjectWebUrls(project);
    const allowedOrigins = projectScreenshotOrigins(project, projectUrls);
    const urls = target.url
      ? (isApprovedProjectScreenshotUrl(target.url, projectUrls) ? [target.url] : [])
      : projectUrls;
    const viewportName = options.viewport ?? "desktop";
    const viewport = VIEWPORTS[viewportName];

    for (const url of urls) {
      const startUrl = target.path ? withPath(url, target.path) : url;
      if (!isAllowedScreenshotResource(startUrl, allowedOrigins) || !(await canReach(startUrl, allowedOrigins))) {
        continue;
      }

      const { chromium } = await import("playwright");
      const browser = await chromium.launch({ headless: true, env: definedEnvironment(minimalChildEnvironment()) });
      try {
        const page = await browser.newPage({ viewport });
        await page.route("**/*", async (route) => {
          if (isAllowedScreenshotResource(route.request().url(), allowedOrigins)) {
            await route.continue();
          } else {
            await route.abort("blockedbyclient");
          }
        });
        const diagnostics = collectScreenshotDiagnostics(page);
        await page.emulateMedia({ reducedMotion: "reduce" }).catch(() => undefined);
        await page.goto(startUrl, { waitUntil: "networkidle", timeout: 20_000 });
        if (!isAllowedScreenshotResource(page.url(), allowedOrigins)) {
          continue;
        }
        if (!target.path && !target.url) {
          await navigateByVisibleUi(page, options.requestText ?? "");
        }
        await freezeDynamicUi(page);

        const image = await captureStableScreenshot(page);
        const finalUrl = safeReportedUrl(page.url());
        return {
          image,
          fileName: `${sanitizeFilePart(project.name)}-${sanitizeFilePart(new URL(finalUrl).pathname || "home")}-screenshot.png`,
          url: finalUrl,
          metadata: {
            startUrl,
            finalUrl,
            viewport: viewportName,
            capturedAt: new Date().toISOString(),
            consoleErrors: diagnostics.consoleErrors,
            failedRequests: diagnostics.failedRequests,
            badResponses: diagnostics.badResponses
          }
        };
      } finally {
        await browser.close();
      }
    }

    return undefined;
  } finally {
    activeScreenshots = Math.max(0, activeScreenshots - 1);
  }
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

    const port = detectKnownDevServerPort(command);
    if (port) {
      urls.push(localhostUrl(port));
    }
  }

  return uniqueUrls(urls);
}

async function detectRunningProjectWebUrls(project: ProjectEntry): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "command="], {
      env: minimalChildEnvironment(),
      maxBuffer: 2_000_000
    });
    return detectLocalWebUrlsFromPs(stdout, project);
  } catch {
    return [];
  }
}

function configuredProjectUrls(project: ProjectEntry): string[] {
  const urls: string[] = [];
  if (project.metadata.frontendUrl) {
    urls.push(project.metadata.frontendUrl);
  }

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

function collectScreenshotDiagnostics(page: Page): {
  consoleErrors: string[];
  failedRequests: string[];
  badResponses: string[];
} {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  const badResponses: string[] = [];

  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(truncateDiagnostic(message.text()));
    }
  });

  page.on("requestfailed", (request) => {
    failedRequests.push(truncateDiagnostic(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`.trim()));
  });

  page.on("response", (response) => {
    if (response.status() >= 400) {
      badResponses.push(truncateDiagnostic(`${response.status()} ${response.url()}`));
    }
  });

  return { consoleErrors, failedRequests, badResponses };
}

async function freezeDynamicUi(page: Page): Promise<void> {
  await page.addStyleTag({ content: DISABLE_MOTION_STYLE }).catch(() => undefined);
}

/**
 * Loading spinners, blinking carets, and async layout shifts can make a
 * single screenshot land mid-transition. Captures repeatedly until two
 * consecutive frames come back byte-identical (or the attempt budget runs
 * out), so a diff against this screenshot reflects real content, not timing.
 */
async function captureStableScreenshot(page: Page): Promise<Buffer> {
  let previous = await page.screenshot({ type: "png", fullPage: false });
  for (let attempt = 1; attempt < STABILITY_ATTEMPTS; attempt++) {
    await page.waitForTimeout(STABILITY_INTERVAL_MS);
    const next = await page.screenshot({ type: "png", fullPage: false });
    if (next.equals(previous)) {
      return next;
    }
    previous = next;
  }
  return previous;
}

export interface NavigationCandidate {
  index: number;
  text: string;
  href: string;
}

export interface ScoredNavigationCandidate extends NavigationCandidate {
  score: number;
}

export function extractScreenshotKeywords(requestText: string): string[] {
  const normalized = requestText.toLowerCase().replace(/[^a-z0-9/_-]+/g, " ");
  return uniqueWords(
    normalized
      .split(/\s+/)
      .map((word) => word.trim().replace(/^\/+|\/+$/g, ""))
      .filter((word) => word.length >= 3 && !SCREENSHOT_STOP_WORDS.has(word) && !word.includes("/"))
  ).slice(0, 8);
}

export function bestNavigationCandidate(
  candidates: NavigationCandidate[],
  requestText: string
): ScoredNavigationCandidate | undefined {
  const keywords = extractScreenshotKeywords(requestText);
  if (keywords.length === 0) {
    return undefined;
  }

  let best: ScoredNavigationCandidate | undefined;
  for (const candidate of candidates) {
    const haystack = normalizeForMatch(`${candidate.text} ${candidate.href}`);
    const score = keywords.reduce((total, keyword) => {
      if (wordInText(haystack, keyword)) {
        return total + 5;
      }

      if (haystack.includes(keyword)) {
        return total + 2;
      }

      return total;
    }, 0);

    if (score > 0 && (!best || score > best.score)) {
      best = { ...candidate, score };
    }
  }

  return best && best.score >= 5 ? best : undefined;
}

async function navigateByVisibleUi(page: Page, requestText: string): Promise<void> {
  const clickable = page.locator("a, button, [role='link'], [role='button']");
  const candidates = await clickable.evaluateAll((elements) =>
    elements
      .map((element, index) => {
        const rect = element.getBoundingClientRect();
        const style = element.ownerDocument.defaultView?.getComputedStyle(element);
        const href = element.getAttribute("href") ?? element.getAttribute("data-href") ?? "";
        const text = [
          element.textContent ?? "",
          element.getAttribute("aria-label") ?? "",
          element.getAttribute("title") ?? "",
          href
        ].join(" ");

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
  const target = bestNavigationCandidate(candidates, requestText);
  if (!target) {
    return;
  }

  await clickable.nth(target.index).click({ timeout: 5_000 });
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
}

interface ExplicitScreenshotTarget {
  url?: string;
  path?: string;
}

function parseExplicitScreenshotTarget(requestText: string): ExplicitScreenshotTarget {
  const explicitUrl = requestText.match(/\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/[^\s]*)?/i)?.[0];
  if (explicitUrl) {
    const normalized = normalizeProjectUrl(explicitUrl);
    return normalized ? { url: normalized } : {};
  }

  const explicitPath = extractExplicitPath(requestText);
  if (explicitPath) {
    return { path: explicitPath };
  }

  return {};
}

function extractExplicitPath(text: string): string | undefined {
  const match = text.match(/(?:^|\s)(\/[a-z0-9][a-z0-9/_-]*)(?:\s|$|[,.?!])/i);
  if (!match?.[1]) {
    return undefined;
  }

  return normalizeRoutePath(match[1]);
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

async function canReach(url: string, allowedOrigins: ReadonlySet<string>): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_000);

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return false;
      const redirected = new URL(location, url).toString();
      return isAllowedScreenshotResource(redirected, allowedOrigins);
    }
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
  return normalizeProjectUrl(url) ?? "";
}

function uniqueUrls(urls: string[]): string[] {
  return [...new Set(urls.map((url) => normalizeProjectUrl(url)).filter((url): url is string => Boolean(url)))];
}

function uniqueWords(words: string[]): string[] {
  return [...new Set(words)];
}

function withPath(baseUrl: string, routePath: string): string {
  const url = new URL(normalizeLocalUrl(baseUrl));
  url.pathname = normalizeRoutePath(routePath);
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, url.pathname === "/" ? "/" : "");
}

export function isApprovedProjectScreenshotUrl(candidate: string, projectUrls: readonly string[]): boolean {
  const normalized = normalizeProjectUrl(candidate);
  if (!normalized) return false;
  const candidateOrigin = new URL(normalized).origin;
  return projectUrls.some((value) => {
    const approved = normalizeProjectUrl(value);
    return Boolean(approved && new URL(approved).origin === candidateOrigin);
  });
}

function projectScreenshotOrigins(project: ProjectEntry, projectUrls: readonly string[]): Set<string> {
  const values = [...projectUrls, project.metadata.backendUrl ?? ""];
  return new Set(
    values
      .map((value) => normalizeProjectUrl(value))
      .filter((value): value is string => Boolean(value))
      .map((value) => new URL(value).origin)
  );
}

function isAllowedScreenshotResource(value: string, allowedOrigins: ReadonlySet<string>): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "data:" || url.protocol === "blob:" || url.protocol === "about:") return true;
    return (url.protocol === "http:" || url.protocol === "https:")
      && !url.username
      && !url.password
      && isLoopbackHost(url.hostname)
      && allowedOrigins.has(url.origin);
  } catch {
    return false;
  }
}

function normalizeProjectUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || !isLoopbackHost(url.hostname)) {
      return undefined;
    }
    if (url.hostname === "localhost" || url.hostname === "[::1]") url.hostname = "127.0.0.1";
    url.hash = "";
    return url.toString().replace(/\/$/, url.pathname === "/" ? "" : "/");
  } catch {
    return undefined;
  }
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function safeReportedUrl(value: string): string {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function definedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

function normalizeRoutePath(routePath: string): string {
  const cleaned = routePath.trim().replace(/\/+/g, "/").replace(/\/$/, "");
  return cleaned && cleaned !== "/" ? cleaned : "/";
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function wordInText(text: string, word: string): boolean {
  return new RegExp(`(?:^| )${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?: |$)`).test(text);
}

function sanitizeFilePart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

function truncateDiagnostic(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 220 ? `${compact.slice(0, 217)}...` : compact;
}

const SCREENSHOT_STOP_WORDS = new Set([
  "about",
  "attach",
  "can",
  "current",
  "cna",
  "dev",
  "front",
  "frontend",
  "give",
  "image",
  "main",
  "need",
  "output",
  "page",
  "pic",
  "picture",
  "please",
  "project",
  "projects",
  "screen",
  "screenshot",
  "send",
  "show",
  "snip",
  "state",
  "status",
  "the",
  "this",
  "view",
  "want",
  "what",
  "whats",
  "working",
  "you"
]);
