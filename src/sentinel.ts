import { createHash } from "node:crypto";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { isLoopbackHost, projectScreenshotOrigins } from "./project-screenshot.js";
import { redactSensitiveText } from "./security.js";
import { configuredCommandNames, runConfiguredProjectCommand } from "./command-runner.js";
import { commandRequiresApproval, isScreenshotBlocked, screenshotRequiresApproval } from "./safety.js";
import {
  DEBOUNCE_THRESHOLD,
  defaultExpectedStatus,
  expectedStatusPredicate,
  SentinelStore,
  type SentinelProjectConfig,
  type WatchKind,
  type WatchState
} from "./sentinel-store.js";
import type { ProjectEntry } from "./types.js";

const execAsync = promisify(exec);
const MAX_REDIRECTS = 5;

export interface WatchCheckResult {
  reachable: boolean;
  ok: boolean;
  statusCode?: number;
  exitCode?: number;
  responseTimeMs?: number;
  error?: string;
}

export interface WatchTarget {
  id: string;
  kind: WatchKind;
  target: string;
}

export interface WatchTransitionResult {
  state: WatchState;
  event: "alert" | "recovery" | undefined;
}

export function initialWatchState(target: WatchTarget): WatchState {
  return { id: target.id, kind: target.kind, target: target.target, status: "unknown", consecutiveFailures: 0 };
}

export function applyWatchCheck(
  previous: WatchState,
  result: WatchCheckResult,
  now: string,
  debounceThreshold = DEBOUNCE_THRESHOLD
): WatchTransitionResult {
  const code = result.statusCode ?? result.exitCode;

  if (result.ok) {
    const wasDown = previous.status === "down";
    const { lastError: _droppedLastError, ...rest } = previous;
    return {
      state: {
        ...rest,
        status: "up",
        consecutiveFailures: 0,
        lastCheckAt: now,
        lastOkAt: now,
        ...(code !== undefined ? { lastCode: code } : {})
      },
      event: wasDown ? "recovery" : undefined
    };
  }

  // Both a reachable-but-erroring response (e.g. HTTP 5xx, a failing command)
  // and a network refusal (the process is gone) are failures, and a target
  // that crashed after being healthy is exactly the regression this feature
  // exists to catch. A target that has never been observed healthy (unknown,
  // or already idle) has nothing to regress from yet: it stays idle without
  // accumulating failures or alerting. That is also how an intentional stop
  // avoids spurious alerts — the user disables the watch (`/sentinel off`)
  // rather than relying on the sentinel to guess intent from a refusal.
  if (previous.status === "unknown" || previous.status === "idle") {
    return {
      state: {
        ...previous,
        status: "idle",
        consecutiveFailures: 0,
        lastCheckAt: now,
        ...(code !== undefined ? { lastCode: code } : {}),
        ...(result.error !== undefined ? { lastError: result.error } : {})
      },
      event: undefined
    };
  }

  const consecutiveFailures = previous.consecutiveFailures + 1;
  const shouldAlert = consecutiveFailures >= debounceThreshold && previous.status !== "down";
  return {
    state: {
      ...previous,
      status: shouldAlert ? "down" : previous.status,
      consecutiveFailures,
      lastCheckAt: now,
      ...(code !== undefined ? { lastCode: code } : {}),
      ...(result.error !== undefined ? { lastError: result.error } : {})
    },
    event: shouldAlert ? "alert" : undefined
  };
}

export interface CheckUrlOptions {
  timeoutMs?: number;
  isExpectedStatus?: (statusCode: number) => boolean;
  fetchImpl?: typeof fetch;
  maxRedirects?: number;
}

/**
 * Fetches a watch URL with the same SSRF posture as the screenshot subsystem:
 * every hop (the initial request and any redirect target) must resolve to a
 * loopback host inside the project's approved origin set, credentials in the
 * URL are never sent, and redirects are followed manually so a hop to an
 * unapproved origin is rejected rather than silently followed by `fetch`.
 */
export async function checkUrl(
  url: string,
  allowedOrigins: ReadonlySet<string>,
  options: CheckUrlOptions = {}
): Promise<WatchCheckResult> {
  const {
    timeoutMs = 5_000,
    isExpectedStatus = defaultExpectedStatus,
    fetchImpl = fetch,
    maxRedirects = MAX_REDIRECTS
  } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    let currentUrl = url;
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      if (!isApprovedWatchOrigin(currentUrl, allowedOrigins)) {
        return {
          reachable: true,
          ok: false,
          error: `Blocked request to a non-approved origin: ${safeOrigin(currentUrl)}`
        };
      }

      const response = await fetchImpl(currentUrl, { method: "GET", redirect: "manual", signal: controller.signal });
      // The sentinel only needs the status line and (for redirects) the location
      // header; it never reads the body. Discard it explicitly on every hop so a
      // recurring poll cannot leak sockets by leaving response bodies unconsumed.
      await discardResponseBody(response);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          return { reachable: true, ok: false, statusCode: response.status, error: "Redirect response had no location header." };
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      return {
        reachable: true,
        ok: isExpectedStatus(response.status),
        statusCode: response.status,
        responseTimeMs: Date.now() - startedAt
      };
    }
    return { reachable: true, ok: false, error: "Too many redirects." };
  } catch (error) {
    return {
      reachable: false,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timer);
  }
}

function isApprovedWatchOrigin(value: string, allowedOrigins: ReadonlySet<string>): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return false;
    }
    if (url.username || url.password) {
      return false;
    }
    if (!isLoopbackHost(url.hostname)) {
      return false;
    }
    return allowedOrigins.has(url.origin);
  } catch {
    return false;
  }
}

/**
 * Releases a fetch response's body so the underlying connection is returned to
 * the pool (or closed) instead of being held open. Tolerates responses whose
 * body is absent or already consumed, including lightweight fetch mocks used in
 * tests. Prefers cancelling the stream (no buffering); falls back to draining.
 */
async function discardResponseBody(response: { body?: unknown; arrayBuffer?: () => Promise<unknown> }): Promise<void> {
  try {
    const body = response.body as { cancel?: () => Promise<void> } | null | undefined;
    if (body && typeof body.cancel === "function") {
      await body.cancel();
      return;
    }
    if (typeof response.arrayBuffer === "function") {
      await response.arrayBuffer();
    }
  } catch {
    // A body that is missing, already consumed, or errors on cancel is not a
    // check failure; the status has already been captured.
  }
}

function safeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "(unparseable url)";
  }
}

/**
 * A fast command may only run unattended if it is currently both configured on
 * the project and classified read-only by the project's policy. This is the
 * single source of truth for that decision: the `/sentinel fast-command`
 * configuration path and `resolveWatchTargets` (which materializes the command
 * target on every cycle) both call it, so a policy change that later reclassifies
 * the command as approval-required or write-capable drops it from the next cycle
 * instead of silently keeping the previously-approved command running.
 */
export function isSentinelFastCommandEligible(project: ProjectEntry, commandName: string): boolean {
  const normalized = commandName.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return configuredCommandNames(project).includes(normalized) && !commandRequiresApproval(project, normalized);
}

/**
 * Whether an unattended sentinel alert may attach a screenshot for this project.
 * A sentinel capture has no interactive actor to satisfy an approval prompt, so
 * only a project whose policy allows screenshots outright is captured; both
 * `deny` and `approval` policies suppress the capture entirely.
 */
export function sentinelScreenshotAllowed(project: ProjectEntry): boolean {
  return !isScreenshotBlocked(project) && !screenshotRequiresApproval(project);
}

const SENTINEL_MUTATION_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "on",
  "off",
  "interval",
  "watch",
  "fast-command",
  "expected-status"
]);

/**
 * Every `/sentinel` subcommand that changes persisted watcher configuration or
 * lifecycle. Only `status` (read-only) is excluded. Mutations are controller-only
 * and this predicate is the authority the command handler revalidates against at
 * time of use, independent of the dispatcher-level gate.
 */
export function isSentinelMutationSubcommand(subcommand: string): boolean {
  return SENTINEL_MUTATION_SUBCOMMANDS.has(subcommand);
}

export async function checkCommand(
  project: ProjectEntry,
  commandName: string,
  timeoutMs = 60_000,
  runner: typeof runConfiguredProjectCommand = runConfiguredProjectCommand
): Promise<WatchCheckResult> {
  try {
    const result = await runner(project, commandName, timeoutMs);
    return {
      reachable: true,
      ok: result.ok,
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      ...(result.ok ? {} : { error: truncateError(redactSensitiveText(result.output)) })
    };
  } catch (error) {
    return {
      reachable: false,
      ok: false,
      error: redactSensitiveText(error instanceof Error ? error.message : String(error))
    };
  }
}

export async function recentCommits(project: ProjectEntry, limit = 5): Promise<string[]> {
  try {
    const { stdout } = await execAsync(`git log --oneline -n ${Math.max(1, limit)}`, {
      cwd: project.root,
      timeout: 10_000,
      maxBuffer: 200_000
    });
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function watchIdForUrl(url: string): string {
  return `url-${createHash("sha1").update(url).digest("hex").slice(0, 12)}`;
}

export function watchIdForCommand(commandName: string): string {
  const slug = commandName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `cmd-${slug || "command"}`;
}

/**
 * Resolves the concrete watch targets for a cycle. `bases` are the project's
 * currently approved origins (auto-discovered plus statically configured dev
 * server URLs, see `findProjectWebUrls`); manual paths are joined onto them,
 * and a manual absolute URL is only kept if it shares an origin with one of
 * those bases — matching the screenshot subsystem's approved-origin rule
 * rather than trusting "any loopback port."
 */
export function resolveWatchTargets(project: ProjectEntry, config: SentinelProjectConfig, bases: string[]): WatchTarget[] {
  const allowedOrigins = projectScreenshotOrigins(project, bases);
  const urls = new Set<string>();
  for (const base of bases) {
    urls.add(normalizeWatchUrl(base));
  }
  for (const manualPath of config.manualPaths) {
    if (/^https?:\/\//i.test(manualPath)) {
      if (isApprovedWatchOrigin(manualPath, allowedOrigins)) {
        urls.add(normalizeWatchUrl(manualPath));
      }
      continue;
    }
    for (const base of bases) {
      urls.add(normalizeWatchUrl(joinUrlPath(base, manualPath)));
    }
  }

  const targets: WatchTarget[] = [...urls].map((url) => ({ id: watchIdForUrl(url), kind: "url" as const, target: url }));
  // Revalidate the persisted fast command against current project policy on every
  // cycle. A command that was read-only when configured but has since been
  // reclassified (removed, moved to approvalRequiredCommands, or dropped from
  // readOnlyCommands) is not materialized as a target and therefore never runs
  // unattended — closing the policy-drift approval bypass.
  if (config.fastCommand && isSentinelFastCommandEligible(project, config.fastCommand)) {
    targets.push({ id: watchIdForCommand(config.fastCommand), kind: "command", target: config.fastCommand });
  }
  return targets;
}

function normalizeWatchUrl(url: string): string {
  const trimmed = url.trim();
  return trimmed.replace(/\/+$/, "") || trimmed;
}

function joinUrlPath(base: string, routePath: string): string {
  const url = new URL(base);
  url.pathname = `/${routePath.replace(/^\/+/, "")}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function truncateError(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 500 ? normalized : `${normalized.slice(-497)}...`;
}

export interface SentinelEvent {
  projectName: string;
  target: WatchTarget;
  event: "alert" | "recovery";
  state: WatchState;
  previousState: WatchState;
}

export interface SentinelDeps {
  discoverUrls: (project: ProjectEntry) => Promise<string[]>;
  checkUrlFn: (url: string, allowedOrigins: ReadonlySet<string>, isExpectedStatus: (statusCode: number) => boolean) => Promise<WatchCheckResult>;
  checkCommandFn: (project: ProjectEntry, commandName: string) => Promise<WatchCheckResult>;
  now: () => Date;
  /**
   * Revalidates, at the start of every cycle, that the actor who enabled the
   * watcher is still an authorized controller and the project is still
   * configured and reachable to the bot. Returning false skips the cycle
   * entirely (no URL fetches, no command execution, no screenshots), so a
   * de-authorized controller or a removed project cannot keep the unattended
   * poller running. When omitted, cycles are not actor-gated.
   */
  authorizeCycle?: (project: ProjectEntry, config: SentinelProjectConfig) => boolean | Promise<boolean>;
}

export class SentinelManager {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly cycling = new Set<string>();

  constructor(
    private readonly projects: ProjectEntry[],
    private readonly store: SentinelStore,
    private readonly deps: SentinelDeps,
    private readonly onEvent: (event: SentinelEvent) => Promise<void>
  ) {}

  async startEnabled(): Promise<void> {
    for (const project of this.projects) {
      const config = await this.store.getProjectConfig(project.name);
      if (config.enabled) {
        this.schedule(project.name, config.intervalSeconds);
      }
    }
  }

  async setEnabled(projectName: string, enabled: boolean, actorId?: string): Promise<SentinelProjectConfig> {
    const config = await this.store.setEnabled(projectName, enabled, actorId);
    if (enabled) {
      this.schedule(projectName, config.intervalSeconds);
      await this.runCycle(projectName);
    } else {
      this.stop(projectName);
    }
    return config;
  }

  async setIntervalSeconds(projectName: string, seconds: number): Promise<SentinelProjectConfig> {
    const config = await this.store.setIntervalSeconds(projectName, seconds);
    if (config.enabled) {
      this.schedule(projectName, config.intervalSeconds);
    }
    return config;
  }

  stop(projectName: string): void {
    const timer = this.timers.get(projectName);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(projectName);
    }
  }

  stopAll(): void {
    for (const projectName of [...this.timers.keys()]) {
      this.stop(projectName);
    }
  }

  async runCycle(projectName: string): Promise<SentinelEvent[]> {
    if (this.cycling.has(projectName)) {
      return [];
    }
    this.cycling.add(projectName);
    try {
      const project = this.projects.find((item) => item.name === projectName);
      const config = await this.store.getProjectConfig(projectName);
      if (!project || !config.enabled) {
        return [];
      }

      if (this.deps.authorizeCycle) {
        const authorized = await this.deps.authorizeCycle(project, config);
        if (!authorized) {
          console.warn(`Sentinel cycle for ${projectName} skipped: enabling actor or project is no longer authorized.`);
          return [];
        }
      }

      const nowIso = this.deps.now().toISOString();
      const bases = await this.deps.discoverUrls(project);
      const allowedOrigins = projectScreenshotOrigins(project, bases);
      const isExpectedStatus = expectedStatusPredicate(config.expectedStatus);
      const targets = resolveWatchTargets(project, config, bases);
      const events: SentinelEvent[] = [];

      for (const target of targets) {
        const previous = (await this.store.getWatchState(projectName, target.id)) ?? initialWatchState(target);
        const result =
          target.kind === "url"
            ? await this.deps.checkUrlFn(target.target, allowedOrigins, isExpectedStatus)
            : await this.deps.checkCommandFn(project, target.target);
        const { state: next, event } = applyWatchCheck(previous, result, nowIso);
        await this.store.saveWatchState(projectName, target.id, next);

        if (!event) {
          continue;
        }
        if (event === "alert" && next.mutedUntil && next.mutedUntil > nowIso) {
          continue;
        }
        events.push({ projectName, target, event, state: next, previousState: previous });
      }

      for (const sentinelEvent of events) {
        await this.onEvent(sentinelEvent).catch((error) => {
          console.warn(`Sentinel alert delivery failed for ${projectName}: ${(error as Error).message}`);
        });
      }

      return events;
    } finally {
      this.cycling.delete(projectName);
    }
  }

  private schedule(projectName: string, intervalSeconds: number): void {
    this.stop(projectName);
    const timer = setTimeout(async () => {
      try {
        await this.runCycle(projectName);
      } catch (error) {
        console.warn(`Sentinel cycle failed for ${projectName}: ${(error as Error).message}`);
      }
      const config = await this.store.getProjectConfig(projectName);
      if (config.enabled) {
        this.schedule(projectName, config.intervalSeconds);
      } else {
        this.timers.delete(projectName);
      }
    }, intervalSeconds * 1_000);
    timer.unref();
    this.timers.set(projectName, timer);
  }
}
