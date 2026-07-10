import {
  AttachmentBuilder,
  ChannelType,
  Client,
  GatewayIntentBits,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  ThreadAutoArchiveDuration,
} from "discord.js";
import type {
  AutocompleteInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
  GuildTextBasedChannel,
  Interaction,
  Message,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
  UserSelectMenuInteraction
} from "discord.js";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { isApprovedDiscordUsername } from "./access.js";
import { commandChoices, peerChoices, projectChoices, taskChoices } from "./autocomplete.js";
import {
  collabDeliveryKey,
  createCollabEnvelope,
  formatCollabEnvelope,
  isFreshCollabEnvelope,
  parseCollabEnvelope
} from "./collab-protocol.js";
import type { CollabCapability, CollabEnvelopeV2, CollabIntent, CollabMode } from "./collab-protocol.js";
import { CollabStore, formatCollabRecent } from "./collab-store.js";
import type { CollabContribution, CollabConversation } from "./collab-store.js";
import { loadConfig, normalizeProjectName } from "./config.js";
import { ProjectContextService, parseIncludePatterns } from "./context.js";
import { answerWithProjectContext, type CodexRequestMode } from "./codex-client.js";
import { parseMentionRequest, parseStatusRequest, statusDetailQuestion, stripBotMention } from "./mention.js";
import { splitDiscordMessage } from "./messages.js";
import { captureProjectScreenshot, type ProjectScreenshot } from "./project-screenshot.js";
import { configuredCommandNames, formatProjectCommandResult, runConfiguredProjectCommand } from "./command-runner.js";
import { syncCommandsIfChanged } from "./command-sync.js";
import { commandDefinitions } from "./commands.js";
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
import { contextLimitForRoute, routeRequest, type RequestRoute } from "./request-router.js";
import {
  commandRequiresApproval,
  isPeerAllowedForProject,
  isScreenshotBlocked,
  isWriteBlockedBySafeMode,
  safeModeActionMessage,
  screenshotRequiresApproval
} from "./safety.js";
import { formatTaskDetail, formatTaskList, formatTaskLogs, TaskStore, type TaskStatus } from "./task-store.js";
import { parseTaskControl, taskControlRow, type TaskControlAction } from "./task-controls.js";
import { filterWorkForProjects, findExternalCodexWork, formatWorkStatus, WorkTracker, type ProjectWorkSnapshot } from "./work-status.js";
import { parseWorkroomButton, workroomActionRows } from "./workroom-controls.js";
import { applySetupState, captureBootstrapConfig, isSetupController } from "./runtime-setup.js";
import { clearRuntimeLock, markRuntimeRunning, runtimeLockPath } from "./runtime-lock.js";
import { SetupStore, type SetupState, type SetupUserPermission } from "./setup-store.js";
import { parseSetupWizardAction, setupRepositoryModal, setupWizardView, type SetupWizardAction } from "./setup-wizard.js";
import type { AppConfig, PackedProjectContext, ProjectEntry } from "./types.js";
import {
  councilChallengePrompt,
  councilContributionPrompt,
  type CouncilSeatStatus,
  formatCouncilProgress,
  councilSynthesisPrompt,
  eventArtifact,
  formatApprovalCard,
  formatBossFight,
  formatCampfire,
  formatCouncilContributions,
  formatCollabEvents,
  formatHandoffCard,
  formatLabHeader,
  formatPeerFanout,
  formatRitual,
  formatRoundtableResult,
  formatSafetySummary,
  formatWorkroomPanel,
  labPrompt,
  localCouncilSeats
} from "./lab.js";

const config = loadConfig();
const setupStore = new SetupStore(process.env.DEVBOT_SETUP_STORE?.trim() || undefined);
const bootstrapConfig = captureBootstrapConfig(config);
applySetupState(config, bootstrapConfig, setupStore.snapshot());
const contextService = new ProjectContextService(config.scanner);
const workTracker = new WorkTracker();
const taskStore = new TaskStore(process.env.DEVBOT_TASK_STORE?.trim() || undefined);
const peerStore = new PeerStore(process.env.DEVBOT_PEER_STORE?.trim() || undefined);
const collabStore = new CollabStore(process.env.DEVBOT_COLLAB_STORE?.trim() || undefined);
const activeTaskControllers = new Map<string, AbortController>();
const activeWorkroomActions = new Set<string>();
let verifiedPrivateRoomId: string | undefined;
let slashCommandsReady = false;
const runtimePidFile = runtimeLockPath(process.env.DEVBOT_RUNTIME_LOCK);
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

client.once("clientReady", async () => {
  markRuntimeRunning(runtimePidFile);
  if (config.autoDeployCommands && client.application) {
    try {
      const deployed = await syncCommandsIfChanged({
        definitions: commandDefinitions,
        guildId: config.discordGuildId,
        setCommands: (definitions, guildId) => client.application!.commands.set(definitions, guildId)
      });
      slashCommandsReady = true;
      console.log(`Slash commands: ${deployed ? "updated" : "current"}.`);
    } catch (error) {
      console.warn(`Unable to synchronize slash commands: ${(error as Error).message}`);
    }
  }
  const startupSetupState = setupStore.snapshot();
  const configuredRoomId = await verifyPrivateRoom(startupSetupState.privateChannelId ?? bootstrapConfig.coordinationChannelId);
  if (configuredRoomId && startupSetupState.privateChannelId) {
    try {
      const channel = await client.channels.fetch(configuredRoomId);
      if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.PrivateThread)) {
        throw new Error("The configured room is no longer a private text room.");
      }
      await syncPrivateRoomChannel(channel, channel.guild.roles.everyone.id, startupSetupState, config);
      verifiedPrivateRoomId = configuredRoomId;
    } catch (error) {
      verifiedPrivateRoomId = undefined;
      console.warn(`Private room access could not be synchronized; Devbot will remain unavailable: ${(error as Error).message}`);
    }
  } else {
    verifiedPrivateRoomId = configuredRoomId;
  }
  console.log(`Logged in as ${client.user?.tag ?? "unknown bot"}.`);
  console.log(`Devbot identity: ${config.botIdentity.displayName} owned by ${config.botIdentity.owner}. Safe mode: ${config.safeMode ? "on" : "off"}.`);
  console.log(`Configured projects: ${config.projects.map((project) => project.name).join(", ")}`);
  console.log(`Owner setup: ${config.ownerUserId ? "enabled" : "disabled (set DEVBOT_OWNER_USER_ID)"}.`);
  console.log(
    `Request routing: ${config.routing.enabled ? "enabled" : "fallback only"} ` +
      `(fast=${config.routing.fastModel ?? "default"}, standard=${config.routing.standardModel ?? "default"}, deep=${config.routing.deepModel ?? "default"}).`
  );
});

process.once("exit", () => clearRuntimeLock(runtimePidFile));

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      const privateChannelId = effectivePrivateRoomId();
      if (!privateChannelId || interaction.channelId !== privateChannelId) {
        await interaction.respond([]);
        return;
      }
      if (!isAllowed(interaction, config)) {
        await interaction.respond([]);
        return;
      }
      await handleAutocomplete(interaction, config);
      return;
    }

    if (interaction.isButton()) {
      const setupAction = parseSetupWizardAction(interaction.customId);
      if (setupAction) {
        if (!isOwner(interaction.user.id, config)) {
          await interaction.reply({ content: "Only the configured Devbot owner can use setup controls.", flags: MessageFlags.Ephemeral });
          return;
        }
        await handleSetupWizardButton(interaction, config, setupAction);
        return;
      }
      const taskControl = parseTaskControl(interaction.customId);
      if (taskControl) {
        if (!isAllowed(interaction, config)) {
          await interaction.reply({ content: "You are not allowed to use this bot.", flags: MessageFlags.Ephemeral });
          return;
        }
        if (!(await ensureConfiguredRoom(interaction))) {
          return;
        }
        await handleTaskControl(interaction, config, taskControl.action, taskControl.taskId);
        return;
      }
      if (!parseWorkroomButton(interaction.customId)) {
        return;
      }
      if (!isAllowed(interaction, config)) {
        await interaction.reply({ content: "You are not allowed to use this bot.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (!(await ensureConfiguredRoom(interaction))) {
        return;
      }
      await handleWorkroomButton(interaction, config);
      return;
    }

    if (interaction.isUserSelectMenu() || interaction.isStringSelectMenu()) {
      const setupAction = parseSetupWizardAction(interaction.customId);
      if (!setupAction) {
        return;
      }
      if (!isOwner(interaction.user.id, config)) {
        await interaction.reply({ content: "Only the configured Devbot owner can use setup controls.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (interaction.isUserSelectMenu()) {
        await handleSetupUserSelect(interaction, config, setupAction);
      } else {
        await handleSetupProjectSelect(interaction, config, setupAction);
      }
      return;
    }

    if (interaction.isModalSubmit()) {
      const setupAction = parseSetupWizardAction(interaction.customId);
      if (!setupAction) {
        return;
      }
      if (!isOwner(interaction.user.id, config)) {
        await interaction.reply({ content: "Only the configured Devbot owner can use setup controls.", flags: MessageFlags.Ephemeral });
        return;
      }
      await handleSetupRepoModal(interaction, config, setupAction);
      return;
    }

    if (!interaction.isChatInputCommand()) {
      return;
    }

    if (interaction.commandName === "setup") {
      if (!config.ownerUserId) {
        await interaction.reply({
          content: "Devbot has no configured owner. Set `DEVBOT_OWNER_USER_ID` locally, restart, then run `/setup wizard`.",
          flags: MessageFlags.Ephemeral
        });
        return;
      }
      if (!isOwner(interaction.user.id, config)) {
        await interaction.reply({ content: "Only the configured Devbot owner can run `/setup`.", flags: MessageFlags.Ephemeral });
        return;
      }
      await handleSetupCommand(interaction, config);
      return;
    }

    if (!isAllowed(interaction, config)) {
      await interaction.reply({ content: "You are not allowed to use this bot.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (!(await ensureConfiguredRoom(interaction))) {
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

    const privateChannelId = effectivePrivateRoomId();
    if (!privateChannelId) {
      await message.reply("Devbot setup is not ready. Ask the owner to run `/setup wizard`.");
      return;
    }
    if (message.channelId !== privateChannelId) {
      await message.reply("Devbot is configured for its private room.");
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
    if (statusProjectRequest.project && !isAllowedMessageForProject(message, statusProjectRequest.project)) {
      await message.reply(`You are not allowed to use project \`${statusProjectRequest.project.name}\` under its .devbot policy.`);
      return;
    }
    const visibleProjects = config.projects.filter((project) => isAllowedMessageForProject(message, project));
    const visibleConfig = { ...config, projects: visibleProjects };
    const parsedStatusRequest = parseStatusRequest(statusProjectRequest.text);
    const statusRequest = parsedStatusRequest.isStatus
      ? parsedStatusRequest
      : parseFallbackStatusRequest(statusProjectRequest.text);

    if (statusRequest.isStatus) {
      await message.channel.sendTyping();
      console.log(`Status request from ${message.author.tag}: image=${statusRequest.wantsImage} question=${Boolean(statusRequest.question)}`);
      const snapshot = await getStatusSnapshotResponse(visibleConfig, statusRequest.wantsImage, statusProjectRequest.project, statusRequest.question);
      await replyToMessageWithChunks(message, snapshot);

      if (statusRequest.question) {
        const detail = await getDetailedStatusResponse({
          appConfig: visibleConfig,
          question: statusRequest.question,
          requester: message.author.tag,
          project: statusProjectRequest.project
        });
        await replyToMessageWithChunks(message, detail);
      }
      return;
    }

    const request = parseMentionRequest(message.content, client.user.id, visibleProjects, botRoleMentionIds);
    if (!request.text) {
      await message.reply("Ask me a project question after the mention. Use `/do` when you want an intentional code change.");
      return;
    }

    if (!isAllowedMessageForProject(message, request.project)) {
      await message.reply(`You are not allowed to use project \`${request.project.name}\` under its .devbot policy.`);
      return;
    }

    if (request.mode === "action" && !isControllerUser(message.author.id, config)) {
      await message.reply("You have view access, but only the owner or an approved controller can run write-capable work.");
      return;
    }

    if (isWriteBlockedBySafeMode(config, request.mode)) {
      await message.reply(safeModeActionMessage("explicit action mentions"));
      return;
    }

    await message.channel.sendTyping();
    const pending = await message.reply("Routing request...");
    const { answer, route, taskId } = await runProjectRequest({
      appConfig: config,
      project: request.project,
      text: request.text,
      includePatterns: request.includePatterns,
      mode: request.mode,
      requester: message.author.tag,
      source: "mention",
      onRoute: async (selected) => {
        await pending.edit(formatRouteProgress(selected, request.project, request.mode));
      }
    });

    const chunks = splitDiscordMessage(`${answer}\n\n${formatResultFooter(request.project, route, request.mode)}`);
    await pending.edit({ content: chunks[0] ?? "No answer generated.", components: [taskControlRow(taskId)] });

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
  if (commandRequiresController(interaction) && !(await ensureControllerAccess(interaction, appConfig))) {
    return;
  }

  if (interaction.commandName === "projects") {
    const projects = appConfig.projects.filter((project) => isAllowedForProject(interaction, project));
    await interaction.reply({
      content: projects.length ? projects.map(formatProjectSummary).join("\n") : "No configured projects are available to you.",
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
    const visibleProjects = appConfig.projects.filter((entry) => isAllowedForProject(interaction, entry));
    const visibleConfig = { ...appConfig, projects: project ? [project] : visibleProjects };
    const snapshot = await getStatusSnapshotResponse(visibleConfig, interaction.options.getBoolean("image") ?? false, project, question);
    await editInteractionWithChunks(interaction, snapshot);

    if (question) {
      const detail = await getDetailedStatusResponse({
        appConfig: visibleConfig,
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
    const project = selectedProject(appConfig.projects, interaction.options.getString("project"));
    if (!(await ensureProjectAccess(interaction, project))) {
      return;
    }
    const question = interaction.options.getString("question", true);
    const includePatterns = parseIncludePatterns(interaction.options.getString("include"));
    const { answer, route, taskId } = await runProjectRequest({
      appConfig,
      project,
      text: question,
      includePatterns,
      mode: "answer",
      requester: interaction.user.tag,
      source: "slash:ask"
    });

    const chunks = splitDiscordMessage(`${answer}\n\n${formatResultFooter(project, route, "answer")}`);
    await interaction.editReply({ content: chunks[0] ?? "No answer generated.", components: [taskControlRow(taskId)] });

    for (const chunk of chunks.slice(1)) {
      await interaction.followUp(chunk);
    }

    return;
  }

  if (interaction.commandName === "do") {
    await interaction.deferReply();
    if (isWriteBlockedBySafeMode(appConfig, "action")) {
      await interaction.editReply(safeModeActionMessage("/do"));
      return;
    }

    const project = selectedProject(appConfig.projects, interaction.options.getString("project"));
    if (!(await ensureProjectAccess(interaction, project))) {
      return;
    }
    const task = interaction.options.getString("task", true);
    const includePatterns = parseIncludePatterns(interaction.options.getString("include"));
    const { answer, route, taskId } = await runProjectRequest({
      appConfig,
      project,
      text: task,
      includePatterns,
      mode: "action",
      requester: interaction.user.tag,
      source: "slash:do"
    });
    const chunks = splitDiscordMessage(`${answer}\n\n${formatResultFooter(project, route, "action")}`);
    await interaction.editReply({ content: chunks[0] ?? "No answer generated.", components: [taskControlRow(taskId)] });

    for (const chunk of chunks.slice(1)) {
      await interaction.followUp(chunk);
    }
  }
}

async function handleSetupCommand(interaction: ChatInputCommandInteraction, appConfig: AppConfig): Promise<void> {
  if (!appConfig.ownerUserId) {
    await interaction.reply({
      content: "Owner setup is disabled. Set `DEVBOT_OWNER_USER_ID` in the local environment and restart Devbot.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "wizard") {
    await interaction.editReply(setupWizardView(setupStore.snapshot(), appConfig, effectivePrivateRoomId()));
    return;
  }
  if (subcommand === "doctor") {
    await interaction.editReply(await formatSetupDoctor(appConfig));
    return;
  }
  if (subcommand === "show") {
    await interaction.editReply(formatSetupSummary(setupStore.snapshot(), appConfig));
    return;
  }

  if (subcommand === "user") {
    const action = interaction.options.getString("action", true);
    const user = interaction.options.getUser("user", true);
    const permission = interaction.options.getString("permission", true) as SetupUserPermission;
    if (user.bot) {
      await interaction.editReply("Use `/setup devbot` for bot accounts.");
      return;
    }
    if (user.id === appConfig.ownerUserId && action === "remove") {
      await interaction.editReply("The configured owner cannot be removed through Discord setup.");
      return;
    }

    const state = await setupStore.setUser(user.id, permission, action === "add");
    applySetupState(appConfig, bootstrapConfig, state);
    await syncPrivateRoomPermissions(interaction, state, appConfig);
    await interaction.editReply(
      `${action === "add" ? "Granted" : "Removed"} ${permission} access ${action === "add" ? "to" : "from"} <@${user.id}>.`
    );
    return;
  }

  if (subcommand === "devbot") {
    const action = interaction.options.getString("action", true);
    const bot = interaction.options.getUser("bot", true);
    if (!bot.bot || bot.id === client.user?.id) {
      await interaction.editReply("Choose another Discord bot account as the peer Devbot.");
      return;
    }

    const state = await setupStore.setPeer(bot.id, action === "add");
    applySetupState(appConfig, bootstrapConfig, state);
    await syncPrivateRoomPermissions(interaction, state, appConfig);
    await interaction.editReply(`${action === "add" ? "Added" : "Removed"} peer Devbot <@${bot.id}>.`);
    return;
  }

  if (subcommand === "repo") {
    const action = interaction.options.getString("action", true);
    const rawName = interaction.options.getString("name", true);
    const name = normalizeProjectName(rawName);
    if (!/[a-z0-9_]/.test(name)) {
      await interaction.editReply("Repository name must contain a letter, number, underscore, or hyphen.");
      return;
    }

    if (action === "add") {
      const pathValue = interaction.options.getString("path");
      if (!pathValue) {
        await interaction.editReply("`path` is required when adding or updating a repository.");
        return;
      }
      const root = resolveSetupPath(pathValue);
      const rootStats = await stat(root).catch(() => undefined);
      if (!rootStats?.isDirectory()) {
        await interaction.editReply(`Local repository root does not exist or is not a directory: \`${root}\``);
        return;
      }

      const state = await setupStore.setRepository(name, root);
      contextService.invalidate(name);
      applySetupState(appConfig, bootstrapConfig, state);
      await interaction.editReply(`Registered \`${name}\` at \`${root}\`.`);
      return;
    }

    if (action === "remove") {
      const managed = setupStore.snapshot().repositories[name];
      if (!managed) {
        await interaction.editReply(`\`${name}\` is not managed by Discord setup; static env/config projects cannot be removed here.`);
        return;
      }
      const state = await setupStore.removeRepository(name);
      contextService.invalidate(name);
      applySetupState(appConfig, bootstrapConfig, state);
      await interaction.editReply(`Removed setup-managed repository \`${name}\`.`);
      return;
    }

    if (!findProject(appConfig.projects, name)) {
      await interaction.editReply(`Unknown repository: \`${name}\`. Add it before selecting it as default.`);
      return;
    }
    const state = await setupStore.setDefaultProject(name);
    applySetupState(appConfig, bootstrapConfig, state);
    await interaction.editReply(`Selected \`${name}\` as Devbot's default project root.`);
    return;
  }

  const channel = await createOrSyncPrivateRoom(interaction, appConfig, interaction.options.getString("name") ?? undefined);
  await interaction.editReply(`Private Devbot room ready: <#${channel.id}>.`);
}

async function handleSetupWizardButton(
  interaction: ButtonInteraction,
  appConfig: AppConfig,
  action: SetupWizardAction
): Promise<void> {
  if (action === "repo") {
    await interaction.showModal(setupRepositoryModal());
    return;
  }

  await interaction.deferUpdate();
  if (action === "room") {
    await createOrSyncPrivateRoom(interaction, appConfig);
  }
  await interaction.editReply(
    setupWizardView(setupStore.snapshot(), appConfig, effectivePrivateRoomId(), action === "finish")
  );
}

async function handleSetupUserSelect(
  interaction: UserSelectMenuInteraction,
  appConfig: AppConfig,
  action: SetupWizardAction
): Promise<void> {
  if (action !== "viewer" && action !== "controller" && action !== "peer") {
    return;
  }
  await interaction.deferUpdate();
  const selected = [...interaction.users.values()];
  const accepted = action === "peer"
    ? selected.filter((user) => user.bot && user.id !== client.user?.id)
    : selected.filter((user) => !user.bot);
  let state = setupStore.snapshot();
  for (const user of accepted) {
    state = action === "peer"
      ? await setupStore.setPeer(user.id, true)
      : await setupStore.setUser(user.id, action === "viewer" ? "view" : "control", true);
  }
  applySetupState(appConfig, bootstrapConfig, state);
  await syncPrivateRoomPermissions(interaction, state, appConfig);
  await interaction.editReply(setupWizardView(state, appConfig, effectivePrivateRoomId()));
  if (accepted.length !== selected.length) {
    await interaction.followUp({
      content: action === "peer" ? "Only other Discord bot accounts can be added as peer Devbots." : "Bot accounts cannot be added as viewers or controllers.",
      flags: MessageFlags.Ephemeral
    });
  }
}

async function handleSetupProjectSelect(
  interaction: StringSelectMenuInteraction,
  appConfig: AppConfig,
  action: SetupWizardAction
): Promise<void> {
  if (action !== "default") {
    return;
  }
  await interaction.deferUpdate();
  const projectName = interaction.values[0];
  if (!projectName || !findProject(appConfig.projects, projectName)) {
    throw new Error("The selected repository is no longer configured. Refresh the setup wizard.");
  }
  const state = await setupStore.setDefaultProject(projectName);
  applySetupState(appConfig, bootstrapConfig, state);
  await interaction.editReply(setupWizardView(state, appConfig, effectivePrivateRoomId()));
}

async function handleSetupRepoModal(
  interaction: ModalSubmitInteraction,
  appConfig: AppConfig,
  action: SetupWizardAction
): Promise<void> {
  if (action !== "repo-modal") {
    return;
  }
  if (!interaction.isFromMessage()) {
    await interaction.reply({ content: "Reopen `/setup wizard` and add the repository from its button.", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferUpdate();
  const state = await registerSetupRepository(
    interaction.fields.getTextInputValue("name"),
    interaction.fields.getTextInputValue("path"),
    appConfig
  );
  await interaction.editReply(setupWizardView(state, appConfig, effectivePrivateRoomId()));
}

async function registerSetupRepository(rawName: string, pathValue: string, appConfig: AppConfig): Promise<SetupState> {
  const name = normalizeProjectName(rawName);
  if (!/[a-z0-9_]/.test(name)) {
    throw new Error("Repository name must contain a letter, number, underscore, or hyphen.");
  }
  const root = resolveSetupPath(pathValue);
  const rootStats = await stat(root).catch(() => undefined);
  if (!rootStats?.isDirectory()) {
    throw new Error("That local repository path does not exist or is not a directory.");
  }
  const hadDefault = appConfig.projects.some((project) => project.isDefault);
  let state = await setupStore.setRepository(name, root);
  contextService.invalidate(name);
  applySetupState(appConfig, bootstrapConfig, state);
  if (!hadDefault) {
    state = await setupStore.setDefaultProject(name);
    applySetupState(appConfig, bootstrapConfig, state);
  }
  return state;
}

async function createOrSyncPrivateRoom(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  appConfig: AppConfig,
  roomName?: string
) {
  const guild = interaction.guild;
  if (!guild) {
    throw new Error("`/setup room` must be run inside the configured Discord server.");
  }

  let state = setupStore.snapshot();
  let channel = state.privateChannelId ? await guild.channels.fetch(state.privateChannelId).catch(() => null) : null;
  if (channel && channel.type !== ChannelType.GuildText && channel.type !== ChannelType.PrivateThread) {
    throw new Error("The saved private room is no longer a Discord text channel or private thread.");
  }

  if (!channel) {
    const requestedName = roomName ?? "devbot-private";
    const name = requestedName.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "devbot-private";
    if (interaction.channel?.type === ChannelType.PrivateThread) {
      channel = interaction.channel;
    } else if (guild.members.me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
      const parentId = (interaction.channel as { parentId?: string | null } | null)?.parentId ?? undefined;
      channel = await guild.channels.create({
        name,
        type: ChannelType.GuildText,
        ...(parentId ? { parent: parentId } : {}),
        permissionOverwrites: roomPermissionOverwrites(guild.roles.everyone.id, state, appConfig),
        reason: `Private Devbot room created by owner ${interaction.user.tag}`
      });
    } else if (interaction.channel?.type === ChannelType.GuildText) {
      channel = await interaction.channel.threads.create({
        name,
        type: ChannelType.PrivateThread,
        invitable: false,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
        reason: `Private Devbot room created by owner ${interaction.user.tag}`
      });
    } else {
      throw new Error("Run `/setup room` in a server text channel or private thread. Devbot cannot manage channels, so it needs a thread-capable parent.");
    }
    state = await setupStore.setPrivateChannel(channel.id);
    applySetupState(appConfig, bootstrapConfig, state);
  }

  await syncPrivateRoomChannel(channel, guild.roles.everyone.id, state, appConfig);
  verifiedPrivateRoomId = channel.id;
  return channel;
}

async function syncPrivateRoomPermissions(
  interaction: ChatInputCommandInteraction | UserSelectMenuInteraction,
  state: SetupState,
  appConfig: AppConfig
): Promise<void> {
  const roomId = state.privateChannelId ?? effectivePrivateRoomId();
  if (!roomId || !interaction.guild) {
    return;
  }
  const channel = await interaction.guild.channels.fetch(roomId).catch(() => null);
  if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.PrivateThread)) {
    throw new Error("The configured private Devbot room is missing or is not a private text room.");
  }
  await syncPrivateRoomChannel(channel, interaction.guild.roles.everyone.id, state, appConfig);
}

async function syncPrivateRoomChannel(
  channel: GuildTextBasedChannel,
  everyoneRoleId: string,
  state: SetupState,
  appConfig: AppConfig
): Promise<void> {
  if (channel.type === ChannelType.GuildText) {
    await channel.permissionOverwrites.set(
      roomPermissionOverwrites(everyoneRoleId, state, appConfig),
      "Synchronize Devbot viewers, controllers, and peer bots"
    );
    return;
  }
  if (channel.type !== ChannelType.PrivateThread) {
    throw new Error("The configured Devbot room must be a text channel or private thread.");
  }

  if (channel.archived) {
    await channel.setArchived(false, "Devbot private room resumed");
  }
  const desired = new Set([...appConfig.allowedUserIds, ...appConfig.peerBotIds]);
  if (appConfig.ownerUserId) {
    desired.add(appConfig.ownerUserId);
  }
  if (client.user) {
    desired.add(client.user.id);
  }
  const members = await channel.members.fetch();
  for (const userId of desired) {
    if (!members.has(userId)) {
      await channel.members.add(userId);
    }
  }
  for (const member of members.values()) {
    if (!desired.has(member.id)) {
      await channel.members.remove(member.id);
    }
  }
}

function roomPermissionOverwrites(everyoneRoleId: string, state: SetupState, appConfig: AppConfig) {
  const humans = new Set([...appConfig.allowedUserIds, ...state.viewerUserIds, ...state.controllerUserIds]);
  if (appConfig.ownerUserId) {
    humans.add(appConfig.ownerUserId);
  }
  const peers = new Set([...appConfig.peerBotIds, ...state.peerBotIds]);
  const humanAllow = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.UseApplicationCommands,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.EmbedLinks
  ];
  const peerAllow = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory];
  const overwrites = [
    { id: everyoneRoleId, deny: [PermissionFlagsBits.ViewChannel] },
    ...[...humans].map((id) => ({ id, allow: humanAllow })),
    ...[...peers].filter((id) => !humans.has(id)).map((id) => ({ id, allow: peerAllow }))
  ];
  if (client.user && !humans.has(client.user.id) && !peers.has(client.user.id)) {
    overwrites.push({
      id: client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageThreads,
        PermissionFlagsBits.CreatePrivateThreads
      ]
    });
  }
  return overwrites;
}

function formatSetupSummary(state: SetupState, appConfig: AppConfig): string {
  const repositories = appConfig.projects.length
    ? appConfig.projects.map((project) => `- \`${project.name}\`${project.isDefault ? " (default)" : ""}: \`${project.root}\``).join("\n")
    : "- none";
  return [
    "Devbot owner setup",
    `Owner: <@${appConfig.ownerUserId}>`,
    `Private room: ${effectivePrivateRoomId() ? `<#${effectivePrivateRoomId()}>` : "not ready"}`,
    `Managed viewers: ${formatSetupMentions(state.viewerUserIds)}`,
    `Managed controllers: ${formatSetupMentions(state.controllerUserIds)}`,
    `Managed peer Devbots: ${formatSetupMentions(state.peerBotIds)}`,
    `Bootstrap user IDs still active: ${bootstrapConfig.allowedUserIds.size}`,
    "",
    "Project roots:",
    repositories
  ].join("\n");
}

async function formatSetupDoctor(appConfig: AppConfig): Promise<string> {
  const defaultProject = appConfig.projects.find((project) => project.isDefault);
  const repoReady = defaultProject ? Boolean((await stat(defaultProject.root).catch(() => undefined))?.isDirectory()) : false;
  const codexReady = path.isAbsolute(appConfig.codex.bin)
    ? Boolean((await stat(appConfig.codex.bin).catch(() => undefined))?.isFile())
    : Boolean(appConfig.codex.bin);
  const checks = [
    [Boolean(appConfig.ownerUserId), "Owner identity", "Set DEVBOT_OWNER_USER_ID locally and restart."],
    [Boolean(effectivePrivateRoomId()), "Private room", "Run /setup wizard and choose Use private room."],
    [repoReady, "Default repository", "Add or repair a repository in /setup wizard."],
    [codexReady, "Codex executable", "Set CODEX_BIN to an installed Codex CLI."],
    [appConfig.routing.enabled && Boolean(appConfig.routing.fastModel && appConfig.routing.standardModel && appConfig.routing.deepModel), "Luna / Terra / Sol routing", "Check CODEX_ROUTER_MODEL and tier model settings."],
    [slashCommandsReady || !appConfig.autoDeployCommands, "Slash commands", "Restart Devbot or run npm run commands:deploy."]
  ] as const;
  const passed = checks.filter(([ready]) => ready).length;
  return [
    "Devbot doctor",
    `Readiness: ${passed}/${checks.length}`,
    "",
    ...checks.map(([ready, label, fix]) => `${ready ? "READY" : "FIX"}  ${label}${ready ? "" : ` - ${fix}`}`),
    "",
    passed === checks.length ? "Ready. Ask with @devbot, change with /do, and check with /status." : "No changes were made. Resolve FIX items, then run /setup doctor again."
  ].join("\n");
}

function formatSetupMentions(ids: string[]): string {
  return ids.length ? ids.map((id) => `<@${id}>`).join(", ") : "none";
}

function resolveSetupPath(value: string): string {
  const trimmed = value.trim();
  const expanded = trimmed === "~" ? homedir() : trimmed.startsWith("~/") ? path.join(homedir(), trimmed.slice(2)) : trimmed;
  return path.resolve(expanded);
}

function formatRoute(route: RequestRoute): string {
  const context = route.contextMode === "none" ? "direct" : route.contextMode === "focused" ? "focused" : "deep context";
  return `${routeName(route)} / ${context}`;
}

function formatRouteProgress(route: RequestRoute, project: ProjectEntry, mode: CodexRequestMode): string {
  if (route.contextMode === "none") {
    return `Answering directly with ${routeName(route)}...`;
  }
  if (route.contextMode === "full") {
    return `Taking a deeper look at \`${project.name}\` with ${routeName(route)}...`;
  }
  return `${mode === "action" ? "Working" : "Looking"} in \`${project.name}\` with ${routeName(route)}...`;
}

function routeName(route: RequestRoute): "Luna" | "Terra" | "Sol" {
  return route.tier === "fast" ? "Luna" : route.tier === "standard" ? "Terra" : "Sol";
}

function formatResultFooter(project: ProjectEntry, route: RequestRoute, mode: CodexRequestMode): string {
  return `${project.name} | ${mode === "action" ? "write-capable" : "read-only"} | ${formatRoute(route)}`;
}

interface ProjectRequestOptions {
  appConfig: AppConfig;
  project: ProjectEntry;
  text: string;
  includePatterns: string[];
  mode: CodexRequestMode;
  requester: string;
  source: string;
  contextCharLimit?: number;
  onRoute?: (route: RequestRoute) => Promise<void>;
}

interface ProjectRequestResult {
  answer: string;
  context: PackedProjectContext;
  taskId: string;
  route: RequestRoute;
}

async function runProjectRequest(options: ProjectRequestOptions): Promise<ProjectRequestResult> {
  if (isWriteBlockedBySafeMode(options.appConfig, options.mode)) {
    throw new Error(safeModeActionMessage(options.source));
  }

  const task = await taskStore.start({
    source: options.source,
    mode: options.mode,
    projectName: options.project.name,
    requester: options.requester,
    text: options.text,
    includePatterns: options.includePatterns
  });
  const work = workTracker.start({
    mode: options.mode,
    projectName: options.project.name,
    requester: options.requester,
    text: options.text,
    taskId: task.id
  });
  const controller = new AbortController();
  activeTaskControllers.set(task.id, controller);

  try {
    const route = await routeRequest({
      codex: options.appConfig.codex,
      routing: options.appConfig.routing,
      text: options.text,
      mode: options.mode,
      projectName: options.project.name,
      projectRoot: options.project.root,
      hasExplicitIncludes: options.includePatterns.length > 0,
      signal: controller.signal
    });
    workTracker.update(work.id, {
      phase: "gathering-context",
      modelTier: route.tier,
      contextMode: route.contextMode
    });
    await options.onRoute?.(route);
    const contextCharLimit = contextLimitForRoute(
      route,
      options.appConfig.scanner.maxPackedContextChars,
      options.appConfig.routing.focusedContextChars,
      options.project.metadata.policy.maxContextChars,
      options.contextCharLimit
    );
    const context = contextCharLimit === 0
      ? { project: options.project, files: [], packedText: "" }
      : await contextService.pack(options.project, options.text, options.includePatterns, contextCharLimit);
    workTracker.update(work.id, {
      phase: "running-codex",
      contextFileCount: context.files.length
    });
    const answer = await runCodex(options.appConfig, options.text, context, options.mode, route, controller.signal);
    await taskStore.succeed(task.id, {
      contextFileCount: context.files.length,
      resultPreview: answer,
      ...(route.model ? { model: route.model } : {}),
      modelTier: route.tier,
      contextMode: route.contextMode,
      routeReason: route.reason,
      routeSource: route.source
    });
    return { answer, context, taskId: task.id, route };
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

async function getWorkStatusMessage(appConfig: AppConfig, requestedProject?: ProjectEntry): Promise<string> {
  const activeBotWork = filterWorkForProjects(workTracker.snapshot(), appConfig.projects);
  const externalCodexWork = await findExternalCodexWork(appConfig.projects);
  const activeWork = [...activeBotWork, ...externalCodexWork];
  const relevantProjectNames = new Set(activeWork.map((work) => work.projectName));
  if (requestedProject) {
    relevantProjectNames.add(requestedProject.name);
  }
  const relevantProjects = appConfig.projects.filter((project) => relevantProjectNames.has(project.name));
  const projectSnapshots: ProjectWorkSnapshot[] = await Promise.all(
    relevantProjects.map(async (project) => {
      const packet = await createReviewPacket(project);
      return {
        projectName: project.name,
        branch: packet.branch,
        defaultBranch: packet.defaultBranch,
        status: packet.status,
        diffStat: packet.diffStat,
        lastCommit: packet.lastCommit
      };
    })
  );
  return formatWorkStatus(activeWork, new Date(), projectSnapshots);
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
  let content = await getWorkStatusMessage(appConfig, requestedProject);

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
  const status = await getWorkStatusMessage(options.appConfig, options.project);
  const project = options.project ?? defaultProject(options.appConfig.projects);
  const detailPrompt = [
    "Give a read-only repository assessment for the configured project.",
    "Use the current work snapshot below as live context, then inspect the project read-only if needed.",
    "Be concrete about repository state, likely blockers, and useful next actions.",
    "Do not present repository evidence as private progress telemetry from an external Codex session.",
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
  return { content: [`Repository assessment for \`${project.name}\`:`, answer].join("\n") };
}

async function handleTaskCommand(interaction: ChatInputCommandInteraction, appConfig: AppConfig): Promise<void> {
  const subcommand = interaction.options.getSubcommand();
  const allowedProjectNames = new Set(
    appConfig.projects.filter((project) => isAllowedForProject(interaction, project)).map((project) => project.name)
  );
  if (subcommand === "recent") {
    await interaction.deferReply();
    const projectName = interaction.options.getString("project") ?? undefined;
    const project = projectName ? mustFindProject(appConfig.projects, projectName) : undefined;
    if (project && !allowedProjectNames.has(project.name)) {
      await interaction.editReply(`You are not allowed to use project \`${project.name}\`.`);
      return;
    }
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
    await interaction.editReply(formatTaskList(tasks.filter((task) => allowedProjectNames.has(task.projectName))));
    return;
  }

  if (subcommand === "show" || subcommand === "status") {
    await interaction.deferReply();
    const id = interaction.options.getString("id", true);
    const task = await taskStore.get(id);
    await interaction.editReply(
      task && allowedProjectNames.has(task.projectName) ? formatTaskDetail(task) : `No accessible saved task found for \`${id}\`.`
    );
    return;
  }

  if (subcommand === "logs") {
    await interaction.deferReply();
    const id = interaction.options.getString("id", true);
    const task = await taskStore.get(id);
    await interaction.editReply(
      task && allowedProjectNames.has(task.projectName) ? formatTaskLogs(task) : `No accessible saved task found for \`${id}\`.`
    );
    return;
  }

  if (subcommand === "cancel") {
    await interaction.deferReply();
    const id = interaction.options.getString("id", true);
    const existing = await taskStore.get(id);
    if (!existing || !allowedProjectNames.has(existing.projectName)) {
      await interaction.editReply(`No accessible saved task found for \`${id}\`.`);
      return;
    }
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
    if (!allowedProjectNames.has(task.projectName)) {
      await interaction.editReply(`No accessible saved task found for \`${id}\`.`);
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
    if (project && !allowedProjectNames.has(project.name)) {
      await interaction.editReply(`You are not allowed to use project \`${project.name}\`.`);
      return;
    }
    const running = await taskStore.listRecent({
      status: "running",
      limit: 25,
      ...(project ? { projectName: project.name } : {})
    });
    const cutoff = Date.now() - minutes * 60_000;
    const stale = running.filter(
      (task) => allowedProjectNames.has(task.projectName) && new Date(task.startedAt).getTime() < cutoff
    );
    await interaction.editReply(stale.length ? formatTaskList(stale) : `No running tasks older than ${minutes}m.`);
  }
}

async function handleTaskControl(
  interaction: ButtonInteraction,
  appConfig: AppConfig,
  action: TaskControlAction,
  taskId: string
): Promise<void> {
  const task = await taskStore.get(taskId);
  if (!task) {
    await interaction.reply({ content: "That saved task is no longer available.", flags: MessageFlags.Ephemeral });
    return;
  }
  const project = findProject(appConfig.projects, task.projectName);
  if (!project || !isAllowedForProject(interaction, project)) {
    await interaction.reply({ content: "That task's project is unavailable to you.", flags: MessageFlags.Ephemeral });
    return;
  }

  if (action === "details") {
    await interaction.reply({
      content: formatTaskDetail(task),
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const mode: CodexRequestMode = task.mode === "action" ? "action" : "answer";
  if (mode === "action" && !isControllerUser(interaction.user.id, appConfig)) {
    await interaction.reply({
      content: "Only the owner or an approved controller can retry write-capable work.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }
  if (isWriteBlockedBySafeMode(appConfig, mode)) {
    await interaction.reply({ content: safeModeActionMessage("this retry"), flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await runProjectRequest({
    appConfig,
    project,
    text: task.text,
    includePatterns: task.includePatterns,
    mode,
    requester: interaction.user.tag,
    source: `button:retry:${task.id}`
  });
  const chunks = splitDiscordMessage(`${result.answer}\n\n${formatResultFooter(project, result.route, mode)}`);
  await interaction.editReply({
    content: chunks.shift() ?? "Retry completed without a response.",
    components: [taskControlRow(result.taskId)]
  });
  for (const chunk of chunks) {
    await interaction.followUp({ content: chunk, flags: MessageFlags.Ephemeral });
  }
}

async function handleDashboardCommand(interaction: ChatInputCommandInteraction, appConfig: AppConfig): Promise<void> {
  await interaction.deferReply();
  const projectName = interaction.options.getString("project") ?? undefined;
  const project = projectName ? mustFindProject(appConfig.projects, projectName) : undefined;
  if (project && !isAllowedForProject(interaction, project)) {
    await interaction.editReply(`You are not allowed to use project \`${project.name}\`.`);
    return;
  }
  const projects = project ? [project] : appConfig.projects.filter((entry) => isAllowedForProject(interaction, entry));
  const visibleProjectNames = new Set(projects.map((entry) => entry.name));
  const status = await getWorkStatusMessage({ ...appConfig, projects });
  const recentTasks = (await taskStore.listRecent({ limit: 25, ...(project ? { projectName: project.name } : {}) }))
    .filter((task) => visibleProjectNames.has(task.projectName))
    .slice(0, 5);
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

  const project = selectedProject(appConfig.projects, interaction.options.getString("project"));
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
    if (task && task.projectName !== project.name) {
      await interaction.editReply(`Task \`${task.id}\` does not belong to project \`${project.name}\`.`);
      return;
    }
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

  await sendPeerMessage(interaction, appConfig, `<@${peerBotId}>\n${formatPeerEnvelope(envelope)}`, peerBotId);
  await interaction.editReply(`Sent ${action} request \`${envelope.requestId}\` to <@${peerBotId}>.`);
}

async function handleLabCommand(interaction: ChatInputCommandInteraction, appConfig: AppConfig): Promise<void> {
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "council") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const project = selectedProject(appConfig.projects, interaction.options.getString("project"));
    if (!(await ensureProjectAccess(interaction, project))) {
      return;
    }
    const brief = interaction.options.getString("prompt", true);
    const seats = localCouncilSeats(interaction.options.getInteger("seats") ?? 3);
    const conversation = await startLabConversation(interaction, subcommand, project, `Sealed Council: ${brief}`, brief);
    const seatStatuses = new Map<string, CouncilSeatStatus>(seats.map((seat) => [seat.id, "working"]));
    let progressUpdates = Promise.resolve();
    const updateSeatProgress = (seatId: string, status: "ready" | "failed"): void => {
      seatStatuses.set(seatId, status);
      progressUpdates = progressUpdates
        .then(() => interaction.editReply(formatCouncilProgress(conversation.id, seats, seatStatuses)))
        .then(() => undefined)
        .catch((error) => {
          console.warn(`Unable to update council progress for ${conversation.id}: ${(error as Error).message}`);
        });
    };
    await interaction.editReply(formatCouncilProgress(conversation.id, seats, seatStatuses));
    const localRuns = await Promise.all(
      seats.map(async (seat) => {
        const seatPrompt = councilContributionPrompt(brief, seat);
        try {
          const result = await runProjectRequest({
            appConfig,
            project,
            text: seatPrompt,
            includePatterns: [],
            mode: "answer",
            requester: interaction.user.tag,
            source: `lab:council:${seat.id}`,
            contextCharLimit: 24_000
          });
          updateSeatProgress(seat.id, "ready");
          return { seat, prompt: seatPrompt, ...result };
        } catch (error) {
          await collabStore.addEvent({
            conversationId: conversation.id,
            type: "note",
            actor: `${appConfig.botIdentity.displayName} ${seat.name}`,
            summary: `Local council seat failed: ${(error as Error).message.slice(0, 240)}`,
            mode: "think"
          });
          updateSeatProgress(seat.id, "failed");
          return undefined;
        }
      })
    );
    await progressUpdates;
    const completedSeats = localRuns.flatMap((run) => (run ? [run] : []));
    if (completedSeats.length === 0) {
      await collabStore.close(conversation.id, appConfig.botIdentity.displayName);
      throw new Error("All local council seats failed before submitting a proposal.");
    }
    await Promise.all(
      completedSeats.map((run) =>
        collabStore.addContribution({
          conversationId: conversation.id,
          actorId: `${client.user?.id ?? appConfig.botIdentity.displayName}:${run.seat.id}`,
          actorName: `${appConfig.botIdentity.displayName} - ${run.seat.name}`,
          kind: "proposal",
          content: run.answer,
          sealed: true,
          artifacts: [eventArtifact("plan", run.taskId, `${run.seat.name} proposal`)]
        })
      )
    );
    const peerPrompt = councilContributionPrompt(brief);
    let peerCount = 0;
    if (conversation.threadId && appConfig.coordinationChannelId) {
      peerCount = await fanOutLabRequest(interaction, appConfig, {
        conversationId: conversation.id,
        project,
        intent: "council",
        capability: "task.plan",
        mode: "think",
        target: brief,
        payload: {
          prompt: peerPrompt,
          sealed: true
        }
      });
    } else {
      await collabStore.addEvent({
        conversationId: conversation.id,
        type: "note",
        actor: appConfig.botIdentity.displayName,
        summary: conversation.threadId
          ? "Peer fan-out skipped because no dedicated coordination channel is configured."
          : "Peer fan-out skipped because a private Discord thread could not be created.",
        mode: "read"
      });
    }
    const current = (await collabStore.get(conversation.id)) ?? conversation;
    const contributions = await collabStore.contributions(conversation.id, { includeSealed: true });
    await publishWorkroomPanel(interaction, current, contributions);
    if (current.threadId) {
      await interaction.editReply(
        [
          `Opened sealed council <#${current.threadId}> with ${completedSeats.length} independent local contribution(s) and ${peerCount} peer invitation(s).`,
          !appConfig.coordinationChannelId && appConfig.peerBotIds.size > 0
            ? "Peer fan-out was skipped because no dedicated coordination channel is configured."
            : undefined
        ]
          .filter((line) => line !== undefined)
          .join("\n")
      );
    } else {
      const failedCount = seats.length - completedSeats.length;
      await interaction.followUp({
        content: [
          "Private thread creation was unavailable, so this council is local-only and its controls remain in this ephemeral response.",
          failedCount > 0
            ? `${completedSeats.length}/${seats.length} local seats submitted; ${failedCount} timed out or failed.`
            : `All ${seats.length} local seats submitted.`
        ].join("\n"),
        flags: MessageFlags.Ephemeral
      });
    }
    return;
  }

  if (subcommand === "recent") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const limit = interaction.options.getInteger("limit") ?? 10;
    const visible = (await collabStore.recent(25))
      .filter((conversation) => canAccessConversation(interaction, conversation, appConfig))
      .slice(0, limit);
    await interaction.editReply(formatCollabRecent(visible));
    return;
  }

  if (subcommand === "events") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const id = interaction.options.getString("id", true);
    const conversation = await collabStore.get(id);
    if (!conversation || !canAccessConversation(interaction, conversation, appConfig)) {
      await interaction.editReply(`Unknown or inaccessible lab session: \`${id}\`.`);
      return;
    }
    const events = await collabStore.events(id);
    await interaction.editReply([`Events for \`${id}\`:`, formatCollabEvents(events)].join("\n"));
    return;
  }

  if (subcommand === "approve") {
    await interaction.deferReply();
    const id = interaction.options.getString("id", true);
    const decision = interaction.options.getString("decision", true);
    const action = interaction.options.getString("action") ?? "record";
    const conversation = await collabStore.get(id);
    if (!conversation) {
      await interaction.editReply(`Unknown lab session: \`${id}\`.`);
      return;
    }
    if (conversation.requesterId && conversation.requesterId !== interaction.user.id && !isControllerUser(interaction.user.id, appConfig)) {
      await interaction.editReply(`Only the requester, owner, or an approved controller can decide lab session \`${id}\`.`);
      return;
    }
    const projectName = interaction.options.getString("project") ?? conversation.projectName;
    const commandNames = parseCommandNames(interaction.options.getString("commands"));
    const note = interaction.options.getString("note") ?? "";
    let actionResult: string | undefined;
    let project: ProjectEntry | undefined;

    if (projectName) {
      project = mustFindProject(appConfig.projects, projectName);
      if (!isAllowedForProject(interaction, project)) {
        await interaction.editReply(`You are not allowed to use project \`${project.name}\`.`);
        return;
      }
    }

    if (conversation.intent === "council") {
      const decided = await collabStore.decide({
        conversationId: id,
        outcome: decision as "approve" | "deny" | "read-only",
        actor: interaction.user.tag,
        ...(note ? { note } : {})
      });
      if (!decided) {
        await interaction.editReply("This council is closed, already decided, or not ready for approval.");
        return;
      }
    }

    if (decision === "approve" && action !== "record") {
      if (appConfig.safeMode) {
        actionResult = "Safe mode is on, so the approval was recorded but no command was executed.";
      } else if (!project) {
        actionResult = "Approval recorded. Add `project:<name>` to execute validation or gates.";
      } else {
        if (action === "validate") {
          const results = await validateReview(project, commandNames);
          actionResult = formatValidationResults(project, results);
        } else if (action === "gates") {
          const result = await evaluateMergeGates(project, commandNames);
          actionResult = formatMergeGateResult(project, result);
        }
      }
    }

    if (conversation.intent !== "council" || actionResult) {
      await collabStore.addEvent({
        conversationId: id,
        type: "approval",
        actor: interaction.user.tag,
        summary: `${decision}${action !== "record" ? ` ${action}` : ""}${note ? `: ${note}` : ""}`,
        mode: decision === "approve" ? "write" : "read",
        artifacts: [
          eventArtifact("approval", decision, note || undefined),
          ...(actionResult ? [eventArtifact("validation", action, projectName)] : [])
        ]
      });
    }
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
    if (task && task.projectName !== project.name) {
      await interaction.editReply(`Task \`${task.id}\` does not belong to project \`${project.name}\`.`);
      return;
    }
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
    if (task && task.projectName !== project.name) {
      await interaction.editReply(`Task \`${task.id}\` does not belong to project \`${project.name}\`.`);
      return;
    }
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
    if (task && task.projectName !== project.name) {
      await interaction.editReply(`Task \`${task.id}\` does not belong to project \`${project.name}\`.`);
      return;
    }
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

async function handleWorkroomButton(interaction: ButtonInteraction, appConfig: AppConfig): Promise<void> {
  const parsed = parseWorkroomButton(interaction.customId);
  if (!parsed) {
    return;
  }
  if ((parsed.action === "approve" || parsed.action === "deny") && !isControllerUser(interaction.user.id, appConfig)) {
    await interaction.reply({
      content: "Only the owner or an approved controller can record approval decisions.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const conversation = await collabStore.get(parsed.conversationId);
  if (!conversation) {
    await interaction.reply({ content: "This workroom no longer exists in the local collaboration store.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (conversation.requesterId && conversation.requesterId !== interaction.user.id && !isControllerUser(interaction.user.id, appConfig)) {
    await interaction.reply({
      content: `Only the requester, owner, or an approved controller can operate workroom \`${conversation.id}\`.`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }
  const expectedChannelId = conversation.controlChannelId ?? conversation.threadId ?? conversation.channelId;
  if (
    !conversation.controlMessageId ||
    interaction.message.id !== conversation.controlMessageId ||
    (expectedChannelId && interaction.channelId !== expectedChannelId)
  ) {
    await interaction.reply({ content: "This is not the active control panel for the workroom.", flags: MessageFlags.Ephemeral });
    return;
  }

  const project = conversation.projectName ? findProject(appConfig.projects, conversation.projectName) : undefined;
  if (project && !isAllowedForProject(interaction, project)) {
    await interaction.reply({ content: `You are not allowed to use project \`${project.name}\`.`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (conversation.status === "closed" || conversation.phase === "closed") {
    await interaction.reply({ content: "This workroom is already closed.", flags: MessageFlags.Ephemeral });
    return;
  }

  if (parsed.action === "approve" || parsed.action === "deny" || parsed.action === "close") {
    await handleWorkroomDecisionButton(interaction, conversation, parsed.action);
    return;
  }

  if (activeWorkroomActions.has(conversation.id)) {
    await interaction.reply({ content: "Another workroom action is already in progress.", flags: MessageFlags.Ephemeral });
    return;
  }

  activeWorkroomActions.add(conversation.id);
  await interaction.deferUpdate();
  try {
    if (parsed.action === "challenge") {
      if (conversation.phase !== "collecting") {
        await replyToWorkroomAction(interaction, "Challenges must be added before the sealed contributions are revealed.");
        return;
      }
      if (!project) {
        await replyToWorkroomAction(interaction, "The project for this workroom is no longer configured.");
        return;
      }
      const existing = await collabStore.contributions(conversation.id, { includeSealed: true });
      if (existing.some((contribution) => contribution.kind === "challenge")) {
        await replyToWorkroomAction(interaction, "This council already has an independent challenger.");
        return;
      }

      const { answer, taskId } = await runProjectRequest({
        appConfig,
        project,
        text: councilChallengePrompt(conversation.brief ?? conversation.title),
        includePatterns: [],
        mode: "answer",
        requester: interaction.user.tag,
        source: "lab:council:challenge",
        contextCharLimit: 24_000
      });
      await collabStore.addContribution({
        conversationId: conversation.id,
        actorId: client.user?.id ?? appConfig.botIdentity.displayName,
        actorName: `${appConfig.botIdentity.displayName} challenger`,
        kind: "challenge",
        content: answer,
        sealed: true,
        artifacts: [eventArtifact("plan", taskId, "independent council challenge")]
      });
      await sendWorkroomText(conversation.id, "An independent challenge has arrived and remains sealed.", interaction);
      await refreshWorkroomPanelInteraction(interaction, conversation.id);
      await replyToWorkroomAction(interaction, "Independent challenge added. It cannot see the other sealed proposals.");
      return;
    }

    if (parsed.action === "reveal") {
      if (conversation.phase !== "collecting") {
        await replyToWorkroomAction(interaction, "This council has already been revealed.");
        return;
      }
      const revealed = await collabStore.revealContributions(conversation.id, interaction.user.tag);
      await sendWorkroomText(conversation.id, formatCouncilContributions(conversation, revealed), interaction);
      await refreshWorkroomPanelInteraction(interaction, conversation.id);
      await replyToWorkroomAction(interaction, `Revealed ${revealed.length} independent contribution(s) in the workroom.`);
      return;
    }

    if (!project) {
      await replyToWorkroomAction(interaction, "The project for this workroom is no longer configured.");
      return;
    }
    if (conversation.phase === "synthesized" || conversation.phase === "decided") {
      await replyToWorkroomAction(interaction, "This council has already been synthesized.");
      return;
    }
    const pendingPeers = conversation.participants.filter(
      (participant) => participant.kind === "bot" && participant.state === "invited"
    );
    if (conversation.phase === "collecting" && pendingPeers.length > 0) {
      await replyToWorkroomAction(
        interaction,
        `${pendingPeers.length} invited peer contribution(s) are still pending. Wait for them, or use Reveal to close collection with the responses already present.`
      );
      return;
    }
    const revealed = await collabStore.revealContributions(conversation.id, interaction.user.tag);
    if (revealed.length === 0) {
      await replyToWorkroomAction(interaction, "There are no contributions to synthesize yet.");
      return;
    }
    const { answer, taskId } = await runProjectRequest({
      appConfig,
      project,
      text: councilSynthesisPrompt(conversation.brief ?? conversation.title, revealed),
      includePatterns: [],
      mode: "answer",
      requester: interaction.user.tag,
      source: "lab:council:synthesis",
      contextCharLimit: 24_000
    });
    await collabStore.addSynthesis({
      conversationId: conversation.id,
      actorId: client.user?.id ?? appConfig.botIdentity.displayName,
      actorName: `${appConfig.botIdentity.displayName} chair`,
      content: answer,
      artifacts: [eventArtifact("plan", taskId, "council synthesis")]
    });
    await sendWorkroomText(conversation.id, formatCouncilContributions(conversation, revealed), interaction);
    await sendWorkroomText(conversation.id, [`Council synthesis for \`${conversation.id}\``, "", answer].join("\n"), interaction);
    await refreshWorkroomPanelInteraction(interaction, conversation.id);
    await replyToWorkroomAction(interaction, "Council revealed and synthesized. The workroom now awaits your decision.");
  } finally {
    activeWorkroomActions.delete(conversation.id);
  }
}

async function handleWorkroomDecisionButton(
  interaction: ButtonInteraction,
  conversation: CollabConversation,
  action: "approve" | "deny" | "close"
): Promise<void> {
  await interaction.deferUpdate();
  let updated: CollabConversation | undefined;
  if (action === "close") {
    updated = await collabStore.close(conversation.id, interaction.user.tag);
  } else {
    if (action === "approve" && conversation.phase !== "synthesized") {
      await interaction.followUp({ content: "Reveal and synthesize the council before approving its recommendation.", flags: MessageFlags.Ephemeral });
      return;
    }
    updated = await collabStore.decide({
      conversationId: conversation.id,
      outcome: action,
      actor: interaction.user.tag
    });
  }

  if (!updated) {
    await interaction.followUp({ content: "The workroom state changed before this decision could be recorded.", flags: MessageFlags.Ephemeral });
    return;
  }
  const contributions = await collabStore.contributions(conversation.id, { includeSealed: true });
  await refreshWorkroomPanelInteraction(interaction, conversation.id);
  await sendWorkroomText(
    conversation.id,
    action === "close"
      ? `Workroom closed by ${interaction.user.tag}.`
      : `Decision recorded: ${action} by ${interaction.user.tag}. No write action was executed.`,
    interaction
  );
  await interaction.followUp({
    content: action === "close" ? "Workroom closed." : `Recorded ${action}. This decision did not execute code or commands.`,
    flags: MessageFlags.Ephemeral
  });
  if (action === "close") {
    await archiveWorkroomThread(updated);
  }
}

async function publishWorkroomPanel(
  interaction: ChatInputCommandInteraction,
  conversation: CollabConversation,
  contributions: CollabContribution[]
): Promise<void> {
  const payload = {
    content: formatWorkroomPanel(conversation, contributions),
    components: workroomActionRows(conversation),
    allowedMentions: { parse: [] as const }
  };

  if (conversation.threadId) {
    try {
      const channel = await client.channels.fetch(conversation.threadId);
      const sent = (await sendToTextChannel(channel, payload)) as { id?: string } | undefined;
      if (sent?.id) {
        await collabStore.setControlMessage(conversation.id, sent.id, conversation.threadId);
      }
      return;
    } catch (error) {
      console.warn(`Unable to publish workroom panel in thread ${conversation.threadId}: ${(error as Error).message}`);
    }
  }

  const message = await interaction.editReply(payload);
  await collabStore.setControlMessage(conversation.id, message.id, interaction.channelId, true);
}

async function refreshWorkroomPanelInteraction(interaction: ButtonInteraction, conversationId: string): Promise<void> {
  const conversation = await collabStore.get(conversationId);
  if (!conversation) {
    return;
  }
  const contributions = await collabStore.contributions(conversationId, { includeSealed: true });
  await interaction.editReply({
    content: formatWorkroomPanel(conversation, contributions),
    components: workroomActionRows(conversation),
    allowedMentions: { parse: [] }
  });
}

async function replyToWorkroomAction(interaction: ButtonInteraction, content: string): Promise<void> {
  await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
}

async function refreshWorkroomPanelMessage(message: Message, conversationId: string): Promise<void> {
  const conversation = await collabStore.get(conversationId);
  if (!conversation) {
    return;
  }
  const contributions = await collabStore.contributions(conversationId, { includeSealed: true });
  await message.edit({
    content: formatWorkroomPanel(conversation, contributions),
    components: workroomActionRows(conversation),
    allowedMentions: { parse: [] }
  });
}

async function refreshStoredWorkroomPanel(conversationId: string): Promise<void> {
  const conversation = await collabStore.get(conversationId);
  if (conversation?.controlEphemeral) {
    return;
  }
  const channelId = conversation?.controlChannelId ?? conversation?.threadId ?? conversation?.channelId;
  if (!conversation?.controlMessageId || !channelId) {
    return;
  }

  try {
    const channel = await client.channels.fetch(channelId);
    const fetchable = channel as { messages?: { fetch?: (id: string) => Promise<Message> } } | null;
    const message = await fetchable?.messages?.fetch?.(conversation.controlMessageId);
    if (message) {
      await refreshWorkroomPanelMessage(message, conversationId);
    }
  } catch (error) {
    console.warn(`Unable to refresh workroom panel ${conversation.controlMessageId}: ${(error as Error).message}`);
  }
}

async function sendWorkroomText(
  conversationId: string,
  content: string,
  fallbackInteraction?: ButtonInteraction
): Promise<void> {
  const conversation = await collabStore.get(conversationId);
  const channelId = conversation?.threadId ?? (conversation?.intent === "council" ? undefined : conversation?.channelId);
  if (channelId) {
    try {
      const channel = await client.channels.fetch(channelId);
      for (const chunk of splitDiscordMessage(content)) {
        await sendToTextChannel(channel, { content: chunk, allowedMentions: { parse: [] } });
      }
      return;
    } catch (error) {
      console.warn(`Unable to send workroom update to ${channelId}: ${(error as Error).message}`);
    }
  }

  if (fallbackInteraction) {
    for (const chunk of splitDiscordMessage(content)) {
      await fallbackInteraction.followUp({ content: chunk, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    }
  }
}

async function archiveWorkroomThread(conversation: CollabConversation): Promise<void> {
  if (!conversation.threadId || conversation.threadId === setupStore.snapshot().privateChannelId) {
    return;
  }

  try {
    const channel = await client.channels.fetch(conversation.threadId);
    if (!channel?.isThread()) {
      return;
    }
    await channel.setArchived(true, "Devbot workroom closed");
    try {
      await channel.setLocked(true, "Devbot workroom closed");
    } catch (error) {
      console.warn(`Unable to lock workroom thread ${conversation.threadId}: ${(error as Error).message}`);
    }
  } catch (error) {
    console.warn(`Unable to archive workroom thread ${conversation.threadId}: ${(error as Error).message}`);
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

  if (
    envelope.from.botId !== message.author.id ||
    (envelope.to?.botId && envelope.to.botId !== client.user.id) ||
    message.guildId !== appConfig.discordGuildId ||
    (appConfig.coordinationChannelId && message.channelId !== appConfig.coordinationChannelId) ||
    !isFreshCollabEnvelope(envelope)
  ) {
    return;
  }
  if (envelope.type === "devbot.peer.request" && !message.mentions.users.has(client.user.id)) {
    return;
  }
  if (!(await collabStore.claimDelivery(collabDeliveryKey(envelope, message.author.id)))) {
    return;
  }

  if (envelope.type !== "devbot.peer.request") {
    const conversation = await collabStore.get(envelope.conversationId);
    const expectedRequestId = envelope.correlationId ?? envelope.requestId;
    const expectedParticipant = conversation?.participants.find(
      (participant) =>
        participant.kind === "bot" && participant.id === message.author.id && participant.requestId === expectedRequestId
    );
    if (!conversation || !expectedParticipant) {
      return;
    }
    if (
      envelope.type === "devbot.peer.result" &&
      envelope.intent === "council" &&
      envelope.capability === "task.plan" &&
      envelope.payload.ok === true &&
      typeof envelope.payload.message === "string"
    ) {
      const actorName = envelope.from.botName ?? envelope.from.owner;
      const contribution = await collabStore.acceptPeerContribution({
        conversationId: envelope.conversationId,
        actorId: message.author.id,
        actorName,
        sourceRequestId: envelope.correlationId ?? envelope.requestId,
        content: envelope.payload.message,
        artifacts: envelope.artifacts
      });
      if (contribution) {
        await sendWorkroomText(
          envelope.conversationId,
          `${actorName} submitted an independent contribution. It remains sealed until the room is revealed.`
        );
        await refreshStoredWorkroomPanel(envelope.conversationId);
      }
    }
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

  if (envelope.payload.transportTruncated === true) {
    await replyWithCollabResult(message, appConfig, envelope, false, "Request payload was truncated by the Discord transport. Send a shorter request.");
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
    if (task && task.projectName !== project.name) {
      await replyWithCollabResult(message, appConfig, envelope, false, `Task ${task.id} does not belong to project ${project.name}.`);
      return;
    }
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
    files: screenshot ? [new AttachmentBuilder(screenshot.image, { name: screenshot.fileName })] : [],
    allowedMentions: { parse: [] }
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
  await message.reply({
    content: [approval, "", formatCollabEnvelope(result, 1_200)].join("\n"),
    allowedMentions: { parse: [] }
  });
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
    `- \`${project.name}\`${project.isDefault ? " (default)" : ""} -> \`${project.root}\``,
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
    "- Ask: mention `@devbot` or use `/ask` for a read-only answer.",
    "- Do: use `/do` for an intentional project change.",
    "- Check: use `/status` for current work and `/dashboard` for the full view.",
    "- Capture UI: `/snip project:<name> target:<page or path>`.",
    "- Inspect tasks: `/task recent`, `/task show`, `/task logs`, `/task retry`.",
    "- Run configured validation: `/run project:<name> command:<preset>` or `/review validate`.",
    "- Prepare handoff: `/review packet project:<name> task:<task-id>`.",
    "- Coordinate peers: `/devbot announce`, `/devbot peers`, `/peer status`, `/peer snip`.",
    "- Open a sealed agent council: `/lab council prompt:<decision>`.",
    "- Owner setup: start with `/setup wizard`; use `/setup doctor` when something feels off.",
    "- Collaborate in the private lab: `/lab roundtable`, `/lab see`, `/lab bossfight`, `/lab ritual`, `/lab safety`.",
    "",
    appConfig.safeMode
      ? "Write-capable actions are disabled while safe mode is on: `/do`, explicit action retries, `/run`, and review validation."
      : "Write-capable actions are enabled for the owner and approved controllers: `/do`, explicit action retries, `/run`, and review validation."
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
  content: string,
  targetBotId?: string
): Promise<void> {
  const payload = {
    content,
    allowedMentions: targetBotId ? { parse: [] as const, users: [targetBotId] } : { parse: [] as const }
  };
  if (appConfig.coordinationChannelId) {
    const channel = await client.channels.fetch(appConfig.coordinationChannelId);
    if (!channel?.isTextBased()) {
      throw new Error(`Configured coordination channel ${appConfig.coordinationChannelId} is not text-based.`);
    }
    if (channel.isThread()) {
      if (channel.archived) {
        await channel.setArchived(false, "Devbot peer coordination resumed");
      }
      if (targetBotId && channel.type === ChannelType.PrivateThread) {
        await channel.members.add(targetBotId);
      }
    }
    await sendToTextChannel(channel, payload);
    return;
  }

  const channel = interaction.channel;
  if (!channel?.isTextBased()) {
    throw new Error("This command must be used in a text channel or COORDINATION_CHANNEL_ID must be configured.");
  }
  await sendToTextChannel(channel, payload);
}

async function sendToTextChannel(channel: unknown, content: unknown): Promise<unknown> {
  const sendable = channel as { send?: (message: unknown) => Promise<unknown> };
  if (!sendable.send) {
    throw new Error("Target channel cannot send messages.");
  }

  return sendable.send(content);
}

function optionalPeerField(key: "project" | "target", value: string | null): Partial<Record<"project" | "target", string>> {
  return value?.trim() ? { [key]: value.trim() } : {};
}

async function startLabConversation(
  interaction: ChatInputCommandInteraction,
  intent: CollabIntent,
  project: ProjectEntry | undefined,
  title: string,
  brief?: string
) {
  const conversation = await collabStore.start({
    intent,
    title,
    requester: interaction.user.tag,
    requesterId: interaction.user.id,
    channelId: interaction.channelId,
    ...(brief ? { brief } : {}),
    ...(project ? { projectName: project.name } : {})
  });
  const sharedRoomThread =
    intent === "council" &&
    interaction.channelId === setupStore.snapshot().privateChannelId &&
    interaction.channel?.type === ChannelType.PrivateThread
      ? interaction.channel
      : undefined;
  const thread = sharedRoomThread ?? (await createLabThread(interaction, conversation.id, intent, title));
  if (!thread) {
    return conversation;
  }

  const withThread = { ...conversation, threadId: thread.id };
  try {
    await sendToTextChannel(thread, {
      content: [
        formatLabHeader(withThread),
        "",
        `Started by ${interaction.user.tag}.`,
        "This thread is the human-visible audit room for this lab session."
      ].join("\n"),
      allowedMentions: { parse: [] }
    });
  } catch (error) {
    if (!sharedRoomThread) {
      await thread.delete?.("Unable to initialize the Devbot workroom").catch(() => undefined);
    }
    console.warn(`Unable to initialize lab thread ${thread.id}: ${(error as Error).message}`);
    return conversation;
  }
  return (await collabStore.setThread(conversation.id, thread.id)) ?? withThread;
}

async function createLabThread(
  interaction: ChatInputCommandInteraction,
  conversationId: string,
  intent: CollabIntent,
  title: string
): Promise<{
  id: string;
  send?: (message: unknown) => Promise<unknown>;
  members?: { add?: (userId: string) => Promise<unknown> };
  delete?: (reason?: string) => Promise<unknown>;
} | undefined> {
  const threaded = interaction.channel as
    | {
        threads?: {
          create?: (options: {
            name: string;
            autoArchiveDuration?: ThreadAutoArchiveDuration;
            type?: ChannelType.PrivateThread;
            invitable?: boolean;
            reason?: string;
          }) => Promise<{
            id: string;
            send?: (message: unknown) => Promise<unknown>;
            members?: { add?: (userId: string) => Promise<unknown> };
            delete?: (reason?: string) => Promise<unknown>;
          }>;
        };
      }
    | null;
  if (!threaded?.threads?.create) {
    return undefined;
  }

  try {
    const privateCouncil = intent === "council";
    const thread = await threaded.threads.create({
      name: labThreadName(conversationId, intent, title),
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      ...(privateCouncil ? { type: ChannelType.PrivateThread, invitable: false } : {}),
      reason: "Devbot collaboration lab session"
    });
    if (privateCouncil) {
      try {
        if (!thread.members?.add) {
          throw new Error("Private thread membership API is unavailable.");
        }
        await thread.members.add(interaction.user.id);
        for (const userId of config.allowedUserIds) {
          if (userId === interaction.user.id) {
            continue;
          }
          await thread.members.add(userId).catch((error) => {
            console.warn(`Unable to add configured viewer ${userId} to council thread ${thread.id}: ${(error as Error).message}`);
          });
        }
      } catch (error) {
        await thread.delete?.("Unable to add the council requester to the private workroom").catch(() => undefined);
        throw error;
      }
    }
    return thread;
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
    await collabStore.inviteParticipant({
      conversationId: input.conversationId,
      id: peer.botId,
      displayName: peer.botName,
      owner: peer.owner,
      requestId: envelope.requestId
    });
    await sendPeerMessage(interaction, appConfig, `<@${peer.botId}>\n${formatCollabEnvelope(envelope)}`, peer.botId);
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
  await collabStore.inviteParticipant({
    conversationId,
    id: botId,
    displayName: botId,
    requestId: envelope.requestId
  });
  await sendPeerMessage(interaction, appConfig, `<@${botId}>\n${formatCollabEnvelope(envelope)}`, botId);
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
  route: RequestRoute,
  signal?: AbortSignal
): Promise<string> {
  return answerWithProjectContext({
    codex: appConfig.codex,
    question: text,
    context,
    mode,
    ...(route.model ? { model: route.model } : {}),
    ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
    contextMode: route.contextMode,
    ...(signal ? { signal } : {})
  });
}

async function handleAutocomplete(interaction: AutocompleteInteraction, appConfig: AppConfig): Promise<void> {
  const focused = interaction.options.getFocused(true);
  const value = String(focused.value ?? "");
  const allowedProjects = appConfig.projects.filter((project) => isAllowedForProject(interaction, project));

  if (focused.name === "project") {
    await interaction.respond(projectChoices(allowedProjects, value));
    return;
  }

  if (focused.name === "command" || focused.name === "commands") {
    const project = findProjectFromAutocomplete(interaction, allowedProjects);
    await interaction.respond(commandChoices(project, value));
    return;
  }

  if (focused.name === "id" || focused.name === "task") {
    const project = findProjectFromAutocomplete(interaction, allowedProjects);
    const tasks = await taskStore.listRecent({ limit: 25, ...(project ? { projectName: project.name } : {}) });
    const allowedProjectNames = new Set(allowedProjects.map((item) => item.name));
    await interaction.respond(taskChoices(tasks.filter((task) => allowedProjectNames.has(task.projectName)), value));
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
  return projectName ? findProject(projects, projectName) : projects.find((project) => project.isDefault) ?? (projects.length === 1 ? projects[0] : undefined);
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
  const selected = projects.find((project) => project.isDefault);
  if (selected) {
    return selected;
  }
  if (projects.length === 1 && projects[0]) {
    return projects[0];
  }

  if (projects.length === 0) {
    throw new Error("No projects are configured. Ask the owner to run `/setup repo`.");
  }
  throw new Error("Multiple projects are configured. Choose one explicitly or ask the owner to select a default with `/setup repo`.");
}

function selectedProject(projects: ProjectEntry[], requestedName: string | null): ProjectEntry {
  return requestedName ? mustFindProject(projects, requestedName) : defaultProject(projects);
}

function parseFallbackStatusRequest(text: string): { isStatus: boolean; question: string | undefined; wantsImage: boolean } {
  const normalized = text.toLowerCase();
  const isStatus = /\b(status|state|progress|wip|working|work|snip|screenshot|screen shot|output)\b/.test(normalized);
  if (!isStatus) {
    return { isStatus: false, question: undefined, wantsImage: false };
  }

  const wantsImage = /\b(snip|screenshot|screen shot|image|picture|pic|output)\b/.test(normalized);
  return { isStatus: true, question: statusDetailQuestion(text), wantsImage };
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

function isAllowed(interaction: ChatInputCommandInteraction | ButtonInteraction | AutocompleteInteraction, appConfig: AppConfig): boolean {
  if (!appConfig.ownerUserId) {
    return false;
  }
  if (isOwner(interaction.user.id, appConfig)) {
    return true;
  }
  const hasUserAllowList = appConfig.allowedUserIds.size > 0;
  const hasUsernameAllowList = appConfig.allowedUsernames.size > 0;
  const hasRoleAllowList = appConfig.allowedRoleIds.size > 0;
  if (!hasUserAllowList && !hasUsernameAllowList && !hasRoleAllowList) {
    return true;
  }

  if (appConfig.allowedUserIds.has(interaction.user.id)) {
    return true;
  }

  if (isApprovedDiscordUsername(interactionNameSource(interaction), appConfig.allowedUsernames)) {
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

function isAllowedForProject(
  interaction: ChatInputCommandInteraction | ButtonInteraction | AutocompleteInteraction,
  project: ProjectEntry
): boolean {
  const policy = project.metadata.policy;
  const hasProjectAllowList = policy.allowedUsers.length > 0 || policy.allowedUsernames.length > 0 || policy.allowedRoles.length > 0;
  if (!hasProjectAllowList) {
    return true;
  }

  if (policy.allowedUsers.includes(interaction.user.id)) {
    return true;
  }

  if (isApprovedDiscordUsername(interactionNameSource(interaction), policy.allowedUsernames)) {
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
  if (!appConfig.ownerUserId) {
    return false;
  }
  if (isOwner(message.author.id, appConfig)) {
    return true;
  }
  const hasUserAllowList = appConfig.allowedUserIds.size > 0;
  const hasUsernameAllowList = appConfig.allowedUsernames.size > 0;
  const hasRoleAllowList = appConfig.allowedRoleIds.size > 0;
  if (!hasUserAllowList && !hasUsernameAllowList && !hasRoleAllowList) {
    return true;
  }

  if (appConfig.allowedUserIds.has(message.author.id)) {
    return true;
  }

  if (isApprovedDiscordUsername(messageNameSource(message), appConfig.allowedUsernames)) {
    return true;
  }

  return message.member?.roles.cache.some((role) => appConfig.allowedRoleIds.has(role.id)) ?? false;
}

function isOwner(userId: string, appConfig: Pick<AppConfig, "ownerUserId">): boolean {
  return Boolean(appConfig.ownerUserId && userId === appConfig.ownerUserId);
}

function isControllerUser(userId: string, appConfig: AppConfig): boolean {
  if (!appConfig.ownerUserId) {
    return false;
  }
  return isSetupController(setupStore.snapshot(), appConfig.ownerUserId, userId);
}

function commandRequiresController(interaction: ChatInputCommandInteraction): boolean {
  if (interaction.commandName === "do" || interaction.commandName === "run") {
    return true;
  }
  const subcommand = interaction.options.getSubcommand(false);
  if (interaction.commandName === "review") {
    return subcommand === "validate" || subcommand === "gates";
  }
  if (interaction.commandName === "task") {
    return subcommand === "cancel" || subcommand === "retry";
  }
  return interaction.commandName === "lab" && subcommand === "approve";
}

async function ensureControllerAccess(interaction: ChatInputCommandInteraction, appConfig: AppConfig): Promise<boolean> {
  if (isControllerUser(interaction.user.id, appConfig)) {
    return true;
  }
  await interaction.reply({
    content: "You have view access, but only the owner or an approved controller can run this command.",
    flags: MessageFlags.Ephemeral
  });
  return false;
}

async function ensureConfiguredRoom(interaction: ChatInputCommandInteraction | ButtonInteraction): Promise<boolean> {
  const privateChannelId = effectivePrivateRoomId();
  if (!privateChannelId) {
    await interaction.reply({
      content: "Devbot setup is not ready. The owner must run `/setup wizard` first.",
      flags: MessageFlags.Ephemeral
    });
    return false;
  }
  if (interaction.channelId === privateChannelId) {
    return true;
  }
  await interaction.reply({
    content: `Devbot is configured for its private room: <#${privateChannelId}>.`,
    flags: MessageFlags.Ephemeral
  });
  return false;
}

function effectivePrivateRoomId(): string | undefined {
  return verifiedPrivateRoomId;
}

async function verifyPrivateRoom(channelId: string | undefined): Promise<string | undefined> {
  if (!channelId) {
    return undefined;
  }
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (channel?.type === ChannelType.PrivateThread) {
    return channel.id;
  }
  if (channel?.type === ChannelType.GuildText) {
    const everyone = channel.permissionOverwrites.cache.get(channel.guild.roles.everyone.id);
    if (everyone?.deny.has(PermissionFlagsBits.ViewChannel)) {
      return channel.id;
    }
  }
  console.warn(`Configured Devbot room ${channelId} is missing or is not private.`);
  return undefined;
}

function isAllowedMessageForProject(message: Message, project: ProjectEntry): boolean {
  const policy = project.metadata.policy;
  const hasProjectAllowList = policy.allowedUsers.length > 0 || policy.allowedUsernames.length > 0 || policy.allowedRoles.length > 0;
  if (!hasProjectAllowList) {
    return true;
  }
  if (policy.allowedUsers.includes(message.author.id)) {
    return true;
  }
  if (isApprovedDiscordUsername(messageNameSource(message), policy.allowedUsernames)) {
    return true;
  }
  return message.member?.roles.cache.some((role) => policy.allowedRoles.includes(role.id)) ?? false;
}

function canAccessConversation(
  interaction: ChatInputCommandInteraction | ButtonInteraction | AutocompleteInteraction,
  conversation: CollabConversation,
  appConfig: AppConfig
): boolean {
  if (
    conversation.intent === "council" &&
    conversation.requesterId &&
    conversation.requesterId !== interaction.user.id &&
    !isControllerUser(interaction.user.id, appConfig)
  ) {
    return false;
  }
  if (!conversation.projectName) {
    return true;
  }
  const project = findProject(appConfig.projects, conversation.projectName);
  return Boolean(project && isAllowedForProject(interaction, project));
}

function interactionNameSource(interaction: ChatInputCommandInteraction | ButtonInteraction | AutocompleteInteraction) {
  return {
    username: interaction.user.username,
    globalName: interaction.user.globalName,
    tag: interaction.user.tag,
    displayName: interaction.member instanceof GuildMember ? interaction.member.displayName : undefined
  };
}

function messageNameSource(message: Message) {
  return {
    username: message.author.username,
    globalName: message.author.globalName,
    tag: message.author.tag,
    displayName: message.member?.displayName
  };
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
