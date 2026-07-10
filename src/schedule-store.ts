import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  hardenPrivateDirectoryPermissions,
  hardenPrivateFilePermissions,
  neutralizeMentions,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  redactSensitiveText
} from "./security.js";
import { probeWorker, type WorkerIdentity, type WorkerLiveness } from "./worker-identity.js";

/**
 * Recurring schedules are read-only (`answer`) by default and by omission: an occurrence
 * fires unattended, with nobody in the loop to approve that specific run. `action` mode
 * is an explicit choice, and even then an occurrence never executes writes by itself: it
 * either posts an approval-gated proposal card, or runs under a standing approval a
 * controller granted ahead of time with a mandatory expiry, max-run budget, and review
 * policy. Every ambiguous or degraded state falls back to a proposal card, never to
 * silent execution.
 */
export type ScheduleMode = "answer" | "action";

export type ScheduleSpec =
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekdays"; hour: number; minute: number }
  | { kind: "every-hours"; hours: number };

const SCHEDULE_ID_PATTERN = /^sched-[a-z0-9-]{1,64}$/i;
const PROPOSAL_TASK_ID_PATTERN = /^task-[a-z0-9-]{1,52}$/i;

/**
 * A controller's pre-authorization for unattended `action` occurrences. Expiry and the
 * max-run budget are mandatory, and at least one review checkpoint (run count or time)
 * must be set: once any of them is crossed, the next occurrence requires fresh approval
 * again via a proposal card.
 */
export interface StandingApproval {
  grantedBy: string;
  grantedById: string;
  grantedAt: string;
  expiresAt: string;
  maxRuns: number;
  runsUsed: number;
  reviewAfterRuns?: number;
  reviewAt?: string;
}

export interface StandingApprovalRevocation {
  by: string;
  byId: string;
  at: string;
}

export type StandingApprovalRefusal = "none" | "revoked" | "expired" | "exhausted" | "review-due";

export type StandingApprovalDecision =
  | { ok: true; approval: StandingApproval }
  | { ok: false; reason: StandingApprovalRefusal };

export interface GrantStandingApprovalInput {
  grantedBy: string;
  grantedById: string;
  expiresAt: Date;
  maxRuns: number;
  reviewAfterRuns?: number;
  reviewAt?: Date;
}

export interface ScheduleEntry {
  id: string;
  spec: string;
  project: string;
  taskText: string;
  mode: ScheduleMode;
  enabled: boolean;
  addedBy: string;
  addedById: string;
  createdAt: string;
  lastRun?: string;
  lastResult?: string;
  lastProposalTaskId?: string;
  standingApproval?: StandingApproval;
  standingApprovalRevoked?: StandingApprovalRevocation;
  nextRun: string;
  running: boolean;
  runStartedAt?: string;
  /**
   * Strong identity of the detached worker executing this occurrence, persisted
   * so a later runtime can verify whether that specific process is still alive
   * before deciding to release the occurrence.
   */
  worker?: WorkerIdentity;
  /**
   * Set when startup recovery could neither confirm the worker died nor confirm
   * it is alive. The occurrence is left `running` (never auto-reclaimed) with an
   * honest blocked status rather than risking a second concurrent execution.
   */
  recoveryBlocked?: boolean;
}

export interface AddScheduleInput {
  spec: string;
  project: string;
  taskText: string;
  mode?: ScheduleMode;
  addedBy: string;
  addedById: string;
}

interface ScheduleStateFile {
  version: 1;
  entries: ScheduleEntry[];
}

const DAILY_PATTERN = /^daily\s+(\d{1,2}):(\d{2})$/;
const WEEKDAYS_PATTERN = /^weekdays\s+(\d{1,2}):(\d{2})$/;
const EVERY_HOURS_PATTERN = /^every\s+(\d+)h$/;

export function parseScheduleSpec(raw: string): ScheduleSpec | undefined {
  const text = raw.trim().toLowerCase();

  const daily = DAILY_PATTERN.exec(text);
  if (daily) {
    return timeSpec("daily", daily);
  }

  const weekdays = WEEKDAYS_PATTERN.exec(text);
  if (weekdays) {
    return timeSpec("weekdays", weekdays);
  }

  const everyHours = EVERY_HOURS_PATTERN.exec(text);
  if (everyHours) {
    const hours = Number(everyHours[1]);
    return hours > 0 ? { kind: "every-hours", hours } : undefined;
  }

  return undefined;
}

function timeSpec(kind: "daily" | "weekdays", match: RegExpExecArray): ScheduleSpec | undefined {
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!isValidTime(hour, minute)) {
    return undefined;
  }
  return { kind, hour, minute };
}

function isValidTime(hour: number, minute: number): boolean {
  return Number.isInteger(hour) && Number.isInteger(minute) && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

export function describeScheduleSpec(spec: ScheduleSpec): string {
  if (spec.kind === "every-hours") {
    return `every ${spec.hours}h`;
  }
  const time = `${String(spec.hour).padStart(2, "0")}:${String(spec.minute).padStart(2, "0")}`;
  return spec.kind === "daily" ? `daily ${time}` : `weekdays ${time}`;
}

/**
 * Local-time, DST-naive: next-run math uses the host's local calendar/clock via `Date`
 * setters, so days that gain/lose an hour under DST are not specially accounted for.
 */
export function nextRunAfter(spec: ScheduleSpec, reference: Date): Date {
  if (spec.kind === "every-hours") {
    return new Date(reference.getTime() + spec.hours * 3_600_000);
  }

  const next = new Date(reference);
  next.setHours(spec.hour, spec.minute, 0, 0);
  if (next.getTime() <= reference.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  if (spec.kind === "weekdays") {
    while (isWeekend(next)) {
      next.setDate(next.getDate() + 1);
    }
  }
  return next;
}

function isWeekend(date: Date): boolean {
  const day = date.getDay();
  return day === 0 || day === 6;
}

export class ScheduleStore {
  private state: ScheduleStateFile | undefined;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly stateFile = path.resolve(".devbot", "schedule.json")) {}

  async add(input: AddScheduleInput): Promise<ScheduleEntry> {
    const parsed = parseScheduleSpec(input.spec);
    if (!parsed) {
      throw new Error(
        "Unrecognized schedule spec. Use `daily HH:MM`, `weekdays HH:MM`, or `every <N>h`, for example `daily 07:00`."
      );
    }
    return this.mutate((state) => {
      const now = new Date();
      const entry: ScheduleEntry = {
        id: newScheduleId(),
        spec: describeScheduleSpec(parsed),
        project: input.project,
        taskText: sanitizeText(input.taskText),
        // Omission fails safe: only an explicit `action` choice yields a write-capable
        // (still approval-gated) schedule.
        mode: input.mode === "action" ? "action" : "answer",
        enabled: true,
        addedBy: input.addedBy,
        addedById: input.addedById,
        createdAt: now.toISOString(),
        nextRun: nextRunAfter(parsed, now).toISOString(),
        running: false
      };
      state.entries.push(entry);
      return { ...entry };
    });
  }

  async list(): Promise<ScheduleEntry[]> {
    const state = await this.readState();
    return state.entries.map((entry) => ({ ...entry }));
  }

  async get(id: string): Promise<ScheduleEntry | undefined> {
    const state = await this.readState();
    const entry = state.entries.find((item) => item.id === id);
    return entry ? { ...entry } : undefined;
  }

  async remove(id: string): Promise<boolean> {
    return this.mutate((state) => {
      const index = state.entries.findIndex((entry) => entry.id === id);
      if (index === -1) {
        return false;
      }
      state.entries.splice(index, 1);
      return true;
    });
  }

  async setEnabled(id: string, enabled: boolean): Promise<ScheduleEntry | undefined> {
    return this.mutate((state) => {
      const entry = state.entries.find((item) => item.id === id);
      if (!entry) {
        return undefined;
      }
      entry.enabled = enabled;
      if (enabled) {
        const parsed = parseScheduleSpec(entry.spec);
        if (parsed) {
          entry.nextRun = nextRunAfter(parsed, new Date()).toISOString();
        }
      }
      return { ...entry };
    });
  }

  async grantStandingApproval(id: string, input: GrantStandingApprovalInput): Promise<ScheduleEntry> {
    return this.mutate((state) => {
      const entry = state.entries.find((item) => item.id === id);
      if (!entry) {
        throw new Error(`No scheduled task found for \`${id}\`.`);
      }
      if (entry.mode !== "action") {
        throw new Error("Standing approvals only apply to action schedules; read-only schedules never need one.");
      }
      const now = new Date();
      if (!(input.expiresAt.getTime() > now.getTime())) {
        throw new Error("A standing approval needs an expiry in the future.");
      }
      if (!Number.isSafeInteger(input.maxRuns) || input.maxRuns < 1) {
        throw new Error("A standing approval needs a positive max-run budget.");
      }
      if (input.reviewAfterRuns !== undefined && (!Number.isSafeInteger(input.reviewAfterRuns) || input.reviewAfterRuns < 1)) {
        throw new Error("The review-after-runs checkpoint must be a positive number of runs.");
      }
      if (input.reviewAt !== undefined && !(input.reviewAt.getTime() > now.getTime())) {
        throw new Error("The review time checkpoint must be in the future.");
      }
      if (input.reviewAfterRuns === undefined && input.reviewAt === undefined) {
        throw new Error("A standing approval needs a review policy: set review-after-runs and/or review-after-hours.");
      }
      entry.standingApproval = {
        grantedBy: input.grantedBy,
        grantedById: input.grantedById,
        grantedAt: now.toISOString(),
        expiresAt: input.expiresAt.toISOString(),
        maxRuns: input.maxRuns,
        runsUsed: 0,
        ...(input.reviewAfterRuns !== undefined ? { reviewAfterRuns: input.reviewAfterRuns } : {}),
        ...(input.reviewAt !== undefined ? { reviewAt: input.reviewAt.toISOString() } : {})
      };
      delete entry.standingApprovalRevoked;
      return { ...entry };
    });
  }

  async revokeStandingApproval(id: string, actor: string, actorId: string): Promise<ScheduleEntry | undefined> {
    return this.mutate((state) => {
      const entry = state.entries.find((item) => item.id === id);
      if (!entry?.standingApproval) {
        return undefined;
      }
      delete entry.standingApproval;
      entry.standingApprovalRevoked = { by: actor, byId: actorId, at: new Date().toISOString() };
      return { ...entry };
    });
  }

  /**
   * Atomically checks the entry's standing approval and, only when it is still valid,
   * consumes one run from its budget in the same persisted mutation. Any other state
   * (missing, revoked, expired, exhausted, or past a review checkpoint) refuses with a
   * reason so the occurrence falls back to an approval-gated proposal, never to silent
   * execution.
   */
  async consumeStandingApproval(id: string, now = new Date()): Promise<StandingApprovalDecision> {
    return this.mutate((state) => {
      const entry = state.entries.find((item) => item.id === id);
      if (!entry || entry.mode !== "action") {
        return { ok: false, reason: "none" };
      }
      const approval = entry.standingApproval;
      if (!approval) {
        return { ok: false, reason: entry.standingApprovalRevoked ? "revoked" : "none" };
      }
      const validity = standingApprovalState(approval, now);
      if (validity !== "active") {
        return { ok: false, reason: validity };
      }
      approval.runsUsed += 1;
      return { ok: true, approval: { ...approval } };
    });
  }

  /**
   * Atomically claims every enabled, due, not-already-running entry by marking it
   * `running` before the caller starts any execution side effect. A second tick that
   * runs while the first execution is still in flight will not see the entry again,
   * so the same occurrence can never fire twice concurrently.
   */
  async claimDue(now = new Date()): Promise<ScheduleEntry[]> {
    return this.mutate((state) => {
      const claimed: ScheduleEntry[] = [];
      const nowIso = now.toISOString();
      for (const entry of state.entries) {
        if (
          entry.enabled &&
          !entry.running &&
          !entry.recoveryBlocked &&
          new Date(entry.nextRun).getTime() <= now.getTime()
        ) {
          entry.running = true;
          entry.runStartedAt = nowIso;
          delete entry.worker;
          claimed.push({ ...entry });
        }
      }
      return claimed;
    });
  }

  async due(now = new Date()): Promise<ScheduleEntry[]> {
    const state = await this.readState();
    return state.entries
      .filter(
        (entry) =>
          entry.enabled && !entry.running && !entry.recoveryBlocked && new Date(entry.nextRun).getTime() <= now.getTime()
      )
      .map((entry) => ({ ...entry }));
  }

  /**
   * Persists the identity of the detached worker now executing a running
   * occurrence. Called as soon as the worker process is spawned so that, if this
   * runtime dies mid-occurrence, a later runtime can positively check whether
   * that specific worker survived before releasing the occurrence.
   */
  async recordRunningWorker(id: string, worker: WorkerIdentity): Promise<void> {
    await this.mutate((state) => {
      const entry = state.entries.find((item) => item.id === id);
      if (!entry || !entry.running) {
        return;
      }
      entry.worker = worker;
    });
  }

  async markRun(id: string, result: string, now = new Date()): Promise<void> {
    await this.mutate((state) => {
      const entry = state.entries.find((item) => item.id === id);
      if (!entry) {
        return;
      }
      const parsed = parseScheduleSpec(entry.spec);
      entry.running = false;
      entry.recoveryBlocked = false;
      delete entry.runStartedAt;
      delete entry.worker;
      entry.lastRun = now.toISOString();
      entry.lastResult = sanitizeText(result);
      if (parsed) {
        entry.nextRun = nextRunAfter(parsed, now).toISOString();
      }
    });
  }

  /**
   * Completes an action occurrence that produced an approval-gated proposal instead of
   * executing: releases the lease, advances `nextRun`, and durably links the occurrence
   * to its proposal task in the same mutation, so each occurrence yields at most one
   * proposal even across restarts.
   */
  async markProposed(id: string, proposalTaskId: string, note: string, now = new Date()): Promise<void> {
    if (!PROPOSAL_TASK_ID_PATTERN.test(proposalTaskId)) {
      throw new Error("Schedule occurrences can only link to a valid proposal task id.");
    }
    await this.mutate((state) => {
      const entry = state.entries.find((item) => item.id === id);
      if (!entry) {
        return;
      }
      const parsed = parseScheduleSpec(entry.spec);
      entry.running = false;
      entry.recoveryBlocked = false;
      delete entry.runStartedAt;
      delete entry.worker;
      entry.lastRun = now.toISOString();
      entry.lastResult = sanitizeText(note);
      entry.lastProposalTaskId = proposalTaskId;
      if (parsed) {
        entry.nextRun = nextRunAfter(parsed, now).toISOString();
      }
    });
  }

  /**
   * On boot, decide the fate of every occurrence still marked `running` from a
   * previous runtime. Codex workers are detached and can outlive a runtime crash,
   * so releasing unconditionally would let the next tick reclaim an occurrence
   * whose worker is still alive and run it a second time concurrently. Instead we
   * check the persisted worker identity per occurrence:
   *
   *  - worker verifiably dead (or none was ever recorded, so nothing detached can
   *    still be executing it) → release the lease and make it due again;
   *  - worker verifiably alive → leave it `running` and untouched, so no tick can
   *    reclaim it while the old worker still owns it;
   *  - ownership uncertain (a live pid we cannot match, or an unverifiable record)
   *    → leave it `running` and flag it `recoveryBlocked`, failing closed rather
   *    than risking a double execution.
   *
   * Returns only the occurrences that were actually released (made due again).
   */
  async recoverInterrupted(
    reason: string,
    probe: (worker: WorkerIdentity) => WorkerLiveness = probeWorker
  ): Promise<ScheduleEntry[]> {
    return this.mutate((state) => {
      const now = new Date();
      const released: ScheduleEntry[] = [];
      for (const entry of state.entries) {
        if (!entry.running) {
          continue;
        }
        const liveness: WorkerLiveness = entry.worker ? probe(entry.worker) : "dead";
        if (liveness === "alive") {
          // The original worker is still running this occurrence elsewhere. Leave
          // it exactly as-is; claimDue() skips running entries, so it cannot fire
          // again while the worker lives.
          entry.recoveryBlocked = false;
          continue;
        }
        if (liveness === "unknown") {
          // Cannot prove the worker is gone. Fail closed: keep the occurrence out
          // of circulation and report an honest blocked status for recovery.
          entry.recoveryBlocked = true;
          entry.lastResult = sanitizeText(
            `Blocked for recovery: ${reason} A prior worker's status could not be verified, so this occurrence was not requeued to avoid a double run.`
          );
          continue;
        }
        entry.running = false;
        entry.recoveryBlocked = false;
        delete entry.runStartedAt;
        delete entry.worker;
        entry.lastResult = sanitizeText(reason);
        entry.nextRun = now.toISOString();
        released.push({ ...entry });
      }
      return released;
    });
  }

  /**
   * Recomputes every enabled entry's `nextRun` from its spec and `lastRun` (or
   * `createdAt` if it has never run). This makes a restart self-healing: an entry
   * that was due while Devbot was offline stays due exactly once (the scheduler
   * loop will fire it on its next tick), and one that is not due yet keeps its
   * original cadence instead of drifting forward on every restart.
   */
  async reconcileOnBoot(): Promise<void> {
    await this.mutate((state) => {
      for (const entry of state.entries) {
        if (!entry.enabled || entry.running) {
          continue;
        }
        const parsed = parseScheduleSpec(entry.spec);
        if (!parsed) {
          continue;
        }
        const reference = new Date(entry.lastRun ?? entry.createdAt);
        entry.nextRun = nextRunAfter(parsed, reference).toISOString();
      }
    });
  }

  private async readState(): Promise<ScheduleStateFile> {
    await this.mutationTail;
    return this.load();
  }

  private async mutate<T>(mutation: (state: ScheduleStateFile) => T): Promise<T> {
    let result: T | undefined;
    const operation = this.mutationTail.then(async () => {
      const state = await this.load();
      const previous = structuredClone(state);
      result = mutation(state);
      try {
        await this.save();
      } catch (error) {
        this.state = previous;
        throw error;
      }
    });
    this.mutationTail = operation.catch(() => undefined);
    await operation;
    return result as T;
  }

  private async load(): Promise<ScheduleStateFile> {
    if (this.state) {
      return this.state;
    }

    try {
      const parsed = JSON.parse(await readFile(this.stateFile, "utf8")) as unknown;
      await hardenPrivateFilePermissions(this.stateFile);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Schedule state must be a JSON object.");
      }
      const raw = parsed as { version?: unknown; entries?: unknown };
      if (raw.version !== undefined && raw.version !== 1) {
        throw new Error(`Unsupported schedule state version: ${String(raw.version)}.`);
      }
      this.state = {
        version: 1,
        entries: Array.isArray(raw.entries)
          ? raw.entries.map(normalizeLoadedEntry).filter((entry): entry is ScheduleEntry => entry !== undefined)
          : []
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`Unable to read schedule state at ${this.stateFile}: ${(error as Error).message}`, { cause: error });
      }
      this.state = { version: 1, entries: [] };
    }

    return this.state;
  }

  private async save(): Promise<void> {
    if (!this.state) {
      return;
    }

    const directory = path.dirname(this.stateFile);
    await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await hardenPrivateDirectoryPermissions(directory);
    const tempFile = `${this.stateFile}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    await writeFile(tempFile, `${JSON.stringify(this.state, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: PRIVATE_FILE_MODE
    });
    await rename(tempFile, this.stateFile);
  }
}

function sanitizeText(value: string): string {
  return neutralizeMentions(redactSensitiveText(value));
}

export function standingApprovalState(
  approval: StandingApproval,
  now = new Date()
): "active" | "expired" | "exhausted" | "review-due" {
  if (now.getTime() >= new Date(approval.expiresAt).getTime()) {
    return "expired";
  }
  if (approval.runsUsed >= approval.maxRuns) {
    return "exhausted";
  }
  if (approval.reviewAfterRuns !== undefined && approval.runsUsed >= approval.reviewAfterRuns) {
    return "review-due";
  }
  if (approval.reviewAt !== undefined && now.getTime() >= new Date(approval.reviewAt).getTime()) {
    return "review-due";
  }
  return "active";
}

export function describeStandingApproval(entry: ScheduleEntry, now = new Date()): string {
  if (entry.mode !== "action") {
    return "read-only";
  }
  const approval = entry.standingApproval;
  if (!approval) {
    return entry.standingApprovalRevoked
      ? `standing approval revoked by ${entry.standingApprovalRevoked.by}; occurrences post approval cards`
      : "no standing approval; occurrences post approval cards";
  }
  const state = standingApprovalState(approval, now);
  if (state === "active") {
    const review = [
      approval.reviewAfterRuns !== undefined ? `review after ${approval.reviewAfterRuns} runs` : undefined,
      approval.reviewAt !== undefined ? `review at ${new Date(approval.reviewAt).toLocaleString()}` : undefined
    ].filter(Boolean).join(", ");
    return `standing approval by ${approval.grantedBy}: ${approval.runsUsed}/${approval.maxRuns} runs used, expires ${new Date(approval.expiresAt).toLocaleString()}, ${review}`;
  }
  return `standing approval ${state}; occurrences post approval cards`;
}

export function formatScheduleList(entries: ScheduleEntry[]): string {
  if (entries.length === 0) {
    return "No scheduled tasks. Use `/schedule add` to create one.";
  }

  return entries
    .map((entry) => {
      const state = entry.recoveryBlocked
        ? "blocked (recovery)"
        : entry.running
          ? "running"
          : entry.enabled
            ? "enabled"
            : "paused";
      const last = entry.lastRun ? `, last run ${new Date(entry.lastRun).toLocaleString()}` : "";
      const next = entry.enabled ? `, next ${new Date(entry.nextRun).toLocaleString()}` : "";
      const modeLabel = entry.mode === "action" ? "action" : "ask";
      const standing = entry.mode === "action" ? `\n  ${describeStandingApproval(entry)}` : "";
      return `- \`${entry.id}\` ${state} \`${entry.spec}\` ${modeLabel} on \`${entry.project}\` by ${entry.addedBy}${last}${next}${standing}\n  ${truncate(entry.taskText, 120)}`;
    })
    .join("\n");
}

function newScheduleId(): string {
  return `sched-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

export function isScheduleId(value: string): boolean {
  return SCHEDULE_ID_PATTERN.test(value);
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}...`;
}

function normalizeLoadedEntry(value: unknown): ScheduleEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as Partial<ScheduleEntry> & { mode?: unknown };
  if (
    // Fail closed on foreign records that claim any unknown mode: they are dropped
    // rather than coerced. A persisted `action` record is only ever approval-gated
    // (proposal card or a validated standing approval), so it is safe to keep.
    (entry.mode !== undefined && entry.mode !== "answer" && entry.mode !== "action") ||
    typeof entry.id !== "string" ||
    !isScheduleId(entry.id) ||
    typeof entry.spec !== "string" ||
    !parseScheduleSpec(entry.spec) ||
    typeof entry.project !== "string" ||
    typeof entry.taskText !== "string" ||
    typeof entry.addedBy !== "string" ||
    typeof entry.createdAt !== "string" ||
    !Number.isFinite(Date.parse(entry.createdAt)) ||
    typeof entry.nextRun !== "string" ||
    !Number.isFinite(Date.parse(entry.nextRun))
  ) {
    return undefined;
  }
  const mode: ScheduleMode = entry.mode === "action" ? "action" : "answer";
  const standingApproval = mode === "action" ? normalizeStandingApproval(entry.standingApproval) : undefined;
  const revocation = mode === "action" ? normalizeRevocation(entry.standingApprovalRevoked) : undefined;
  const lastProposalTaskId =
    mode === "action" && typeof entry.lastProposalTaskId === "string" && PROPOSAL_TASK_ID_PATTERN.test(entry.lastProposalTaskId)
      ? entry.lastProposalTaskId
      : undefined;
  return {
    id: entry.id,
    spec: entry.spec,
    project: entry.project,
    taskText: sanitizeText(entry.taskText),
    mode,
    enabled: entry.enabled === true,
    addedBy: entry.addedBy,
    addedById: stringValue(entry.addedById) ?? "unknown",
    createdAt: entry.createdAt,
    ...(validTimestamp(entry.lastRun) ? { lastRun: validTimestamp(entry.lastRun)! } : {}),
    ...(stringValue(entry.lastResult) ? { lastResult: sanitizeText(stringValue(entry.lastResult)!) } : {}),
    ...(lastProposalTaskId ? { lastProposalTaskId } : {}),
    ...(standingApproval ? { standingApproval } : {}),
    ...(revocation ? { standingApprovalRevoked: revocation } : {}),
    nextRun: entry.nextRun,
    running: entry.running === true,
    ...(validTimestamp(entry.runStartedAt) ? { runStartedAt: validTimestamp(entry.runStartedAt)! } : {}),
    ...(normalizeWorker((value as { worker?: unknown }).worker)
      ? { worker: normalizeWorker((value as { worker?: unknown }).worker)! }
      : {}),
    ...((value as { recoveryBlocked?: unknown }).recoveryBlocked === true ? { recoveryBlocked: true } : {})
  };
}

function normalizeWorker(value: unknown): WorkerIdentity | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const worker = value as Partial<WorkerIdentity>;
  if (
    !Number.isInteger(worker.pid) ||
    (worker.pid as number) <= 0 ||
    !Number.isInteger(worker.pgid) ||
    (worker.pgid as number) <= 0 ||
    !validTimestamp(worker.recordedAt)
  ) {
    return undefined;
  }
  return {
    pid: worker.pid as number,
    pgid: worker.pgid as number,
    recordedAt: worker.recordedAt as string,
    ...(stringValue(worker.startToken) ? { startToken: stringValue(worker.startToken)! } : {})
  };
}

/**
 * A standing approval that fails any structural check is dropped rather than repaired,
 * so a tampered or corrupted record degrades to "no standing approval" (proposal cards)
 * instead of unattended execution.
 */
function normalizeStandingApproval(value: unknown): StandingApproval | undefined {
  if (!value || typeof value !== "object") return undefined;
  const approval = value as Partial<StandingApproval>;
  if (
    typeof approval.grantedBy !== "string" ||
    !approval.grantedBy.trim() ||
    typeof approval.grantedById !== "string" ||
    !approval.grantedById.trim() ||
    !validTimestamp(approval.grantedAt) ||
    !validTimestamp(approval.expiresAt) ||
    !isPositiveInteger(approval.maxRuns) ||
    !Number.isSafeInteger(approval.runsUsed) ||
    (approval.runsUsed as number) < 0 ||
    (approval.reviewAfterRuns !== undefined && !isPositiveInteger(approval.reviewAfterRuns)) ||
    (approval.reviewAt !== undefined && !validTimestamp(approval.reviewAt)) ||
    (approval.reviewAfterRuns === undefined && approval.reviewAt === undefined)
  ) {
    return undefined;
  }
  return {
    grantedBy: approval.grantedBy,
    grantedById: approval.grantedById,
    grantedAt: approval.grantedAt as string,
    expiresAt: approval.expiresAt as string,
    maxRuns: approval.maxRuns as number,
    runsUsed: approval.runsUsed as number,
    ...(approval.reviewAfterRuns !== undefined ? { reviewAfterRuns: approval.reviewAfterRuns } : {}),
    ...(approval.reviewAt !== undefined ? { reviewAt: approval.reviewAt } : {})
  };
}

function normalizeRevocation(value: unknown): StandingApprovalRevocation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const revocation = value as Partial<StandingApprovalRevocation>;
  if (typeof revocation.by !== "string" || !revocation.by.trim() || typeof revocation.byId !== "string" || !revocation.byId.trim() || !validTimestamp(revocation.at)) {
    return undefined;
  }
  return { by: revocation.by, byId: revocation.byId, at: revocation.at as string };
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function validTimestamp(value: unknown): string | undefined {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined;
}
