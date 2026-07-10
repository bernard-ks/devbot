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

/**
 * A recorded cloudflared child. Beyond the raw `pid` (which the OS recycles),
 * the record carries a durable process identity — the process group id, the
 * kernel-reported start time, and the invocation/argv signature — so a later
 * reconcile can prove the pid still belongs to the *same* cloudflared it
 * recorded, not a recycled pid that merely happens to be another cloudflared.
 * The identity fields are optional only so a partial/legacy record still loads;
 * a record missing any of them can never be positively verified, so reconcile
 * refuses to signal it.
 */
export interface TunnelProcessRecord {
  id: string;
  pid: number;
  origin: string;
  createdAt: string;
  pgid?: number;
  startTime?: string;
  argvSignature?: string;
}

/**
 * The live identity of a pid as observed at reconcile time. Every field must
 * match the recorded identity before the pid is signalled.
 */
export interface ProcessIdentity {
  command: string;
  pgid?: number;
  startTime?: string;
}

export interface ReconcileDeps {
  isAlive?: (pid: number) => boolean;
  identifyProcess?: (pid: number) => Promise<ProcessIdentity | undefined>;
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
   * cannot positively re-identify as the *same* cloudflared it recorded (pid
   * recycling — even by an unrelated cloudflared — is refused), and keeps any
   * record whose process survives SIGTERM and SIGKILL so the next startup
   * tries again.
   */
  reconcile(deps: ReconcileDeps = {}): Promise<ReconcileSummary> {
    const isAlive = deps.isAlive ?? defaultIsAlive;
    const identifyProcess = deps.identifyProcess ?? defaultIdentifyProcess;
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
        const identity = await identifyProcess(record.pid);
        if (identity === undefined) {
          // Could not read the pid's current identity; never signal blindly,
          // but keep the record so a later startup can try again.
          summary.unverified += 1;
          remaining.push(record);
          continue;
        }
        if (!recordCarriesFullIdentity(record)) {
          // The record predates (or lost) the durable identity fields, so this
          // live pid can never be positively proven to be the one we recorded.
          // Default-deny: refuse to signal, keep it for a human to inspect.
          summary.unverified += 1;
          remaining.push(record);
          continue;
        }
        if (!identityMatchesRecord(record, identity)) {
          // The live pid is not the cloudflared we recorded: its start time,
          // process group, or invocation no longer matches (a recycled pid,
          // even one belonging to a *different* cloudflared). The original is
          // gone, and this pid must not be signalled.
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

/** True only when a record carries every durable-identity field needed to prove a live pid is the one it recorded. */
function recordCarriesFullIdentity(record: TunnelProcessRecord): boolean {
  return (
    typeof record.pgid === "number" &&
    typeof record.startTime === "string" &&
    record.startTime.length > 0 &&
    typeof record.argvSignature === "string" &&
    record.argvSignature.length > 0
  );
}

/**
 * A live pid is the recorded cloudflared only if ALL of its durable identity
 * matches: it is still a cloudflared, its full invocation still carries the
 * recorded argv signature, its process group is unchanged, and — the strongest
 * signal against pid recycling — its kernel start time is identical. Any single
 * mismatch fails the check, so the pid is never signalled.
 */
function identityMatchesRecord(record: TunnelProcessRecord, identity: ProcessIdentity): boolean {
  if (!identity.command.toLowerCase().includes("cloudflared")) {
    return false;
  }
  if (!record.argvSignature || !identity.command.includes(record.argvSignature)) {
    return false;
  }
  if (identity.pgid === undefined || identity.pgid !== record.pgid) {
    return false;
  }
  if (!identity.startTime || identity.startTime !== record.startTime) {
    return false;
  }
  return true;
}

/**
 * Parses one `ps -o pgid=,lstart=,command=` row into a live process identity.
 * `lstart` is a fixed five-field timestamp (e.g. `Fri Jul 10 12:34:56 2026`),
 * which is what makes it a reliable per-process fingerprint the pid alone is
 * not.
 */
export function parseProcessIdentityLine(psOutput: string): ProcessIdentity | undefined {
  const line = psOutput.split("\n").find((entry) => entry.trim().length > 0);
  if (!line) {
    return undefined;
  }
  const match = /^\s*(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*\S)\s*$/.exec(line);
  if (!match?.[2] || !match[3]) {
    return undefined;
  }
  return { pgid: Number(match[1]), startTime: match[2], command: match[3] };
}

async function defaultIdentifyProcess(pid: number): Promise<ProcessIdentity | undefined> {
  if (process.platform === "win32") {
    return undefined;
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "pgid=,lstart=,command="], {
      timeout: 5_000,
      maxBuffer: 10_000
    });
    return parseProcessIdentityLine(stdout);
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
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date(0).toISOString(),
      ...(Number.isInteger(raw.pgid) && (raw.pgid as number) > 0 ? { pgid: raw.pgid as number } : {}),
      ...(typeof raw.startTime === "string" && raw.startTime ? { startTime: raw.startTime } : {}),
      ...(typeof raw.argvSignature === "string" && raw.argvSignature ? { argvSignature: raw.argvSignature } : {})
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
