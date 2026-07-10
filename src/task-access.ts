import type { TaskRecord } from "./task-store.js";

export interface TaskAccessContext {
  userId: string;
  projectAllowed: boolean;
  controller: boolean;
}

/**
 * Shared shape for any durable record (task, memory entry, ...) whose
 * visibility must be restricted to its originating requester and
 * project-authorized controllers once it is marked workroom-scoped or
 * internal. Kept generic so every subsystem that copies data out of a task
 * (memory, review, etc.) can apply the exact same access rule instead of
 * re-deriving it and drifting out of sync.
 */
export interface AccessScopedRecord {
  accessScope?: "project" | "workroom";
  internal?: boolean;
  requesterId?: string;
}

export function canAccessScopedRecord(record: AccessScopedRecord, context: TaskAccessContext): boolean {
  if (!context.projectAllowed) return false;
  if (record.accessScope === "workroom" || record.internal) {
    return context.controller || record.requesterId === context.userId;
  }
  return true;
}

export function canAccessTaskRecord(task: TaskRecord, context: TaskAccessContext): boolean {
  return canAccessScopedRecord(task, context);
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
