import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { duelReviewButton } from "./duel-ui.js";
import { isTaskId, type TaskRecord, type TaskStatus } from "./task-store.js";

export type TaskControlAction =
  | "details"
  | "actions"
  | "followup"
  | "review"
  | "retry"
  | "cancel"
  | "promote"
  | "validate"
  | "adjust";

interface PublicTaskControlOptions {
  status?: TaskStatus;
  mode?: string;
}

interface PrivateTaskControlOptions {
  canControl: boolean;
  safeMode: boolean;
  hasChecks: boolean;
}

export function taskControlRow(
  taskId: string,
  options: PublicTaskControlOptions = {}
): ActionRowBuilder<ButtonBuilder> {
  const status = options.status ?? "succeeded";
  const mode = options.mode ?? "answer";
  const buttons = [button("details", taskId, "Details", ButtonStyle.Secondary)];
  if (status === "succeeded") {
    buttons.push(button("followup", taskId, "Follow up", ButtonStyle.Primary));
    if (mode === "action") {
      buttons.push(button("review", taskId, "Review changes", ButtonStyle.Secondary));
    }
  }
  buttons.push(button("actions", taskId, "Actions", ButtonStyle.Secondary));
  return new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
}

export function taskActionRows(
  task: TaskRecord,
  options: PrivateTaskControlOptions
): ActionRowBuilder<ButtonBuilder>[] {
  const buttons: ButtonBuilder[] = [];
  const mode = task.mode === "action" ? "action" : "answer";

  if (task.status === "running" && options.canControl) {
    buttons.push(button("cancel", task.id, "Cancel", ButtonStyle.Danger));
  }

  if (task.status === "succeeded") {
    buttons.push(button("followup", task.id, "Follow up", ButtonStyle.Primary));
    if (mode === "answer" && options.canControl && !options.safeMode) {
      buttons.push(button("promote", task.id, "Make change", ButtonStyle.Success));
    }
    if (mode === "action") {
      buttons.push(button("review", task.id, "Review changes", ButtonStyle.Secondary));
      if (options.canControl && options.hasChecks && !options.safeMode) {
        buttons.push(button("validate", task.id, "Run checks", ButtonStyle.Success));
      }
      if (options.canControl) {
        buttons.push(duelReviewButton(task.id));
      }
    }
  }

  if (task.status === "failed" || task.status === "canceled") {
    if (mode === "answer" || options.canControl) {
      const blockedBySafeMode = mode === "action" && options.safeMode;
      buttons.push(button("adjust", task.id, "Adjust request", ButtonStyle.Primary).setDisabled(blockedBySafeMode));
      buttons.push(button("retry", task.id, "Retry", ButtonStyle.Secondary).setDisabled(blockedBySafeMode));
    }
  }

  return buttons.length > 0
    ? [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons.slice(0, 5))]
    : [];
}

export function taskActionMatchesState(action: TaskControlAction, task: TaskRecord): boolean {
  const mode = task.mode === "action" ? "action" : "answer";
  if (action === "details" || action === "actions") {
    return true;
  }
  if (action === "cancel") {
    return task.status === "running";
  }
  if (action === "adjust" || action === "retry") {
    return task.status === "failed" || task.status === "canceled";
  }
  if (action === "followup") {
    return task.status === "succeeded";
  }
  if (action === "promote") {
    return task.status === "succeeded" && mode === "answer";
  }
  return task.status === "succeeded" && mode === "action";
}

export function parseTaskControl(customId: string): { action: TaskControlAction; taskId: string } | undefined {
  const match = /^devbot:task-control:(details|actions|followup|review|retry|cancel|promote|validate|adjust):(.+)$/i.exec(customId);
  if (!match?.[1] || !match[2] || !isTaskId(match[2])) {
    return undefined;
  }
  return { action: match[1] as TaskControlAction, taskId: match[2] };
}

function button(action: TaskControlAction, taskId: string, label: string, style: ButtonStyle): ButtonBuilder {
  if (!isTaskId(taskId)) {
    throw new Error("Task ID cannot be encoded in a Discord control.");
  }
  return new ButtonBuilder()
    .setCustomId(`devbot:task-control:${action}:${taskId}`)
    .setLabel(label)
    .setStyle(style);
}
