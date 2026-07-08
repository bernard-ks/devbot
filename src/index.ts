import {
  AttachmentBuilder,
  Client,
  GatewayIntentBits,
  GuildMember,
  MessageFlags,
} from "discord.js";
import type { AutocompleteInteraction, ChatInputCommandInteraction, Interaction, Message } from "discord.js";
import { commandChoices, peerChoices, projectChoices, taskChoices } from "./autocomplete.js";
import { createCollabEnvelope, formatCollabEnvelope, parseCollabEnvelope } from "./collab-protocol.js";
import type { CollabCapability, CollabEnvelopeV2, CollabIntent, CollabMode } from "./collab-protocol.js";
import { CollabStore, formatCollabRecent } from "./collab-store.js";
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
import {
  commandRequiresApproval,
  isPeerAllowedForProject,
  isScreenshotBlocked,
  isWriteBlockedBySafeMode,
  safeModeActionMessage,
  screenshotRequiresApproval
} from "./safety.js";
import { formatTaskDetail, formatTaskList, formatTaskLogs, TaskStore, type TaskStatus } from "./task-store.js";
import { findExternalCodexWork, formatWorkStatus, WorkTracker } from "./work-status.js";
import type { AppConfig, PackedProjectContext, ProjectEntry } from "./types.js";
import {
  eventArtifact,
  formatApprovalCard,
  formatBossFight,
  formatCampfire,
  formatCollabEvents,
  formatHandoffCard,
  formatLabHeader,
  formatPeerFanout,
  formatRitual,
  formatRoundtableResult,
  formatSafetySummary,
  labPrompt
} from "./lab.js";

const config = loadConfig();
const contextService = new ProjectContextService(config.scanner);
const workTracker = new WorkTracker();
const taskStore = new TaskStore(process.env.DEVBOT_TASK_STORE?.trim() || undefined);
const peerStore = new PeerStore(process.env.DEVBOT_PEER_STORE?.trim() || undefined);
const collabStore = new CollabStore(process.env.DEVBOT_COLLAB_STORE?.trim() || undefined);
const activeTaskControllers = new Map<string, AbortController>();
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
      await handleAutocomplete(interaction, config);
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

    if (isWriteBlockedBySafeMode(config, request.mode)) {
      await message.reply(safeModeActionMessage("action-style mentions"));
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
    if (project && !(await ensureProjectAccess(interaction, project))) {
      return;
    }
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
    if (!(await ensureProjectAccess(interaction, project))) {
      return;
    }
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

  if (interaction.commandName === "lab") {
    await handleLabCommand(interaction, appConfig);
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
    if (!(await ensureProjectAccess(interaction, project))) {
      return;
    }
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
    if (isWriteBlockedBySafeMode(appConfig, "action")) {
      await interaction.editReply(safeModeActionMessage("/act"));
      return;
    }

    const project = mustFindProject(appConfig.projects, interaction.options.getString("project", true));
    if (!(await ensureProjectAccess(interaction, project))) {
      return;
    }
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
  if (isWriteBlockedBySafeMode(options.appConfig, options.mode)) {
    throw new Error(safeModeActionMessage(options.source));
  }

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
  const controller = new AbortController();
  activeTaskControllers.set(task.id, controller);

  try {
    const context = await contextService.pack(options.project, options.text, options.includePatterns);
    const answer = await runCodex(options.appConfig, options.text, context, options.mode, controller.signal);
    await taskStore.succeed(task.id, {
      contextFileCount: context.files.length,
      resultPreview: answer
    });
    return { answer, context, taskId: task.id };
  } catch (error) {
    if (controller.signal.aborted) {
      await taskStore.cancel(task.id, "Canceled by user request.");
    } else {
      await taskStore.fail(task.id, error);
    }
    throw error;
  } finally {
    activeTaskControllers.delete(task.id);
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
    activeTaskControllers.get(id)?.abort();
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

    if (isWriteBlockedBySafeMode(appConfig, task.mode === "action" ? "action" : "answer")) {
      await interaction.editReply(safeModeActionMessage("/task retry"));
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
  if (!(await ensureProjectAccess(interaction, project))) {
    return;
  }
  const command = interaction.options.getString("command", true);
  const result = await runConfiguredProjectCommand(project, command);
  await editInteractionWithChunks(interaction, { content: formatProjectCommandResult(result) });
}

async function handleReviewCommand(interaction: ChatInputCommandInteraction, appConfig: AppConfig): Promise<void> {
  const subcommand = interaction.options.getSubcommand();
  const project = mustFindProject(appConfig.projects, interaction.options.getString("project", true));
  if (!(await ensureProjectAccess(interaction, project))) {
    return;
  }

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

  if (subcommand === "help") {
    await interaction.reply({ content: formatDevbotHelp(appConfig), flags: MessageFlags.Ephemeral });
    return;
  }

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

async function handleLabCommand(interaction: ChatInputCommandInteraction, appConfig: AppConfig): Promise<void> {
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "recent") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply(formatCollabRecent(await collabStore.recent(interaction.options.getInteger("limit") ?? 10)));
    return;
  }

  if (subcommand === "events") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const id = interaction.options.getString("id", true);
    const events = await collabStore.events(id);
    await interaction.editReply([`Events for \`${id}\`:`, formatCollabEvents(events)].join("\n"));
    return;
  }

  if (subcommand === "approve") {
    await interaction.deferReply();
    const id = interaction.options.getString("id", true);
    const decision = interaction.options.getString("decision", true);
    const action = interaction.options.getString("action") ?? "record";
    const projectName = interaction.options.getString("project") ?? undefined;
    const commandNames = parseCommandNames(interaction.options.getString("commands"));
    const note = interaction.options.getString("note") ?? "";
    let actionResult: string | undefined;

    if (decision === "approve" && action !== "record") {
      if (appConfig.safeMode) {
        actionResult = "Safe mode is on, so the approval was recorded but no command was executed.";
      } else if (!projectName) {
        actionResult = "Approval recorded. Add `project:<name>` to execute validation or gates.";
      } else {
        const project = mustFindProject(appConfig.projects, projectName);
        if (action === "validate") {
          const results = await validateReview(project, commandNames);
          actionResult = formatValidationResults(project, results);
        } else if (action === "gates") {
          const result = await evaluateMergeGates(project, commandNames);
          actionResult = formatMergeGateResult(project, result);
        }
      }
    }

    await collabStore.addEvent({
      conversationId: id,
      type: "approval",
      actor: interaction.user.tag,
      summary: `${decision}${action !== "record" ? ` ${action}` : ""}${note ? `: ${note}` : ""}`,
      mode: decision === "approve" ? "write" : "read",
      artifacts: [
        eventArtifact("approval", decision, note || undefined),
        ...(actionResult ? [eventArtifact(action === "gates" ? "validation" : "validation", action, projectName)] : [])
      ]
    });
    await editInteractionWithChunks(interaction, {
      content: [
        `Recorded \`${decision}\` for lab session \`${id}\`${note ? `: ${note}` : "."}`,
        actionResult ? ["", actionResult].join("\n") : undefined
      ]
        .filter((line) => line !== undefined)
        .join("\n")
    });
    return;
  }

  if (subcommand === "safety") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const projectName = interaction.options.getString("project");
    const project = projectName ? mustFindProject(appConfig.projects, projectName) : undefined;
    if (project && !(await ensureProjectAccess(interaction, project))) {
      return;
    }
    await interaction.editReply(formatSafetySummary(appConfig, project));
    return;
  }

  if (subcommand === "roster") {
    await interaction.deferReply();
    const peers = await allowedPeerRecords(appConfig);
    const conversation = await startLabConversation(interaction, subcommand, undefined, "Capability Trading Cards");
    await collabStore.addEvent({
      conversationId: conversation.id,
      type: "artifact",
      actor: interaction.user.tag,
      summary: `Rendered ${peers.length} peer capability card(s).`,
      artifacts: [eventArtifact("log", "peer roster", `${peers.length} peer(s)`)]
    });
    await interaction.editReply([formatLabHeader(conversation), "", formatPeerList(peers)].join("\n"));
    return;
  }

  if (subcommand === "campfire") {
    await interaction.deferReply();
    const minutes = interaction.options.getInteger("minutes") ?? 30;
    const projectName = interaction.options.getString("project") ?? undefined;
    const project = projectName ? mustFindProject(appConfig.projects, projectName) : undefined;
    if (project && !(await ensureProjectAccess(interaction, project))) {
      return;
    }
    const running = await taskStore.listRecent({
      status: "running",
      limit: 25,
      ...(project ? { projectName: project.name } : {})
    });
    const cutoff = Date.now() - minutes * 60_000;
    const stale = running.filter((task) => new Date(task.startedAt).getTime() < cutoff);
    const conversation = await startLabConversation(interaction, subcommand, project, `Stale Task Campfire (${minutes}m)`);
    await collabStore.addEvent({
      conversationId: conversation.id,
      type: "artifact",
      actor: interaction.user.tag,
      summary: `Found ${stale.length} stale task(s).`,
      artifacts: stale.map((task) => eventArtifact("task", task.id, task.status))
    });
    await interaction.editReply([formatLabHeader(conversation), "", formatCampfire(stale, minutes)].join("\n"));
    return;
  }

  if (subcommand === "roundtable" || subcommand === "jam" || subcommand === "argue") {
    await interaction.deferReply();
    const project = mustFindProject(appConfig.projects, interaction.options.getString("project", true));
    if (!(await ensureProjectAccess(interaction, project))) {
      return;
    }
    const text =
      subcommand === "roundtable"
        ? interaction.options.getString("prompt", true)
        : subcommand === "jam"
          ? interaction.options.getString("theme", true)
          : interaction.options.getString("proposal", true);
    const conversation = await startLabConversation(interaction, subcommand, project, `${subcommand}: ${text}`);
    const prompt = labPrompt(subcommand, text);
    const { answer, taskId } = await runProjectRequest({
      appConfig,
      project,
      text: prompt,
      includePatterns: [],
      mode: "answer",
      requester: interaction.user.tag,
      source: `lab:${subcommand}`
    });
    await collabStore.addEvent({
      conversationId: conversation.id,
      type: "artifact",
      actor: appConfig.botIdentity.displayName,
      summary: `Local ${subcommand} response saved as ${taskId}.`,
      mode: "think",
      artifacts: [eventArtifact("plan", taskId, subcommand)]
    });
    const peerCount = await fanOutLabRequest(interaction, appConfig, {
      conversationId: conversation.id,
      project,
      intent: subcommand,
      capability: "task.plan",
      mode: "think",
      target: text,
      payload: { prompt, sourceTaskId: taskId }
    });
    const content =
      subcommand === "roundtable"
        ? formatRoundtableResult(conversation, answer, peerCount)
        : [formatLabHeader(conversation), "", answer, "", peerCount > 0 ? `Invited ${peerCount} peer devbot(s) to riff too.` : "No peer devbots invited."].join("\n");
    await editInteractionWithChunks(interaction, { content });
    return;
  }

  if (subcommand === "see") {
    await interaction.deferReply();
    const projectName = interaction.options.getString("project");
    const project = projectName ? mustFindProject(appConfig.projects, projectName) : defaultProject(appConfig.projects);
    if (!(await ensureProjectAccess(interaction, project))) {
      return;
    }
    const target = interaction.options.getString("target", true);
    const viewport = interaction.options.getString("viewport") as "desktop" | "tablet" | "mobile" | null;
    const conversation = await startLabConversation(interaction, subcommand, project, `Screenshot Seance: ${target}`);
    const screenshotApproval = screenshotPolicyMessage(project, interaction.user.tag);
    const screenshot = screenshotApproval ? undefined : await captureProjectScreenshot(project, { requestText: target, viewport: viewport ?? "desktop" });
    const peerCount = await fanOutLabRequest(interaction, appConfig, {
      conversationId: conversation.id,
      project,
      intent: "see",
      capability: "screenshot.read",
      mode: "read",
      target,
      payload: { target, viewport: viewport ?? "desktop" }
    });
    await collabStore.addEvent({
      conversationId: conversation.id,
      type: "artifact",
      actor: appConfig.botIdentity.displayName,
      summary: screenshot ? `Captured local screenshot for ${target}.` : `No local screenshot available for ${target}.`,
      mode: "read",
      artifacts: screenshot ? [eventArtifact("screenshot", screenshot.fileName, screenshot.metadata.finalUrl)] : []
    });
    const content = [
      formatLabHeader(conversation),
      "",
      screenshotApproval ?? (screenshot ? formatScreenshotReply(project, screenshot) : `No running local web UI found for \`${project.name}\`.`),
      "",
      formatPeerFanout("see", await allowedPeerRecords(appConfig, project), target),
      peerCount > 0 ? `Sent ${peerCount} peer screenshot request(s).` : undefined
    ]
      .filter(Boolean)
      .join("\n");
    await editInteractionWithChunks(interaction, {
      content,
      ...(screenshot ? { image: screenshot.image, imageName: screenshot.fileName } : {})
    });
    return;
  }

  if (subcommand === "handoff") {
    await interaction.deferReply();
    const project = mustFindProject(appConfig.projects, interaction.options.getString("project", true));
    if (!(await ensureProjectAccess(interaction, project))) {
      return;
    }
    const target = interaction.options.getString("target", true);
    const taskId = interaction.options.getString("task") ?? undefined;
    const task = taskId ? await taskStore.get(taskId) : undefined;
    const packet = await createReviewPacket(project, task);
    const conversation = await startLabConversation(interaction, subcommand, project, `Baton Pass to ${target}`);
    await collabStore.addEvent({
      conversationId: conversation.id,
      type: "artifact",
      actor: interaction.user.tag,
      summary: `Created handoff for ${target}.`,
      artifacts: [eventArtifact("review-packet", "handoff packet", project.name)]
    });
    await maybeSendTargetedReviewRequest(interaction, appConfig, conversation.id, target, project, formatReviewPacket(packet), taskId);
    await editInteractionWithChunks(interaction, {
      content: formatHandoffCard({
        conversation,
        task,
        target,
        reviewPacket: formatReviewPacket(packet)
      })
    });
    return;
  }

  if (subcommand === "bossfight") {
    await interaction.deferReply();
    const project = mustFindProject(appConfig.projects, interaction.options.getString("project", true));
    if (!(await ensureProjectAccess(interaction, project))) {
      return;
    }
    const taskId = interaction.options.getString("task") ?? undefined;
    const task = taskId ? await taskStore.get(taskId) : undefined;
    const packet = await createReviewPacket(project, task);
    const conversation = await startLabConversation(interaction, subcommand, project, "Boss Fight Review");
    const commandNames = parseCommandNames(interaction.options.getString("commands"));
    const commandApprovalRequired = commandsNeedApproval(project, commandNames);
    const gates = appConfig.safeMode || commandApprovalRequired ? undefined : await evaluateMergeGates(project, commandNames).then((result) => formatMergeGateResult(project, result));
    const approval = appConfig.safeMode || commandApprovalRequired
      ? formatApprovalCard({
          action: "Run local merge gates",
          actor: interaction.user.tag,
          projectName: project.name,
          risk: "medium",
          reason: appConfig.safeMode
            ? "Safe mode blocks validation commands because project presets may mutate local state."
            : "Project policy marks one or more validation commands as approval-required.",
          scope: "Configured project command presets only",
          sideEffects: "May run package scripts, build artifacts, tests, or network calls depending on project config."
        })
      : undefined;
    const peerCount = await fanOutLabRequest(interaction, appConfig, {
      conversationId: conversation.id,
      project,
      intent: "bossfight",
      capability: "review.packet",
      mode: "read",
      target: "bossfight review",
      payload: { taskId, reviewPacket: formatReviewPacket(packet) }
    });
    await collabStore.addEvent({
      conversationId: conversation.id,
      type: "artifact",
      actor: appConfig.botIdentity.displayName,
      summary: `Boss fight prepared with ${peerCount} peer observer(s).`,
      artifacts: [eventArtifact("review-packet", "bossfight review", project.name)]
    });
    await editInteractionWithChunks(interaction, {
      content: formatBossFight({
        conversation,
        reviewPacket: formatReviewPacket(packet),
        gates,
        peerCount,
        ...(approval ? { approval } : {})
      })
    });
    return;
  }

  if (subcommand === "fix-from-snip") {
    await interaction.deferReply();
    const project = mustFindProject(appConfig.projects, interaction.options.getString("project", true));
    if (!(await ensureProjectAccess(interaction, project))) {
      return;
    }
    const target = interaction.options.getString("target", true);
    const complaint = interaction.options.getString("complaint", true);
    const conversation = await startLabConversation(interaction, subcommand, project, `Snip-to-Fix: ${target}`);
    const screenshotApproval = screenshotPolicyMessage(project, interaction.user.tag);
    const screenshot = screenshotApproval ? undefined : await captureProjectScreenshot(project, { requestText: target });
    const prompt = labPrompt("fix-from-snip", `${complaint}\n\nTarget: ${target}`);
    const { answer, taskId } = await runProjectRequest({
      appConfig,
      project,
      text: prompt,
      includePatterns: [],
      mode: "answer",
      requester: interaction.user.tag,
      source: "lab:fix-from-snip"
    });
    const approval = formatApprovalCard({
      action: "Run scoped UI fix from screenshot complaint",
      actor: interaction.user.tag,
      projectName: project.name,
      risk: "medium",
      reason: "This would start write-capable Codex work based on visual evidence.",
      scope: "Selected project only; no secrets/config; before/after screenshot expected.",
      sideEffects: "May edit UI files and run verification commands."
    });
    await collabStore.addEvent({
      conversationId: conversation.id,
      type: "approval",
      actor: appConfig.botIdentity.displayName,
      summary: `Prepared fix plan ${taskId}; waiting for owner approval before writes.`,
      mode: "write",
      artifacts: [eventArtifact("plan", taskId, "fix-from-snip")]
    });
    await editInteractionWithChunks(interaction, {
      content: [formatLabHeader(conversation), "", screenshotApproval ?? (screenshot ? formatScreenshotReply(project, screenshot) : "No local screenshot captured."), "", answer, "", approval].join("\n"),
      ...(screenshot ? { image: screenshot.image, imageName: screenshot.fileName } : {})
    });
    return;
  }

  if (subcommand === "ritual") {
    await interaction.deferReply();
    const project = mustFindProject(appConfig.projects, interaction.options.getString("project", true));
    if (!(await ensureProjectAccess(interaction, project))) {
      return;
    }
    const taskId = interaction.options.getString("task") ?? undefined;
    const task = taskId ? await taskStore.get(taskId) : undefined;
    const packet = await createReviewPacket(project, task);
    const recentTasks = await taskStore.listRecent({ limit: 5, projectName: project.name });
    const conversation = await startLabConversation(interaction, subcommand, project, "Merge Ritual Thread");
    await collabStore.addEvent({
      conversationId: conversation.id,
      type: "artifact",
      actor: interaction.user.tag,
      summary: "Created merge ritual card.",
      artifacts: [eventArtifact("review-packet", "merge ritual", project.name)]
    });
    await editInteractionWithChunks(interaction, {
      content: formatRitual({
        conversation,
        reviewPacket: formatReviewPacket(packet),
        tasks: recentTasks,
        safety: formatSafetySummary(appConfig, project)
      })
    });
  }
}

async function maybeHandlePeerMessage(message: Message, appConfig: AppConfig): Promise<void> {
  if (!client.user || !appConfig.peerBotIds.has(message.author.id)) {
    return;
  }

  const collabEnvelope = parseCollabEnvelope(message.content);
  if (collabEnvelope) {
    await maybeHandleCollabPeerMessage(message, appConfig, collabEnvelope);
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
  if (!isPeerAllowedForProject(project, message.author.id)) {
    const result = createPeerEnvelope({
      type: "devbot.peer.result",
      requestId: envelope.requestId,
      from: client.user.id,
      owner: appConfig.botIdentity.owner,
      action: envelope.action,
      project: project.name,
      ok: false,
      message: `Peer <@${message.author.id}> is not allowed for project ${project.name}.`
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
    const approval = screenshotPolicyMessage(project, envelope.owner);
    if (approval) {
      const result = createPeerEnvelope({
        type: "devbot.peer.result",
        requestId: envelope.requestId,
        from: client.user.id,
        owner: appConfig.botIdentity.owner,
        action: envelope.action,
        project: project.name,
        ok: false,
        message: approval
      });
      await message.reply(formatPeerEnvelope(result));
      return;
    }

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

async function maybeHandleCollabPeerMessage(
  message: Message,
  appConfig: AppConfig,
  envelope: CollabEnvelopeV2
): Promise<void> {
  if (!client.user) {
    return;
  }

  if (envelope.type !== "devbot.peer.request") {
    await collabStore.addEvent({
      conversationId: envelope.conversationId,
      type: envelope.type === "devbot.peer.result" ? "peer-result" : envelope.type === "devbot.peer.approval" ? "approval" : "note",
      actor: envelope.from.botName ?? envelope.from.owner,
      summary: `${envelope.intent} ${envelope.capability}`,
      mode: envelope.mode,
      artifacts: envelope.artifacts
    });
    return;
  }

  if (!message.mentions.users.has(client.user.id)) {
    return;
  }

  let project: ProjectEntry | undefined;
  try {
    project = envelope.to?.project ? findProject(appConfig.projects, envelope.to.project) : defaultProject(appConfig.projects);
  } catch {
    project = undefined;
  }
  if (!project) {
    await replyWithCollabResult(message, appConfig, envelope, false, `Unknown project: ${envelope.to?.project ?? "(default)"}`);
    return;
  }
  if (!isPeerAllowedForProject(project, message.author.id)) {
    await replyWithCollabResult(message, appConfig, envelope, false, `Peer <@${message.author.id}> is not allowed for project ${project.name}.`);
    return;
  }

  if (envelope.capability === "status.read") {
    const status = await getStatusSnapshotResponse(appConfig, false, project, String(envelope.payload.target ?? ""));
    await replyWithCollabResult(message, appConfig, envelope, true, status.content);
    return;
  }

  if (envelope.capability === "screenshot.read") {
    const approval = screenshotPolicyMessage(project, envelope.from.botName ?? envelope.from.owner);
    if (approval) {
      await replyWithCollabApproval(message, appConfig, envelope, approval);
      return;
    }

    const target = String(envelope.payload.target ?? envelope.payload.prompt ?? "");
    const screenshot = await captureProjectScreenshot(project, { requestText: target });
    await replyWithCollabResult(message, appConfig, envelope, Boolean(screenshot), screenshot ? formatScreenshotReply(project, screenshot) : `No running local web UI found for ${project.name}.`, screenshot);
    return;
  }

  if (envelope.capability === "task.plan") {
    const prompt = String(envelope.payload.prompt ?? envelope.payload.target ?? "Give a concise read-only plan.");
    const { answer, taskId } = await runProjectRequest({
      appConfig,
      project,
      text: prompt,
      includePatterns: [],
      mode: "answer",
      requester: envelope.from.owner,
      source: "peer:plan"
    });
    await replyWithCollabResult(message, appConfig, envelope, true, answer, undefined, [eventArtifact("plan", taskId, envelope.intent)]);
    return;
  }

  if (envelope.capability === "review.packet") {
    const taskId = typeof envelope.payload.taskId === "string" ? envelope.payload.taskId : undefined;
    const task = taskId ? await taskStore.get(taskId) : undefined;
    const packet = await createReviewPacket(project, task);
    await replyWithCollabResult(message, appConfig, envelope, true, formatReviewPacket(packet), undefined, [
      eventArtifact("review-packet", "peer review packet", project.name)
    ]);
    return;
  }

  const approval = formatApprovalCard({
    action: envelope.capability,
    actor: envelope.from.botName ?? envelope.from.owner,
    projectName: project.name,
    risk: envelope.capability === "review.validate" ? "medium" : "high",
    reason: "Peer-requested validation or mutation requires explicit owner approval.",
    scope: "Selected project only after owner approval.",
    sideEffects: "May run local commands, edit files, push, merge, deploy, or otherwise mutate state depending on the approved action."
  });
  await replyWithCollabApproval(message, appConfig, envelope, approval);
}

async function replyWithCollabResult(
  message: Message,
  appConfig: AppConfig,
  request: CollabEnvelopeV2,
  ok: boolean,
  resultMessage: string,
  screenshot?: ProjectScreenshot,
  artifacts = request.artifacts
): Promise<void> {
  if (!client.user) {
    return;
  }

  const result = createCollabEnvelope({
    type: "devbot.peer.result",
    conversationId: request.conversationId,
    requestId: request.requestId,
    correlationId: request.requestId,
    from: {
      botId: client.user.id,
      owner: appConfig.botIdentity.owner,
      botName: appConfig.botIdentity.displayName
    },
    to: {
      botId: request.from.botId,
      ...(request.to?.project ? { project: request.to.project } : {})
    },
    capability: request.capability,
    intent: request.intent,
    mode: request.mode,
    requiresApproval: false,
    payload: {
      ok,
      message: resultMessage
    },
    artifacts
  });
  await message.reply({
    content: formatCollabEnvelope(result),
    files: screenshot ? [new AttachmentBuilder(screenshot.image, { name: screenshot.fileName })] : []
  });
}

async function replyWithCollabApproval(
  message: Message,
  appConfig: AppConfig,
  request: CollabEnvelopeV2,
  approval: string
): Promise<void> {
  if (!client.user) {
    return;
  }

  const result = createCollabEnvelope({
    type: "devbot.peer.approval",
    conversationId: request.conversationId,
    requestId: request.requestId,
    correlationId: request.requestId,
    from: {
      botId: client.user.id,
      owner: appConfig.botIdentity.owner,
      botName: appConfig.botIdentity.displayName
    },
    to: {
      botId: request.from.botId,
      ...(request.to?.project ? { project: request.to.project } : {})
    },
    capability: request.capability,
    intent: request.intent,
    mode: request.mode,
    requiresApproval: true,
    payload: {
      message: approval
    },
    artifacts: [eventArtifact("approval", "approval required", request.capability)]
  });
  await message.reply([approval, "", formatCollabEnvelope(result)].join("\n"));
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

function formatDevbotHelp(appConfig: AppConfig): string {
  return [
    `Devbot help for \`${appConfig.botIdentity.displayName}\``,
    `Safe mode: ${appConfig.safeMode ? "on" : "off"}`,
    "",
    "Common workflows:",
    "- Check work: `/status` or `/dashboard`.",
    "- Ask read-only questions: `/ask project:<name> question:<text>`.",
    "- Capture UI: `/snip project:<name> target:<page or path>`.",
    "- Inspect tasks: `/task recent`, `/task show`, `/task logs`, `/task retry`.",
    "- Run configured validation: `/run project:<name> command:<preset>` or `/review validate`.",
    "- Prepare handoff: `/review packet project:<name> task:<task-id>`.",
    "- Coordinate peers: `/devbot announce`, `/devbot peers`, `/peer status`, `/peer snip`.",
    "- Collaborate in the private lab: `/lab roundtable`, `/lab see`, `/lab bossfight`, `/lab ritual`, `/lab safety`.",
    "",
    appConfig.safeMode
      ? "Write-capable actions are disabled while safe mode is on: `/act`, action-style mentions, `/run`, and review validation."
      : "Write-capable actions are enabled for allowed users: `/act`, action-style mentions, `/run`, and review validation."
  ].join("\n");
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

async function startLabConversation(
  interaction: ChatInputCommandInteraction,
  intent: CollabIntent,
  project: ProjectEntry | undefined,
  title: string
) {
  const conversation = await collabStore.start({
    intent,
    title,
    requester: interaction.user.tag,
    channelId: interaction.channelId,
    ...(project ? { projectName: project.name } : {})
  });
  const thread = await createLabThread(interaction, conversation.id, intent, title);
  if (!thread) {
    return conversation;
  }

  const updated = await collabStore.setThread(conversation.id, thread.id);
  const withThread = updated ?? { ...conversation, threadId: thread.id };
  await sendToTextChannel(thread, [
    formatLabHeader(withThread),
    "",
    `Started by ${interaction.user.tag}.`,
    "This thread is the human-visible audit room for this lab session."
  ].join("\n"));
  return withThread;
}

async function createLabThread(
  interaction: ChatInputCommandInteraction,
  conversationId: string,
  intent: CollabIntent,
  title: string
): Promise<{ id: string; send?: (message: string) => Promise<unknown> } | undefined> {
  const threaded = interaction.channel as
    | {
        threads?: {
          create?: (options: { name: string; autoArchiveDuration?: number; reason?: string }) => Promise<{
            id: string;
            send?: (message: string) => Promise<unknown>;
          }>;
        };
      }
    | null;
  if (!threaded?.threads?.create) {
    return undefined;
  }

  try {
    return await threaded.threads.create({
      name: labThreadName(conversationId, intent, title),
      autoArchiveDuration: 1440,
      reason: "Devbot collaboration lab session"
    });
  } catch (error) {
    console.warn(`Unable to create lab thread for ${conversationId}: ${(error as Error).message}`);
    return undefined;
  }
}

function labThreadName(conversationId: string, intent: CollabIntent, title: string): string {
  const compactTitle = title
    .replace(/[`*_~|>#[\]\n\r]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const suffix = conversationId.split("-").slice(-1)[0] ?? conversationId;
  return `${intent} ${compactTitle || "lab"} ${suffix}`.slice(0, 100);
}

async function allowedPeerRecords(appConfig: AppConfig, project?: ProjectEntry) {
  const known = await peerStore.list();
  const records = known.filter((peer) => appConfig.peerBotIds.has(peer.botId) && (!project || isPeerAllowedForProject(project, peer.botId)));
  const knownIds = new Set(records.map((peer) => peer.botId));
  for (const botId of appConfig.peerBotIds) {
    if (!knownIds.has(botId) && (!project || isPeerAllowedForProject(project, botId))) {
      records.push({
        botId,
        owner: "unknown",
        botName: botId,
        projects: [],
        commands: [],
        supportsScreenshots: false,
        safeMode: true,
        lastSeenAt: new Date(0).toISOString()
      });
    }
  }
  return records;
}

function screenshotPolicyMessage(project: ProjectEntry, actor: string): string | undefined {
  if (isScreenshotBlocked(project)) {
    return formatApprovalCard({
      action: "Capture project screenshot",
      actor,
      projectName: project.name,
      risk: "medium",
      reason: "Project policy blocks screenshots for this project.",
      scope: "No screenshot captured.",
      sideEffects: "None."
    });
  }

  if (screenshotRequiresApproval(project)) {
    return formatApprovalCard({
      action: "Capture project screenshot",
      actor,
      projectName: project.name,
      risk: "medium",
      reason: "Project policy requires approval before screenshots, because local UI may expose authenticated or private state.",
      scope: "Configured frontend URL or detected local dev server only.",
      sideEffects: "May expose visible UI contents in Discord."
    });
  }

  return undefined;
}

function commandsNeedApproval(project: ProjectEntry, commandNames: string[] | undefined): boolean {
  const names = commandNames?.length ? commandNames : configuredCommandNames(project);
  return names.some((name) => commandRequiresApproval(project, name));
}

async function fanOutLabRequest(
  interaction: ChatInputCommandInteraction,
  appConfig: AppConfig,
  input: {
    conversationId: string;
    project: ProjectEntry;
    intent: CollabIntent;
    capability: CollabCapability;
    mode: CollabMode;
    target: string;
    payload: Record<string, unknown>;
  }
): Promise<number> {
  const peers = await allowedPeerRecords(appConfig, input.project);
  let sent = 0;
  for (const peer of peers) {
    const envelope = createCollabEnvelope({
      type: "devbot.peer.request",
      conversationId: input.conversationId,
      from: {
        botId: client.user?.id ?? "unknown",
        owner: appConfig.botIdentity.owner,
        botName: appConfig.botIdentity.displayName
      },
      to: {
        botId: peer.botId,
        project: input.project.name
      },
      capability: input.capability,
      intent: input.intent,
      mode: input.mode,
      requiresApproval: input.mode === "write" || input.capability === "review.validate",
      payload: input.payload,
      artifacts: []
    });
    await sendPeerMessage(interaction, appConfig, `<@${peer.botId}>\n${formatCollabEnvelope(envelope)}`);
    await collabStore.addEvent({
      conversationId: input.conversationId,
      type: "peer-request",
      actor: appConfig.botIdentity.displayName,
      summary: `Requested ${input.capability} from ${peer.botName} for ${input.target}.`,
      mode: input.mode
    });
    sent += 1;
  }
  return sent;
}

async function maybeSendTargetedReviewRequest(
  interaction: ChatInputCommandInteraction,
  appConfig: AppConfig,
  conversationId: string,
  target: string,
  project: ProjectEntry,
  reviewPacket: string,
  taskId: string | undefined
): Promise<void> {
  const botId = parseBotId(target);
  if (!botId || !appConfig.peerBotIds.has(botId)) {
    return;
  }

  const envelope = createCollabEnvelope({
    type: "devbot.peer.request",
    conversationId,
    from: {
      botId: client.user?.id ?? "unknown",
      owner: appConfig.botIdentity.owner,
      botName: appConfig.botIdentity.displayName
    },
    to: {
      botId,
      project: project.name
    },
    capability: "review.packet",
    intent: "handoff",
    mode: "read",
    requiresApproval: false,
    payload: {
      taskId,
      reviewPacket
    },
    artifacts: [eventArtifact("review-packet", "handoff packet", project.name)]
  });
  await sendPeerMessage(interaction, appConfig, `<@${botId}>\n${formatCollabEnvelope(envelope)}`);
  await collabStore.addEvent({
    conversationId,
    type: "peer-request",
    actor: appConfig.botIdentity.displayName,
    summary: `Sent review handoff to <@${botId}>.`,
    mode: "read",
    artifacts: [eventArtifact("review-packet", "peer handoff", project.name)]
  });
}

async function runCodex(
  appConfig: AppConfig,
  text: string,
  context: PackedProjectContext,
  mode: CodexRequestMode,
  signal?: AbortSignal
): Promise<string> {
  return answerWithProjectContext({
    codex: appConfig.codex,
    question: text,
    context,
    mode,
    ...(signal ? { signal } : {})
  });
}

async function handleAutocomplete(interaction: AutocompleteInteraction, appConfig: AppConfig): Promise<void> {
  const focused = interaction.options.getFocused(true);
  const value = String(focused.value ?? "");

  if (focused.name === "project") {
    await interaction.respond(projectChoices(appConfig.projects, value));
    return;
  }

  if (focused.name === "command" || focused.name === "commands") {
    const project = findProjectFromAutocomplete(interaction, appConfig.projects);
    await interaction.respond(commandChoices(project, value));
    return;
  }

  if (focused.name === "id" || focused.name === "task") {
    const project = findProjectFromAutocomplete(interaction, appConfig.projects);
    const tasks = await taskStore.listRecent({ limit: 25, ...(project ? { projectName: project.name } : {}) });
    await interaction.respond(taskChoices(tasks, value));
    return;
  }

  if (focused.name === "bot") {
    await interaction.respond(peerChoices(await peerStore.list(), value));
    return;
  }

  await interaction.respond([]);
}

function findProjectFromAutocomplete(interaction: AutocompleteInteraction, projects: ProjectEntry[]): ProjectEntry | undefined {
  const projectName = interaction.options.getString("project");
  return projectName ? findProject(projects, projectName) : undefined;
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

async function ensureProjectAccess(interaction: ChatInputCommandInteraction, project: ProjectEntry): Promise<boolean> {
  if (isAllowedForProject(interaction, project)) {
    return true;
  }

  const content = `You are not allowed to use project \`${project.name}\` under its .devbot policy.`;
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(content);
  } else {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }
  return false;
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

function isAllowedForProject(interaction: ChatInputCommandInteraction, project: ProjectEntry): boolean {
  const policy = project.metadata.policy;
  const hasProjectAllowList = policy.allowedUsers.length > 0 || policy.allowedRoles.length > 0;
  if (!hasProjectAllowList) {
    return true;
  }

  if (policy.allowedUsers.includes(interaction.user.id)) {
    return true;
  }

  if (interaction.member instanceof GuildMember) {
    return interaction.member.roles.cache.some((role) => policy.allowedRoles.includes(role.id));
  }

  const memberRoles = interaction.member?.roles;
  if (Array.isArray(memberRoles)) {
    return memberRoles.some((roleId) => policy.allowedRoles.includes(roleId));
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
