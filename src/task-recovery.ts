import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  hardenPrivateDirectoryPermissions,
  hardenPrivateFilePermissions,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  redactSensitiveText
} from "./security.js";
import { isTaskId, type TaskAccessScope, type TaskRecord } from "./task-store.js";

export type ExecutionPhase = "starting" | "routing" | "gathering-context" | "running-codex";

export interface ExecutionChildIdentity {
  pid: number;
  command: string;
  startedAt: string;
}

export interface ExecutionRecord {
  taskId: string;
  projectName: string;
  mode: string;
  phase: ExecutionPhase;
  requester: string;
  requesterId?: string;
  accessScope?: TaskAccessScope;
  channelId?: string;
  threadId?: string;
  controlMessageId?: string;
  workspacePath?: string;
  branchName?: string;
  baseBranch?: string;
  workspaceIsolated?: boolean;
  child?: ExecutionChildIdentity;
  startedAt: string;
  updatedAt: string;
}

export interface StartExecutionInput {
  taskId: string;
  projectName: string;
  mode: string;
  requester: string;
  requesterId?: string;
  accessScope?: TaskAccessScope;
  channelId?: string;
  threadId?: string;
  controlMessageId?: string;
  startedAt?: string;
}

export interface ExecutionLoadIssues {
  quarantinedTo?: string;
  invalidRecordsDropped: number;
}

interface ExecutionStateFile {
  version: 1;
  executions: ExecutionRecord[];
}

/**
 * Durable ledger of task executions that are in flight right now. Records are
 * written when a task starts running, updated at phase transitions, and
 * cleared on every in-process terminal outcome, so any record that survives a
 * restart marks work the previous runtime never finished.
 */
export class ExecutionLedger {
  private state: ExecutionStateFile | undefined;
  private issues: ExecutionLoadIssues | undefined;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly stateFile = path.resolve(".devbot", "executions.json")) {}

  async record(input: StartExecutionInput): Promise<void> {
    const now = new Date().toISOString();
    const candidate = normalizeLoadedExecution({
      ...input,
      phase: "starting",
      startedAt: input.startedAt ?? now,
      updatedAt: now
    });
    if (!candidate) {
      throw new Error("The execution record is missing required task identity fields.");
    }
    await this.mutate((state) => {
      state.executions = state.executions.filter((record) => record.taskId !== candidate.taskId);
      state.executions.unshift(candidate);
    });
  }

  async setPhase(taskId: string, phase: ExecutionPhase): Promise<void> {
    await this.update(taskId, (record) => {
      record.phase = phase;
    });
  }

  async setChild(taskId: string, child: ExecutionChildIdentity): Promise<void> {
    await this.update(taskId, (record) => {
      const normalized = normalizeChildIdentity(child);
      if (normalized) record.child = normalized;
    });
  }

  async setDiscordContext(
    taskId: string,
    input: { channelId?: string; threadId?: string; controlMessageId?: string }
  ): Promise<void> {
    await this.update(taskId, (record) => {
      if (stringValue(input.channelId)) record.channelId = redactSensitiveText(input.channelId!.trim());
      if (stringValue(input.threadId)) record.threadId = redactSensitiveText(input.threadId!.trim());
      if (stringValue(input.controlMessageId)) record.controlMessageId = redactSensitiveText(input.controlMessageId!.trim());
    });
  }

  async setWorkspace(
    taskId: string,
    input: { workspacePath: string; branchName?: string; baseBranch?: string; isolated: boolean }
  ): Promise<void> {
    await this.update(taskId, (record) => {
      record.workspacePath = redactSensitiveText(input.workspacePath);
      record.workspaceIsolated = input.isolated;
      if (stringValue(input.branchName)) record.branchName = redactSensitiveText(input.branchName!.trim());
      if (stringValue(input.baseBranch)) record.baseBranch = redactSensitiveText(input.baseBranch!.trim());
    });
  }

  async clear(taskId: string): Promise<void> {
    await this.mutate((state) => {
      state.executions = state.executions.filter((record) => record.taskId !== taskId);
    });
  }

  async listActive(): Promise<ExecutionRecord[]> {
    await this.mutationTail;
    const state = await this.load();
    return state.executions.map((record) => structuredClone(record));
  }

  /**
   * Authoritative retry gate: true while a durable record for this task still
   * represents an unresolved worker (see executionWorkerUnresolved). Derived
   * from the ledger rather than the task's status, so dismissing an interrupted
   * task or any other status change cannot wash the gate away, and a restart
   * re-derives the same answer from the same durable record.
   */
  async hasUnresolvedWorker(taskId: string): Promise<boolean> {
    await this.mutationTail;
    const state = await this.load();
    const record = state.executions.find((item) => item.taskId === taskId);
    return record ? executionWorkerUnresolved(record) : false;
  }

  async loadIssues(): Promise<ExecutionLoadIssues> {
    await this.mutationTail;
    await this.load();
    return this.issues ?? { invalidRecordsDropped: 0 };
  }

  private async update(taskId: string, apply: (record: ExecutionRecord) => void): Promise<void> {
    await this.mutate((state) => {
      const record = state.executions.find((item) => item.taskId === taskId);
      if (!record) return;
      apply(record);
      record.updatedAt = new Date().toISOString();
    });
  }

  private async mutate(mutation: (state: ExecutionStateFile) => void): Promise<void> {
    const operation = this.mutationTail.then(async () => {
      const state = await this.load();
      const previous = structuredClone(state);
      mutation(state);
      try {
        await this.save();
      } catch (error) {
        this.state = previous;
        throw error;
      }
    });
    this.mutationTail = operation.catch(() => undefined);
    await operation;
  }

  private async load(): Promise<ExecutionStateFile> {
    if (this.state) {
      return this.state;
    }

    this.issues = { invalidRecordsDropped: 0 };
    let raw: string | undefined;
    try {
      raw = await readFile(this.stateFile, "utf8");
      await hardenPrivateFilePermissions(this.stateFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        await this.quarantineStateFile();
      }
      this.state = { version: 1, executions: [] };
      return this.state;
    }

    let executions: ExecutionRecord[] = [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Execution state must be a JSON object.");
      }
      const file = parsed as { version?: unknown; executions?: unknown };
      if (file.version !== undefined && file.version !== 1) {
        throw new Error(`Unsupported execution state version: ${String(file.version)}.`);
      }
      const entries = Array.isArray(file.executions) ? file.executions : [];
      for (const entry of entries) {
        const record = normalizeLoadedExecution(entry);
        if (record) executions.push(record);
        else this.issues.invalidRecordsDropped += 1;
      }
    } catch {
      await this.quarantineStateFile();
      executions = [];
    }

    this.state = { version: 1, executions };
    return this.state;
  }

  private async quarantineStateFile(): Promise<void> {
    const target = `${this.stateFile}.corrupt-${Date.now()}-${randomBytes(4).toString("hex")}`;
    try {
      await rename(this.stateFile, target);
      await hardenPrivateFilePermissions(target);
      if (this.issues) this.issues.quarantinedTo = target;
    } catch {
      // The unreadable file stays in place; recovery continues with empty state.
    }
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

/**
 * Captures a spawn identity for a child so a bare pid is never trusted later:
 * the same pid only counts as the same process when its kernel start time and
 * command both still match.
 */
export async function captureChildIdentity(pid: number): Promise<ExecutionChildIdentity | undefined> {
  if (process.platform === "win32" || !Number.isSafeInteger(pid) || pid <= 0) {
    return undefined;
  }
  const [startedAt, command] = await Promise.all([psColumn(pid, "lstart="), psColumn(pid, "comm=")]);
  if (!startedAt || !command) {
    return undefined;
  }
  return { pid, startedAt, command };
}

export type OrphanTerminationOutcome =
  | "already-exited"
  | "not-ours"
  | "terminated"
  | "killed"
  | "kill-unconfirmed"
  | "unverifiable";

/**
 * Stops an orphaned child from a previous runtime with an observed exit:
 * verify spawn identity, SIGTERM its process group, wait, then SIGKILL after
 * re-verifying identity. A pid whose identity no longer matches is never
 * signaled. If the process still has not exited after the post-SIGKILL wait,
 * the exit is left unconfirmed rather than reported as an observed kill.
 */
export async function terminateOrphanedChild(
  child: ExecutionChildIdentity,
  options: { gracePeriodMs?: number; killWaitMs?: number; pollIntervalMs?: number } = {}
): Promise<OrphanTerminationOutcome> {
  if (process.platform === "win32") {
    return "unverifiable";
  }
  const gracePeriodMs = options.gracePeriodMs ?? 5_000;
  const killWaitMs = options.killWaitMs ?? 2_000;
  const pollIntervalMs = options.pollIntervalMs ?? 100;

  const current = await captureChildIdentity(child.pid);
  if (!current) return "already-exited";
  if (!sameIdentity(current, child)) return "not-ours";

  signalProcessGroup(child.pid, "SIGTERM");
  if (await waitForExit(child.pid, gracePeriodMs, pollIntervalMs)) {
    return "terminated";
  }

  const beforeKill = await captureChildIdentity(child.pid);
  if (!beforeKill) return "terminated";
  if (!sameIdentity(beforeKill, child)) return "not-ours";

  signalProcessGroup(child.pid, "SIGKILL");
  if (await waitForExit(child.pid, killWaitMs, pollIntervalMs)) {
    return "killed";
  }
  return "kill-unconfirmed";
}

export interface RecoveryTaskStore {
  listRunning(): Promise<TaskRecord[]>;
  interrupt(id: string, note: string): Promise<TaskRecord | undefined>;
  setCleanupPending(id: string, pending: boolean): Promise<TaskRecord | undefined>;
}

export interface InterruptedTaskNotice {
  task: TaskRecord;
  record?: ExecutionRecord;
  childOutcome: OrphanTerminationOutcome | "no-child";
}

export interface ReconcileOptions {
  ledger: ExecutionLedger;
  tasks: RecoveryTaskStore;
  log?: (message: string) => void;
  notify?: (notice: InterruptedTaskNotice) => Promise<void>;
  terminate?: (child: ExecutionChildIdentity) => Promise<OrphanTerminationOutcome>;
  isActive?: (taskId: string) => boolean;
}

export interface ReconcileSummary {
  interruptedTasks: number;
  orphansStopped: number;
  staleRecordsCleared: number;
  invalidRecordsDropped: number;
  quarantinedTo?: string;
}

/**
 * Startup reconciliation. Every task the previous runtime left running is marked
 * interrupted with an honest account of what is known. Every retained execution
 * record is reconciled until its worker's exit is observed, regardless of the
 * task's current status: a record kept from an earlier restart because its hard
 * kill was unconfirmed is retried here even though the task no longer appears in
 * listRunning(). A durable record is only cleared once there is nothing left to
 * clean up (no worker, or a worker whose exit is now observed); while cleanup
 * stays unconfirmed the task's retry/resume controls remain refused. Model work
 * is never re-attached or resumed automatically.
 */
export async function reconcileInterruptedTasks(options: ReconcileOptions): Promise<ReconcileSummary> {
  const log = options.log ?? (() => undefined);
  const terminate = options.terminate ?? terminateOrphanedChild;
  const records = await options.ledger.listActive();
  const issues = await options.ledger.loadIssues();
  if (issues.quarantinedTo) {
    log(`Execution ledger was unreadable and was quarantined to ${issues.quarantinedTo}.`);
  }
  if (issues.invalidRecordsDropped > 0) {
    log(`Dropped ${issues.invalidRecordsDropped} malformed execution record(s) during recovery.`);
  }

  const recordsByTask = new Map(records.map((record) => [record.taskId, record]));
  const running = await options.tasks.listRunning();
  const runningById = new Map(running.map((task) => [task.id, task]));
  const summary: ReconcileSummary = {
    interruptedTasks: 0,
    orphansStopped: 0,
    staleRecordsCleared: 0,
    invalidRecordsDropped: issues.invalidRecordsDropped,
    ...(issues.quarantinedTo ? { quarantinedTo: issues.quarantinedTo } : {})
  };

  // Reconcile the union of currently-running tasks and every retained record, so
  // a record whose task was already marked interrupted on an earlier restart is
  // still driven to an observed worker exit rather than cleared as stale.
  const taskIds = new Set<string>([...runningById.keys(), ...recordsByTask.keys()]);

  for (const taskId of taskIds) {
    if (options.isActive?.(taskId)) {
      log(`Task ${taskId} is already active in this runtime; skipping restart reconciliation for it.`);
      continue;
    }
    const record = recordsByTask.get(taskId);
    const runningTask = runningById.get(taskId);

    let childOutcome: OrphanTerminationOutcome | "no-child" = "no-child";
    if (record?.child) {
      try {
        childOutcome = await terminate(record.child);
      } catch (error) {
        childOutcome = "unverifiable";
        log(`Unable to stop the recorded child of task ${taskId}: ${(error as Error).message}`);
      }
      if (childOutcome === "terminated" || childOutcome === "killed") {
        summary.orphansStopped += 1;
      }
    }
    const exitObserved = childExitObserved(childOutcome);

    if (runningTask) {
      const interrupted = await options.tasks.interrupt(taskId, interruptionNote(record, childOutcome));
      if (interrupted) {
        summary.interruptedTasks += 1;
        if (options.notify) {
          try {
            await options.notify({ task: interrupted, ...(record ? { record } : {}), childOutcome });
          } catch (error) {
            log(`Unable to announce the interruption of task ${taskId}: ${(error as Error).message}`);
          }
        }
      }
    }

    // A record that reached running-codex without a captured child identity may
    // point at a worker that was spawned but never recorded (a crash between
    // spawn and the identity write). It cannot be signaled, but it must not be
    // cleared as stale.
    const unaccountedWorker = !record?.child && record?.phase === "running-codex";
    const cleanupUnresolved = record?.child ? !exitObserved : Boolean(unaccountedWorker);

    // Fail closed: while a worker's cleanup is unresolved the task's cleanup
    // stays pending so retry/resume are refused; clear it once cleanup resolves.
    if (record?.child || unaccountedWorker) {
      await options.tasks.setCleanupPending(taskId, cleanupUnresolved);
    }

    if (record) {
      if (!cleanupUnresolved) {
        await options.ledger.clear(taskId);
        if (!runningById.has(taskId)) {
          summary.staleRecordsCleared += 1;
        }
      } else if (record.child) {
        log(`Kept the durable record of task ${taskId}; its worker exit was not observed (${childOutcome}).`);
      } else {
        log(`Kept the durable record of task ${taskId}; a worker may have been spawned before its identity was recorded, so retry stays blocked.`);
      }
    }
  }

  return summary;
}

/**
 * True while a retained execution record still represents a worker whose cleanup
 * is unresolved, and therefore must keep the task's retry/resume controls
 * refused. Two cases qualify:
 *   1. A captured child identity is present. The record is only cleared once the
 *      worker's exit is observed during reconciliation, so a surviving record
 *      with a child means the exit was never confirmed.
 *   2. No child identity was captured but the record reached the running-codex
 *      phase, where the worker process is spawned. This covers a crash between
 *      spawn and the durable identity write: a worker may exist that was never
 *      recorded, so it is treated as unaccounted rather than assumed absent.
 * Records that never reached running-codex and have no child never started a
 * worker, so they do not block retry.
 */
export function executionWorkerUnresolved(record: ExecutionRecord): boolean {
  return Boolean(record.child) || record.phase === "running-codex";
}

/**
 * A durable execution record is only cleared once the previous runtime's worker
 * is known to be gone. An unconfirmed hard kill or an unverifiable outcome
 * leaves the record in place so the execution stays visible for cleanup.
 */
function childExitObserved(outcome: OrphanTerminationOutcome | "no-child"): boolean {
  return (
    outcome === "no-child" ||
    outcome === "already-exited" ||
    outcome === "not-ours" ||
    outcome === "terminated" ||
    outcome === "killed"
  );
}

export function interruptionNote(
  record: ExecutionRecord | undefined,
  childOutcome: OrphanTerminationOutcome | "no-child"
): string {
  const parts = ["Devbot restarted while this task was running, so the model run was not resumed."];
  if (record) {
    parts.push(`It was last observed ${phaseLabel(record.phase)}.`);
  }
  if (childOutcome === "terminated" || childOutcome === "killed") {
    parts.push("The previous runtime's worker process was still running and was stopped with an observed exit.");
  } else if (childOutcome === "kill-unconfirmed") {
    parts.push(
      "The previous runtime's worker process was sent a hard kill but its exit could not be confirmed, so it is left flagged as unverified cleanup and its record is kept until the exit is observed."
    );
  } else if (childOutcome === "not-ours") {
    parts.push("The recorded process id now belongs to a different program and was left untouched.");
  } else if (childOutcome === "already-exited") {
    parts.push("The previous runtime's worker process had already exited.");
  } else if (childOutcome === "unverifiable") {
    parts.push("The recorded worker process could not be verified, so no process was signaled.");
  }
  if (record?.workspaceIsolated && record.branchName) {
    parts.push(`Any partial changes are preserved on branch ${record.branchName}.`);
  } else {
    parts.push("The project checkout was not modified by this runtime after the restart.");
  }
  return parts.join(" ");
}

function phaseLabel(phase: ExecutionPhase): string {
  if (phase === "starting") return "preparing to run";
  if (phase === "routing") return "choosing an approach";
  if (phase === "gathering-context") return "reading project context";
  return "running the model";
}

function sameIdentity(left: ExecutionChildIdentity, right: ExecutionChildIdentity): boolean {
  return left.pid === right.pid && left.startedAt === right.startedAt && left.command === right.command;
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Process already exited.
    }
  }
}

async function waitForExit(pid: number, timeoutMs: number, pollIntervalMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

function psColumn(pid: number, column: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-p", String(pid), "-o", column],
      { encoding: "utf8", timeout: 10_000, windowsHide: true },
      (error, stdout) => {
        const value = stdout.trim();
        resolve(!error && value ? value : undefined);
      }
    );
  });
}

function normalizeLoadedExecution(value: unknown): ExecutionRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<ExecutionRecord>;
  if (
    typeof record.taskId !== "string" ||
    !isTaskId(record.taskId) ||
    !stringValue(record.projectName) ||
    !stringValue(record.mode) ||
    !stringValue(record.requester)
  ) {
    return undefined;
  }
  const phase = oneOf(record.phase, ["starting", "routing", "gathering-context", "running-codex"] as const);
  if (!phase) return undefined;
  const startedAt = validTimestamp(record.startedAt);
  if (!startedAt) return undefined;
  const accessScope = oneOf(record.accessScope, ["project", "workroom"] as const);
  const child = normalizeChildIdentity(record.child);
  return {
    taskId: record.taskId,
    projectName: redactSensitiveText(record.projectName!.trim()),
    mode: redactSensitiveText(record.mode!.trim()),
    phase,
    requester: redactSensitiveText(record.requester!.trim()),
    ...(stringValue(record.requesterId) ? { requesterId: redactSensitiveText(record.requesterId!.trim()) } : {}),
    ...(accessScope ? { accessScope } : {}),
    ...(stringValue(record.channelId) ? { channelId: redactSensitiveText(record.channelId!.trim()) } : {}),
    ...(stringValue(record.threadId) ? { threadId: redactSensitiveText(record.threadId!.trim()) } : {}),
    ...(stringValue(record.controlMessageId) ? { controlMessageId: redactSensitiveText(record.controlMessageId!.trim()) } : {}),
    ...(stringValue(record.workspacePath) ? { workspacePath: redactSensitiveText(record.workspacePath!.trim()) } : {}),
    ...(stringValue(record.branchName) ? { branchName: redactSensitiveText(record.branchName!.trim()) } : {}),
    ...(stringValue(record.baseBranch) ? { baseBranch: redactSensitiveText(record.baseBranch!.trim()) } : {}),
    ...(typeof record.workspaceIsolated === "boolean" ? { workspaceIsolated: record.workspaceIsolated } : {}),
    ...(child ? { child } : {}),
    startedAt,
    updatedAt: validTimestamp(record.updatedAt) ?? startedAt
  };
}

function normalizeChildIdentity(value: unknown): ExecutionChildIdentity | undefined {
  if (!value || typeof value !== "object") return undefined;
  const child = value as Partial<ExecutionChildIdentity>;
  if (
    typeof child.pid !== "number" ||
    !Number.isSafeInteger(child.pid) ||
    child.pid <= 0 ||
    !stringValue(child.command) ||
    !stringValue(child.startedAt)
  ) {
    return undefined;
  }
  return {
    pid: child.pid,
    command: redactSensitiveText(child.command!.trim()),
    startedAt: redactSensitiveText(child.startedAt!.trim())
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function validTimestamp(value: unknown): string | undefined {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function oneOf<const T extends readonly string[]>(value: unknown, values: T): T[number] | undefined {
  return typeof value === "string" && values.includes(value) ? value as T[number] : undefined;
}
