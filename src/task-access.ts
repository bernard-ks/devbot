import type { TaskRecord } from "./task-store.js";
import type { VoiceNoteRecord } from "./voice-store.js";

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

export interface OwnerAccessContext {
  userId: string;
  controller: boolean;
}

/** Only the original requester or an approved controller may mutate/consume a pending voice note. */
export function canManageVoiceNote(record: Pick<VoiceNoteRecord, "requesterId">, context: OwnerAccessContext): boolean {
  return context.controller || record.requesterId === context.userId;
}
