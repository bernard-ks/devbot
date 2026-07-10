import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { hardenPrivateDirectoryPermissions, PRIVATE_DIRECTORY_MODE } from "./security.js";

const execFileAsync = promisify(execFile);

const DEFAULT_RECONCILE_GRACE_MS = 5_000;
const RECONCILE_POLL_MS = 100;

export interface TunnelProcessRecord {
  id: string;
  pid: number;
  origin: string;
  createdAt: string;
}

export interface ReconcileDeps {
  isAlive?: (pid: number) => boolean;
  commandForPid?: (pid: number) => Promise<string | undefined>;
  killPid?: (pid: number, signal: NodeJS.Signals) => void;
  sleepMs?: (ms: number) => Promise<void>;
  killGraceMs?: number;
}

export interface ReconcileSummary {
  alreadyGone: number;
  killed: number;
  unverified: number;
  survived: number;
}

/**
 * Persists the pid of every spawned cloudflared child so an unclean Devbot
 * exit (crash, SIGKILL) does not silently leave a public tunnel running: the
 * next startup reconciles the ledger, killing any recorded process that is
 * still alive and still identifiable as cloudflared. Records are released
 * only when a real exit is observed, so a kill that never confirms stays in
 * the ledger for the next startup to retry.
 */
export class TunnelProcessLedger {
  private records: TunnelProcessRecord[];
  private readonly bootRecordIds: Set<string>;
  private mutationQueue: Promise<unknown> = Promise.resolve();
  private readonly filePath: string;

  constructor(filePath = ".devbot/preview-tunnels.json") {
    this.filePath = path.resolve(filePath);
    this.records = loadRecords(this.filePath);
    this.bootRecordIds = new Set(this.records.map((record) => record.id));
  }

  list(): TunnelProcessRecord[] {
    return this.records.map((record) => ({ ...record }));
  }

  record(entry: TunnelProcessRecord): Promise<void> {
    return this.mutate((records) => {
      const next = records.filter((record) => record.id !== entry.id);
      next.push({ ...entry });
      return next;
    });
  }

  release(id: string): Promise<void> {
    return this.mutate((records) => records.filter((record) => record.id !== id));
  }

  /**
   * Kills orphaned cloudflared processes left by a previous runtime. Only
   * touches records that already existed at construction time, never pids it
   * cannot positively identify as cloudflared (pid recycling), and keeps any
   * record whose process survives SIGTERM and SIGKILL so the next startup
   * tries again.
   */
  reconcile(deps: ReconcileDeps = {}): Promise<ReconcileSummary> {
    const isAlive = deps.isAlive ?? defaultIsAlive;
    const commandForPid = deps.commandForPid ?? defaultCommandForPid;
    const killPid = deps.killPid ?? defaultKillPid;
    const sleepMs = deps.sleepMs ?? defaultSleep;
    const graceMs = deps.killGraceMs ?? DEFAULT_RECONCILE_GRACE_MS;

    return this.mutate(async (records) => {
      const summary: ReconcileSummary = { alreadyGone: 0, killed: 0, unverified: 0, survived: 0 };
      const remaining: TunnelProcessRecord[] = [];
      for (const record of records) {
        if (!this.bootRecordIds.has(record.id)) {
          remaining.push(record);
          continue;
        }
        if (!isAlive(record.pid)) {
          summary.alreadyGone += 1;
          continue;
        }
        const command = await commandForPid(record.pid);
        if (command === undefined) {
          // Could not verify what the pid is now; never signal blindly, but
          // keep the record so a later startup can try again.
          summary.unverified += 1;
          remaining.push(record);
          continue;
        }
        if (!command.toLowerCase().includes("cloudflared")) {
          // The pid was recycled by an unrelated process: the original
          // cloudflared is gone, and this pid must not be signalled.
          summary.alreadyGone += 1;
          continue;
        }
        killPid(record.pid, "SIGTERM");
        if (await waitUntilGone(record.pid, isAlive, sleepMs, graceMs)) {
          summary.killed += 1;
          continue;
        }
        try {
          killPid(record.pid, "SIGKILL");
        } catch {
          // signal unsupported on this platform; the poll below decides.
        }
        if (await waitUntilGone(record.pid, isAlive, sleepMs, graceMs)) {
          summary.killed += 1;
          continue;
        }
        summary.survived += 1;
        remaining.push(record);
      }
      return { records: remaining, result: summary };
    });
  }

  private mutate(change: (records: TunnelProcessRecord[]) => TunnelProcessRecord[]): Promise<void>;
  private mutate<T>(
    change: (records: TunnelProcessRecord[]) => Promise<{ records: TunnelProcessRecord[]; result: T }>
  ): Promise<T>;
  private mutate<T>(
    change: (records: TunnelProcessRecord[]) =>
      | TunnelProcessRecord[]
      | Promise<{ records: TunnelProcessRecord[]; result: T }>
  ): Promise<T | void> {
    const run = this.mutationQueue.then(async () => {
      const outcome = await change(this.records.map((record) => ({ ...record })));
      const next = Array.isArray(outcome) ? outcome : outcome.records;
      await persistRecords(this.filePath, next);
      this.records = next;
      return Array.isArray(outcome) ? undefined : outcome.result;
    });
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

async function waitUntilGone(
  pid: number,
  isAlive: (pid: number) => boolean,
  sleepMs: (ms: number) => Promise<void>,
  graceMs: number
): Promise<boolean> {
  const deadline = Date.now() + graceMs;
  while (isAlive(pid)) {
    if (Date.now() >= deadline) {
      return false;
    }
    await sleepMs(RECONCILE_POLL_MS);
  }
  return true;
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function defaultCommandForPid(pid: number): Promise<string | undefined> {
  if (process.platform === "win32") {
    return undefined;
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "comm="], { timeout: 5_000, maxBuffer: 10_000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function defaultKillPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // ESRCH (already gone) and EPERM both resolve through the liveness poll.
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const handle = setTimeout(resolve, ms);
    handle.unref?.();
  });
}

function loadRecords(filePath: string): TunnelProcessRecord[] {
  if (!existsSync(filePath)) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const raw = entry as Partial<TunnelProcessRecord>;
    if (typeof raw.id !== "string" || !raw.id || !Number.isInteger(raw.pid) || (raw.pid as number) <= 0) {
      return [];
    }
    return [{
      id: raw.id,
      pid: raw.pid as number,
      origin: typeof raw.origin === "string" ? raw.origin : "unknown",
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date(0).toISOString()
    }];
  });
}

async function persistRecords(filePath: string, records: TunnelProcessRecord[]): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await hardenPrivateDirectoryPermissions(directory);
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(records, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, filePath);
}
