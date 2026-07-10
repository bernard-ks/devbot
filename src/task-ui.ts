import { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from "discord.js";
import type { CodexRequestMode } from "./codex-client.js";
import type { RequestRoute } from "./request-router.js";
import { isTaskId, type TaskRecord } from "./task-store.js";

const MODAL_PREFIX = "devbot:task-modal:";

export type TaskProgressPhase = "routing" | "gathering-context" | "running-codex" | "failed" | "canceled";
export type TaskModalAction = "followup" | "promote" | "adjust";

export interface TaskProgressEvent {
  taskId: string;
  projectName: string;
  mode: CodexRequestMode;
  text: string;
  requester: string;
  startedAt: string;
  phase: TaskProgressPhase;
  route?: RequestRoute;
  contextFileCount?: number;
  error?: string;
}

export interface ParsedTaskModal {
  action: TaskModalAction;
  taskId: string;
}

export function formatTaskProgress(progress: TaskProgressEvent, now = new Date()): string {
  const access = progress.mode === "action" ? "write-capable" : "read-only";
  const elapsed = formatElapsed(now.getTime() - new Date(progress.startedAt).getTime());
  const phase = progressPhaseLabel(progress);
  return [
    `**${progress.projectName} task**`,
    `${access} | ${elapsed}`,
    "",
    `**${phase.title}**`,
    truncate(phase.detail, 800),
    "",
    `Request: \`${inlineCode(truncate(progress.text, 240))}\``
  ].join("\n");
}

export function taskRequestModal(action: TaskModalAction, task: TaskRecord): ModalBuilder {
  if (!isTaskId(task.id)) {
    throw new Error("Task ID cannot be encoded in a Discord modal.");
  }
  const title = action === "followup" ? "Follow up" : action === "promote" ? "Turn answer into a change" : "Adjust and retry";
  const label = action === "followup" ? "What do you want to ask next?" : "What should Devbot do?";
  const input = new TextInputBuilder()
    .setCustomId("request")
    .setLabel(label)
    .setStyle(TextInputStyle.Paragraph)
    .setMinLength(2)
    .setMaxLength(4_000)
    .setRequired(true);
  if (action === "adjust") {
    input.setValue(task.text.slice(0, 4_000));
  } else if (action === "promote") {
    input.setPlaceholder("Implement the recommended change from this answer");
  } else {
    input.setPlaceholder("Ask a focused follow-up question");
  }
  return new ModalBuilder()
    .setCustomId(`${MODAL_PREFIX}${action}:${task.id}`)
    .setTitle(title)
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}

export function parseTaskModal(customId: string): ParsedTaskModal | undefined {
  if (!customId.startsWith(MODAL_PREFIX)) {
    return undefined;
  }
  const [action, taskId, ...extra] = customId.slice(MODAL_PREFIX.length).split(":");
  if (extra.length > 0 || !isTaskModalAction(action) || !taskId || !isTaskId(taskId)) {
    return undefined;
  }
  return { action, taskId };
}

export function continuationPrompt(action: TaskModalAction, task: TaskRecord, request: string): string {
  if (action === "adjust") {
    return request.trim();
  }
  const previous = task.resultPreview ?? task.error ?? "No previous result is available.";
  const intent = action === "promote" ? "Requested project change" : "Follow-up question";
  return [
    "Continue from an earlier Devbot task.",
    "",
    "Original request:",
    truncate(task.text, 1_200),
    "",
    "Previous result:",
    truncate(previous, 2_000),
    "",
    `${intent}:`,
    request.trim()
  ].join("\n");
}

function progressPhaseLabel(progress: TaskProgressEvent): { title: string; detail: string } {
  if (progress.phase === "routing") {
    return { title: "Choosing an approach", detail: "Selecting Luna, Terra, or Sol and the right amount of project context." };
  }
  if (progress.phase === "gathering-context") {
    const route = progress.route;
    return {
      title: "Reading the project",
      detail: `${route ? routeName(route) : "Codex"} is preparing ${route?.contextMode ?? "project"} context.`
    };
  }
  if (progress.phase === "running-codex") {
    const files = progress.contextFileCount === undefined
      ? ""
      : ` with ${progress.contextFileCount} context ${progress.contextFileCount === 1 ? "file" : "files"}`;
    return { title: "Working", detail: `${progress.route ? routeName(progress.route) : "Codex"} is working${files}.` };
  }
  if (progress.phase === "canceled") {
    return { title: "Canceled", detail: progress.error ?? "The task was canceled before completion." };
  }
  return { title: "Needs attention", detail: progress.error ?? "The task failed before completion. Open Actions to adjust or retry it." };
}

function routeName(route: RequestRoute): "Luna" | "Terra" | "Sol" {
  return route.tier === "fast" ? "Luna" : route.tier === "standard" ? "Terra" : "Sol";
}

function isTaskModalAction(value: string | undefined): value is TaskModalAction {
  return value === "followup" || value === "promote" || value === "adjust";
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function inlineCode(value: string): string {
  return value.replace(/`/g, "'").replace(/[\r\n]+/g, " ");
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}
