import type { TaskRecord } from "./task-store.js";

export interface TaskAccessContext {
  userId: string;
  projectAllowed: boolean;
  controller: boolean;
}

export function canAccessTaskRecord(task: TaskRecord, context: TaskAccessContext): boolean {
  if (!context.projectAllowed) return false;
  if (task.accessScope === "workroom" || task.internal) {
    return context.controller || task.requesterId === context.userId;
  }
  return true;
}

export function isTaskListVisible(task: TaskRecord, context: TaskAccessContext): boolean {
  return !task.internal && canAccessTaskRecord(task, context);
}

export type TaskSyncRefusal = "access" | "no-isolated-branch" | "task-active" | "requester-or-controller" | "safe-mode";

export function taskSyncRefusal(task: TaskRecord, context: TaskAccessContext & { safeMode: boolean }): TaskSyncRefusal | undefined {
  if (!canAccessTaskRecord(task, context)) return "access";
  if (!task.workspaceIsolated || !task.workspacePath || !task.branchName || !task.baseBranch) return "no-isolated-branch";
  if (task.status === "running" || task.status === "awaiting-approval") return "task-active";
  if (!context.controller && task.requesterId !== context.userId) return "requester-or-controller";
  if (context.safeMode) return "safe-mode";
  return undefined;
}

export interface TaskRetryContext {
  interrupted: boolean;
  writeCapable: boolean;
  globalAllowed: boolean;
  projectAllowed: boolean;
  controller: boolean;
  requester: boolean;
}

export type TaskRetryRefusal = "not-allowed" | "not-project" | "needs-controller" | "needs-requester-or-controller";

/**
 * Fail-closed authorization for retrying a saved task, evaluated against current
 * authority at the moment of retry rather than whoever first requested the task.
 * Write-capable retries always require current controller authority, so a
 * since-demoted requester cannot resume them; requester-only recovery is limited
 * to read-only work that a restart interrupted.
 */
export function taskRetryRefusal(context: TaskRetryContext): TaskRetryRefusal | undefined {
  if (!context.globalAllowed) return "not-allowed";
  if (!context.projectAllowed) return "not-project";
  if (context.writeCapable && !context.controller) return "needs-controller";
  if (context.interrupted && !context.controller && !context.requester) return "needs-requester-or-controller";
  return undefined;
}
