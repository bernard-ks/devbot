import path from "node:path";
import { accessSync, constants } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { findProjectWebUrls } from "./project-screenshot.js";
import { hardenedGitArguments, hardenedGitEnvironment, minimalChildEnvironment } from "./security.js";
import type { ProjectEntry } from "./types.js";

const execFileAsync = promisify(execFile);

export const DEFAULT_TTL_MINUTES = 15;
export const MAX_TTL_MINUTES = 60;
export const MIN_TTL_MINUTES = 1;
export const MAX_CONCURRENT_TUNNELS = 3;
export const PENDING_CONFIRM_TIMEOUT_MS = 120_000;
const DEFAULT_URL_TIMEOUT_MS = 20_000;
const DEFAULT_KILL_GRACE_MS = 5_000;
const TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export type TunnelExpireReason = "ttl" | "stop" | "shutdown" | "process-exit" | "disabled";
export type PendingExpireReason = "confirm-timeout" | "cancel";

export interface PendingTunnel {
  id: string;
  projectName: string;
  origin: string;
  port: number;
  ttlMinutes: number;
  requestedBy: string;
  channelId: string;
  createdAt: string;
  messageId?: string;
}

export interface ActiveTunnel {
  id: string;
  projectName: string;
  url: string;
  origin: string;
  port: number;
  ttlMinutes: number;
  startedAt: string;
  expiresAt: string;
  startedBy: string;
  channelId: string;
  messageId?: string;
}

export interface TunnelReadableLike {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
}

export interface TunnelChildProcess {
  pid?: number | undefined;
  stdout: TunnelReadableLike | null;
  stderr: TunnelReadableLike | null;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type TunnelSpawnFn = (command: string, args: string[], env: NodeJS.ProcessEnv) => TunnelChildProcess;

export function findCloudflaredPath(
  pathEnv: string = process.env.PATH ?? "",
  isExecutablePath: (candidate: string) => boolean = defaultIsExecutable
): string | undefined {
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, "cloudflared");
    if (isExecutablePath(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function defaultIsExecutable(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Doctor-level validation that the found binary actually runs and identifies
 * itself as cloudflared, without ever creating a tunnel. Returns the version
 * line, or undefined when it fails to run or reports something else.
 */
export async function cloudflaredVersion(
  cloudflaredPath: string,
  runVersion: (command: string) => Promise<string> = defaultRunVersion
): Promise<string | undefined> {
  try {
    const output = await runVersion(cloudflaredPath);
    const line = output.split("\n").map((entry) => entry.trim()).find(Boolean);
    return line && /cloudflared/i.test(line) ? line : undefined;
  } catch {
    return undefined;
  }
}

async function defaultRunVersion(command: string): Promise<string> {
  const { stdout } = await execFileAsync(command, ["--version"], {
    timeout: 5_000,
    maxBuffer: 10_000,
    env: minimalChildEnvironment()
  });
  return stdout;
}

export function clampTtlMinutes(
  minutes: number | undefined,
  options: { defaultMinutes?: number; maxMinutes?: number; minMinutes?: number } = {}
): number {
  const defaultMinutes = options.defaultMinutes ?? DEFAULT_TTL_MINUTES;
  const maxMinutes = options.maxMinutes ?? MAX_TTL_MINUTES;
  const minMinutes = options.minMinutes ?? MIN_TTL_MINUTES;
  if (minutes === undefined || !Number.isFinite(minutes)) {
    return defaultMinutes;
  }
  return Math.min(maxMinutes, Math.max(minMinutes, Math.trunc(minutes)));
}

export function parseTunnelUrl(chunk: string): string | undefined {
  return chunk.match(TUNNEL_URL_PATTERN)?.[0];
}

export interface ValidatedLoopbackOrigin {
  origin: string;
  port: number;
}

/**
 * Independently re-validates a candidate URL as an explicit loopback origin,
 * regardless of any filtering already done upstream. Preserves the exact
 * scheme, address, and port instead of discarding or rewriting them (a
 * service bound only to `[::1]` is not the service on `127.0.0.1`); rejects
 * remote hosts, credentials, and out-of-range ports.
 */
export function validateLoopbackOrigin(value: string): ValidatedLoopbackOrigin | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return undefined;
  }
  if (parsed.username || parsed.password) {
    return undefined;
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") {
    return undefined;
  }
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    return undefined;
  }
  return { origin: `${parsed.protocol}//${host}:${port}`, port };
}

export interface StartCloudflaredOptions {
  spawnFn: TunnelSpawnFn;
  cloudflaredPath: string;
  origin: string;
  env: NodeJS.ProcessEnv;
  urlTimeoutMs?: number;
}

export interface StartCloudflaredResult {
  url: string;
  child: TunnelChildProcess;
}

export function startCloudflaredTunnel(options: StartCloudflaredOptions): Promise<StartCloudflaredResult> {
  const child = options.spawnFn(options.cloudflaredPath, ["tunnel", "--url", options.origin], options.env);
  return waitForTunnelUrl(child, options.urlTimeoutMs).then((url) => ({ url, child }));
}

/** Races cloudflared's stdout/stderr for the reported URL against exit, error, and a timeout. */
export function waitForTunnelUrl(child: TunnelChildProcess, urlTimeoutMs?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error("Timed out waiting for cloudflared to report a tunnel URL."));
    }, urlTimeoutMs ?? DEFAULT_URL_TIMEOUT_MS);

    const onData = (chunk: Buffer | string): void => {
      if (settled) return;
      const url = parseTunnelUrl(chunk.toString());
      if (!url) return;
      settled = true;
      clearTimeout(timeout);
      resolve(url);
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`cloudflared exited before reporting a tunnel URL (code ${code ?? "unknown"}).`));
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

export type PreviewGateReason = "no-owner" | "not-owner" | "disabled";
export type PreviewOwnerGateReason = "no-owner" | "not-owner";

/** Owner-only gate shared by every /preview subcommand, including stop/status. */
export function previewOwnerGateReason(
  config: { ownerUserId: string | undefined },
  requesterId: string
): PreviewOwnerGateReason | undefined {
  if (!config.ownerUserId) {
    return "no-owner";
  }
  if (requesterId !== config.ownerUserId) {
    return "not-owner";
  }
  return undefined;
}

/** Full gate for /preview share: owner-only, plus the default-off feature flag. */
export function previewGateReason(
  config: { previewTunnelsEnabled: boolean; ownerUserId: string | undefined },
  requesterId: string
): PreviewGateReason | undefined {
  const ownerGate = previewOwnerGateReason(config, requesterId);
  if (ownerGate) {
    return ownerGate;
  }
  if (!config.previewTunnelsEnabled) {
    return "disabled";
  }
  return undefined;
}

/** Per-project preview policy is owner-controlled runtime state, never checked-in repo metadata. */
export function projectPreviewGateReason(projectPreviewAllowed: boolean): "project-disabled" | undefined {
  return projectPreviewAllowed ? undefined : "project-disabled";
}

export async function findRunningProjectOrigin(
  project: ProjectEntry,
  probeUrl: (origin: string) => Promise<boolean> = defaultProbeUrl,
  listUrls: (project: ProjectEntry) => Promise<string[]> = findProjectWebUrls
): Promise<ValidatedLoopbackOrigin | undefined> {
  const urls = await listUrls(project);
  for (const url of urls) {
    const validated = validateLoopbackOrigin(url);
    if (!validated) continue;
    if (await probeUrl(validated.origin)) {
      return validated;
    }
  }
  return undefined;
}

async function defaultProbeUrl(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch(url, { method: "GET", redirect: "manual", signal: controller.signal });
    return response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export interface ProjectRevisionInfo {
  branch: string;
  revision: string;
}

/** Best-effort branch/revision for the pre-spawn confirmation; falls back to "unknown", never throws. */
export async function describeProjectRevision(project: ProjectEntry): Promise<ProjectRevisionInfo> {
  const [branch, revision] = await Promise.all([
    gitField(project.root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    gitField(project.root, ["rev-parse", "--short", "HEAD"])
  ]);
  return { branch, revision };
}

async function gitField(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", hardenedGitArguments(cwd, args), {
      timeout: 5_000,
      maxBuffer: 10_000,
      env: hardenedGitEnvironment()
    });
    return stdout.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

interface TrackedBase {
  id: string;
  projectName: string;
  origin: string;
  port: number;
  ttlMinutes: number;
  requestedBy: string;
  channelId: string;
  createdAt: string;
  messageId?: string;
}

interface TrackedPending extends TrackedBase {
  state: "pending";
  aborted: boolean;
  child?: TunnelChildProcess;
  homeDir?: string;
  pendingTimer: unknown;
  onPendingExpire: (pending: PendingTunnel, reason: PendingExpireReason) => void;
}

interface TrackedActive extends TrackedBase {
  state: "active" | "stopping";
  url: string;
  startedAt: string;
  expiresAt: string;
  child: TunnelChildProcess;
  homeDir: string;
  ttlTimer: unknown;
  onExpire: (tunnel: ActiveTunnel, reason: TunnelExpireReason) => void;
}

type Tracked = TrackedPending | TrackedActive;

export interface ReserveTunnelInput {
  projectName: string;
  origin: string;
  port: number;
  ttlMinutes?: number;
  requestedBy: string;
  channelId: string;
  onPendingExpire: (pending: PendingTunnel, reason: PendingExpireReason) => void;
}

export interface TunnelProcessLedgerLike {
  record(entry: { id: string; pid: number; origin: string; createdAt: string }): Promise<void>;
  release(id: string): Promise<void>;
}

export interface TunnelManagerDeps {
  spawnFn: TunnelSpawnFn;
  findCloudflaredPath: () => string | undefined;
  now?: () => Date;
  scheduleTimeout?: (fn: () => void, ms: number) => unknown;
  clearScheduledTimeout?: (handle: unknown) => void;
  urlTimeoutMs?: number;
  killGraceMs?: number;
  pendingConfirmTimeoutMs?: number;
  maxConcurrentTunnels?: number;
  createTunnelHome?: () => Promise<string>;
  removeTunnelHome?: (directory: string) => Promise<void>;
  processLedger?: TunnelProcessLedgerLike;
}

/**
 * Tracks preview tunnels through pending (reserved, not yet spawned) -> active
 * (cloudflared running, URL known) -> stopping (kill in flight) states. A
 * project slot is reserved before anything is spawned so two concurrent
 * requests for the same project cannot both spawn a child, and a pending
 * reservation is abortable (stop/disable/shutdown) before it ever spawns.
 */
export class TunnelManager {
  private readonly tunnels = new Map<string, Tracked>();

  constructor(private readonly deps: TunnelManagerDeps) {}

  hasActiveForProject(projectName: string): boolean {
    return [...this.tunnels.values()].some((tracked) => tracked.projectName === projectName);
  }

  get(id: string): ActiveTunnel | undefined {
    const tracked = this.tunnels.get(id);
    return tracked && tracked.state !== "pending" ? toActiveTunnel(tracked) : undefined;
  }

  getPending(id: string): PendingTunnel | undefined {
    const tracked = this.tunnels.get(id);
    return tracked && tracked.state === "pending" ? toPendingTunnel(tracked) : undefined;
  }

  list(): ActiveTunnel[] {
    return [...this.tunnels.values()]
      .filter((tracked): tracked is TrackedActive => tracked.state !== "pending")
      .map(toActiveTunnel);
  }

  attachMessage(id: string, messageId: string): void {
    const tracked = this.tunnels.get(id);
    if (tracked) {
      tracked.messageId = messageId;
    }
  }

  reserve(input: ReserveTunnelInput): PendingTunnel {
    if (this.hasActiveForProject(input.projectName)) {
      throw new Error(
        `Project \`${input.projectName}\` already has an active or pending preview tunnel. Stop it before starting another.`
      );
    }
    const maxConcurrent = this.deps.maxConcurrentTunnels ?? MAX_CONCURRENT_TUNNELS;
    if (this.tunnels.size >= maxConcurrent) {
      throw new Error(`Devbot already has ${maxConcurrent} preview tunnel(s) pending or active. Stop one before starting another.`);
    }

    const now = this.deps.now?.() ?? new Date();
    const id = randomUUID();
    const schedule = this.deps.scheduleTimeout ?? defaultSchedule;
    const pendingTimeoutMs = this.deps.pendingConfirmTimeoutMs ?? PENDING_CONFIRM_TIMEOUT_MS;

    const tracked: TrackedPending = {
      id,
      projectName: input.projectName,
      origin: input.origin,
      port: input.port,
      ttlMinutes: clampTtlMinutes(input.ttlMinutes),
      requestedBy: input.requestedBy,
      channelId: input.channelId,
      createdAt: now.toISOString(),
      state: "pending",
      aborted: false,
      pendingTimer: undefined,
      onPendingExpire: input.onPendingExpire
    };
    tracked.pendingTimer = schedule(() => this.expirePending(id, "confirm-timeout"), pendingTimeoutMs);
    this.tunnels.set(id, tracked);
    return toPendingTunnel(tracked);
  }

  /** Cancels a reservation that has not launched yet (Cancel button, disable, shutdown). */
  cancelPending(id: string): PendingTunnel | undefined {
    const tracked = this.tunnels.get(id);
    if (!tracked || tracked.state !== "pending") {
      return undefined;
    }
    this.expirePending(id, "cancel");
    return toPendingTunnel(tracked);
  }

  private expirePending(id: string, reason: PendingExpireReason): void {
    const tracked = this.tunnels.get(id);
    if (!tracked || tracked.state !== "pending") {
      return;
    }
    tracked.aborted = true;
    this.tunnels.delete(id);
    this.clearScheduled(tracked.pendingTimer);
    if (tracked.child) {
      tracked.child.kill("SIGTERM");
    }
    tracked.onPendingExpire(toPendingTunnel(tracked), reason);
  }

  /** Spawns cloudflared for a confirmed reservation. Aborts cleanly if cancelled mid-flight. */
  async launch(id: string, onExpire: (tunnel: ActiveTunnel, reason: TunnelExpireReason) => void): Promise<ActiveTunnel> {
    const tracked = this.tunnels.get(id);
    if (!tracked || tracked.state !== "pending") {
      throw new Error("This preview tunnel confirmation has expired. Run `/preview share` again.");
    }
    this.clearScheduled(tracked.pendingTimer);

    const cloudflaredPath = this.deps.findCloudflaredPath();
    if (!cloudflaredPath) {
      this.tunnels.delete(id);
      throw new Error("cloudflared is not installed. Install it with `brew install cloudflared` and try again.");
    }

    const createHome = this.deps.createTunnelHome ?? defaultCreateTunnelHome;
    const homeDir = await createHome();
    const env = isolatedTunnelEnvironment(homeDir);

    // Spawn directly (rather than inside startCloudflaredTunnel) so the child
    // is attached to the reservation before we start waiting for its URL: a
    // cancel that arrives during that wait can then kill it immediately,
    // instead of only after the wait settles on its own.
    const child = this.deps.spawnFn(cloudflaredPath, ["tunnel", "--url", tracked.origin], env);
    tracked.child = child;
    this.recordChildProcess(tracked.id, tracked.origin, child);
    if (tracked.aborted) {
      child.kill("SIGTERM");
      await this.removeHomeSafely(homeDir);
      throw new Error("The preview tunnel was cancelled before it finished starting.");
    }

    let url: string;
    try {
      url = await waitForTunnelUrl(child, this.deps.urlTimeoutMs);
    } catch (error) {
      this.tunnels.delete(id);
      await this.removeHomeSafely(homeDir);
      throw error;
    }

    if (this.tunnels.get(id) !== tracked || tracked.aborted) {
      child.kill("SIGTERM");
      await this.removeHomeSafely(homeDir);
      throw new Error("The preview tunnel was cancelled before it finished starting.");
    }

    const now = this.deps.now?.() ?? new Date();
    const expiresAt = new Date(now.getTime() + tracked.ttlMinutes * 60_000);
    const schedule = this.deps.scheduleTimeout ?? defaultSchedule;

    const active: TrackedActive = {
      id: tracked.id,
      projectName: tracked.projectName,
      origin: tracked.origin,
      port: tracked.port,
      ttlMinutes: tracked.ttlMinutes,
      requestedBy: tracked.requestedBy,
      channelId: tracked.channelId,
      createdAt: tracked.createdAt,
      ...(tracked.messageId ? { messageId: tracked.messageId } : {}),
      state: "active",
      url,
      startedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      child,
      homeDir,
      ttlTimer: undefined,
      onExpire
    };
    active.ttlTimer = schedule(() => {
      void this.expire(id, "ttl", false);
    }, tracked.ttlMinutes * 60_000);

    child.on("exit", () => {
      if (this.tunnels.get(id) === active) {
        // The child has already exited; there is nothing left to signal.
        void this.expire(id, "process-exit", true);
      }
    });
    child.on("error", (error) => {
      if (this.tunnels.get(id) === active) {
        console.warn(`cloudflared for preview tunnel ${active.projectName} (${id}) reported an error: ${error.message}`);
        // Node's 'error' event does not guarantee the process has exited, so
        // still attempt a kill in case it is still running.
        void this.expire(id, "process-exit", false);
      }
    });

    this.tunnels.set(id, active);
    return toActiveTunnel(active);
  }

  /** Stops an active tunnel by id. Waits for a confirmed exit (SIGTERM, then SIGKILL) before reporting stopped. */
  async stop(id: string, reason: TunnelExpireReason = "stop"): Promise<ActiveTunnel | undefined> {
    const tracked = this.tunnels.get(id);
    if (!tracked || tracked.state === "pending") {
      return undefined;
    }
    if (tracked.state === "stopping") {
      return toActiveTunnel(tracked);
    }
    return this.finalizeActive(tracked, reason, false);
  }

  private async expire(
    id: string,
    reason: Extract<TunnelExpireReason, "ttl" | "process-exit">,
    alreadyExited: boolean
  ): Promise<void> {
    const tracked = this.tunnels.get(id);
    if (!tracked || tracked.state !== "active") {
      return;
    }
    await this.finalizeActive(tracked, reason, alreadyExited);
  }

  private async finalizeActive(tracked: TrackedActive, reason: TunnelExpireReason, alreadyExited: boolean): Promise<ActiveTunnel> {
    tracked.state = "stopping";
    this.clearScheduled(tracked.ttlTimer);
    // If the child is already confirmed gone (a real "exit" event fired), it
    // will never emit another one — signalling and waiting here would just
    // stall for the full grace period for no reason.
    if (!alreadyExited) {
      const exited = await this.killWithEscalation(tracked.child);
      if (!exited) {
        console.warn(
          `cloudflared for preview tunnel ${tracked.projectName} (${tracked.id}) did not confirm exit after SIGTERM/SIGKILL; check for an orphaned process manually.`
        );
      }
    }
    this.tunnels.delete(tracked.id);
    await this.removeHomeSafely(tracked.homeDir);
    const result = toActiveTunnel(tracked);
    tracked.onExpire(result, reason);
    return result;
  }

  /** Stops or cancels whatever tunnel (pending or active) is tracked for a project. */
  async stopByProject(
    projectName: string,
    reason: TunnelExpireReason = "stop"
  ): Promise<{ kind: "active"; tunnel: ActiveTunnel } | { kind: "pending"; tunnel: PendingTunnel } | undefined> {
    const tracked = [...this.tunnels.values()].find((entry) => entry.projectName === projectName);
    if (!tracked) {
      return undefined;
    }
    if (tracked.state === "pending") {
      const pending = this.cancelPending(tracked.id);
      return pending ? { kind: "pending", tunnel: pending } : undefined;
    }
    const active = await this.stop(tracked.id, reason);
    return active ? { kind: "active", tunnel: active } : undefined;
  }

  /** Stops/cancels every tracked tunnel (shutdown, or the owner disabling the feature). */
  async stopAll(reason: TunnelExpireReason = "shutdown"): Promise<ActiveTunnel[]> {
    const results: ActiveTunnel[] = [];
    for (const id of [...this.tunnels.keys()]) {
      const tracked = this.tunnels.get(id);
      if (!tracked) continue;
      if (tracked.state === "pending") {
        this.cancelPending(id);
        continue;
      }
      const stopped = await this.stop(id, reason);
      if (stopped) results.push(stopped);
    }
    return results;
  }

  private async killWithEscalation(child: TunnelChildProcess): Promise<boolean> {
    const graceMs = this.deps.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    if (await this.waitForExit(child, graceMs, () => child.kill("SIGTERM"))) {
      return true;
    }
    return this.waitForExit(child, graceMs, () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // signal unsupported on this platform; nothing more we can do.
      }
    });
  }

  private waitForExit(child: TunnelChildProcess, timeoutMs: number, act: () => void): Promise<boolean> {
    const schedule = this.deps.scheduleTimeout ?? defaultSchedule;
    const clear = this.deps.clearScheduledTimeout ?? defaultClear;
    return new Promise((resolve) => {
      let settled = false;
      const timer = schedule(() => {
        if (settled) return;
        settled = true;
        resolve(false);
      }, timeoutMs);
      child.on("exit", () => {
        if (settled) return;
        settled = true;
        clear(timer);
        resolve(true);
      });
      act();
    });
  }

  /**
   * Records the spawned pid so a restart can reconcile orphans, and releases
   * the record only once a real exit is observed: a kill that never confirms
   * keeps its entry, so the next startup still knows to hunt it down.
   */
  private recordChildProcess(id: string, origin: string, child: TunnelChildProcess): void {
    const ledger = this.deps.processLedger;
    if (!ledger || typeof child.pid !== "number") {
      return;
    }
    const createdAt = (this.deps.now?.() ?? new Date()).toISOString();
    void ledger
      .record({ id, pid: child.pid, origin, createdAt })
      .catch((error: unknown) => console.warn(`Unable to record preview tunnel process ${id}: ${(error as Error).message}`));
    child.on("exit", () => {
      void ledger
        .release(id)
        .catch((error: unknown) => console.warn(`Unable to release preview tunnel process record ${id}: ${(error as Error).message}`));
    });
  }

  private async removeHomeSafely(homeDir: string | undefined): Promise<void> {
    if (!homeDir) return;
    const remove = this.deps.removeTunnelHome ?? defaultRemoveTunnelHome;
    try {
      await remove(homeDir);
    } catch (error) {
      console.warn(`Unable to remove isolated preview-tunnel home ${homeDir}: ${(error as Error).message}`);
    }
  }

  private clearScheduled(handle: unknown): void {
    const clear = this.deps.clearScheduledTimeout ?? defaultClear;
    clear(handle);
  }
}

function defaultSchedule(fn: () => void, ms: number): unknown {
  const handle = setTimeout(fn, ms);
  handle.unref?.();
  return handle;
}

function defaultClear(handle: unknown): void {
  clearTimeout(handle as NodeJS.Timeout);
}

async function defaultCreateTunnelHome(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "devbot-tunnel-"));
}

async function defaultRemoveTunnelHome(directory: string): Promise<void> {
  await rm(directory, { force: true, recursive: true });
}

/**
 * cloudflared reads ~/.cloudflared (and XDG directories on some platforms)
 * for cached config/credentials; giving it an empty, single-use HOME and
 * XDG tree keeps it from picking up ambient Cloudflare account state (and
 * keeps it isolated from bot secrets, same as minimalChildEnvironment
 * already does for tokens).
 */
export function isolatedTunnelEnvironment(homeDir: string): NodeJS.ProcessEnv {
  const env = minimalChildEnvironment();
  env.HOME = homeDir;
  env.USERPROFILE = homeDir;
  env.XDG_CONFIG_HOME = path.join(homeDir, ".config");
  env.XDG_CACHE_HOME = path.join(homeDir, ".cache");
  env.XDG_DATA_HOME = path.join(homeDir, ".local", "share");
  env.XDG_STATE_HOME = path.join(homeDir, ".local", "state");
  return env;
}

function toActiveTunnel(tracked: TrackedActive): ActiveTunnel {
  return {
    id: tracked.id,
    projectName: tracked.projectName,
    url: tracked.url,
    origin: tracked.origin,
    port: tracked.port,
    ttlMinutes: tracked.ttlMinutes,
    startedAt: tracked.startedAt,
    expiresAt: tracked.expiresAt,
    startedBy: tracked.requestedBy,
    channelId: tracked.channelId,
    ...(tracked.messageId ? { messageId: tracked.messageId } : {})
  };
}

function toPendingTunnel(tracked: TrackedPending): PendingTunnel {
  return {
    id: tracked.id,
    projectName: tracked.projectName,
    origin: tracked.origin,
    port: tracked.port,
    ttlMinutes: tracked.ttlMinutes,
    requestedBy: tracked.requestedBy,
    channelId: tracked.channelId,
    createdAt: tracked.createdAt,
    ...(tracked.messageId ? { messageId: tracked.messageId } : {})
  };
}
