import path from "node:path";
import { accessSync, constants } from "node:fs";
import { findProjectWebUrls } from "./project-screenshot.js";
import type { ProjectEntry } from "./types.js";

export const DEFAULT_TTL_MINUTES = 15;
export const MAX_TTL_MINUTES = 60;
export const MIN_TTL_MINUTES = 1;
const DEFAULT_URL_TIMEOUT_MS = 20_000;
const TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export type TunnelExpireReason = "ttl" | "stop" | "shutdown" | "process-exit";

export interface ActiveTunnel {
  projectName: string;
  url: string;
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
  stdout: TunnelReadableLike | null;
  stderr: TunnelReadableLike | null;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type TunnelSpawnFn = (command: string, args: string[]) => TunnelChildProcess;

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

export interface StartCloudflaredOptions {
  spawnFn: TunnelSpawnFn;
  cloudflaredPath: string;
  port: number;
  urlTimeoutMs?: number;
}

export interface StartCloudflaredResult {
  url: string;
  child: TunnelChildProcess;
}

export function startCloudflaredTunnel(options: StartCloudflaredOptions): Promise<StartCloudflaredResult> {
  const child = options.spawnFn(options.cloudflaredPath, ["tunnel", "--url", `http://127.0.0.1:${options.port}`]);
  return new Promise((resolve, reject) => {
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error("Timed out waiting for cloudflared to report a tunnel URL."));
    }, options.urlTimeoutMs ?? DEFAULT_URL_TIMEOUT_MS);

    const onData = (chunk: Buffer | string): void => {
      if (settled) return;
      const url = parseTunnelUrl(chunk.toString());
      if (!url) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ url, child });
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`cloudflared exited before reporting a tunnel URL (code ${code ?? "unknown"}).`));
    });
  });
}

export type PreviewGateReason = "no-owner" | "not-owner" | "disabled";

export function previewGateReason(
  config: { previewTunnelsEnabled: boolean; ownerUserId: string | undefined },
  requesterId: string
): PreviewGateReason | undefined {
  if (!config.ownerUserId) {
    return "no-owner";
  }
  if (requesterId !== config.ownerUserId) {
    return "not-owner";
  }
  if (!config.previewTunnelsEnabled) {
    return "disabled";
  }
  return undefined;
}

export async function findRunningProjectPort(
  project: ProjectEntry,
  probeUrl: (url: string) => Promise<boolean> = defaultProbeUrl,
  listUrls: (project: ProjectEntry) => Promise<string[]> = findProjectWebUrls
): Promise<number | undefined> {
  const urls = await listUrls(project);
  for (const url of urls) {
    if (await probeUrl(url)) {
      return portFromUrl(url);
    }
  }
  return undefined;
}

function portFromUrl(url: string): number | undefined {
  const parsed = new URL(url);
  if (parsed.port) {
    return Number(parsed.port);
  }
  return parsed.protocol === "https:" ? 443 : 80;
}

async function defaultProbeUrl(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch(url, { method: "GET", signal: controller.signal });
    return response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

interface TrackedTunnel extends ActiveTunnel {
  child: TunnelChildProcess;
  ttlTimer: unknown;
  onExpire: (tunnel: ActiveTunnel, reason: TunnelExpireReason) => void;
}

export interface StartTunnelInput {
  projectName: string;
  port: number;
  ttlMinutes?: number;
  startedBy: string;
  channelId: string;
  onExpire: (tunnel: ActiveTunnel, reason: TunnelExpireReason) => void;
}

export interface TunnelManagerDeps {
  spawnFn: TunnelSpawnFn;
  findCloudflaredPath: () => string | undefined;
  now?: () => Date;
  scheduleTimeout?: (fn: () => void, ms: number) => unknown;
  clearScheduledTimeout?: (handle: unknown) => void;
  urlTimeoutMs?: number;
}

export class TunnelManager {
  private readonly tunnels = new Map<string, TrackedTunnel>();

  constructor(private readonly deps: TunnelManagerDeps) {}

  hasActive(projectName: string): boolean {
    return this.tunnels.has(projectName);
  }

  get(projectName: string): ActiveTunnel | undefined {
    const tracked = this.tunnels.get(projectName);
    return tracked ? toActiveTunnel(tracked) : undefined;
  }

  list(): ActiveTunnel[] {
    return [...this.tunnels.values()].map(toActiveTunnel);
  }

  attachMessage(projectName: string, messageId: string): void {
    const tracked = this.tunnels.get(projectName);
    if (tracked) {
      tracked.messageId = messageId;
    }
  }

  async start(input: StartTunnelInput): Promise<ActiveTunnel> {
    if (this.tunnels.has(input.projectName)) {
      throw new Error(`Project \`${input.projectName}\` already has an active preview tunnel. Stop it before starting another.`);
    }

    const cloudflaredPath = this.deps.findCloudflaredPath();
    if (!cloudflaredPath) {
      throw new Error("cloudflared is not installed. Install it with `brew install cloudflared` and try again.");
    }

    const ttlMinutes = clampTtlMinutes(input.ttlMinutes);
    const { url, child } = await startCloudflaredTunnel({
      spawnFn: this.deps.spawnFn,
      cloudflaredPath,
      port: input.port,
      ...(this.deps.urlTimeoutMs !== undefined ? { urlTimeoutMs: this.deps.urlTimeoutMs } : {})
    });

    if (this.tunnels.has(input.projectName)) {
      child.kill("SIGTERM");
      throw new Error(`Project \`${input.projectName}\` already has an active preview tunnel. Stop it before starting another.`);
    }

    const now = this.deps.now?.() ?? new Date();
    const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000);
    const schedule = this.deps.scheduleTimeout ?? defaultSchedule;

    const tracked: TrackedTunnel = {
      projectName: input.projectName,
      url,
      port: input.port,
      ttlMinutes,
      startedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      startedBy: input.startedBy,
      channelId: input.channelId,
      child,
      ttlTimer: undefined,
      onExpire: input.onExpire
    };

    tracked.ttlTimer = schedule(() => this.expire(input.projectName, "ttl"), ttlMinutes * 60_000);

    child.on("exit", () => {
      if (this.tunnels.get(input.projectName) === tracked) {
        this.expire(input.projectName, "process-exit");
      }
    });

    this.tunnels.set(input.projectName, tracked);
    return toActiveTunnel(tracked);
  }

  stop(projectName: string): ActiveTunnel | undefined {
    const tracked = this.tunnels.get(projectName);
    if (!tracked) {
      return undefined;
    }
    this.tunnels.delete(projectName);
    this.clearTimer(tracked);
    tracked.child.kill("SIGTERM");
    return toActiveTunnel(tracked);
  }

  stopAll(): ActiveTunnel[] {
    return [...this.tunnels.keys()].map((name) => this.stop(name)).filter((tunnel): tunnel is ActiveTunnel => Boolean(tunnel));
  }

  private expire(projectName: string, reason: Exclude<TunnelExpireReason, "stop" | "shutdown">): void {
    const tracked = this.tunnels.get(projectName);
    if (!tracked) {
      return;
    }
    this.tunnels.delete(projectName);
    this.clearTimer(tracked);
    if (reason === "ttl") {
      tracked.child.kill("SIGTERM");
    }
    tracked.onExpire(toActiveTunnel(tracked), reason);
  }

  private clearTimer(tracked: TrackedTunnel): void {
    const clear = this.deps.clearScheduledTimeout ?? defaultClear;
    clear(tracked.ttlTimer);
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

function toActiveTunnel(tracked: TrackedTunnel): ActiveTunnel {
  return {
    projectName: tracked.projectName,
    url: tracked.url,
    port: tracked.port,
    ttlMinutes: tracked.ttlMinutes,
    startedAt: tracked.startedAt,
    expiresAt: tracked.expiresAt,
    startedBy: tracked.startedBy,
    channelId: tracked.channelId,
    ...(tracked.messageId ? { messageId: tracked.messageId } : {})
  };
}
