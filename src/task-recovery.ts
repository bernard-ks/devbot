import { execFile } from "node:child_process";
import type { TaskRecord, TaskStore, TaskWorkerIdentity } from "./task-store.js";

/**
 * Result of asking whether the detached worker a task recorded is provably gone:
 *  - "terminated": the worker's process group is positively absent (or the pid
 *    was recycled by an unrelated process, so our worker is gone) — the isolated
 *    worktree can no longer be written by it and is therefore quiescent.
 *  - "alive": a process whose identity still matches the recorded worker is
 *    running, so a delayed write is still possible.
 *  - "unproven": termination could not be established (no identity was captured,
 *    the platform has no process-group semantics, or the probe failed). Treated
 *    exactly like "alive" by the finalizer: fail closed.
 */
export type WorkerTerminationOutcome = "terminated" | "alive" | "unproven";

export interface TaskRecoveryDeps {
  store: TaskStore;
  /**
   * Resolves the on-disk workspace root a canceled task actually wrote to (its
   * isolated worktree, or the main checkout when it ran unisolated). Returns
   * undefined when the workspace cannot be located or trusted, which finalizes
   * closed: no post-task tree is recorded and Undo stays hidden.
   */
  resolveWorkspaceRoot: (task: TaskRecord) => Promise<string | undefined>;
  hashWorkingTree: (root: string) => Promise<string>;
  /**
   * Proves whether the task's recorded worker has terminated. Defaults to a real
   * process-group probe ({@link probeWorkerTermination}); tests inject a fake.
   */
  probeWorkerTermination?: (task: TaskRecord) => Promise<WorkerTerminationOutcome>;
  /** Grace window the default probe waits for a still-present worker to exit. */
  workerTerminationGraceMs?: number;
}

/**
 * The single place cancellation is finalized. A canceled action task's post-task
 * tree is recorded — the one thing that makes Undo eligible — only after the
 * task's worker is *proven* gone. A detached worker survives its parent, so both
 * cancellation routes can reach here while it is still alive:
 *  - explicit cancel, where `runCodex`'s abort fallback can reject on a timer
 *    before the child's close is observed;
 *  - restart recovery, where a previous runtime crashed and its detached worker
 *    may still be running and writing.
 *
 * So termination is not assumed: {@link probeWorkerTermination} must return
 * "terminated" (the worker's process group is positively absent, which for the
 * task's isolated worktree is exactly worktree quiescence) before the tree is
 * hashed. If termination cannot be proven — worker still alive, no identity
 * captured, or probe failure — the tree is left unrecorded on purpose: the
 * eligibility guard then hides Undo instead of exposing a control that would
 * restore against a checkpoint that was never stable (fail closed).
 */
export async function finalizeCanceledActionTask(deps: TaskRecoveryDeps, task: TaskRecord): Promise<void> {
  if (task.mode !== "action" || !task.checkpointRef || task.checkpointPostTaskTree) {
    return;
  }

  const probe = deps.probeWorkerTermination
    ?? ((candidate: TaskRecord) =>
      probeWorkerTermination(
        candidate,
        deps.workerTerminationGraceMs !== undefined ? { graceMs: deps.workerTerminationGraceMs } : {}
      ));
  let outcome: WorkerTerminationOutcome;
  try {
    outcome = await probe(task);
  } catch {
    outcome = "unproven";
  }
  if (outcome !== "terminated") {
    // Worker still alive (or its state is unknown): a later write could still
    // land, so recording a tree now would checkpoint an unstable state. Leave it
    // unset — Undo stays hidden and refuses closed.
    return;
  }

  let root: string | undefined;
  try {
    root = await deps.resolveWorkspaceRoot(task);
  } catch {
    return;
  }
  if (!root) {
    return;
  }
  try {
    const tree = await deps.hashWorkingTree(root);
    await deps.store.recordPostTaskTree(task.id, tree);
  } catch {
    // Leave checkpointPostTaskTree unset; Undo stays hidden and refuses closed.
  }
}

/**
 * Production restart-recovery path, invoked once the runtime comes back up.
 * Marks the previous runtime's still-running tasks as canceled, then finalizes
 * each one through {@link finalizeCanceledActionTask} so a task interrupted
 * mid-write is either fully undoable (its worker is proven gone and its tree is
 * stable) or shows no Undo control at all — never the dangerous middle state
 * where Undo is offered but would restore an unquiesced tree. Returns the number
 * of tasks that were interrupted.
 */
export async function recoverInterruptedTasks(deps: TaskRecoveryDeps): Promise<number> {
  const interrupted = await deps.store.interruptRunning();
  for (const task of interrupted) {
    await finalizeCanceledActionTask(deps, task);
  }
  return interrupted.length;
}

const DEFAULT_GRACE_MS = 3_000;
const DEFAULT_POLL_MS = 100;

/**
 * Captures a strong spawn identity for a detached worker so a bare pid is never
 * trusted later: the same pid only counts as the same worker when its kernel
 * start time and command both still match. Returns undefined when no trustworthy
 * identity is available (Windows has no equivalent, or `ps` yields nothing),
 * which downstream is treated as "cannot prove termination" — fail closed.
 */
export async function captureWorkerIdentity(pid: number | undefined): Promise<TaskWorkerIdentity | undefined> {
  if (process.platform === "win32" || pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) {
    return undefined;
  }
  const [startedAt, command] = await Promise.all([psColumn(pid, "lstart="), psColumn(pid, "comm=")]);
  if (!startedAt || !command) {
    return undefined;
  }
  return { pid, startedAt, command };
}

/**
 * Decides whether the task's recorded worker is provably gone. A detached worker
 * is its own process-group leader (pgid == pid), so the group is probed with
 * signal 0:
 *  - the whole group is absent → "terminated" (positively-verified absence);
 *  - a group member is present and the leader's identity still matches the
 *    record → "alive" (our worker survives, possibly still writing);
 *  - a group member is present but the leader's identity no longer matches → the
 *    pid was recycled by an unrelated process, so our worker is gone →
 *    "terminated".
 * When a still-matching worker is seen, the probe waits up to `graceMs` for it to
 * exit (covering the SIGTERM→SIGKILL window a just-canceled worker is in) before
 * concluding "alive".
 */
export async function probeWorkerTermination(
  task: TaskRecord,
  options: { graceMs?: number; pollIntervalMs?: number } = {}
): Promise<WorkerTerminationOutcome> {
  const worker = task.worker;
  if (!worker || process.platform === "win32") {
    return "unproven";
  }
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
  const deadline = Date.now() + Math.max(0, graceMs);

  for (;;) {
    if (!isProcessGroupPresent(worker.pid)) {
      return "terminated";
    }
    const current = await captureWorkerIdentity(worker.pid);
    if (current && !sameWorker(current, worker)) {
      // The pid was recycled by an unrelated process; our worker is gone.
      return "terminated";
    }
    if (Date.now() >= deadline) {
      // A group member is still present and either matches the recorded worker or
      // could not be resolved to prove it is unrelated. Fail closed as "alive".
      return "alive";
    }
    await delay(pollIntervalMs);
  }
}

function sameWorker(left: TaskWorkerIdentity, right: TaskWorkerIdentity): boolean {
  return left.pid === right.pid && left.startedAt === right.startedAt && left.command === right.command;
}

function isProcessGroupPresent(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      // The group exists but is owned by another user; a member is present.
      return true;
    }
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
