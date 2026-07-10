import type { TaskRecord, TaskStore } from "./task-store.js";

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
}

/**
 * The single place cancellation is finalized. Once a canceled action task's
 * worker is known to be quiescent, snapshot the exact working-tree hash so Undo
 * can restore under the same drift guard as succeed/fail. Both cancellation
 * routes funnel through here after quiescence is established:
 *  - explicit cancel, where `runCodex` only rejects after the child has closed;
 *  - restart recovery, where the previous runtime's process is already gone.
 *
 * Recording the post-task tree is exactly what makes Undo eligible. When it
 * cannot be captured (task never checkpointed, workspace missing or untrusted,
 * or hashing fails) the field is left unset on purpose: the eligibility guard
 * then hides Undo instead of offering a control that would refuse.
 */
export async function finalizeCanceledActionTask(deps: TaskRecoveryDeps, task: TaskRecord): Promise<void> {
  if (task.mode !== "action" || !task.checkpointRef || task.checkpointPostTaskTree) {
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
 * mid-write is either fully undoable or shows no Undo control at all — never the
 * dangerous middle state where Undo is offered but refuses. Returns the number
 * of tasks that were interrupted.
 */
export async function recoverInterruptedTasks(deps: TaskRecoveryDeps): Promise<number> {
  const interrupted = await deps.store.interruptRunning();
  for (const task of interrupted) {
    await finalizeCanceledActionTask(deps, task);
  }
  return interrupted.length;
}
