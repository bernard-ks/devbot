import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  StringSelectMenuBuilder,
  TextDisplayBuilder
} from "discord.js";
import type { StudioAgent, StudioLane, StudioSnapshot, StudioTask } from "./studio-data.js";
import { isTaskId } from "./task-store.js";

const CONTROL_PREFIX = "devbot:studio:v1:";
const SAFE_SCOPE = /^(?:all|[a-z0-9_-]{1,40})$/;

export type StudioAction = "refresh" | "inbox" | "task" | "project";

export interface StudioControl {
  action: StudioAction;
  scope: string;
}

export interface StudioDashboardOptions {
  selectedProject?: string;
  selectedTaskId?: string;
}

export interface StudioDashboardPayload {
  flags: MessageFlags.IsComponentsV2;
  components: [ContainerBuilder];
  allowedMentions: { parse: [] };
}

export function studioEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.DEVBOT_STUDIO_ENABLED?.trim().toLowerCase() === "true";
}

export function studioCustomId(action: StudioAction, scope = "all"): string {
  if (!SAFE_SCOPE.test(scope)) throw new RangeError("Studio controls require a safe project scope.");
  return `${CONTROL_PREFIX}${action}:${scope}`;
}

export function parseStudioControl(customId: string): StudioControl | undefined {
  if (customId.length > 100 || !customId.startsWith(CONTROL_PREFIX)) return undefined;
  const [action, scope, ...extra] = customId.slice(CONTROL_PREFIX.length).split(":");
  if (extra.length > 0 || !isStudioAction(action) || !scope || !SAFE_SCOPE.test(scope)) return undefined;
  return { action, scope };
}

export function studioDashboardCard(
  snapshot: StudioSnapshot,
  options: StudioDashboardOptions = {}
): StudioDashboardPayload {
  const availableProjects = snapshot.projects.map((project) => project.name).filter((name) => SAFE_SCOPE.test(name));
  const selectedProject = options.selectedProject && availableProjects.includes(options.selectedProject)
    ? options.selectedProject
    : "all";
  const tasks = selectedProject === "all"
    ? snapshot.tasks
    : snapshot.tasks.filter((task) => task.project === selectedProject);
  const selectedTask = tasks.find((task) => task.id === options.selectedTaskId)
    ?? tasks.find((task) => task.lane === "needs-me")
    ?? tasks.find((task) => task.lane === "in-flight")
    ?? tasks[0];
  const scope = selectedProject;

  const container = new ContainerBuilder()
    .setAccentColor(tasks.some((task) => task.lane === "needs-me") ? 0xd97706 : 0x5865f2)
    .addTextDisplayComponents(text([
      "## Devbot Studio",
      `**Discord-native workroom** | ${inline(snapshot.bot.name, 70)} | ${snapshot.bot.safeMode ? "Safe mode on" : "Safe mode off"}`,
      `**Current view:** ${selectedProject === "all" ? "All projects (view only)" : inline(selectedProject, 70)}`,
      `Needs Me **${laneCount(tasks, "needs-me")}** | In flight **${laneCount(tasks, "in-flight")}** | Recent **${laneCount(tasks, "recent")}** | Projects **${snapshot.projects.length}**`
    ].join("\n")))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addTextDisplayComponents(text(formatBoard(tasks)));

  if (selectedTask) {
    container
      .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
      .addTextDisplayComponents(text(formatSelectedTask(selectedTask)));
  }

  container
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addTextDisplayComponents(text([
      formatAgents(snapshot.agents, tasks),
      "",
      formatBranches(snapshot, selectedProject)
    ].join("\n")));

  if (availableProjects.length > 1) {
    container.addActionRowComponents(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(studioCustomId("project", scope))
          .setPlaceholder("Choose view; a project becomes your current selection")
          .addOptions(
            { label: "All projects (view only)", value: "all", default: selectedProject === "all" },
            ...availableProjects.slice(0, 24).map((name) => ({
              label: label(name, 100),
              value: name,
              default: name === selectedProject
            }))
          )
      )
    );
  }

  if (tasks.length > 0) {
    container.addActionRowComponents(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(studioCustomId("task", scope))
          .setPlaceholder("Inspect a task")
          .addOptions(...tasks.slice(0, 25).map((task) => ({
            label: label(task.title, 100),
            description: label(`${laneLabel(task.lane)} | ${task.project} | ${task.status}`, 100),
            value: task.id,
            default: task.id === selectedTask?.id
          })))
      )
    );
  }

  const buttons = [
    new ButtonBuilder()
      .setCustomId(studioCustomId("refresh", scope))
      .setLabel("Refresh")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(studioCustomId("inbox", scope))
      .setLabel(laneCount(tasks, "needs-me") ? `Needs Me (${laneCount(tasks, "needs-me")})` : "Needs Me")
      .setStyle(laneCount(tasks, "needs-me") ? ButtonStyle.Danger : ButtonStyle.Secondary)
  ];
  if (selectedTask && isTaskId(selectedTask.id)) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`devbot:task-control:details:${selectedTask.id}`)
        .setLabel("Open full task")
        .setStyle(ButtonStyle.Primary)
    );
  }
  container.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons));

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    allowedMentions: { parse: [] }
  };
}

function formatBoard(tasks: readonly StudioTask[]): string {
  return (["needs-me", "in-flight", "recent"] as const)
    .map((lane) => {
      const laneTasks = tasks.filter((task) => task.lane === lane).slice(0, lane === "recent" ? 4 : 5);
      const lines = laneTasks.length
        ? laneTasks.map((task) => `- \`${inlineCode(task.id, 64)}\` **${inline(task.project, 50)}** — ${inline(task.title, 150)}`)
        : ["- Nothing here."];
      return `**${laneLabel(lane)}**\n${lines.join("\n")}`;
    })
    .join("\n\n");
}

function formatSelectedTask(task: StudioTask): string {
  const approval = task.approval.attention
    ? `Needs ${inline(task.approval.attention, 40)}`
    : task.approval.status
      ? inline(task.approval.status, 50)
      : "No decision pending";
  const branch = task.branch.name
    ? `\`${inlineCode(task.branch.name, 140)}\`${task.branch.merged ? " (merged)" : task.branch.isolated ? " (isolated)" : ""}`
    : "No isolated branch";
  const proof = task.evidence.verification.length
    ? task.evidence.verification.slice(0, 4).map((item) => `- ${block(item, 240)}`).join("\n")
    : "- No verification recorded.";
  const changed = task.evidence.changedFiles.length
    ? task.evidence.changedFiles.slice(0, 5).map((file) => `\`${inlineCode(file, 120)}\``).join(", ")
    : "None recorded";
  const outcome = task.error ?? task.result;
  return [
    `### Selected · ${inline(task.title, 180)}`,
    `**Project:** ${inline(task.project, 70)} | **Status:** ${inline(task.status, 40)} | **Decision:** ${approval}`,
    `**Branch:** ${branch}`,
    `**Changed:** ${changed}`,
    `**Proof**\n${proof}`,
    outcome ? `**Outcome**\n${block(outcome, 520)}` : undefined
  ].filter((value): value is string => Boolean(value)).join("\n\n");
}

function formatAgents(agents: readonly StudioAgent[], visibleTasks: readonly StudioTask[]): string {
  const visibleIds = new Set(visibleTasks.map((task) => task.id));
  const lines = agents.map((agent) => {
    const assignment = agent.taskId && visibleIds.has(agent.taskId) && agent.taskTitle
      ? ` — ${inline(agent.taskTitle, 90)}`
      : "";
    return `- **${inline(agent.name, 40)}** · ${inline(agent.role, 50)} · ${inline(agent.status, 20)}${assignment}`;
  });
  return `**Agent map (Devbot-managed tasks only)**\n${lines.join("\n")}`;
}

function formatBranches(snapshot: StudioSnapshot, selectedProject: string): string {
  const projects = selectedProject === "all"
    ? snapshot.projects.slice(0, 4)
    : snapshot.projects.filter((project) => project.name === selectedProject);
  if (projects.length === 0) return "**Branch state**\n- No repository evidence available.";
  return `**Branch state**\n${projects.map((project) => (
    `- **${inline(project.name, 60)}** · \`${inlineCode(project.branch, 100)}\` → \`${inlineCode(project.defaultBranch, 80)}\` · ${project.dirty ? "changes present" : "clean"}`
  )).join("\n")}`;
}

function laneCount(tasks: readonly StudioTask[], lane: StudioLane): number {
  return tasks.filter((task) => task.lane === lane).length;
}

function laneLabel(lane: StudioLane): string {
  return lane === "needs-me" ? "Needs Me" : lane === "in-flight" ? "In flight" : "Recent";
}

function text(value: string): TextDisplayBuilder {
  return new TextDisplayBuilder().setContent(value.slice(0, 4_000));
}

function inline(value: string, maxLength: number): string {
  return label(value, maxLength)
    .replace(/([\\`*_{}\[\]()<>#+\-.!|~])/g, "\\$1")
    .replace(/@/g, "@\u200b")
    .replace(/https?:\/\//gi, (match) => `${match.slice(0, -2)}\/\u200b/`);
}

function inlineCode(value: string, maxLength: number): string {
  return label(value, maxLength).replace(/`/g, "'");
}

function block(value: string, maxLength: number): string {
  const normalized = value
    .replace(/https?:\/\/\S+/gi, "[link]")
    .replace(/@/g, "@\u200b")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}

function label(value: string, maxLength: number): string {
  const normalized = value
    .replace(/https?:\/\/\S+/gi, "[link]")
    .replace(/@/g, "＠")
    .replace(/\s+/g, " ")
    .trim() || "Not provided";
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}

function isStudioAction(value: string | undefined): value is StudioAction {
  return value === "refresh" || value === "inbox" || value === "task" || value === "project";
}
