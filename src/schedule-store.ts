import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

export type ScheduleMode = "answer" | "action";

export type ScheduleSpec =
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekdays"; hour: number; minute: number }
  | { kind: "every-hours"; hours: number };

export interface ScheduleEntry {
  id: string;
  spec: string;
  project: string;
  taskText: string;
  mode: ScheduleMode;
  enabled: boolean;
  addedBy: string;
  createdAt: string;
  lastRun?: string;
  lastResult?: string;
  nextRun: string;
}

export interface AddScheduleInput {
  spec: string;
  project: string;
  taskText: string;
  mode: ScheduleMode;
  addedBy: string;
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
        taskText: input.taskText,
        mode: input.mode,
        enabled: true,
        addedBy: input.addedBy,
        createdAt: now.toISOString(),
        nextRun: nextRunAfter(parsed, now).toISOString()
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

  async due(now = new Date()): Promise<ScheduleEntry[]> {
    const state = await this.readState();
    return state.entries
      .filter((entry) => entry.enabled && new Date(entry.nextRun).getTime() <= now.getTime())
      .map((entry) => ({ ...entry }));
  }

  async markRun(id: string, result: string, now = new Date()): Promise<void> {
    await this.mutate((state) => {
      const entry = state.entries.find((item) => item.id === id);
      if (!entry) {
        return;
      }
      const parsed = parseScheduleSpec(entry.spec);
      entry.lastRun = now.toISOString();
      entry.lastResult = result;
      if (parsed) {
        entry.nextRun = nextRunAfter(parsed, now).toISOString();
      }
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
        if (!entry.enabled) {
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
      const parsed = JSON.parse(await readFile(this.stateFile, "utf8")) as ScheduleStateFile;
      this.state = { version: 1, entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
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

    await mkdir(path.dirname(this.stateFile), { recursive: true });
    const tempFile = `${this.stateFile}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    await writeFile(tempFile, `${JSON.stringify(this.state, null, 2)}\n`);
    await rename(tempFile, this.stateFile);
  }
}

export function formatScheduleList(entries: ScheduleEntry[]): string {
  if (entries.length === 0) {
    return "No scheduled tasks. Use `/schedule add` to create one.";
  }

  return entries
    .map((entry) => {
      const state = entry.enabled ? "enabled" : "paused";
      const last = entry.lastRun ? `, last run ${new Date(entry.lastRun).toLocaleString()}` : "";
      const next = entry.enabled ? `, next ${new Date(entry.nextRun).toLocaleString()}` : "";
      return `- \`${entry.id}\` ${state} \`${entry.spec}\` ${entry.mode} on \`${entry.project}\` by ${entry.addedBy}${last}${next}\n  ${truncate(entry.taskText, 120)}`;
    })
    .join("\n");
}

function newScheduleId(): string {
  return `sched-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}...`;
}
