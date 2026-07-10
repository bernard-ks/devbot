import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { ModelTier } from "./request-router.js";
import type { DuelVerdictOverall, ReviewerIndependence, ResolvedDuelIssue } from "./duel.js";
import { hardenPrivateDirectoryPermissions, hardenPrivateFilePermissions, PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE } from "./security.js";

export type DuelRunStatus = "running" | "succeeded" | "failed" | "canceled";

export interface DuelEvidenceSummary {
  baseRevision?: string;
  headRevision?: string;
  patchHash: string;
  fileCount: number;
  includedFileCount: number;
  truncated: boolean;
}

export interface DuelRecord {
  id: string;
  taskId: string;
  projectName: string;
  status: DuelRunStatus;
  authorTier?: ModelTier;
  reviewerTier?: ModelTier;
  reviewerIndependence?: ReviewerIndependence;
  evidence?: DuelEvidenceSummary;
  overall?: DuelVerdictOverall;
  issues: ResolvedDuelIssue[];
  dismissed: boolean;
  dismissedBy?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

interface DuelStateFile {
  version: 1;
  duels: DuelRecord[];
}

const MAX_ISSUES = 100;
const MAX_ISSUE_TEXT = 2_000;

export class DuelStore {
  private state: DuelStateFile | undefined;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly stateFile = path.resolve(".devbot", "duels.json"),
    private readonly maxRecords = 300
  ) {}

  /** Creates a "running" record before any model work happens. If an earlier duel for the same
   *  task is still "running" (e.g. the process crashed mid-flight), it is superseded first so
   *  restart-safe reconciliation never leaves two open "running" records for one task. */
  async start(input: { id: string; taskId: string; projectName: string }): Promise<DuelRecord> {
    return this.mutate((state) => {
      const now = new Date().toISOString();
      for (const existing of state.duels) {
        if (existing.taskId === input.taskId && existing.status === "running") {
          existing.status = "failed";
          existing.error = "Superseded by a new duel review request for the same task.";
          existing.updatedAt = now;
        }
      }
      const record: DuelRecord = {
        id: input.id,
        taskId: input.taskId,
        projectName: input.projectName,
        status: "running",
        issues: [],
        dismissed: false,
        createdAt: now,
        updatedAt: now
      };
      state.duels = state.duels.filter((existing) => existing.id !== input.id);
      state.duels.unshift(record);
      state.duels = state.duels.slice(0, this.maxRecords);
      return cloneRecord(record);
    });
  }

  async succeed(
    id: string,
    result: {
      authorTier: ModelTier;
      reviewerTier: ModelTier;
      reviewerIndependence: ReviewerIndependence;
      evidence: DuelEvidenceSummary;
      overall: DuelVerdictOverall;
      issues: ResolvedDuelIssue[];
    }
  ): Promise<DuelRecord | undefined> {
    return this.update(id, (record, now) => {
      if (record.status !== "running") return;
      record.status = "succeeded";
      record.authorTier = result.authorTier;
      record.reviewerTier = result.reviewerTier;
      record.reviewerIndependence = result.reviewerIndependence;
      record.evidence = result.evidence;
      record.overall = result.overall;
      record.issues = boundIssues(result.issues);
      record.updatedAt = now;
    });
  }

  async fail(id: string, error: unknown): Promise<DuelRecord | undefined> {
    return this.update(id, (record, now) => {
      if (record.status !== "running") return;
      record.status = "failed";
      record.error = (error instanceof Error ? error.message : String(error)).slice(0, 800);
      record.updatedAt = now;
    });
  }

  async get(id: string): Promise<DuelRecord | undefined> {
    const state = await this.readState();
    const record = state.duels.find((item) => item.id === id);
    return record ? cloneRecord(record) : undefined;
  }

  /** Atomic compare-and-set: only the first dismissal of a succeeded duel gets `dismissed: true`;
   *  duplicate submissions see the already-dismissed record. */
  async dismiss(id: string, actor: string): Promise<{ dismissed: boolean; record: DuelRecord | undefined }> {
    let dismissed = false;
    const record = await this.update(id, (record, now) => {
      if (record.dismissed || record.status !== "succeeded") return;
      dismissed = true;
      record.dismissed = true;
      record.dismissedBy = actor;
      record.updatedAt = now;
    });
    return { dismissed, record };
  }

  /** Marks every still-"running" duel as failed and returns their ids so the startup path can
   *  reconcile each one's side effects (a duel's id is its collaboration conversation id). A
   *  crash-interrupted duel otherwise leaves its collaboration conversation open forever, which
   *  keeps consuming the collaboration limit. */
  async interruptRunning(reason = "Interrupted when Devbot restarted."): Promise<string[]> {
    return this.mutate((state) => {
      const now = new Date().toISOString();
      const interrupted: string[] = [];
      for (const record of state.duels) {
        if (record.status !== "running") continue;
        record.status = "failed";
        record.error = reason;
        record.updatedAt = now;
        interrupted.push(record.id);
      }
      return interrupted;
    });
  }

  private async update(id: string, apply: (record: DuelRecord, now: string) => void): Promise<DuelRecord | undefined> {
    return this.mutate((state) => {
      const record = state.duels.find((item) => item.id === id);
      if (!record) return undefined;
      const now = new Date().toISOString();
      apply(record, now);
      return cloneRecord(record);
    });
  }

  private async readState(): Promise<DuelStateFile> {
    await this.mutationTail;
    return this.load();
  }

  private async mutate<T>(mutation: (state: DuelStateFile) => T): Promise<T> {
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

  private async load(): Promise<DuelStateFile> {
    if (this.state) {
      return this.state;
    }

    try {
      const parsed = JSON.parse(await readFile(this.stateFile, "utf8")) as { version?: unknown; duels?: unknown };
      await hardenPrivateFilePermissions(this.stateFile);
      if (parsed.version !== undefined && parsed.version !== 1) {
        throw new Error(`Unsupported duel state version: ${String(parsed.version)}.`);
      }
      this.state = { version: 1, duels: Array.isArray(parsed.duels) ? parsed.duels.filter(isValidDuelRecord) : [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`Unable to read duel state at ${this.stateFile}: ${(error as Error).message}`, { cause: error });
      }
      this.state = { version: 1, duels: [] };
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

function boundIssues(issues: ResolvedDuelIssue[]): ResolvedDuelIssue[] {
  return issues.slice(0, MAX_ISSUES).map((issue) => ({
    ...issue,
    claim: issue.claim.slice(0, MAX_ISSUE_TEXT),
    authorNote: issue.authorNote.slice(0, MAX_ISSUE_TEXT)
  }));
}

const RUN_STATUSES: DuelRunStatus[] = ["running", "succeeded", "failed", "canceled"];

/** Fail closed on persisted state: records that no longer match the typed schema are dropped on
 *  load rather than trusted, so a tampered or corrupted state file cannot smuggle in an
 *  unexpected shape. */
function isValidDuelRecord(candidate: unknown): candidate is DuelRecord {
  if (typeof candidate !== "object" || candidate === null) {
    return false;
  }
  const record = candidate as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.taskId === "string" &&
    typeof record.projectName === "string" &&
    RUN_STATUSES.includes(record.status as DuelRunStatus) &&
    typeof record.dismissed === "boolean" &&
    Array.isArray(record.issues) &&
    record.issues.every(
      (issue) =>
        typeof issue === "object" &&
        issue !== null &&
        typeof (issue as Record<string, unknown>).claim === "string" &&
        typeof (issue as Record<string, unknown>).authorNote === "string" &&
        ["conceded", "disputed"].includes((issue as Record<string, unknown>).status as string)
    ) &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string"
  );
}

function cloneRecord(record: DuelRecord): DuelRecord {
  return { ...record, issues: record.issues.map((issue) => ({ ...issue })) };
}
