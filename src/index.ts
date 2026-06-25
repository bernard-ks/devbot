import {
  AttachmentBuilder,
  Client,
  GatewayIntentBits,
  GuildMember,
  MessageFlags,
} from "discord.js";
import type { AutocompleteInteraction, ChatInputCommandInteraction, Interaction, Message } from "discord.js";
import { loadConfig } from "./config.js";
import { ProjectContextService, parseIncludePatterns } from "./context.js";
import { answerWithProjectContext, type CodexRequestMode } from "./codex-client.js";
import { parseMentionRequest, parseStatusRequest, stripBotMention } from "./mention.js";
import { splitDiscordMessage } from "./messages.js";
import { captureProjectScreenshot } from "./project-screenshot.js";
import { formatTaskDetail, formatTaskList, TaskStore } from "./task-store.js";
import { findExternalCodexWork, formatWorkStatus, WorkTracker } from "./work-status.js";
import type { AppConfig, PackedProjectContext, ProjectEntry } from "./types.js";

const config = loadConfig();
const contextService = new ProjectContextService(config.scanner);
const workTracker = new WorkTracker();
const taskStore = new TaskStore(process.env.DEVBOT_TASK_STORE?.trim() || undefined);
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user?.tag ?? "unknown bot"}.`);
  console.log(`Configured projects: ${config.projects.map((project) => project.name).join(", ")}`);
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction, config.projects);
      return;
    }

    if (!interaction.isChatInputCommand()) {
      return;
    }

    if (!isAllowed(interaction, config)) {
      await interaction.reply({ content: "You are not allowed to use this bot.", flags: MessageFlags.Ephemeral });
      return;
    }

    await handleCommand(interaction, config);
  } catch (error) {
    console.error(error);
    await replyWithError(interaction, error);
  }
});

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot || !client.user) {
      return;
    }

    const botRoleMentionIds = getBotRoleMentionIds(message, client.user.username);
    const mentionsBot =
      message.mentions.users.has(client.user.id) ||
      botRoleMentionIds.length > 0 ||
      message.content.toLowerCase().includes(`@${client.user.username.toLowerCase()}`);
    if (!mentionsBot) {
      return;
    }

    if (!isAllowedMessage(message, config)) {
      await message.reply("You are not allowed to use this bot.");
      return;
    }

    const mentionText = stripBotMention(message.content, client.user.id, botRoleMentionIds);
    console.log(
      `Mention from ${message.author.tag}: content=${JSON.stringify(truncateForLog(message.content))} text=${JSON.stringify(
        truncateForLog(mentionText)
      )}`
    );

    const statusProjectRequest = parseOptionalProjectToken(mentionText, config.projects);
    const parsedStatusRequest = parseStatusRequest(statusProjectRequest.text);
    const statusRequest = parsedStatusRequest.isStatus
      ? parsedStatusRequest
      : parseFallbackStatusRequest(statusProjectRequest.text);

    if (statusRequest.isStatus) {
      await message.channel.sendTyping();
      console.log(`Status request from ${message.author.tag}: image=${statusRequest.wantsImage} question=${Boolean(statusRequest.question)}`);
      const snapshot = await getStatusSnapshotResponse(config, statusRequest.wantsImage, statusProjectRequest.project, statusRequest.question);
      await replyToMessageWithChunks(message, snapshot);

      if (statusRequest.question) {
        const detail = await getDetailedStatusResponse({
          appConfig: config,
          question: statusRequest.question,
          requester: message.author.tag,
          project: statusProjectRequest.project
        });
        await replyToMessageWithChunks(message, detail);
      }
      return;
    }

    const request = parseMentionRequest(message.content, client.user.id, config.projects, botRoleMentionIds);
    if (!request.text) {
      await message.reply("Tell me what to do after the mention. Example: `@devbot fix the failing tests`");
      return;
    }

    await message.channel.sendTyping();
    const pending = await message.reply(`Working on \`${request.project.name}\`...`);
    const { answer, taskId } = await runProjectRequest({
      appConfig: config,
      project: request.project,
      text: request.text,
      includePatterns: request.includePatterns,
      mode: request.mode,
      requester: message.author.tag,
      source: "mention"
    });

    const chunks = splitDiscordMessage(`Task: \`${taskId}\`\n\n${answer}`);
    await pending.edit(chunks[0] ?? "No answer generated.");

    for (const chunk of chunks.slice(1)) {
      await message.reply(chunk);
    }
  } catch (error) {
    console.error(error);
    await message.reply(`Error: ${(error as Error).message}`);
  }
});

await client.login(config.discordToken);

async function handleCommand(interaction: ChatInputCommandInteraction, appConfig: AppConfig): Promise<void> {
  if (interaction.commandName === "projects") {
    await interaction.reply({
      content: appConfig.projects.map((project) => `- \`${project.name}\` -> \`${project.root}\``).join("\n"),
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (interaction.commandName === "status") {
    await interaction.deferReply();
    const projectName = interaction.options.getString("project");
    const question = interaction.options.getString("question") ?? undefined;
    const project = projectName ? mustFindProject(appConfig.projects, projectName) : undefined;
    const snapshot = await getStatusSnapshotResponse(appConfig, interaction.options.getBoolean("image") ?? false, project, question);
    await editInteractionWithChunks(interaction, snapshot);

    if (question) {
      const detail = await getDetailedStatusResponse({
        appConfig,
        question,
        requester: interaction.user.tag,
        project
      });
      await followUpWithChunks(interaction, detail);
    }
    return;
  }

  if (interaction.commandName === "snip") {
    await interaction.deferReply();
    const projectName = interaction.options.getString("project");
    const target = interaction.options.getString("target", true);
    const project = projectName ? mustFindProject(appConfig.projects, projectName) : defaultProject(appConfig.projects);
    const screenshot = await captureProjectScreenshot(project, { requestText: target });
    if (!screenshot) {
      await interaction.editReply(`I could not find a running local web UI to screenshot for \`${project.name}\`.`);
      return;
    }

    await editInteractionWithChunks(interaction, {
      content: `Attached live UI screenshot for \`${project.name}\` from ${screenshot.url}.`,
      image: screenshot.image,
      imageName: screenshot.fileName
    });
    return;
  }

  if (interaction.commandName === "task") {
    await handleTaskCommand(interaction, appConfig);
    return;
  }

  if (interaction.commandName === "refresh") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const project = mustFindProject(appConfig.projects, interaction.options.getString("project", true));
    const fileCount = await contextService.refresh(project);
    await interaction.editReply(`Refreshed \`${project.name}\` with ${fileCount} indexed files.`);
    return;
  }

  if (interaction.commandName === "ask") {
    await interaction.deferReply();
    const project = mustFindProject(appConfig.projects, interaction.options.getString("project", true));
    const question = interaction.options.getString("question", true);
    const includePatterns = parseIncludePatterns(interaction.options.getString("include"));
    const { answer, context, taskId } = await runProjectRequest({
      appConfig,
      project,
      text: question,
      includePatterns,
      mode: "answer",
      requester: interaction.user.tag,
      source: "slash:ask"
    });

    const header = [
      `Project: \`${project.name}\``,
      `Task: \`${taskId}\``,
      `Context files: ${context.files.length}`,
      includePatterns.length > 0 ? `Include: \`${includePatterns.join(", ")}\`` : undefined
    ]
      .filter(Boolean)
      .join("\n");
    const chunks = splitDiscordMessage(`${header}\n\n${answer}`);
    await interaction.editReply(chunks[0] ?? "No answer generated.");

    for (const chunk of chunks.slice(1)) {
      await interaction.followUp(chunk);
    }

    return;
  }

  if (interaction.commandName === "act") {
    await interaction.deferReply();
    const project = mustFindProject(appConfig.projects, interaction.options.getString("project", true));
    const task = interaction.options.getString("task", true);
    const includePatterns = parseIncludePatterns(interaction.options.getString("include"));
    const { answer, taskId } = await runProjectRequest({
      appConfig,
      project,
      text: task,
      includePatterns,
      mode: "action",
      requester: interaction.user.tag,
      source: "slash:act"
    });
    const chunks = splitDiscordMessage(`Task: \`${taskId}\`\n\n${answer}`);
    await interaction.editReply(chunks[0] ?? "No answer generated.");

    for (const chunk of chunks.slice(1)) {
      await interaction.followUp(chunk);
    }
  }
}

interface ProjectRequestOptions {
  appConfig: AppConfig;
  project: ProjectEntry;
  text: string;
  includePatterns: string[];
  mode: CodexRequestMode;
  requester: string;
  source: string;
}

interface ProjectRequestResult {
  answer: string;
  context: PackedProjectContext;
  taskId: string;
}

async function runProjectRequest(options: ProjectRequestOptions): Promise<ProjectRequestResult> {
  const work = workTracker.start({
    mode: options.mode,
    projectName: options.project.name,
    requester: options.requester,
    text: options.text
  });
  const task = await taskStore.start({
    source: options.source,
    mode: options.mode,
    projectName: options.project.name,
    requester: options.requester,
    text: options.text,
    includePatterns: options.includePatterns
  });

  try {
    const context = await contextService.pack(options.project, options.text, options.includePatterns);
    const answer = await runCodex(options.appConfig, options.text, context, options.mode);
    await taskStore.succeed(task.id, {
      contextFileCount: context.files.length,
      resultPreview: answer
    });
    return { answer, context, taskId: task.id };
  } catch (error) {
    await taskStore.fail(task.id, error);
    throw error;
  } finally {
    workTracker.finish(work.id);
  }
}

async function getWorkStatusMessage(appConfig: AppConfig): Promise<string> {
  const activeBotWork = workTracker.snapshot();
  const externalCodexWork = await findExternalCodexWork(appConfig.projects);
  return formatWorkStatus([...activeBotWork, ...externalCodexWork]);
}

interface StatusResponseOptions {
  appConfig: AppConfig;
  requester: string;
  project: ProjectEntry | undefined;
  question: string;
}

interface BotResponse {
  content: string;
  image?: Buffer;
  imageName?: string;
}

async function getStatusSnapshotResponse(
  appConfig: AppConfig,
  wantsImage: boolean,
  requestedProject?: ProjectEntry,
  requestText = ""
): Promise<BotResponse> {
  let content = await getWorkStatusMessage(appConfig);

  if (wantsImage) {
    const project = requestedProject ?? defaultProject(appConfig.projects);
    const screenshot = await captureProjectScreenshot(project, { requestText });

    if (screenshot) {
      content = `${content}\n\nAttached live UI screenshot for \`${project.name}\` from ${screenshot.url}.`;
      return { content, image: screenshot.image, imageName: screenshot.fileName };
    }

    content = `${content}\n\nI could not find a running local web UI to screenshot for \`${project.name}\`. Start the frontend dev server or set PROJECT_SCREENSHOT_URLS_JSON.`;
  }

  return { content };
}

async function getDetailedStatusResponse(options: StatusResponseOptions): Promise<BotResponse> {
  const status = await getWorkStatusMessage(options.appConfig);
  const project = options.project ?? defaultProject(options.appConfig.projects);
  const detailPrompt = [
    "Give a deeper development status update for the configured project.",
    "Use the current work snapshot below as live context, then inspect the project read-only if needed.",
    "Be concrete about what appears active, what output/state is visible, and what is unknown.",
    "",
    "Current work snapshot:",
    status,
    "",
    "Status question:",
    options.question
  ].join("\n");
  const { answer } = await runProjectRequest({
    appConfig: options.appConfig,
    project,
    text: detailPrompt,
    includePatterns: [],
    mode: "answer",
    requester: options.requester,
    source: "status-detail"
  });
  return { content: [`Detailed update for \`${project.name}\`:`, answer].join("\n") };
}

async function handleTaskCommand(interaction: ChatInputCommandInteraction, appConfig: AppConfig): Promise<void> {
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "recent") {
    await interaction.deferReply();
    const projectName = interaction.options.getString("project") ?? undefined;
    const project = projectName ? mustFindProject(appConfig.projects, projectName) : undefined;
    const status = interaction.options.getString("status") as "running" | "succeeded" | "failed" | null;
    const filters: { limit: number; projectName?: string; status?: "running" | "succeeded" | "failed" } = {
      limit: interaction.options.getInteger("limit") ?? 10
    };
    if (project?.name) {
      filters.projectName = project.name;
    }
    if (status) {
      filters.status = status;
    }

    const tasks = await taskStore.listRecent(filters);
    await interaction.editReply(formatTaskList(tasks));
    return;
  }

  if (subcommand === "show") {
    await interaction.deferReply();
    const id = interaction.options.getString("id", true);
    const task = await taskStore.get(id);
    await interaction.editReply(task ? formatTaskDetail(task) : `No saved task found for \`${id}\`.`);
  }
}

async function replyToMessageWithChunks(message: Message, response: BotResponse): Promise<void> {
  const chunks = splitDiscordMessage(response.content);
  const files = attachmentFiles(response);
  await message.reply({ content: chunks[0] ?? "No status generated.", files });

  for (const chunk of chunks.slice(1)) {
    await message.reply(chunk);
  }
}

async function editInteractionWithChunks(interaction: ChatInputCommandInteraction, response: BotResponse): Promise<void> {
  const chunks = splitDiscordMessage(response.content);
  const files = attachmentFiles(response);
  await interaction.editReply({ content: chunks[0] ?? "No status generated.", files });

  for (const chunk of chunks.slice(1)) {
    await interaction.followUp(chunk);
  }
}

async function followUpWithChunks(interaction: ChatInputCommandInteraction, response: BotResponse): Promise<void> {
  const chunks = splitDiscordMessage(response.content);
  const files = attachmentFiles(response);
  await interaction.followUp({ content: chunks[0] ?? "No status generated.", files });

  for (const chunk of chunks.slice(1)) {
    await interaction.followUp(chunk);
  }
}

function attachmentFiles(response: BotResponse): AttachmentBuilder[] {
  return response.image ? [new AttachmentBuilder(response.image, { name: response.imageName ?? "devbot-screenshot.png" })] : [];
}

async function runCodex(
  appConfig: AppConfig,
  text: string,
  context: PackedProjectContext,
  mode: CodexRequestMode
): Promise<string> {
  return answerWithProjectContext({
    codex: appConfig.codex,
    question: text,
    context,
    mode
  });
}

async function handleAutocomplete(interaction: AutocompleteInteraction, projects: ProjectEntry[]): Promise<void> {
  const focused = interaction.options.getFocused().toLowerCase();
  const choices = projects
    .filter((project) => project.name.includes(focused))
    .slice(0, 25)
    .map((project) => ({ name: project.name, value: project.name }));

  await interaction.respond(choices);
}

function mustFindProject(projects: ProjectEntry[], name: string): ProjectEntry {
  const normalized = name.trim().toLowerCase();
  const project = projects.find((entry) => entry.name === normalized);
  if (!project) {
    throw new Error(`Unknown project: ${name}`);
  }

  return project;
}

function parseOptionalProjectToken(text: string, projects: ProjectEntry[]): { text: string; project: ProjectEntry | undefined } {
  const projectMatch = text.match(/\bproject:([a-z0-9_-]+)\b/i);
  if (!projectMatch) {
    return { text, project: undefined };
  }

  return {
    text: text.replace(projectMatch[0], "").trim(),
    project: mustFindProject(projects, projectMatch[1] ?? "")
  };
}

function defaultProject(projects: ProjectEntry[]): ProjectEntry {
  if (projects.length === 1 && projects[0]) {
    return projects[0];
  }

  throw new Error("Multiple projects are configured. Add `project:<name>` to the request.");
}

function parseFallbackStatusRequest(text: string): { isStatus: boolean; question: string | undefined; wantsImage: boolean } {
  const normalized = text.toLowerCase();
  const isStatus = /\b(status|state|progress|wip|working|work|snip|screenshot|screen shot|output)\b/.test(normalized);
  if (!isStatus) {
    return { isStatus: false, question: undefined, wantsImage: false };
  }

  const wantsImage = /\b(snip|screenshot|screen shot|image|picture|pic|output)\b/.test(normalized);
  return { isStatus: true, question: text.trim() || undefined, wantsImage };
}

function truncateForLog(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 220 ? `${compact.slice(0, 217)}...` : compact;
}

function getBotRoleMentionIds(message: Message, botUsername: string): string[] {
  const normalizedBotName = botUsername.toLowerCase();
  return message.mentions.roles
    .filter((role) => role.name.toLowerCase() === normalizedBotName)
    .map((role) => role.id);
}

function isAllowed(interaction: ChatInputCommandInteraction, appConfig: AppConfig): boolean {
  const hasUserAllowList = appConfig.allowedUserIds.size > 0;
  const hasRoleAllowList = appConfig.allowedRoleIds.size > 0;
  if (!hasUserAllowList && !hasRoleAllowList) {
    return true;
  }

  if (appConfig.allowedUserIds.has(interaction.user.id)) {
    return true;
  }

  if (interaction.member instanceof GuildMember) {
    return interaction.member.roles.cache.some((role) => appConfig.allowedRoleIds.has(role.id));
  }

  const memberRoles = interaction.member?.roles;
  if (Array.isArray(memberRoles)) {
    return memberRoles.some((roleId) => appConfig.allowedRoleIds.has(roleId));
  }

  return false;
}

function isAllowedMessage(message: Message, appConfig: AppConfig): boolean {
  const hasUserAllowList = appConfig.allowedUserIds.size > 0;
  const hasRoleAllowList = appConfig.allowedRoleIds.size > 0;
  if (!hasUserAllowList && !hasRoleAllowList) {
    return true;
  }

  if (appConfig.allowedUserIds.has(message.author.id)) {
    return true;
  }

  return message.member?.roles.cache.some((role) => appConfig.allowedRoleIds.has(role.id)) ?? false;
}

async function replyWithError(interaction: Interaction, error: unknown): Promise<void> {
  if (!interaction.isRepliable()) {
    return;
  }

  const message = `Error: ${(error as Error).message}`;
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
}
