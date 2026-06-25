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
import { captureProjectScreenshot, type ProjectScreenshot } from "./project-screenshot.js";
import { configuredCommandNames, formatProjectCommandResult, runConfiguredProjectCommand } from "./command-runner.js";
import {
  buildCapabilities,
  createPeerEnvelope,
  formatCapabilities,
  formatPeerEnvelope,
  formatPeerList,
  parsePeerEnvelope,
  PeerStore
} from "./peer.js";
import { createReviewPacket, evaluateMergeGates, formatMergeGateResult, formatReviewPacket, formatValidationResults, validateReview } from "./review.js";
import { formatTaskDetail, formatTaskList, formatTaskLogs, TaskStore, type TaskStatus } from "./task-store.js";
import { findExternalCodexWork, formatWorkStatus, WorkTracker } from "./work-status.js";
import type { AppConfig, PackedProjectContext, ProjectEntry } from "./types.js";

const config = loadConfig();
const contextService = new ProjectContextService(config.scanner);
const workTracker = new WorkTracker();
const taskStore = new TaskStore(process.env.DEVBOT_TASK_STORE?.trim() || undefined);
const peerStore = new PeerStore(process.env.DEVBOT_PEER_STORE?.trim() || undefined);
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user?.tag ?? "unknown bot"}.`);
  console.log(`Devbot identity: ${config.botIdentity.displayName} owned by ${config.botIdentity.owner}. Safe mode: ${config.safeMode ? "on" : "off"}.`);
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
    if (!client.user) {
      return;
    }

    if (message.author.bot) {
      await maybeHandlePeerMessage(message, config);
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
      content: appConfig.projects.map(formatProjectSummary).join("\n"),
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
    const viewport = interaction.options.getString("viewport") as "desktop" | "tablet" | "mobile" | null;
    const project = projectName ? mustFindProject(appConfig.projects, projectName) : defaultProject(appConfig.projects);
    const screenshot = await captureProjectScreenshot(project, { requestText: target, viewport: viewport ?? "desktop" });
    if (!screenshot) {
      await interaction.editReply(`I could not find a running local web UI to screenshot for \`${project.name}\`.`);
      return;
    }

    await editInteractionWithChunks(interaction, {
      content: formatScreenshotReply(project, screenshot),
      image: screenshot.image,
      imageName: screenshot.fileName
    });
    return;
  }

  if (interaction.commandName === "task") {
    await handleTaskCommand(interaction, appConfig);
    return;
  }

  if (interaction.commandName === "dashboard") {
    await handleDashboardCommand(interaction, appConfig);
    return;
  }

  if (interaction.commandName === "run") {
    await handleRunCommand(interaction, appConfig);
    return;
  }

  if (interaction.commandName === "review") {
    await handleReviewCommand(interaction, appConfig);
    return;
  }

  if (interaction.commandName === "devbot") {
    await handleDevbotCommand(interaction, appConfig);
    return;
  }

  if (interaction.commandName === "peer") {
    await handlePeerCommand(interaction, appConfig);
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
      content = `${content}\n\n${formatScreenshotReply(project, screenshot)}`;
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
    const status = interaction.options.getString("status") as TaskStatus | null;
    const filters: { limit: number; projectName?: string; status?: TaskStatus } = {
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

  if (subcommand === "show" || subcommand === "status") {
    await interaction.deferReply();
    const id = interaction.options.getString("id", true);
    const task = await taskStore.get(id);
    await interaction.editReply(task ? formatTaskDetail(task) : `No saved task found for \`${id}\`.`);
    return;
  }

  if (subcommand === "logs") {
    await interaction.deferReply();
    const id = interaction.options.getString("id", true);
    const task = await taskStore.get(id);
    await interaction.editReply(task ? formatTaskLogs(task) : `No saved task found for \`${id}\`.`);
    return;
  }

  if (subcommand === "cancel") {
    await interaction.deferReply();
    const id = interaction.options.getString("id", true);
    const task = await taskStore.cancel(id, `Canceled by ${interaction.user.tag}.`);
    await interaction.editReply(task ? `Task \`${id}\` is now ${task.status}.` : `No saved task found for \`${id}\`.`);
    return;
  }

  if (subcommand === "retry") {
    await interaction.deferReply();
    const id = interaction.options.getString("id", true);
    const task = await taskStore.get(id);
    if (!task) {
      await interaction.editReply(`No saved task found for \`${id}\`.`);
      return;
    }

    const project = mustFindProject(appConfig.projects, task.projectName);
    const { answer, taskId } = await runProjectRequest({
      appConfig,
      project,
      text: task.text,
      includePatterns: task.includePatterns,
      mode: task.mode === "action" ? "action" : "answer",
      requester: interaction.user.tag,
      source: `retry:${task.id}`
    });
    await editInteractionWithChunks(interaction, { content: `Retried \`${id}\` as \`${taskId}\`.\n\n${answer}` });
    return;
  }

  if (subcommand === "stale") {
    await interaction.deferReply();
    const minutes = interaction.options.getInteger("minutes") ?? 30;
    const projectName = interaction.options.getString("project") ?? undefined;
    const project = projectName ? mustFindProject(appConfig.projects, projectName) : undefined;
    const running = await taskStore.listRecent({
      status: "running",
      limit: 25,
      ...(project ? { projectName: project.name } : {})
    });
    const cutoff = Date.now() - minutes * 60_000;
    const stale = running.filter((task) => new Date(task.startedAt).getTime() < cutoff);
    await interaction.editReply(stale.length ? formatTaskList(stale) : `No running tasks older than ${minutes}m.`);
  }
}

async function handleDashboardCommand(interaction: ChatInputCommandInteraction, appConfig: AppConfig): Promise<void> {
  await interaction.deferReply();
  const projectName = interaction.options.getString("project") ?? undefined;
  const project = projectName ? mustFindProject(appConfig.projects, projectName) : undefined;
  const projects = project ? [project] : appConfig.projects;
  const status = await getWorkStatusMessage(appConfig);
  const recentTasks = await taskStore.listRecent({ limit: 5, ...(project ? { projectName: project.name } : {}) });
  const lines = [
    `Devbot dashboard for ${project ? `\`${project.name}\`` : "configured projects"}`,
    `Bot: \`${appConfig.botIdentity.displayName}\` owned by ${appConfig.botIdentity.owner}`,
    `Safe mode: ${appConfig.safeMode ? "on" : "off"}`,
    "",
    "Projects:",
    projects.map(formatProjectSummary).join("\n"),
    "",
    "Active work:",
    status,
    "",
    "Recent tasks:",
    formatTaskList(recentTasks)
  ];

  await editInteractionWithChunks(interaction, { content: lines.join("\n") });
}

async function handleRunCommand(interaction: ChatInputCommandInteraction, appConfig: AppConfig): Promise<void> {
  await interaction.deferReply();
  if (appConfig.safeMode) {
    await interaction.editReply("Safe mode is on, so configured project command runs are disabled.");
    return;
  }

  const project = mustFindProject(appConfig.projects, interaction.options.getString("project", true));
  const command = interaction.options.getString("command", true);
  const result = await runConfiguredProjectCommand(project, command);
  await editInteractionWithChunks(interaction, { content: formatProjectCommandResult(result) });
}

async function handleReviewCommand(interaction: ChatInputCommandInteraction, appConfig: AppConfig): Promise<void> {
  const subcommand = interaction.options.getSubcommand();
  const project = mustFindProject(appConfig.projects, interaction.options.getString("project", true));

  if (subcommand === "packet") {
    await interaction.deferReply();
    const taskId = interaction.options.getString("task") ?? undefined;
    const task = taskId ? await taskStore.get(taskId) : undefined;
    const packet = await createReviewPacket(project, task);
    await editInteractionWithChunks(interaction, { content: formatReviewPacket(packet) });
    return;
  }

  if (appConfig.safeMode) {
    await interaction.reply({ content: "Safe mode is on, so review validation commands are disabled.", flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply();
  const commandNames = parseCommandNames(interaction.options.getString("commands"));
  if (subcommand === "validate") {
    const results = await validateReview(project, commandNames);
    await editInteractionWithChunks(interaction, { content: formatValidationResults(project, results) });
    return;
  }

  if (subcommand === "gates") {
    const result = await evaluateMergeGates(project, commandNames);
    await editInteractionWithChunks(interaction, { content: formatMergeGateResult(project, result) });
  }
}

async function handleDevbotCommand(interaction: ChatInputCommandInteraction, appConfig: AppConfig): Promise<void> {
  const subcommand = interaction.options.getSubcommand();
  const capabilities = buildCapabilities(appConfig, client.user?.id);

  if (subcommand === "capabilities") {
    await interaction.reply({ content: formatCapabilities(capabilities), flags: MessageFlags.Ephemeral });
    return;
  }

  if (subcommand === "peers") {
    await interaction.reply({ content: formatPeerList(await peerStore.list()), flags: MessageFlags.Ephemeral });
    return;
  }

  if (subcommand === "announce") {
    await interaction.deferReply();
    const envelope = createPeerEnvelope({
      type: "devbot.peer.announce",
      from: client.user?.id ?? "unknown",
      owner: appConfig.botIdentity.owner,
      capabilities
    });
    await sendPeerMessage(interaction, appConfig, formatPeerEnvelope(envelope));
    await interaction.editReply("Announced devbot capabilities.");
  }
}

async function handlePeerCommand(interaction: ChatInputCommandInteraction, appConfig: AppConfig): Promise<void> {
  const subcommand = interaction.options.getSubcommand();
  const peerBotId = parseBotId(interaction.options.getString("bot", true));
  if (!appConfig.peerBotIds.has(peerBotId)) {
    await interaction.reply({
      content: `Peer <@${peerBotId}> is not allow-listed. Add it to PEER_BOT_IDS before sending peer requests.`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await interaction.deferReply();
  const action = subcommand === "snip" ? "snip" : subcommand === "status" ? "status" : "capabilities";
  const envelope = createPeerEnvelope({
    type: "devbot.peer.request",
    from: client.user?.id ?? "unknown",
    owner: appConfig.botIdentity.owner,
    action,
    ...optionalPeerField("project", interaction.options.getString("project")),
    ...optionalPeerField("target", interaction.options.getString("target"))
  });

  await sendPeerMessage(interaction, appConfig, `<@${peerBotId}>\n${formatPeerEnvelope(envelope)}`);
  await interaction.editReply(`Sent ${action} request \`${envelope.requestId}\` to <@${peerBotId}>.`);
}

async function maybeHandlePeerMessage(message: Message, appConfig: AppConfig): Promise<void> {
  if (!client.user || !appConfig.peerBotIds.has(message.author.id)) {
    return;
  }

  const envelope = parsePeerEnvelope(message.content);
  if (!envelope) {
    return;
  }

  if (envelope.capabilities) {
    await peerStore.upsert(message.author.id, envelope.capabilities);
  }

  if (envelope.type !== "devbot.peer.request") {
    return;
  }

  if (!message.mentions.users.has(client.user.id)) {
    return;
  }

  if (!envelope.action) {
    return;
  }

  if (envelope.action === "capabilities") {
    const capabilities = buildCapabilities(appConfig, client.user.id);
    const result = createPeerEnvelope({
      type: "devbot.peer.result",
      requestId: envelope.requestId,
      from: client.user.id,
      owner: appConfig.botIdentity.owner,
      action: envelope.action,
      ok: true,
      message: formatCapabilities(capabilities),
      capabilities
    });
    await message.reply(formatPeerEnvelope(result));
    return;
  }

  let project: ProjectEntry | undefined;
  try {
    project = envelope.project ? findProject(appConfig.projects, envelope.project) : defaultProject(appConfig.projects);
  } catch {
    project = undefined;
  }
  if (!project) {
    const result = createPeerEnvelope({
      type: "devbot.peer.result",
      requestId: envelope.requestId,
      from: client.user.id,
      owner: appConfig.botIdentity.owner,
      action: envelope.action,
      ok: false,
      message: `Unknown project: ${envelope.project}`
    });
    await message.reply(formatPeerEnvelope(result));
    return;
  }

  if (envelope.action === "status") {
    const status = await getStatusSnapshotResponse(appConfig, false, project, envelope.target ?? "");
    const result = createPeerEnvelope({
      type: "devbot.peer.result",
      requestId: envelope.requestId,
      from: client.user.id,
      owner: appConfig.botIdentity.owner,
      action: envelope.action,
      project: project.name,
      ok: true,
      message: status.content
    });
    await message.reply(formatPeerEnvelope(result));
    return;
  }

  if (envelope.action === "snip") {
    const screenshot = await captureProjectScreenshot(project, { requestText: envelope.target ?? "" });
    const result = createPeerEnvelope({
      type: "devbot.peer.result",
      requestId: envelope.requestId,
      from: client.user.id,
      owner: appConfig.botIdentity.owner,
      action: envelope.action,
      project: project.name,
      ok: Boolean(screenshot),
      message: screenshot ? formatScreenshotReply(project, screenshot) : `No running local web UI found for ${project.name}.`
    });
    await message.reply({
      content: formatPeerEnvelope(result),
      files: screenshot ? [new AttachmentBuilder(screenshot.image, { name: screenshot.fileName })] : []
    });
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

function formatScreenshotReply(project: ProjectEntry, screenshot: ProjectScreenshot): string {
  const diagnostics = screenshot.metadata;
  const issueCount = diagnostics.consoleErrors.length + diagnostics.failedRequests.length + diagnostics.badResponses.length;
  const lines = [
    `Attached live UI screenshot for \`${project.name}\`.`,
    `URL: ${diagnostics.finalUrl}`,
    `Viewport: ${diagnostics.viewport}`,
    `Captured: ${new Date(diagnostics.capturedAt).toLocaleString()}`,
    `Diagnostics: ${issueCount === 0 ? "no console errors, failed requests, or bad responses captured." : `${issueCount} issue(s) captured.`}`
  ];

  if (issueCount > 0) {
    lines.push(formatDiagnosticList("Console errors", diagnostics.consoleErrors));
    lines.push(formatDiagnosticList("Failed requests", diagnostics.failedRequests));
    lines.push(formatDiagnosticList("Bad HTTP responses", diagnostics.badResponses));
  }

  return lines.filter(Boolean).join("\n");
}

function formatDiagnosticList(label: string, values: string[]): string {
  if (values.length === 0) {
    return "";
  }

  return `${label}:\n${values.slice(0, 5).map((value) => `- ${value}`).join("\n")}`;
}

function formatProjectSummary(project: ProjectEntry): string {
  const commands = configuredCommandNames(project);
  const details = [
    `- \`${project.name}\` -> \`${project.root}\``,
    project.metadata.frontendUrl ? `frontend: ${project.metadata.frontendUrl}` : undefined,
    commands.length > 0 ? `commands: ${commands.map((command) => `\`${command}\``).join(", ")}` : undefined,
    project.metadata.ownerBot ? `owner bot: ${project.metadata.ownerBot}` : undefined
  ].filter(Boolean);

  return details.join(" | ");
}

function parseCommandNames(value: string | null): string[] | undefined {
  const parsed = parseIncludePatterns(value);
  return parsed.length > 0 ? parsed.map((item) => item.toLowerCase()) : undefined;
}

function parseBotId(value: string): string {
  return value.trim().replace(/[<@!>]/g, "");
}

async function sendPeerMessage(
  interaction: ChatInputCommandInteraction,
  appConfig: AppConfig,
  content: string
): Promise<void> {
  if (appConfig.coordinationChannelId) {
    const channel = await client.channels.fetch(appConfig.coordinationChannelId);
    if (!channel?.isTextBased()) {
      throw new Error(`Configured coordination channel ${appConfig.coordinationChannelId} is not text-based.`);
    }
    await sendToTextChannel(channel, content);
    return;
  }

  const channel = interaction.channel;
  if (!channel?.isTextBased()) {
    throw new Error("This command must be used in a text channel or COORDINATION_CHANNEL_ID must be configured.");
  }
  await sendToTextChannel(channel, content);
}

async function sendToTextChannel(channel: unknown, content: string): Promise<void> {
  const sendable = channel as { send?: (message: string) => Promise<unknown> };
  if (!sendable.send) {
    throw new Error("Target channel cannot send messages.");
  }

  await sendable.send(content);
}

function optionalPeerField(key: "project" | "target", value: string | null): Partial<Record<"project" | "target", string>> {
  return value?.trim() ? { [key]: value.trim() } : {};
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
  const project = findProject(projects, name);
  if (!project) {
    throw new Error(`Unknown project: ${name}`);
  }

  return project;
}

function findProject(projects: ProjectEntry[], name: string): ProjectEntry | undefined {
  const normalized = name.trim().toLowerCase();
  return projects.find(
    (entry) =>
      entry.name === normalized ||
      entry.metadata.aliases.includes(normalized) ||
      entry.metadata.canonicalName?.toLowerCase() === normalized
  );
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
