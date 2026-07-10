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

/**
 * Result of a stop/expire attempt. `exitConfirmed` is false when SIGTERM and
 * SIGKILL both went unanswered: the tunnel is intentionally still tracked and
 * must be reported as *not* stopped, because a cloudflared process may still be
 * serving the exposed origin. Cleanup (untracking, home removal, expiry) is
 * deferred until the child's exit is actually observed.
 */
export interface TunnelStopOutcome {
  tunnel: ActiveTunnel;
  exitConfirmed: boolean;
}

/**
 * A single observation of a child's `exit`, attached the instant the child is
 * available and BEFORE any signal is ever sent to it. `exited` is a durable
 * promise and `hasExited()` its synchronous mirror. Because the listener is in
 * place before signalling, an exit that lands in the narrow window between a
 * kill wait giving up and a caller attaching cleanup is never missed: `.then()`
 * still fires on an already-resolved promise, so cleanup is never skipped.
 */
export interface ExitObservation {
  readonly exited: Promise<void>;
  hasExited(): boolean;
}

export function observeChildExit(child: TunnelChildProcess): ExitObservation {
  let exited = false;
  let markExited!: () => void;
  const exitedPromise = new Promise<void>((resolve) => {
    markExited = resolve;
  });
  child.on("exit", () => {
    if (exited) return;
    exited = true;
    markExited();
  });
  return {
    exited: exitedPromise,
    hasExited: () => exited
  };
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

/**
 * Resolves the exact loopback origin to expose for a project. A candidate URL
 * is only accepted once it is (1) a valid loopback origin, (2) actually
 * reachable, and (3) served by a process that provably belongs to this
 * project's process tree. The third check is what stops a configured or global
 * screenshot URL (or any other candidate) from publicly exposing an unrelated
 * local service that merely happens to answer on the same loopback port.
 */
export async function findRunningProjectOrigin(
  project: ProjectEntry,
  probeUrl: (origin: string) => Promise<boolean> = defaultProbeUrl,
  listUrls: (project: ProjectEntry) => Promise<string[]> = findProjectWebUrls,
  verifyListener: (project: ProjectEntry, port: number) => Promise<boolean> = defaultVerifyProjectListener
): Promise<ValidatedLoopbackOrigin | undefined> {
  const urls = await listUrls(project);
  for (const url of urls) {
    const validated = validateLoopbackOrigin(url);
    if (!validated) continue;
    if (!(await probeUrl(validated.origin))) continue;
    if (!(await verifyListener(project, validated.port))) continue;
    return validated;
  }
  return undefined;
}

/**
 * Launch-time counterpart to `findRunningProjectOrigin`: re-proves that the one
 * exact origin reserved at `/preview share` time is STILL (1) a valid loopback
 * origin, (2) reachable, and (3) served by a listener inside this project's
 * process tree — the same three gates, re-run atomically just before spawning.
 * This is what defeats a listener swap during the confirmation window: if the
 * project server exited and a foreign process bound the port, the reachability
 * probe may still answer, but the listener-identity check fails and the origin
 * is refused. Purely a decision; it never signals or touches the foreign
 * listener.
 */
export async function revalidateProjectOrigin(
  project: ProjectEntry,
  origin: string,
  port: number,
  probeUrl: (origin: string) => Promise<boolean> = defaultProbeUrl,
  verifyListener: (project: ProjectEntry, port: number) => Promise<boolean> = defaultVerifyProjectListener
): Promise<boolean> {
  const validated = validateLoopbackOrigin(origin);
  if (!validated || validated.origin !== origin || validated.port !== port) {
    return false;
  }
  if (!(await probeUrl(origin))) {
    return false;
  }
  return verifyListener(project, port);
}

export interface ProcessInfo {
  pid: number;
  ppid: number;
  command: string;
}

export type ListenerPidLookup = (port: number) => Promise<number[]>;
export type ProcessSnapshot = () => Promise<ProcessInfo[]>;

export interface VerifyProjectListenerDeps {
  listListenerPids?: ListenerPidLookup;
  snapshotProcesses?: ProcessSnapshot;
}

/**
 * Proves that whoever is listening on `port` belongs to the managed project's
 * process tree before its origin can be exposed. Fails closed: if no listener
 * pid can be identified (no `lsof`, nothing bound, permission denied), or any
 * listener on that port is outside the project tree, the port is refused. A
 * configured screenshot URL alone is never sufficient.
 */
export async function verifyProjectListener(
  project: ProjectEntry,
  port: number,
  deps: VerifyProjectListenerDeps = {}
): Promise<boolean> {
  const listListenerPids = deps.listListenerPids ?? defaultListenerPidsForPort;
  const snapshotProcesses = deps.snapshotProcesses ?? defaultSnapshotProcesses;
  const listeners = await listListenerPids(port);
  if (listeners.length === 0) {
    return false;
  }
  const processes = await snapshotProcesses();
  const projectPids = collectProjectPids(processes, project.root);
  return listeners.every((pid) => projectPids.has(pid));
}

async function defaultVerifyProjectListener(project: ProjectEntry, port: number): Promise<boolean> {
  return verifyProjectListener(project, port);
}

/** Parses `ps -axo pid=,ppid=,command=` output into a process table. */
export function parseProcessTree(psOutput: string): ProcessInfo[] {
  const infos: ProcessInfo[] = [];
  for (const line of psOutput.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*\S)\s*$/.exec(line);
    if (!match?.[3]) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    infos.push({ pid, ppid, command: match[3] });
  }
  return infos;
}

/**
 * Pids that belong to a project: any process whose command line references the
 * project root as a path token, plus every descendant of such a process. The
 * descendant walk matters because a dev server is frequently a child of
 * `npm run dev`/`next dev`, and only the parent's argv carries the project
 * path; the child that actually binds the socket may not.
 */
export function collectProjectPids(processes: ProcessInfo[], projectRoot: string): Set<number> {
  const root = path.resolve(projectRoot);
  const childrenByParent = new Map<number, number[]>();
  for (const proc of processes) {
    const siblings = childrenByParent.get(proc.ppid) ?? [];
    siblings.push(proc.pid);
    childrenByParent.set(proc.ppid, siblings);
  }
  const projectPids = new Set<number>();
  const queue: number[] = [];
  for (const proc of processes) {
    if (commandReferencesRoot(proc.command, root)) {
      if (!projectPids.has(proc.pid)) {
        projectPids.add(proc.pid);
        queue.push(proc.pid);
      }
    }
  }
  while (queue.length > 0) {
    const pid = queue.shift() as number;
    for (const child of childrenByParent.get(pid) ?? []) {
      if (!projectPids.has(child)) {
        projectPids.add(child);
        queue.push(child);
      }
    }
  }
  return projectPids;
}

/**
 * Treats the root as a whole path token: a sibling directory sharing a prefix
 * (`.../web` vs `.../web-legacy`) must not be mistaken for the project.
 */
function commandReferencesRoot(command: string, root: string): boolean {
  let from = 0;
  for (;;) {
    const index = command.indexOf(root, from);
    if (index === -1) return false;
    const after = command[index + root.length];
    if (after === undefined || after === path.sep || after === "/" || after === " " || after === '"' || after === "'" || after === ":") {
      return true;
    }
    from = index + root.length;
  }
}

async function defaultListenerPidsForPort(port: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      env: minimalChildEnvironment(),
      timeout: 5_000,
      maxBuffer: 100_000
    });
    return parseListenerPids(stdout);
  } catch {
    return [];
  }
}

function parseListenerPids(output: string): number[] {
  const pids = new Set<number>();
  for (const line of output.split("\n")) {
    const value = Number(line.trim());
    if (Number.isInteger(value) && value > 0) {
      pids.add(value);
    }
  }
  return [...pids];
}

async function defaultSnapshotProcesses(): Promise<ProcessInfo[]> {
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,command="], {
      env: minimalChildEnvironment(),
      maxBuffer: 2_000_000
    });
    return parseProcessTree(stdout);
  } catch {
    return [];
  }
}

/** Parses one `ps -o pgid=,lstart=` row into the durable identity (process group + fixed five-field start time). */
export function parseProcessIdentity(psOutput: string): DurableProcessIdentity {
  const line = psOutput.split("\n").find((entry) => entry.trim().length > 0);
  if (!line) {
    return {};
  }
  const match = /^\s*(\d+)\s+(\S.*\S|\S)\s*$/.exec(line);
  if (!match?.[2]) {
    return {};
  }
  return { pgid: Number(match[1]), startTime: match[2] };
}

async function defaultCaptureProcessIdentity(pid: number): Promise<DurableProcessIdentity> {
  if (process.platform === "win32") {
    return {};
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "pgid=,lstart="], {
      env: minimalChildEnvironment(),
      timeout: 5_000,
      maxBuffer: 10_000
    });
    return parseProcessIdentity(stdout);
  } catch {
    return {};
  }
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
  exitObservation?: ExitObservation;
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
  exitObservation: ExitObservation;
  homeDir: string;
  ttlTimer: unknown;
  onExpire: (tunnel: ActiveTunnel, reason: TunnelExpireReason) => void;
  deferredCleanupArmed?: boolean;
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

export interface TunnelProcessRecordInput {
  id: string;
  pid: number;
  origin: string;
  createdAt: string;
  pgid?: number;
  startTime?: string;
  argvSignature?: string;
}

export interface TunnelProcessLedgerLike {
  record(entry: TunnelProcessRecordInput): Promise<void>;
  release(id: string): Promise<void>;
}

/** Durable, recycle-resistant identity of a spawned child, captured at record time. */
export interface DurableProcessIdentity {
  pgid?: number;
  startTime?: string;
}

/** The cloudflared argv, as a signature the ledger can later re-match against `ps` output. */
export function tunnelInvocationSignature(origin: string): string {
  return `tunnel --url ${origin}`;
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
  captureProcessIdentity?: (pid: number) => Promise<DurableProcessIdentity>;
}

export interface RevalidateReservationInput {
  origin: string;
  port: number;
  projectName: string;
}

/**
 * Launch-time re-proof that the reserved origin is still served by this
 * project's own listener. Returns false to refuse the launch (listener changed
 * or can no longer be proven); it must never signal or touch any process.
 */
export type RevalidateReservation = (pending: RevalidateReservationInput) => Promise<boolean>;

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
    // A spawned-but-not-yet-active child (cancel mid-launch) is owned by
    // launch(), which observes its exit before removing the isolated home or
    // releasing its ledger record. Do not signal or tear it down here without
    // observing that exit — that is exactly the fail-open the review flagged.
    tracked.onPendingExpire(toPendingTunnel(tracked), reason);
  }

  /** Spawns cloudflared for a confirmed reservation. Aborts cleanly if cancelled mid-flight. */
  async launch(
    id: string,
    onExpire: (tunnel: ActiveTunnel, reason: TunnelExpireReason) => void,
    revalidate?: RevalidateReservation
  ): Promise<ActiveTunnel> {
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

    // Re-prove, atomically at launch and immediately before anything is
    // spawned, that the exact reserved origin is still reachable AND still
    // served by a listener inside this project's process tree. The project
    // server verified at `/preview share` time may have exited during the
    // up-to-120s confirmation window, letting a foreign process bind the port;
    // reachability alone would then expose that foreign service. Fail closed:
    // refuse without spawning cloudflared or signalling anything, so the
    // foreign listener is never touched.
    if (revalidate) {
      let stillProjectOwned: boolean;
      try {
        stillProjectOwned = await revalidate({
          origin: tracked.origin,
          port: tracked.port,
          projectName: tracked.projectName
        });
      } catch (error) {
        this.tunnels.delete(id);
        throw new Error(
          `Could not re-verify the local listener for \`${tracked.projectName}\` before launch; refusing to expose it. (${(error as Error).message})`
        );
      }
      // A cancel/disable/shutdown that raced the async revalidation wins.
      if (this.tunnels.get(id) !== tracked || tracked.aborted) {
        throw new Error("The preview tunnel was cancelled before it finished starting.");
      }
      if (!stillProjectOwned) {
        this.tunnels.delete(id);
        throw new Error(
          "The local server for this project can no longer be verified as the one that would be exposed " +
            "(its listener changed since `/preview share`); refusing to launch. Run `/preview share` again."
        );
      }
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
    // Observe the exit before any signal is ever sent — this single observation
    // is shared by every teardown path below, closing the gap where an exit
    // could land between a kill wait giving up and a listener being attached.
    const exitObservation = observeChildExit(child);
    tracked.exitObservation = exitObservation;

    // Durably record the process for orphan reconciliation and fail closed if
    // it cannot be persisted: nothing is exposed until the ledger write
    // resolves. An unrecorded public tunnel that a crash could orphan must
    // never be published.
    try {
      await this.recordChildProcess(tracked.id, tracked.origin, child, exitObservation);
    } catch (error) {
      this.tunnels.delete(id);
      await this.abortLaunchedChild(child, exitObservation, homeDir);
      throw new Error(
        `Could not durably record the preview tunnel for orphan tracking; refusing to expose it. (${(error as Error).message})`
      );
    }

    if (tracked.aborted) {
      await this.abortLaunchedChild(child, exitObservation, homeDir);
      throw new Error("The preview tunnel was cancelled before it finished starting.");
    }

    let url: string;
    try {
      url = await waitForTunnelUrl(child, this.deps.urlTimeoutMs);
    } catch (error) {
      this.tunnels.delete(id);
      await this.abortLaunchedChild(child, exitObservation, homeDir);
      throw error;
    }

    if (this.tunnels.get(id) !== tracked || tracked.aborted) {
      await this.abortLaunchedChild(child, exitObservation, homeDir);
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
      exitObservation,
      homeDir,
      ttlTimer: undefined,
      onExpire
    };
    active.ttlTimer = schedule(() => {
      void this.expire(id, "ttl", false);
    }, tracked.ttlMinutes * 60_000);

    void exitObservation.exited.then(() => {
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

  /**
   * Stops an active tunnel by id. Waits for a confirmed exit (SIGTERM, then
   * SIGKILL) before reporting it stopped. If neither signal produces an
   * observed exit, the tunnel stays tracked and is reported with
   * `exitConfirmed: false` rather than as a clean stop.
   */
  async stop(id: string, reason: TunnelExpireReason = "stop"): Promise<TunnelStopOutcome | undefined> {
    const tracked = this.tunnels.get(id);
    if (!tracked || tracked.state === "pending") {
      return undefined;
    }
    if (tracked.state === "stopping") {
      // A prior stop/expire could not confirm the child exited, so it is still
      // tracked while we wait for a real exit. Re-report it as unconfirmed
      // instead of pretending it stopped cleanly.
      return { tunnel: toActiveTunnel(tracked), exitConfirmed: false };
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

  private async finalizeActive(
    tracked: TrackedActive,
    reason: TunnelExpireReason,
    alreadyExited: boolean
  ): Promise<TunnelStopOutcome> {
    tracked.state = "stopping";
    this.clearScheduled(tracked.ttlTimer);
    // If the child is already confirmed gone (a real "exit" event fired), it
    // will never emit another one — signalling and waiting here would just
    // stall for the full grace period for no reason.
    if (alreadyExited || (await this.killWithEscalation(tracked.child, tracked.exitObservation))) {
      await this.completeCleanup(tracked, reason);
      return { tunnel: toActiveTunnel(tracked), exitConfirmed: true };
    }
    // SIGTERM and SIGKILL both went unanswered. Do NOT free the project slot,
    // remove the isolated home, or fire expiry: a cloudflared process may still
    // be serving the public origin. Keep the tunnel tracked and finish cleanup
    // only once its exit is actually observed, so it is never reported as
    // stopped while the exposure could still be live. The persisted ledger
    // record is likewise retained (released only on a real exit) so a restart
    // can still reconcile the orphan.
    console.warn(
      `cloudflared for preview tunnel ${tracked.projectName} (${tracked.id}) did not confirm exit after SIGTERM/SIGKILL; it stays tracked and reported as not stopped until its process exit is observed.`
    );
    this.deferCleanupUntilExit(tracked, reason);
    return { tunnel: toActiveTunnel(tracked), exitConfirmed: false };
  }

  /** Untracks a tunnel, removes its isolated home, and fires expiry. Used once a real exit is confirmed. */
  private async completeCleanup(tracked: TrackedActive, reason: TunnelExpireReason): Promise<void> {
    if (this.tunnels.get(tracked.id) !== tracked) {
      return;
    }
    this.tunnels.delete(tracked.id);
    await this.removeHomeSafely(tracked.homeDir);
    tracked.onExpire(toActiveTunnel(tracked), reason);
  }

  /**
   * Completes the deferred cleanup once a resistant child (kill never confirmed)
   * eventually exits. Chains off the single exit observation attached before any
   * signal was sent, so an exit that already landed in the gap between the kill
   * wait giving up and this call is still honoured — `.then()` fires on an
   * already-resolved promise — instead of being missed by a listener attached
   * too late.
   */
  private deferCleanupUntilExit(tracked: TrackedActive, reason: TunnelExpireReason): void {
    if (tracked.deferredCleanupArmed) {
      return;
    }
    tracked.deferredCleanupArmed = true;
    void tracked.exitObservation.exited.then(() => this.completeCleanup(tracked, reason));
  }

  /**
   * Tears down a child that was spawned but must not become an active tunnel
   * (launch aborted, cancelled, or failed to record). The isolated home is only
   * removed once the child's exit is observed: a resistant child that ignores
   * SIGTERM/SIGKILL keeps its home until it is really gone, so state is never
   * deleted out from under a process that may still be serving the origin. Its
   * ledger record (if any) is likewise released only on the observed exit.
   */
  private async abortLaunchedChild(
    child: TunnelChildProcess,
    observation: ExitObservation,
    homeDir: string | undefined
  ): Promise<void> {
    if (await this.killWithEscalation(child, observation)) {
      await this.removeHomeSafely(homeDir);
      return;
    }
    console.warn(
      "cloudflared for an aborted preview tunnel did not confirm exit after SIGTERM/SIGKILL; its isolated home is retained until the process exit is observed."
    );
    void observation.exited.then(() => this.removeHomeSafely(homeDir));
  }

  /** Stops or cancels whatever tunnel (pending or active) is tracked for a project. */
  async stopByProject(
    projectName: string,
    reason: TunnelExpireReason = "stop"
  ): Promise<
    | { kind: "active"; tunnel: ActiveTunnel; exitConfirmed: boolean }
    | { kind: "pending"; tunnel: PendingTunnel }
    | undefined
  > {
    const tracked = [...this.tunnels.values()].find((entry) => entry.projectName === projectName);
    if (!tracked) {
      return undefined;
    }
    if (tracked.state === "pending") {
      const pending = this.cancelPending(tracked.id);
      return pending ? { kind: "pending", tunnel: pending } : undefined;
    }
    const outcome = await this.stop(tracked.id, reason);
    return outcome ? { kind: "active", tunnel: outcome.tunnel, exitConfirmed: outcome.exitConfirmed } : undefined;
  }

  /**
   * Stops/cancels every tracked tunnel (shutdown, or the owner disabling the
   * feature). Returns only the tunnels whose exit was confirmed; a tunnel whose
   * kill did not confirm stays tracked and is not reported as stopped here.
   */
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
      if (stopped?.exitConfirmed) results.push(stopped.tunnel);
    }
    return results;
  }

  private async killWithEscalation(child: TunnelChildProcess, observation: ExitObservation): Promise<boolean> {
    if (observation.hasExited()) {
      return true;
    }
    const graceMs = this.deps.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    if (await this.awaitExitOrTimeout(observation, graceMs, () => child.kill("SIGTERM"))) {
      return true;
    }
    return this.awaitExitOrTimeout(observation, graceMs, () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // signal unsupported on this platform; nothing more we can do.
      }
    });
  }

  /**
   * Sends a signal and races the child's single exit observation against a grace
   * timeout. Because the observation was attached before any signal was ever
   * sent, an exit that fires the instant the timeout resolves false is still
   * recorded on the observation, so no caller downstream can miss it.
   */
  private awaitExitOrTimeout(observation: ExitObservation, timeoutMs: number, act: () => void): Promise<boolean> {
    if (observation.hasExited()) {
      return Promise.resolve(true);
    }
    const schedule = this.deps.scheduleTimeout ?? defaultSchedule;
    const clear = this.deps.clearScheduledTimeout ?? defaultClear;
    return new Promise((resolve) => {
      let settled = false;
      const timer = schedule(() => {
        if (settled) return;
        settled = true;
        resolve(false);
      }, timeoutMs);
      void observation.exited.then(() => {
        if (settled) return;
        settled = true;
        clear(timer);
        resolve(true);
      });
      act();
    });
  }

  /**
   * Durably records the spawned pid so a restart can reconcile orphans, and
   * releases the record only once a real exit is observed: a kill that never
   * confirms keeps its entry, so the next startup still knows to hunt it down.
   * Awaited by launch() before the tunnel is exposed; it throws (so launch fails
   * closed) if the record cannot be written, or if the child reports no pid and
   * therefore cannot be tracked at all.
   */
  private async recordChildProcess(
    id: string,
    origin: string,
    child: TunnelChildProcess,
    observation: ExitObservation
  ): Promise<void> {
    const ledger = this.deps.processLedger;
    if (!ledger) {
      return;
    }
    if (typeof child.pid !== "number") {
      throw new Error("cloudflared did not report a process id");
    }
    const createdAt = (this.deps.now?.() ?? new Date()).toISOString();
    // Capture a recycle-resistant identity (process group + kernel start time)
    // alongside the pid and the invocation signature, so a later reconcile can
    // prove the pid is still this exact cloudflared before ever signalling it.
    const capture = this.deps.captureProcessIdentity ?? defaultCaptureProcessIdentity;
    const identity = await capture(child.pid).catch(() => ({}) as DurableProcessIdentity);
    await ledger.record({
      id,
      pid: child.pid,
      origin,
      createdAt,
      argvSignature: tunnelInvocationSignature(origin),
      ...(typeof identity.pgid === "number" ? { pgid: identity.pgid } : {}),
      ...(identity.startTime ? { startTime: identity.startTime } : {})
    });
    void observation.exited.then(() => {
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
