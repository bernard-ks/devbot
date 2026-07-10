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
