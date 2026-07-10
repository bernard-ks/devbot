import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle
} from "discord.js";
import type { TaskRecord } from "./task-store.js";
import type { ProjectEntry } from "./types.js";

const CONTROL_PREFIX = "devbot:workspace:";
const MODAL_PREFIX = "devbot:workspace-modal:";

export type WorkspaceAction = "open" | "ask" | "act" | "status" | "recent" | "inbox" | "refresh" | "project";
export type WorkspaceModalAction = "ask" | "act";

export interface WorkspaceControl {
  action: WorkspaceAction;
  projectName?: string;
}

export interface WorkspaceModalControl {
  action: WorkspaceModalAction;
  projectName: string;
}

export interface WorkspacePanelInput {
  projects: ProjectEntry[];
  selectedProject: ProjectEntry;
  canControl: boolean;
  safeMode: boolean;
  status: string;
  recentTasks: TaskRecord[];
  needsAttentionCount?: number;
}

export function parseWorkspaceControl(customId: string): WorkspaceControl | undefined {
  if (!customId.startsWith(CONTROL_PREFIX)) {
    return undefined;
  }
  const [action, projectName, ...extra] = customId.slice(CONTROL_PREFIX.length).split(":");
  if (extra.length > 0 || !isWorkspaceAction(action)) {
    return undefined;
  }
  if (action === "open" || action === "project") {
    return projectName ? undefined : { action };
  }
  return projectName && isSafeProjectName(projectName) ? { action, projectName } : undefined;
}

export function parseWorkspaceModal(customId: string): WorkspaceModalControl | undefined {
  if (!customId.startsWith(MODAL_PREFIX)) {
    return undefined;
  }
  const [action, projectName, ...extra] = customId.slice(MODAL_PREFIX.length).split(":");
  if (extra.length > 0 || (action !== "ask" && action !== "act") || !projectName || !isSafeProjectName(projectName)) {
    return undefined;
  }
  return { action, projectName };
}

export function workspaceLauncherView() {
  return {
    content: ["**Devbot workspace**", "Open your project controls."].join("\n"),
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`${CONTROL_PREFIX}open`).setLabel("Open workspace").setStyle(ButtonStyle.Primary)
      )
    ],
    allowedMentions: { parse: [] as const }
  };
}

export function workspacePanelView(input: WorkspacePanelInput) {
  const access = input.canControl ? "Controller" : "Viewer";
  const mode = input.safeMode ? "Safe mode on" : "Safe mode off";
  const content = [
    `**${input.selectedProject.name} workspace**`,
    `${access} | ${mode}`,
    "",
    compactStatus(input.status),
    "",
    "**Recent work**",
    formatRecentTasks(workspaceRecentTasks(input.recentTasks))
  ].join("\n");
  const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CONTROL_PREFIX}ask:${input.selectedProject.name}`)
      .setLabel("Ask")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${CONTROL_PREFIX}act:${input.selectedProject.name}`)
      .setLabel("Make change")
      .setStyle(ButtonStyle.Success)
      .setDisabled(!input.canControl || input.safeMode),
    new ButtonBuilder()
      .setCustomId(`${CONTROL_PREFIX}status:${input.selectedProject.name}`)
      .setLabel("Status")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${CONTROL_PREFIX}recent:${input.selectedProject.name}`)
      .setLabel("Recent")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${CONTROL_PREFIX}inbox:${input.selectedProject.name}`)
      .setLabel(input.needsAttentionCount ? `Needs Me (${input.needsAttentionCount})` : "Needs Me")
      .setStyle(input.needsAttentionCount ? ButtonStyle.Danger : ButtonStyle.Secondary)
  );
  const utilityControls = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CONTROL_PREFIX}refresh:${input.selectedProject.name}`)
      .setLabel("Refresh")
      .setStyle(ButtonStyle.Secondary)
  );
  const components: Array<ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>> = [controls, utilityControls];

  if (input.projects.length > 1) {
    const selectableProjects = [
      input.selectedProject,
      ...input.projects.filter((project) => project.name !== input.selectedProject.name)
    ].slice(0, 25);
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`${CONTROL_PREFIX}project`)
          .setPlaceholder("Switch project")
          .addOptions(
            ...selectableProjects.map((project) => ({
              label: project.name,
              value: project.name,
              default: project.name === input.selectedProject.name
            }))
          )
      )
    );
  }

  return { content: truncate(content, 1_900), components, allowedMentions: { parse: [] as const } };
}

export function workspaceRecentTasks(tasks: TaskRecord[], limit = 3): TaskRecord[] {
  return tasks
    .filter((task) => !task.source.startsWith("lab:council:") && !task.source.startsWith("workroom:agent:"))
    .slice(0, limit);
}

export function workspaceRequestModal(action: WorkspaceModalAction, projectName: string): ModalBuilder {
  const isAction = action === "act";
  return new ModalBuilder()
    .setCustomId(`${MODAL_PREFIX}${action}:${projectName}`)
    .setTitle(isAction ? "Make a project change" : "Ask Devbot")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("request")
          .setLabel(isAction ? "What should Devbot change?" : "What do you want to know?")
          .setPlaceholder(isAction ? "Fix the failing authentication test" : "How does authentication work?")
          .setStyle(TextInputStyle.Paragraph)
          .setMinLength(2)
          .setMaxLength(4_000)
          .setRequired(true)
      )
    );
}

export function compactStatus(status: string): string {
  const now = sectionLines(status, "**Now**")[0] ?? "No confirmed work is running.";
  const open = sectionLines(status, "**Open sessions (activity unknown)**")[0];
  const repository = sectionLines(status, "**Repository evidence**")[0];
  const risk = sectionLines(status, "**Blockers and risks**")[0] ?? "No visible blocker.";
  const next = sectionLines(status, "**Best next step**")[0] ?? "Ready for the next assignment.";
  return [
    "**Now**",
    truncate([now, open].filter(Boolean).join(" "), 360),
    repository ? ["", "**Repository**", truncate(repository, 360)].join("\n") : undefined,
    "",
    "**Risk**",
    truncate(risk, 300),
    "",
    "**Next**",
    truncate(next, 360)
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

function formatRecentTasks(tasks: TaskRecord[]): string {
  if (tasks.length === 0) {
    return "No recent tasks for this project.";
  }
  return tasks
    .slice(0, 3)
    .map((task) => {
      const request = task.text.replace(/`/g, "'").replace(/\s+/g, " ").trim();
      return `- ${taskStatusLabel(task)} | ${task.mode === "action" ? "Change" : "Answer"}: ${truncate(request, 100)}`;
    })
    .join("\n");
}

function taskStatusLabel(task: TaskRecord): string {
  if (task.status === "awaiting-approval") return "Approval needed";
  if (task.status === "succeeded") return "Done";
  if (task.status === "failed") return "Needs attention";
  if (task.status === "canceled") return "Canceled";
  return "Working";
}

function sectionLines(status: string, heading: string): string[] {
  const lines = status.split(/\r?\n/);
  const start = lines.indexOf(heading);
  if (start < 0) {
    return [];
  }
  const section: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\*\*.+\*\*$/.test(line.trim())) {
      break;
    }
    if (line.trim()) {
      section.push(line.trim());
    }
  }
  return section;
}

function isWorkspaceAction(value: string | undefined): value is WorkspaceAction {
  return value === "open" || value === "ask" || value === "act" || value === "status" || value === "recent" || value === "inbox" || value === "refresh" || value === "project";
}

function isSafeProjectName(value: string): boolean {
  return /^[a-z0-9_-]{1,40}$/.test(value);
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+\n/g, "\n").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}
