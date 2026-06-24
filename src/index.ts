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
import { renderStatusImage } from "./status-image.js";
import { findExternalCodexWork, formatWorkStatus, WorkTracker } from "./work-status.js";
import type { AppConfig, PackedProjectContext, ProjectEntry } from "./types.js";

const config = loadConfig();
const contextService = new ProjectContextService(config.scanner);
const workTracker = new WorkTracker();
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
    if (message.author.bot || !client.user || !message.mentions.users.has(client.user.id)) {
      return;
    }

    if (!isAllowedMessage(message, config)) {
      await message.reply("You are not allowed to use this bot.");
      return;
    }

    const statusProjectRequest = parseOptionalProjectToken(stripBotMention(message.content, client.user.id), config.projects);
    const statusRequest = parseStatusRequest(statusProjectRequest.text);
    if (statusRequest.isStatus) {
      await message.channel.sendTyping();
      console.log(`Status request from ${message.author.tag}: image=${statusRequest.wantsImage} question=${Boolean(statusRequest.question)}`);
      const snapshot = await getStatusSnapshotResponse(config, statusRequest.wantsImage);
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

    const request = parseMentionRequest(message.content, client.user.id, config.projects);
    if (!request.text) {
      await message.reply("Tell me what to do after the mention. Example: `@devbot fix the failing tests`");
      return;
    }

    await message.channel.sendTyping();
    const pending = await message.reply(`Working on \`${request.project.name}\`...`);
    const { answer } = await runProjectRequest({
      appConfig: config,
      project: request.project,
      text: request.text,
      includePatterns: request.includePatterns,
      mode: request.mode,
      requester: message.author.tag
    });

    const chunks = splitDiscordMessage(answer);
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
    const snapshot = await getStatusSnapshotResponse(appConfig, interaction.options.getBoolean("image") ?? false);
    await editInteractionWithChunks(interaction, snapshot);

    if (question) {
      const detail = await getDetailedStatusResponse({
        appConfig,
        question,
        requester: interaction.user.tag,
        project: projectName ? mustFindProject(appConfig.projects, projectName) : undefined
      });
      await followUpWithChunks(interaction, detail);
    }
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
    const { answer, context } = await runProjectRequest({
      appConfig,
      project,
      text: question,
      includePatterns,
      mode: "answer",
      requester: interaction.user.tag
    });

    const header = [
      `Project: \`${project.name}\``,
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
    const { answer } = await runProjectRequest({
      appConfig,
      project,
      text: task,
      includePatterns,
      mode: "action",
      requester: interaction.user.tag
    });
    const chunks = splitDiscordMessage(answer);
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
}

interface ProjectRequestResult {
  answer: string;
  context: PackedProjectContext;
}

async function runProjectRequest(options: ProjectRequestOptions): Promise<ProjectRequestResult> {
  const work = workTracker.start({
    mode: options.mode,
    projectName: options.project.name,
    requester: options.requester,
    text: options.text
  });

  try {
    const context = await contextService.pack(options.project, options.text, options.includePatterns);
    const answer = await runCodex(options.appConfig, options.text, context, options.mode);
    return { answer, context };
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
}

async function getStatusSnapshotResponse(appConfig: AppConfig, wantsImage: boolean): Promise<BotResponse> {
  const content = await getWorkStatusMessage(appConfig);

  if (wantsImage) {
    return { content, image: await renderStatusImage(content) };
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
    requester: options.requester
  });
  return { content: [`Detailed update for \`${project.name}\`:`, answer].join("\n") };
}

async function replyToMessageWithChunks(message: Message, response: BotResponse): Promise<void> {
  const chunks = splitDiscordMessage(response.content);
  const files = response.image ? [new AttachmentBuilder(response.image, { name: "devbot-status.png" })] : [];
  await message.reply({ content: chunks[0] ?? "No status generated.", files });

  for (const chunk of chunks.slice(1)) {
    await message.reply(chunk);
  }
}

async function editInteractionWithChunks(interaction: ChatInputCommandInteraction, response: BotResponse): Promise<void> {
  const chunks = splitDiscordMessage(response.content);
  const files = response.image ? [new AttachmentBuilder(response.image, { name: "devbot-status.png" })] : [];
  await interaction.editReply({ content: chunks[0] ?? "No status generated.", files });

  for (const chunk of chunks.slice(1)) {
    await interaction.followUp(chunk);
  }
}

async function followUpWithChunks(interaction: ChatInputCommandInteraction, response: BotResponse): Promise<void> {
  const chunks = splitDiscordMessage(response.content);
  const files = response.image ? [new AttachmentBuilder(response.image, { name: "devbot-status.png" })] : [];
  await interaction.followUp({ content: chunks[0] ?? "No status generated.", files });

  for (const chunk of chunks.slice(1)) {
    await interaction.followUp(chunk);
  }
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
