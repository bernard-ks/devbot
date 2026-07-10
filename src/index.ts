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
  MessageContextMenuCommandInteraction,
  ModalSubmitInteraction,
  OmitPartialGroupDMChannel,
  StringSelectMenuInteraction,
  UserSelectMenuInteraction
} from "discord.js";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { isAccessSubjectAllowed, isApprovedDiscordUsername } from "./access.js";
import {
  confirmToActProposalCard,
  needsMeInbox,
  parseAmbientCustomId,
  parseAmbientRoleSelection,
  parseProposalEntityId,
  progressCard,
  proofFirstCompletionCard,
  proposalEntityId,
  proposalEditModal,
  type AmbientAction,
  type AmbientRole
} from "./ambient-ui.js";
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
import {
  answerWithProjectContext,
  locateErrorInProject,
  parseLocateResponse,
  parseTranscription,
  transcribeErrorImages,
  type CodexRequestMode
} from "./codex-client.js";
import {
  detectBackends,
  getActiveBackendId,
  initActiveBackend,
  setActiveBackendId,
  type BackendAvailability
} from "./agent-backend.js";
import { parseMentionRequest, parseStatusRequest, statusDetailQuestion, stripBotMention } from "./mention.js";
import { splitDiscordMessage } from "./messages.js";
import { buildAgentPrompt, classifyNaturalIntent, type AgentRole } from "./natural-intent.js";
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
import { publicErrorMessage, redactSensitiveText } from "./security.js";
import {
  commandRequiresApproval,
  isPeerAllowedForProject,
  isScreenshotBlocked,
  isWriteBlockedBySafeMode,
  safeModeActionMessage,
  screenshotRequiresApproval
} from "./safety.js";
import { formatTaskDetail, formatTaskList, formatTaskLogs, TaskStore, type TaskRecord, type TaskStatus } from "./task-store.js";
import { canAccessTaskRecord, taskRetryRefusal, taskSyncRefusal, type TaskRetryRefusal, type TaskSyncRefusal } from "./task-access.js";
import {
  describeBranchFreshness,
  inspectBranchFreshness,
  syncTaskBranch,
  type BranchFreshnessResult,
  type SyncTaskBranchResult
} from "./branch-freshness.js";
import { captureChildIdentity, ExecutionLedger, reconcileInterruptedTasks, settleExecutionRecord } from "./task-recovery.js";
import {
  createTaskWorktree,
  inspectTaskWorktree,
  resumeTaskWorktree,
  type CreateTaskWorktreeResult,
  type TaskWorktree
} from "./task-worktree.js";
import {
  parsePreviewControl,
  interruptedTaskNoticeRow,
  parseTaskControl,
  previewControlRow,
  taskActionMatchesState,
  taskActionRows,
  taskControlRow,
  type PreviewButtonAction,
  type TaskControlAction
} from "./task-controls.js";
import { isolatedVisualProofNote, resolveShipImage } from "./visual-capture.js";
import { composeShipCard } from "./ship-card.js";
import {
  authorizeTaskPreview,
  formatPreviewInstance,
  resolvePreviewCommand,
  TaskPreviewManager,
  type PreviewControlAction,
  type PreviewInstance
} from "./task-preview.js";
import {
  continuationPrompt,
  formatInterruptedTaskNotice,
  formatTaskProgress,
  parseTaskModal,
  taskRequestModal,
  type TaskModalAction,
  type TaskProgressEvent
} from "./task-ui.js";
import { UserPreferenceStore } from "./user-preferences.js";
import {
  buildFixTaskPrompt,
  canActOnScreenshotFix,
  downloadImageAttachment,
  filterImageAttachments,
  formatNoErrorFoundReply,
  formatScreenshotAnalysisReply,
  parseScreenshotFixControl,
  screenshotFixControlRow,
  withTempImageDir,
  type ImageAttachmentInput,
  type ScreenshotFixAction,
  type ScreenshotFixActionContext
} from "./screenshot-fix.js";
import { ScreenshotFixStore } from "./screenshot-fix-store.js";
import {
  filterWorkForProjects,
  findExternalCodexWork,
  formatWorkStatus,
  scopeStatusToProject,
  WorkTracker,
  type ProjectWorkSnapshot
} from "./work-status.js";
import { parseWorkroomButton, workroomActionRows } from "./workroom-controls.js";
import { applySetupState, captureBootstrapConfig, isSetupController } from "./runtime-setup.js";
import { clearRuntimeLock, markRuntimeRunning, runtimeLockPath } from "./runtime-lock.js";
import { SetupStore, type SetupState, type SetupUserPermission } from "./setup-store.js";
import { parseSetupWizardAction, setupRepositoryModal, setupWizardView, type SetupWizardAction } from "./setup-wizard.js";
import type { AppConfig, PackedProjectContext, ProjectEntry } from "./types.js";
import {
  parseWorkspaceControl,
  parseWorkspaceModal,
  workspaceLauncherView,
  workspacePanelView,
  workspaceRequestModal,
  type WorkspaceAction,
  type WorkspaceModalAction
} from "./workspace-ui.js";
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
setActiveBackendId(process.env.DEVBOT_AGENT_BACKEND?.trim() || setupStore.snapshot().agentBackendId);
const contextService = new ProjectContextService(config.scanner);
const workTracker = new WorkTracker();
const taskStore = new TaskStore(process.env.DEVBOT_TASK_STORE?.trim() || undefined);
const previewLedgerFile = process.env.DEVBOT_PREVIEW_STORE?.trim();
const previewManager = new TaskPreviewManager(previewLedgerFile ? { ledgerFile: previewLedgerFile } : {});
const executionLedger = new ExecutionLedger(process.env.DEVBOT_EXECUTION_STORE?.trim() || undefined);
const userPreferences = new UserPreferenceStore(process.env.DEVBOT_PREFERENCES_STORE?.trim() || undefined);
const peerStore = new PeerStore(process.env.DEVBOT_PEER_STORE?.trim() || undefined);
const collabStore = new CollabStore(process.env.DEVBOT_COLLAB_STORE?.trim() || undefined);
const screenshotFixStore = new ScreenshotFixStore(process.env.DEVBOT_SNAPFIX_STORE?.trim() || undefined);
const activeTaskControllers = new Map<string, AbortController>();
const activeTaskActions = new Set<string>();
const activeWorkroomActions = new Set<string>();
const RETRY_CLEANUP_BLOCKED_MESSAGE =
  "This task can't be retried yet: Devbot couldn't confirm the previous run's worker process exited, so retrying now could run a second worker against the same workspace. It becomes retryable once cleanup is confirmed on a restart.";
let verifiedPrivateRoomId: string | undefined;
const verifiedProjectRoomAudiences = new Map<string, number>();
let slashCommandsReady = false;
const runtimePidFile = runtimeLockPath(process.env.DEVBOT_RUNTIME_LOCK);
markRuntimeRunning(runtimePidFile);
const gatewayIntents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
if (process.env.DEVBOT_MESSAGE_CONTENT_INTENT?.trim().toLowerCase() === "true") {
  gatewayIntents.push(GatewayIntentBits.MessageContent);
}
const client = new Client({
  intents: gatewayIntents,
  allowedMentions: { parse: [], repliedUser: false }
});

client.once("clientReady", async () => {
  try {
    const summary = await reconcileInterruptedTasks({
      ledger: executionLedger,
      tasks: taskStore,
      log: (message) => console.warn(message),
      notify: async ({ task }) => announceInterruptedTask(task),
      isActive: (taskId) => activeTaskControllers.has(taskId)
    });
    if (summary.interruptedTasks > 0) {
      const orphans = summary.orphansStopped > 0
        ? ` and stopped ${summary.orphansStopped} orphaned worker process${summary.orphansStopped === 1 ? "" : "es"}`
        : "";
      console.log(`Marked ${summary.interruptedTasks} task${summary.interruptedTasks === 1 ? "" : "s"} interrupted after the restart${orphans}.`);
    }
  } catch (error) {
    console.warn(`Unable to reconcile interrupted tasks: ${publicErrorMessage(error)}`);
  }
  try {
    for (const note of await previewManager.reconcile()) {
      console.log(`Preview reconciliation: ${note}`);
    }
  } catch (error) {
    console.warn(`Unable to reconcile preview processes: ${publicErrorMessage(error)}`);
  }
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
      console.warn(`Unable to synchronize slash commands: ${publicErrorMessage(error)}`);
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
      console.warn(`Private room access could not be synchronized; Devbot will remain unavailable: ${publicErrorMessage(error)}`);
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
  try {
    const { activeId, availabilities } = await initActiveBackend(config.codex, {
      envBackend: process.env.DEVBOT_AGENT_BACKEND?.trim(),
      setupBackend: setupStore.snapshot().agentBackendId
    });
    const installed = availabilities.filter((backend) => backend.installed).map((backend) => backend.id);
    console.log(`Agent backend: ${activeId} active. Detected: ${installed.length ? installed.join(", ") : "none"}.`);
  } catch (error) {
    console.warn(`Unable to detect coding-agent backends: ${(error as Error).message}`);
  }
  if (verifiedPrivateRoomId && config.projects.length > 0) {
    await ensureWorkspaceLauncher(config).catch((error) => {
      console.warn(`Unable to synchronize the workspace launcher: ${publicErrorMessage(error)}`);
    });
  }
});

process.once("exit", () => clearRuntimeLock(runtimePidFile));

for (const shutdownSignal of ["SIGINT", "SIGTERM"] as const) {
  process.once(shutdownSignal, () => {
    void previewManager
      .stopAll("shutdown")
      .catch((error) => console.warn(`Unable to stop previews during shutdown: ${publicErrorMessage(error)}`))
      .finally(() => {
        void Promise.resolve(client.destroy())
          .catch(() => undefined)
          .finally(() => process.exit(shutdownSignal === "SIGINT" ? 130 : 143));
      });
  });
}

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      if (!(await isConfiguredRoomId(interaction.channelId))) {
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
      const ambientControl = parseAmbientCustomId(interaction.customId);
      if (ambientControl && ambientControl.action !== "team-select") {
        if (!isAllowed(interaction, config)) {
          await interaction.reply({ content: "You are not allowed to use this bot.", flags: MessageFlags.Ephemeral });
          return;
        }
        if (!(await ensureConfiguredRoom(interaction))) return;
        await handleAmbientButton(interaction, config, ambientControl.action, ambientControl.entityId);
        return;
      }
      const workspaceControl = parseWorkspaceControl(interaction.customId);
      if (workspaceControl) {
        if (!isAllowed(interaction, config)) {
          await interaction.reply({ content: "You are not allowed to use this bot.", flags: MessageFlags.Ephemeral });
          return;
        }
        if (!(await ensureConfiguredRoom(interaction))) {
          return;
        }
        await handleWorkspaceButton(interaction, config, workspaceControl.action, workspaceControl.projectName);
        return;
      }
      const setupAction = parseSetupWizardAction(interaction.customId);
      if (setupAction) {
        if (!isOwner(interaction.user.id, config)) {
          await interaction.reply({ content: "Only the configured Devbot owner can use setup controls.", flags: MessageFlags.Ephemeral });
          return;
        }
        await handleSetupWizardButton(interaction, config, setupAction);
        return;
      }
      const previewControl = parsePreviewControl(interaction.customId);
      if (previewControl) {
        if (!isAllowed(interaction, config)) {
          await interaction.reply({ content: "You are not allowed to use this bot.", flags: MessageFlags.Ephemeral });
          return;
        }
        if (!(await ensureConfiguredRoom(interaction))) {
          return;
        }
        await handlePreviewControlButton(interaction, config, previewControl.action, previewControl.previewId);
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
      const screenshotFixControl = parseScreenshotFixControl(interaction.customId);
      if (screenshotFixControl) {
        if (!isAllowed(interaction, config)) {
          await interaction.reply({ content: "You are not allowed to use this bot.", flags: MessageFlags.Ephemeral });
          return;
        }
        if (!(await ensureConfiguredRoom(interaction))) {
          return;
        }
        await handleScreenshotFixControl(interaction, config, screenshotFixControl.action, screenshotFixControl.id);
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
      const ambientControl = parseAmbientCustomId(interaction.customId);
      if (ambientControl?.action === "team-select" && interaction.isStringSelectMenu()) {
        if (!isAllowed(interaction, config)) {
          await interaction.reply({ content: "You are not allowed to use this bot.", flags: MessageFlags.Ephemeral });
          return;
        }
        if (!(await ensureConfiguredRoom(interaction))) return;
        await handleAmbientTeamSelect(interaction, config, ambientControl.entityId);
        return;
      }
      const workspaceControl = parseWorkspaceControl(interaction.customId);
      if (workspaceControl?.action === "project" && interaction.isStringSelectMenu()) {
        if (!isAllowed(interaction, config)) {
          await interaction.reply({ content: "You are not allowed to use this bot.", flags: MessageFlags.Ephemeral });
          return;
        }
        if (!(await ensureConfiguredRoom(interaction))) {
          return;
        }
        await handleWorkspaceProjectSelect(interaction, config);
        return;
      }
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
      const ambientControl = parseAmbientCustomId(interaction.customId);
      if (ambientControl?.action === "proposal-edit") {
        if (!isAllowed(interaction, config)) {
          await interaction.reply({ content: "You are not allowed to use this bot.", flags: MessageFlags.Ephemeral });
          return;
        }
        if (!(await ensureConfiguredRoom(interaction))) return;
        await handleAmbientProposalEdit(interaction, config, ambientControl.entityId);
        return;
      }
      const workspaceModal = parseWorkspaceModal(interaction.customId);
      if (workspaceModal) {
        if (!isAllowed(interaction, config)) {
          await interaction.reply({ content: "You are not allowed to use this bot.", flags: MessageFlags.Ephemeral });
          return;
        }
        if (!(await ensureConfiguredRoom(interaction))) {
          return;
        }
        await handleWorkspaceModal(interaction, config, workspaceModal.action, workspaceModal.projectName);
        return;
      }
      const taskModal = parseTaskModal(interaction.customId);
      if (taskModal) {
        if (!isAllowed(interaction, config)) {
          await interaction.reply({ content: "You are not allowed to use this bot.", flags: MessageFlags.Ephemeral });
          return;
        }
        if (!(await ensureConfiguredRoom(interaction))) {
          return;
        }
        await handleTaskModal(interaction, config, taskModal.action, taskModal.taskId);
        return;
      }
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

    if (interaction.isMessageContextMenuCommand()) {
      if (interaction.commandName !== "Start Devbot workroom") return;
      if (!isAllowed(interaction, config)) {
        await interaction.reply({ content: "You are not allowed to use this bot.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (!(await ensureConfiguredRoom(interaction))) return;
      await handleAmbientContextMenu(interaction, config);
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
    console.error(publicErrorMessage(error));
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
    const threadTask = message.channel.type === ChannelType.PrivateThread
      ? await taskStore.findByThread(message.channelId)
      : undefined;
    if (!mentionsBot && !threadTask) {
      return;
    }
    if (!mentionsBot && threadTask && !message.content.trim()) {
      return;
    }
    if (!isAllowedMessage(message, config)) {
      return;
    }

    if (!effectivePrivateRoomId() && Object.keys(setupStore.snapshot().projectRoomIds).length === 0) {
      await message.reply("Devbot setup is not ready. Ask the owner to run `/setup wizard`.");
      return;
    }
    if (!(await isConfiguredRoomId(message.channelId))) {
      if (effectivePrivateRoomId()) {
        await message.author.send(`Use Devbot in its configured private room: <#${effectivePrivateRoomId()}>.`).catch(() => undefined);
      }
      return;
    }

    const mentionText = mentionsBot ? stripBotMention(message.content, client.user.id, botRoleMentionIds) : message.content.trim();
    console.log(`Mention request from user ${message.author.id} in channel ${message.channelId} (${mentionText.length} characters).`);

    const roomProject = await projectForConfiguredRoom(message.channelId, config);
    const statusProjectRequest = parseOptionalProjectToken(mentionText, config.projects);
    if (roomProject && statusProjectRequest.project && statusProjectRequest.project.name !== roomProject.name) {
      await message.reply(`This room is dedicated to \`${roomProject.name}\`. Use that project's room for \`${statusProjectRequest.project.name}\`.`);
      return;
    }
    if (statusProjectRequest.project && !isAllowedMessageForProject(message, statusProjectRequest.project)) {
      await message.reply(`You are not allowed to use project \`${statusProjectRequest.project.name}\` under its .devbot policy.`);
      return;
    }
    const visibleProjects = (roomProject ? [roomProject] : config.projects).filter((project) => isAllowedMessageForProject(message, project));
    const preferredProjects = projectsWithUserPreference(visibleProjects, message.author.id);
    const preferredProject = roomProject ?? statusProjectRequest.project ?? defaultProjectIfAvailable(preferredProjects);
    if (preferredProject && hasProjectAudienceRestriction(preferredProject) && !roomProject) {
      await message.reply(
        "This project has a scoped audience, so I will not post its results from a channel mention. Open the workspace or use `/ask` for a private response."
      );
      return;
    }
    const visibleConfig = { ...config, projects: preferredProject ? [preferredProject] : visibleProjects };

    const imageAttachments = filterImageAttachments(
      [...message.attachments.values()].map((attachment) => ({
        id: attachment.id,
        name: attachment.name,
        url: attachment.url,
        contentType: attachment.contentType,
        size: attachment.size
      }))
    );
    if (imageAttachments.length > 0) {
      if (!preferredProject) {
        await message.reply("I can see the image, but no project is configured to analyze it against. Ask the owner to run `/setup repo`.");
        return;
      }
      await handleScreenshotMention(message, config, preferredProject, imageAttachments);
      return;
    }

    const parsedStatusRequest = parseStatusRequest(statusProjectRequest.text);
    const statusRequest = parsedStatusRequest.isStatus
      ? parsedStatusRequest
      : parseFallbackStatusRequest(statusProjectRequest.text);

    if (statusRequest.isStatus) {
      await message.channel.sendTyping();
      console.log(`Status request from ${message.author.tag}: image=${statusRequest.wantsImage} question=${Boolean(statusRequest.question)}`);
      const snapshot = await getStatusSnapshotResponse(
        visibleConfig,
        statusRequest.wantsImage,
        preferredProject,
        statusRequest.question,
        message.author.tag
      );
      await replyToMessageWithChunks(message, snapshot);

      if (statusRequest.question) {
        const detail = await getDetailedStatusResponse({
          appConfig: visibleConfig,
          question: statusRequest.question,
          requester: message.author.tag,
          project: preferredProject
        });
        await replyToMessageWithChunks(message, detail);
      }
      return;
    }

    const request = parseMentionRequest(message.content, client.user.id, preferredProjects, botRoleMentionIds);
    if (!request.text) {
      await message.reply("Ask me a project question after the mention. Use `/do` when you want an intentional code change.");
      return;
    }

    if (!isAllowedMessageForProject(message, request.project)) {
      await message.reply(`You are not allowed to use project \`${request.project.name}\` under its .devbot policy.`);
      return;
    }

    const naturalIntent = classifyNaturalIntent(request.text);
    if (request.mode === "action" || naturalIntent.kind === "proposed-action") {
      await createAmbientProposalFromMessage({
        message,
        appConfig: config,
        project: request.project,
        text: request.text,
        includePatterns: request.includePatterns,
        source: threadTask ? `thread:${threadTask.id}` : "mention",
        ...(threadTask ? { parentTaskId: threadTask.id } : {})
      });
      return;
    }

    await userPreferences.setSelectedProject(message.author.id, request.project.name);

    await message.channel.sendTyping();
    const pending = await message.reply("Routing request...");
    await executeMessageRequest({
      message,
      pending,
      appConfig: config,
      project: request.project,
      text: request.text,
      includePatterns: request.includePatterns,
      mode: request.mode,
      requester: message.author.tag,
      requesterId: message.author.id,
      channelId: message.channelId,
      ...(threadTask ? { threadId: message.channelId, parentTaskId: threadTask.id } : {}),
      source: threadTask ? `thread:${threadTask.id}` : "mention"
    });
  } catch (error) {
    console.error(publicErrorMessage(error));
    await message.reply(`Error: ${publicErrorMessage(error)}`);
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
    const projectName = interaction.options.getString("project");
    const question = interaction.options.getString("question") ?? undefined;
    const project = projectName
      ? mustFindProject(appConfig.projects, projectName)
      : preferredProjectForInteraction(appConfig, interaction);
    if (!project) {
      await interaction.reply({ content: "No configured project is available to you.", flags: MessageFlags.Ephemeral });
      return;
    }
    const privateReply = hasProjectAudienceRestriction(project);
    await interaction.deferReply(privateReply ? { flags: MessageFlags.Ephemeral } : undefined);
    if (!(await ensureProjectAccess(interaction, project))) {
      return;
    }
    await userPreferences.setSelectedProject(interaction.user.id, project.name);
    const visibleConfig = { ...appConfig, projects: [project] };
    const snapshot = await getStatusSnapshotResponse(
      visibleConfig,
      interaction.options.getBoolean("image") ?? false,
      project,
      question,
      interaction.user.tag
    );
    await editInteractionWithChunks(interaction, snapshot, privateReply);

    if (question) {
      const detail = await getDetailedStatusResponse({
        appConfig: visibleConfig,
        question,
        requester: interaction.user.tag,
        project
      });
      await followUpWithChunks(interaction, detail, privateReply);
    }
    return;
  }

  if (interaction.commandName === "snip") {
    const projectName = interaction.options.getString("project");
    const target = interaction.options.getString("target", true);
    const viewport = interaction.options.getString("viewport") as "desktop" | "tablet" | "mobile" | null;
    const project = projectName ? mustFindProject(appConfig.projects, projectName) : defaultProject(appConfig.projects);
    const privateReply = hasProjectAudienceRestriction(project);
    await interaction.deferReply(privateReply ? { flags: MessageFlags.Ephemeral } : undefined);
    if (!(await ensureProjectAccess(interaction, project))) {
      return;
    }
    const screenshotPolicy = screenshotPolicyMessage(project, interaction.user.tag);
    if (screenshotPolicy) {
      await interaction.editReply(screenshotPolicy);
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
    }, privateReply);
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

  if (interaction.commandName === "inbox") {
    await handleNeedsMeCommand(interaction, appConfig);
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
    const project = mustFindProject(appConfig.projects, interaction.options.getString("project", true));
    if (!(await ensureProjectAccess(interaction, project))) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const fileCount = await contextService.refresh(project);
    await interaction.editReply(`Refreshed \`${project.name}\` with ${fileCount} indexed files.`);
    return;
  }

  if (interaction.commandName === "ask") {
    const project = selectedProjectForInteraction(appConfig, interaction, interaction.options.getString("project"));
    if (!(await ensureProjectAccess(interaction, project))) {
      return;
    }
    await userPreferences.setSelectedProject(interaction.user.id, project.name);
    const question = interaction.options.getString("question", true);
    const includePatterns = parseIncludePatterns(interaction.options.getString("include"));
    await executeInteractionRequest({
      interaction,
      appConfig,
      project,
      text: question,
      includePatterns,
      mode: "answer",
      requester: interaction.user.tag,
      source: "slash:ask",
      ephemeral: hasProjectAudienceRestriction(project)
    });
    return;
  }

  if (interaction.commandName === "do") {
    if (isWriteBlockedBySafeMode(appConfig, "action")) {
      await interaction.reply({ content: safeModeActionMessage("/do"), flags: MessageFlags.Ephemeral });
      return;
    }

    const project = selectedProjectForInteraction(appConfig, interaction, interaction.options.getString("project"));
    if (!(await ensureProjectAccess(interaction, project))) {
      return;
    }
    await userPreferences.setSelectedProject(interaction.user.id, project.name);
    const task = interaction.options.getString("task", true);
    const includePatterns = parseIncludePatterns(interaction.options.getString("include"));
    await executeInteractionRequest({
      interaction,
      appConfig,
      project,
      text: task,
      includePatterns,
      mode: "action",
      requester: interaction.user.tag,
      source: "slash:do",
      ephemeral: hasProjectAudienceRestriction(project)
    });
    return;
  }

  if (interaction.commandName === "ship") {
    await handleShipCommand(interaction, appConfig);
    return;
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

  if (subcommand === "backend") {
    const requested = interaction.options.getString("id");
    if (requested) {
      const state = await setupStore.setAgentBackend(requested);
      setActiveBackendId(process.env.DEVBOT_AGENT_BACKEND?.trim() || state.agentBackendId);
    }
    await interaction.editReply(await formatBackendReport(appConfig, requested ?? undefined));
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

  if (subcommand === "project-room") {
    const action = interaction.options.getString("action", true);
    const project = mustFindProject(appConfig.projects, interaction.options.getString("project", true));
    if (action === "remove") {
      const previousRoomId = setupStore.snapshot().projectRoomIds[project.name];
      await setupStore.unbindProjectRoom(project.name);
      if (previousRoomId) verifiedProjectRoomAudiences.delete(previousRoomId);
      await interaction.editReply(`Removed the ambient room binding for \`${project.name}\`.`);
      return;
    }

    const selectedChannel = interaction.options.getChannel("channel") ?? interaction.channel;
    const channel = selectedChannel?.id && interaction.guild
      ? await interaction.guild.channels.fetch(selectedChannel.id).catch(() => null)
      : null;
    if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.PrivateThread)) {
      await interaction.editReply("Choose a private server text channel or private thread for this project.");
      return;
    }
    if (!(await verifyPrivateRoom(channel.id))) {
      await interaction.editReply(
        "That room is not private. Deny `View Channel` to `@everyone`, or choose a private thread, then bind it again."
      );
      return;
    }
    const audienceProblem = await projectRoomAudienceProblem(channel, project, appConfig);
    if (audienceProblem) {
      await interaction.editReply(audienceProblem);
      return;
    }
    await setupStore.bindProjectRoom(project.name, channel.id);
    verifiedProjectRoomAudiences.set(channel.id, Date.now());
    await interaction.editReply(`Bound \`${project.name}\` to its ambient room: <#${channel.id}>.`);
    return;
  }

  const channel = await createOrSyncPrivateRoom(interaction, appConfig, interaction.options.getString("name") ?? undefined);
  await ensureWorkspaceLauncher(appConfig);
  await interaction.editReply(`Private Devbot room ready: <#${channel.id}>.`);
}

async function projectRoomAudienceProblem(
  channel: GuildTextBasedChannel,
  project: ProjectEntry,
  appConfig: AppConfig
): Promise<string | undefined> {
  const guildMembers = await channel.guild.members.fetch();
  const visibleIds = channel.type === ChannelType.PrivateThread
    ? new Set((await channel.members.fetch()).map((member) => member.id))
    : new Set(
        [...guildMembers.values()]
          .filter((member) => channel.permissionsFor(member).has(PermissionFlagsBits.ViewChannel))
          .map((member) => member.id)
      );
  const unauthorized = [...visibleIds].flatMap((memberId) => {
    const member = guildMembers.get(memberId);
    if (!member) return [memberId];
    if (member.user.bot) {
      return member.id === client.user?.id || (appConfig.peerBotIds.has(member.id) && isPeerAllowedForProject(project, member.id))
        ? []
        : [member.id];
    }
    return isAllowedGuildMember(member, appConfig) && isAllowedGuildMemberForProject(member, project) ? [] : [member.id];
  });
  if (unauthorized.length === 0) return undefined;
  const examples = unauthorized.slice(0, 3).map((id) => `<@${id}>`).join(", ");
  return `That room is private, but its visible audience exceeds the Devbot and project allowlists (${examples}${unauthorized.length > 3 ? ", ..." : ""}). Tighten the Discord permissions before binding it.`;
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
  if (action === "finish") {
    await ensureWorkspaceLauncher(appConfig);
  }
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
    PermissionFlagsBits.SendMessagesInThreads,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.UseApplicationCommands,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.EmbedLinks
  ];
  const peerAllow = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.SendMessagesInThreads,
    PermissionFlagsBits.ReadMessageHistory
  ];
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
        PermissionFlagsBits.SendMessagesInThreads,
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
  const projectRooms = Object.entries(state.projectRoomIds).length
    ? Object.entries(state.projectRoomIds).map(([projectName, roomId]) => `- \`${projectName}\`: <#${roomId}>`).join("\n")
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
    repositories,
    "",
    "Project rooms:",
    projectRooms
  ].join("\n");
}

async function formatSetupDoctor(appConfig: AppConfig): Promise<string> {
  const defaultProject = appConfig.projects.find((project) => project.isDefault);
  const repoReady = defaultProject ? Boolean((await stat(defaultProject.root).catch(() => undefined))?.isDirectory()) : false;
  const backends = await detectBackends(appConfig.codex).catch(() => [] as BackendAvailability[]);
  const activeBackendId = getActiveBackendId();
  const activeBackend = backends.find((backend) => backend.id === activeBackendId);
  const backendReady = Boolean(activeBackend?.installed && activeBackend.compatible);
  const answerReadOnly = activeBackend ? activeBackend.capabilities.enforcesAnswerReadOnly : true;
  const actionConfined = activeBackend ? activeBackend.capabilities.confinesActionWorkspace : true;
  const checks = [
    [Boolean(appConfig.ownerUserId), "Owner identity", "Set DEVBOT_OWNER_USER_ID locally and restart."],
    [Boolean(effectivePrivateRoomId()), "Private room", "Run /setup wizard and choose Use private room."],
    [repoReady, "Default repository", "Add or repair a repository in /setup wizard."],
    [backendReady, `Agent backend (${activeBackendId})`, activeBackend?.compatibilityError ?? "Install the selected agent CLI or pick another with /setup backend."],
    [answerReadOnly, `Read-only answers (${activeBackendId})`, "This backend cannot guarantee read-only /ask runs; switch to codex or claude with /setup backend."],
    [actionConfined, `Workspace-confined actions (${activeBackendId})`, "This backend cannot confine /do writes to the task workspace; switch to codex with /setup backend."],
    [appConfig.routing.enabled && Boolean(appConfig.routing.fastModel && appConfig.routing.standardModel && appConfig.routing.deepModel), "Luna / Terra / Sol routing", "Check CODEX_ROUTER_MODEL and tier model settings."],
    [slashCommandsReady || !appConfig.autoDeployCommands, "Slash commands", "Restart Devbot or run npm run commands:deploy."]
  ] as const;
  const passed = checks.filter(([ready]) => ready).length;
  const backendSummary = backends.length
    ? backends.map((backend) => `${backend.id === activeBackendId ? "*" : "-"} ${backend.id}: ${backend.installed ? backend.version ?? "installed" : "not installed"}${backend.experimental ? " (experimental)" : ""}${backend.capabilities.enforcesAnswerReadOnly ? "" : " (no read-only /ask)"}${backend.capabilities.confinesActionWorkspace ? "" : " (no /do actions)"}${backend.installed && !backend.compatible ? " (execution disabled)" : ""}`)
    : ["- backend detection unavailable"];
  return [
    "Devbot doctor",
    `Readiness: ${passed}/${checks.length}`,
    "",
    ...checks.map(([ready, label, fix]) => `${ready ? "READY" : "FIX"}  ${label}${ready ? "" : ` - ${fix}`}`),
    "",
    "Coding-agent backends:",
    ...backendSummary,
    "",
    passed === checks.length ? "Ready. Ask with @devbot, change with /do, and check with /status." : "No changes were made. Resolve FIX items, then run /setup doctor again."
  ].join("\n");
}

function formatBackendLine(backend: BackendAvailability, activeId: string): string {
  const marker = backend.id === activeId ? "ACTIVE " : "       ";
  const status = backend.installed ? backend.version ?? "installed" : "not installed";
  const tags = [
    backend.experimental ? "experimental" : "",
    backend.capabilities.enforcesAnswerReadOnly ? "" : "no read-only /ask",
    backend.capabilities.confinesActionWorkspace ? "" : "no /do actions",
    backend.installed && !backend.compatible ? backend.compatibilityError ?? "execution disabled" : "",
    backend.error && !backend.installed ? backend.error : ""
  ].filter(Boolean);
  return `${marker}${backend.id} (${backend.displayName}): ${status}${tags.length ? ` [${tags.join("; ")}]` : ""}`;
}

async function formatBackendReport(appConfig: AppConfig, requested?: string): Promise<string> {
  const availabilities = await detectBackends(appConfig.codex);
  const activeId = getActiveBackendId();
  const envForced = process.env.DEVBOT_AGENT_BACKEND?.trim();
  const active = availabilities.find((backend) => backend.id === activeId);
  const lines = [
    "Devbot coding-agent backends",
    `Active: ${activeId}${active && !active.installed ? " (selected but not detected on this machine)" : ""}`,
    "",
    ...availabilities.map((backend) => formatBackendLine(backend, activeId)),
    "",
    "Selection order: DEVBOT_AGENT_BACKEND env, then /setup backend. Only codex is auto-selected; every other backend requires an explicit choice here."
  ];
  if (requested && envForced && envForced.toLowerCase() !== requested.toLowerCase()) {
    lines.push(`Saved ${requested}, but DEVBOT_AGENT_BACKEND=${envForced} overrides it until the env var is cleared.`);
  } else if (requested) {
    lines.push(`Active backend set to ${requested}.`);
  }
  return lines.join("\n");
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
  parentTaskId?: string;
  dedupeKey?: string;
  existingTaskId?: string;
  requesterId?: string;
  accessScope?: "project" | "workroom";
  internal?: boolean;
  channelId?: string;
  threadId?: string;
  agentRoles?: AmbientRole[];
  displayText?: string;
  resumeWorkspace?: { workspacePath: string; branchName: string; baseBranch: string };
  signal?: AbortSignal;
  onProgress?: (progress: TaskProgressEvent) => Promise<void>;
  /** Fires once the task record is durably created, before any work that can fail. Used to consume a caller-owned pending record only after there is something to retry against. */
  onTaskStarted?: (taskId: string) => Promise<void>;
}

interface ProjectRequestResult {
  answer: string;
  context: PackedProjectContext;
  taskId: string;
  route: RequestRoute;
  visualProofNote?: string;
}

async function runProjectRequest(options: ProjectRequestOptions): Promise<ProjectRequestResult> {
  if (isWriteBlockedBySafeMode(options.appConfig, options.mode)) {
    throw new Error(safeModeActionMessage(options.source));
  }

  const task = options.existingTaskId
    ? await requireRunningTask(options.existingTaskId, options.project.name)
    : await taskStore.start({
        source: options.source,
        mode: options.mode,
        projectName: options.project.name,
        requester: options.requester,
        text: options.text,
        includePatterns: options.includePatterns,
        ...(options.parentTaskId ? { parentTaskId: options.parentTaskId } : {}),
        ...(options.dedupeKey ? { dedupeKey: options.dedupeKey } : {}),
        ...(options.requesterId ? { requesterId: options.requesterId } : {}),
        ...(options.accessScope ? { accessScope: options.accessScope } : {}),
        ...(options.internal ? { internal: true } : {}),
        ...(options.channelId ? { channelId: options.channelId } : {}),
        ...(options.threadId ? { threadId: options.threadId } : {}),
        ...(options.agentRoles?.length ? { agentRoles: options.agentRoles } : {})
      });
  if (options.onTaskStarted) {
    try {
      await options.onTaskStarted(task.id);
    } catch (error) {
      console.warn(`Unable to run the post-start hook for task ${task.id}: ${publicErrorMessage(error)}`);
    }
  }
  try {
    await executionLedger.record({
      taskId: task.id,
      projectName: options.project.name,
      mode: options.mode,
      requester: options.requester,
      ...(task.requesterId ? { requesterId: task.requesterId } : {}),
      ...(task.accessScope ? { accessScope: task.accessScope } : {}),
      ...(task.channelId ? { channelId: task.channelId } : {}),
      ...(task.threadId ? { threadId: task.threadId } : {}),
      ...(task.controlMessageId ? { controlMessageId: task.controlMessageId } : {}),
      startedAt: task.startedAt
    });
  } catch (error) {
    const failure = new Error(
      `Task stopped before execution because its durable recovery record could not be created: ${publicErrorMessage(error)}`,
      { cause: error }
    );
    await taskStore.fail(task.id, failure);
    throw failure;
  }
  const controller = new AbortController();
  const abortFromParent = (): void => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromParent();
  else options.signal?.addEventListener("abort", abortFromParent, { once: true });
  activeTaskControllers.set(task.id, controller);
  const releaseController = (): void => {
    activeTaskControllers.delete(task.id);
    options.signal?.removeEventListener("abort", abortFromParent);
  };
  let executionProject = options.project;
  let isolatedWorktree: TaskWorktree | undefined;
  const workspaceNotes: string[] = [];
  try {
    await ensureRequestStillActive();
    if (options.mode === "action") {
      let isolated: CreateTaskWorktreeResult | undefined;
      if (options.resumeWorkspace) {
        const resumed = await resumeTaskWorktree({
          sourcePath: options.project.root,
          worktreePath: options.resumeWorkspace.workspacePath,
          branch: options.resumeWorkspace.branchName,
          baseRevision: options.resumeWorkspace.baseBranch
        });
        if (resumed.available) {
          isolated = resumed;
          workspaceNotes.push(`Reused the isolated workspace preserved on branch ${resumed.worktree.branch} from the interrupted task.`);
        } else {
          workspaceNotes.push(`The preserved workspace could not be reused (${resumed.message}); a fresh isolated worktree was created.`);
        }
      }
      isolated ??= await createTaskWorktree({
        sourcePath: options.project.root,
        taskName: task.id,
        baseRef: "HEAD"
      });
      await ensureRequestStillActive();
      if (isolated.available) {
        isolatedWorktree = isolated.worktree;
        executionProject = { ...options.project, root: isolated.worktree.path };
        contextService.invalidate(options.project.name);
        await taskStore.setWorkspace(task.id, {
          workspacePath: isolated.worktree.path,
          branchName: isolated.worktree.branch,
          baseBranch: isolated.worktree.baseRevision,
          isolated: true
        });
        await executionLedger.setWorkspace(task.id, {
          workspacePath: isolated.worktree.path,
          branchName: isolated.worktree.branch,
          baseBranch: isolated.worktree.baseRevision,
          isolated: true
        });
        await ensureRequestStillActive();
      } else {
        await taskStore.setWorkspace(task.id, {
          workspacePath: options.project.root,
          baseBranch: options.project.metadata.defaultBranch ?? "HEAD",
          isolated: false
        });
        const isolationError = new Error(`Action stopped before write access because branch isolation is unavailable: ${isolated.message}`);
        await taskStore.setEvidence(task.id, {
          verification: [`Branch isolation unavailable: ${isolated.message}`, "No source-checkout changes were allowed."]
        });
        await taskStore.fail(task.id, isolationError);
        throw isolationError;
      }
    }
  } catch (error) {
    if (controller.signal.aborted) await taskStore.cancel(task.id, "Canceled by user request.");
    else await taskStore.fail(task.id, error);
    await settleExecutionRecordSafely(task.id);
    releaseController();
    throw error;
  }
  const work = options.internal
    ? undefined
    : workTracker.start({
        mode: options.mode,
        projectName: options.project.name,
        requester: options.requester,
        text: options.displayText ?? options.text,
        taskId: task.id
      });
  const progressBase = {
    taskId: task.id,
    projectName: options.project.name,
    mode: options.mode,
    text: options.displayText ?? options.text,
    requester: options.requester,
    startedAt: task.startedAt
  };
  await reportTaskProgress(options, { ...progressBase, phase: "routing" });
  await recordExecutionState(task.id, executionLedger.setPhase(task.id, "routing"));
  let selectedRoute: RequestRoute | undefined;

  try {
    const route = await routeRequest({
      codex: options.appConfig.codex,
      routing: options.appConfig.routing,
      text: options.text,
      mode: options.mode,
      projectName: options.project.name,
      projectRoot: executionProject.root,
      hasExplicitIncludes: options.includePatterns.length > 0,
      signal: controller.signal
    });
    selectedRoute = route;
    if (work) workTracker.update(work.id, {
      phase: "gathering-context",
      modelTier: route.tier,
      contextMode: route.contextMode
    });
    await reportTaskProgress(options, { ...progressBase, phase: "gathering-context", route });
    await recordExecutionState(task.id, executionLedger.setPhase(task.id, "gathering-context"));
    const contextCharLimit = contextLimitForRoute(
      route,
      options.appConfig.scanner.maxPackedContextChars,
      options.appConfig.routing.focusedContextChars,
      executionProject.metadata.policy.maxContextChars,
      options.contextCharLimit
    );
    const context = contextCharLimit === 0
      ? { project: executionProject, files: [], packedText: "" }
      : await contextService.pack(executionProject, options.text, options.includePatterns, contextCharLimit);
    if (work) workTracker.update(work.id, {
      phase: "running-codex",
      contextFileCount: context.files.length
    });
    await reportTaskProgress(options, {
      ...progressBase,
      phase: "running-codex",
      route,
      contextFileCount: context.files.length
    });
    // A worker may be spawned after this durable transition, but runCodex
    // withholds stdin until recordExecutionChild atomically persists the exact
    // child identity and advances the phase to running-codex.
    await executionLedger.setPhase(task.id, "spawning-worker");
    const answer = await runCodex(
      options.appConfig,
      options.text,
      context,
      options.mode,
      route,
      controller.signal,
      recordExecutionChild(task.id),
      recordExecutionExit(task.id)
    );
    if (isolatedWorktree) {
      await recordTaskWorktreeEvidence(task.id, isolatedWorktree, true, workspaceNotes);
      // Every action task runs in an isolated Git worktree (task-worktree.ts); Codex's edits land
      // on a review branch, never in options.project.root. Devbot has no managed preview of that
      // isolated workspace, so there is no server it could honestly screenshot "after" against —
      // the source checkout's dev server never reflects this task's changes. Per review, automatic
      // before/after capture is skipped entirely rather than attaching a diff that would silently
      // misrepresent someone else's (or no) change as this task's result. `/ship` remains available
      // as an explicit, on-demand, honestly-captioned surface (visual-capture.ts).
      await taskStore.recordCapture(task.id, {
        captureNote: isolatedVisualProofNote(task.id, isolatedWorktree.branch)
      });
    }
    const completed = await taskStore.succeed(task.id, {
      contextFileCount: context.files.length,
      resultPreview: answer,
      ...(route.model ? { model: route.model } : {}),
      modelTier: route.tier,
      contextMode: route.contextMode,
      routeReason: route.reason,
      routeSource: route.source
    });
    if (!completed) {
      const current = await taskStore.get(task.id);
      if (current?.status === "canceled") {
        controller.abort(current.error ?? "Canceled by user request.");
      }
      throw new Error(current?.error ?? `Task stopped while ${current?.status ?? "unavailable"}.`);
    }
    return {
      answer,
      context,
      taskId: task.id,
      route,
      ...(isolatedWorktree ? { visualProofNote: isolatedVisualProofNote(task.id, isolatedWorktree.branch) } : {})
    };
  } catch (error) {
    if (isolatedWorktree) {
      await recordTaskWorktreeEvidence(task.id, isolatedWorktree, false, workspaceNotes).catch(() => undefined);
    }
    if (controller.signal.aborted) {
      await taskStore.cancel(task.id, "Canceled by user request.");
      await reportTaskProgress(options, {
        ...progressBase,
        phase: "canceled",
        ...(selectedRoute ? { route: selectedRoute } : {}),
        error: "Canceled by user request."
      });
    } else {
      await taskStore.fail(task.id, error);
      await reportTaskProgress(options, {
        ...progressBase,
        phase: "failed",
        ...(selectedRoute ? { route: selectedRoute } : {}),
        error: publicErrorMessage(error)
      });
    }
    throw error;
  } finally {
    if (options.mode === "action") {
      contextService.invalidate(options.project.name);
    }
    await settleExecutionRecordSafely(task.id);
    releaseController();
    if (work) workTracker.finish(work.id);
  }

  async function ensureRequestStillActive(): Promise<void> {
    const current = await taskStore.get(task.id);
    if (controller.signal.aborted || current?.status !== "running") {
      throw new Error(current?.error ?? "Canceled by user request.");
    }
  }
}

async function requireRunningTask(taskId: string, projectName: string): Promise<TaskRecord> {
  const task = await taskStore.get(taskId);
  if (!task || task.status !== "running" || task.projectName !== projectName) {
    throw new Error("The approved task is no longer available to run.");
  }
  return task;
}

async function recordExecutionState(taskId: string, operation: Promise<void>): Promise<void> {
  try {
    await operation;
  } catch (error) {
    console.warn(`Unable to update the execution ledger for ${taskId}: ${publicErrorMessage(error)}`);
  }
}

function recordExecutionChild(taskId: string): (pid: number) => Promise<void> {
  return async (pid) => {
    const identity = await captureChildIdentity(pid);
    if (identity) {
      if (process.platform !== "win32" && identity.groupId !== pid) {
        throw new Error(`Worker ${pid} did not start as an isolated process-group leader.`);
      }
      // Persist the child identity durably before the caller sends work. A
      // failed write throws, so the caller stops the child and the retained
      // ledger record keeps this task's retry gate blocked.
      await executionLedger.startChild(taskId, identity);
      return;
    }
    if (process.platform === "win32") {
      // Spawn identities cannot be probed here (no ps / process groups). Mark
      // the worker as potentially active before stdin is released; a normal
      // close advances to worker-exited, while a crash/fallback retains the
      // conservative retry block.
      await executionLedger.setPhase(taskId, "running-codex");
      return;
    }
    // A supported platform could not capture a durable identity for a worker it
    // just spawned. Fail closed: refuse to send work, so the caller stops the
    // child and the retained record keeps retry blocked.
    throw new Error(`Could not durably record the worker for task ${taskId} before sending work.`);
  };
}

async function settleExecutionRecordSafely(taskId: string): Promise<void> {
  try {
    const outcome = await settleExecutionRecord({ ledger: executionLedger, tasks: taskStore, taskId });
    if (outcome === "kill-unconfirmed" || outcome === "unverifiable") {
      console.warn(`Kept the execution ledger for ${taskId}; worker cleanup is still ${outcome}.`);
    }
  } catch (error) {
    // Failing to settle must never erase the record. A later restart will
    // reconcile it and the ledger-derived retry gate remains closed.
    console.warn(`Unable to settle the execution ledger for ${taskId}: ${publicErrorMessage(error)}`);
  }
}

function recordExecutionExit(taskId: string): () => Promise<void> {
  return async () => {
    // The close event is authoritative for the leader even when it exits
    // nonzero. Persist it independently of runCodex's success value, then reap
    // any same-group descendants before the caller sees completion.
    await recordExecutionState(taskId, executionLedger.setPhase(taskId, "worker-exited"));
    await settleExecutionRecordSafely(taskId);
  };
}

async function rememberTaskMessage(taskId: string, channelId: string, messageId: string): Promise<void> {
  try {
    await taskStore.setDiscordContext(taskId, { channelId, controlMessageId: messageId });
    await executionLedger.setDiscordContext(taskId, { channelId, controlMessageId: messageId });
  } catch (error) {
    console.warn(`Unable to record the task message for ${taskId}: ${publicErrorMessage(error)}`);
  }
}

async function fetchOwnTaskMessage(task: TaskRecord): Promise<Message | undefined> {
  const channelId = task.threadId ?? task.channelId;
  if (!channelId || !task.controlMessageId) {
    return undefined;
  }
  const channel = await client.channels.fetch(channelId);
  if (!channel?.isTextBased() || channel.isDMBased()) {
    return undefined;
  }
  const message = await channel.messages.fetch(task.controlMessageId);
  return message.author.id === client.user?.id ? message : undefined;
}

async function announceInterruptedTask(task: TaskRecord): Promise<void> {
  const message = await fetchOwnTaskMessage(task);
  if (!message) {
    return;
  }
  await message.edit({
    content: formatInterruptedTaskNotice(task),
    components: [interruptedTaskNoticeRow(task.id, { mode: task.mode, safeMode: config.safeMode, cleanupPending: task.cleanupPending === true })],
    allowedMentions: { parse: [] }
  });
}

async function recordTaskWorktreeEvidence(
  taskId: string,
  worktree: TaskWorktree,
  completed = true,
  notes: readonly string[] = []
): Promise<void> {
  const inspection = await inspectTaskWorktree(worktree);
  if (!inspection.available) {
    await taskStore.setEvidence(taskId, {
      verification: [...notes, `Isolated branch created, but evidence collection failed: ${inspection.message}`]
    });
    return;
  }

  const changedFiles = [...new Set(inspection.changes.map((change) => change.path))];
  const verification = [
    ...notes,
    `Work isolated on branch ${worktree.branch}.`,
    inspection.diff.truncated
      ? "Git diff inspection exceeded 100 KB; only changed-file status was retained."
      : "Inspected staged and unstaged Git diff without storing patch contents.",
    "No configured validation command was run automatically."
  ];
  if (completed && changedFiles.length > 0) {
    verification.push("Changes were left uncommitted on the isolated branch for human review.");
  } else if (changedFiles.length === 0) {
    verification.push("The action completed without file changes.");
  } else {
    verification.push("Partial changes were preserved without an automatic commit because the task did not complete.");
  }
  await taskStore.setEvidence(taskId, {
    changedFiles,
    diffStat: `${changedFiles.length} changed ${changedFiles.length === 1 ? "file" : "files"}`,
    verification
  });
}

async function reportTaskProgress(options: ProjectRequestOptions, progress: TaskProgressEvent): Promise<void> {
  if (!options.onProgress) {
    return;
  }
  try {
    await options.onProgress(progress);
  } catch (error) {
    console.warn(`Unable to update Discord task progress for ${progress.taskId}: ${publicErrorMessage(error)}`);
  }
}

interface InteractionRequestOptions extends Omit<ProjectRequestOptions, "onProgress"> {
  interaction: ChatInputCommandInteraction | ModalSubmitInteraction | ButtonInteraction;
  ephemeral?: boolean;
}

async function executeInteractionRequest(options: InteractionRequestOptions): Promise<void> {
  const { interaction, ephemeral, ...requestOptions } = options;
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : undefined);
  }
  let progressRendered = false;
  try {
    const result = await runProjectRequest({
      ...requestOptions,
      onProgress: async (progress) => {
        await interaction.editReply({
          content: formatTaskProgress(progress),
          components: [taskControlRow(progress.taskId, { status: taskStatusForProgress(progress), mode: progress.mode })]
        });
        if (!progressRendered) {
          progressRendered = true;
          try {
            const reply = await interaction.fetchReply();
            if (!reply.flags.has(MessageFlags.Ephemeral)) {
              await rememberTaskMessage(progress.taskId, reply.channelId, reply.id);
            }
          } catch (error) {
            console.warn(`Unable to resolve the task message for ${progress.taskId}: ${publicErrorMessage(error)}`);
          }
        }
      }
    });
    const chunks = splitDiscordMessage(
      [result.answer, result.visualProofNote, formatResultFooter(requestOptions.project, result.route, requestOptions.mode)]
        .filter((part) => part !== undefined)
        .join("\n\n")
    );
    await interaction.editReply({
      content: chunks.shift() ?? "Task completed without a response.",
      components: [taskControlRow(result.taskId, { status: "succeeded", mode: requestOptions.mode })]
    });
    for (const chunk of chunks) {
      await interaction.followUp({
        content: chunk,
        ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {})
      });
    }
  } catch (error) {
    if (!progressRendered) {
      throw error;
    }
    console.error(publicErrorMessage(error));
  }
}

interface MessageRequestOptions extends Omit<ProjectRequestOptions, "onProgress"> {
  message: Message;
  pending: Message;
}

async function executeMessageRequest(options: MessageRequestOptions): Promise<void> {
  const { message, pending, ...requestOptions } = options;
  let progressRendered = false;
  try {
    const result = await runProjectRequest({
      ...requestOptions,
      onProgress: async (progress) => {
        await pending.edit({
          content: formatTaskProgress(progress),
          components: [taskControlRow(progress.taskId, { status: taskStatusForProgress(progress), mode: progress.mode })]
        });
        if (!progressRendered) {
          progressRendered = true;
          await rememberTaskMessage(progress.taskId, pending.channelId, pending.id);
        }
      }
    });
    const chunks = splitDiscordMessage(
      [result.answer, result.visualProofNote, formatResultFooter(requestOptions.project, result.route, requestOptions.mode)]
        .filter((part) => part !== undefined)
        .join("\n\n")
    );
    await pending.edit({
      content: chunks.shift() ?? "Task completed without a response.",
      components: [taskControlRow(result.taskId, { status: "succeeded", mode: requestOptions.mode })]
    });
    for (const chunk of chunks) {
      await message.reply(chunk);
    }
  } catch (error) {
    if (!progressRendered) {
      throw error;
    }
    console.error(publicErrorMessage(error));
  }
}

async function handleScreenshotMention(
  message: OmitPartialGroupDMChannel<Message>,
  appConfig: AppConfig,
  project: ProjectEntry,
  attachments: ImageAttachmentInput[]
): Promise<void> {
  await message.channel.sendTyping();
  try {
    await withTempImageDir(async (dir) => {
      const imagePaths: string[] = [];
      for (const [index, attachment] of attachments.entries()) {
        imagePaths.push(await downloadImageAttachment(attachment, dir, index));
      }

      const transcriptionRaw = await transcribeErrorImages({
        codex: appConfig.codex,
        imagePaths,
        cwd: project.root
      });
      const transcription = parseTranscription(transcriptionRaw);
      if (!transcription.found) {
        await message.reply(formatNoErrorFoundReply(redactSensitiveText(transcription.text), attachments.length));
        return;
      }

      const context = await contextService.pack(project, transcription.text, [], appConfig.scanner.maxPackedContextChars);
      const locateRaw = await locateErrorInProject({
        codex: appConfig.codex,
        context,
        transcription: transcription.text
      });
      const located = parseLocateResponse(locateRaw);
      const analysis = {
        transcription: redactSensitiveText(transcription.text),
        location: redactSensitiveText(located.location),
        approach: redactSensitiveText(located.approach)
      };

      const record = await screenshotFixStore.create({
        projectName: project.name,
        requesterId: message.author.id,
        ...analysis
      });

      await message.reply({
        content: formatScreenshotAnalysisReply(analysis, attachments.length),
        components: [screenshotFixControlRow(record.id)]
      });
    });
  } catch (error) {
    console.error(publicErrorMessage(error));
    await message.reply(`Error analyzing the attached image: ${publicErrorMessage(error)}`);
  }
}

function taskStatusForProgress(progress: TaskProgressEvent): TaskStatus {
  return progress.phase === "failed" ? "failed" : progress.phase === "canceled" ? "canceled" : "running";
}

interface AmbientProposalRequest {
  appConfig: AppConfig;
  project: ProjectEntry;
  text: string;
  includePatterns: string[];
  requester: string;
  requesterId: string;
  channelId: string;
  channel: unknown;
  source: string;
  parentTaskId?: string;
}

async function createAmbientProposalFromMessage(
  input: Omit<AmbientProposalRequest, "requester" | "requesterId" | "channelId" | "channel"> & { message: Message }
): Promise<void> {
  const result = await createAmbientProposal({
    ...input,
    requester: input.message.author.tag,
    requesterId: input.message.author.id,
    channelId: input.message.channelId,
    channel: input.message.channel
  });
  if (result.threadId && result.threadId !== input.message.channelId) {
    await input.message.reply({
      content: `I opened a private workroom for this proposal: <#${result.threadId}>.`,
      allowedMentions: { parse: [] }
    });
  }
}

async function createAmbientProposal(input: AmbientProposalRequest): Promise<TaskRecord> {
  await userPreferences.setSelectedProject(input.requesterId, input.project.name);
  const task = await taskStore.propose({
    source: input.source,
    mode: "action",
    projectName: input.project.name,
    requester: input.requester,
    requesterId: input.requesterId,
    accessScope: "workroom",
    channelId: input.channelId,
    text: input.text,
    includePatterns: input.includePatterns,
    agentRoles: ["builder", "reviewer", "verifier"],
    ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {})
  });
  const currentThread = input.parentTaskId && input.channelId
    ? await taskStore.findByThread(input.channelId)
    : undefined;
  const thread = currentThread
    ? input.channel
    : await createAmbientTaskThread(input.channel, task, input.project, input.appConfig, input.requesterId);
  if (!thread && hasProjectAudienceRestriction(input.project)) {
    await taskStore.deny(task.id, "Devbot privacy guard");
    throw new Error("Devbot could not create a private task thread, so the scoped project proposal was not published.");
  }
  const target = thread ?? input.channel;
  let sent: { id?: string } | undefined;
  try {
    sent = (await sendToTextChannel(target, proposalCardForTask(task))) as { id?: string } | undefined;
  } catch (error) {
    await taskStore.deny(task.id, "Devbot delivery guard");
    if (thread && !currentThread) {
      await (thread as { delete?: (reason?: string) => Promise<unknown> }).delete?.("Unable to publish the Devbot proposal").catch(() => undefined);
    }
    throw error;
  }
  const threadId = (thread as { id?: string } | undefined)?.id;
  await taskStore.setDiscordContext(task.id, {
    ...(threadId ? { threadId } : {}),
    ...(sent?.id ? { controlMessageId: sent.id } : {})
  });
  return (await taskStore.get(task.id)) ?? task;
}

async function createAmbientTaskThread(
  channel: unknown,
  task: TaskRecord,
  project: ProjectEntry,
  appConfig: AppConfig,
  requesterId: string
): Promise<unknown | undefined> {
  const source = channel as {
    type?: ChannelType;
    parent?: unknown;
    threads?: {
      create?: (options: {
        name: string;
        type: ChannelType.PrivateThread;
        invitable: false;
        autoArchiveDuration: ThreadAutoArchiveDuration;
        reason: string;
      }) => Promise<{
        id: string;
        members?: { add?: (id: string) => Promise<unknown> };
        delete?: (reason?: string) => Promise<unknown>;
      }>;
    };
  };
  const parent = source.type === ChannelType.PrivateThread ? source.parent : source;
  const threaded = parent as typeof source;
  if (!threaded?.threads?.create) return undefined;

  let thread: {
    id: string;
    members?: { add?: (id: string) => Promise<unknown> };
    delete?: (reason?: string) => Promise<unknown>;
  } | undefined;
  try {
    const audience = await resolveAmbientThreadAudience(parent, project, appConfig, requesterId);
    if (audience.controllerIds.size === 0) {
      throw new Error("No project-authorized controller is available for this workroom.");
    }
    thread = await threaded.threads.create({
      name: ambientThreadName(task, project),
      type: ChannelType.PrivateThread,
      invitable: false,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      reason: `Private Devbot task workroom requested by ${task.requester}`
    });
    if (!thread.members?.add) throw new Error("Private thread membership is unavailable.");
    await thread.members.add(requesterId);
    let controllerAdded = audience.controllerIds.has(requesterId);
    for (const controllerId of audience.controllerIds) {
      if (controllerId === requesterId) continue;
      try {
        await thread.members.add(controllerId);
        controllerAdded = true;
      } catch (error) {
        console.warn(`Unable to add controller ${controllerId} to task workroom ${thread.id}: ${publicErrorMessage(error)}`);
      }
    }
    if (!controllerAdded) {
      throw new Error("No project-authorized controller could be added to the private workroom.");
    }
    const threadId = thread.id;
    for (const memberId of audience.memberIds) {
      if (memberId === requesterId || audience.controllerIds.has(memberId)) continue;
      await thread.members.add(memberId).catch((error) => {
        console.warn(`Unable to add ${memberId} to task workroom ${threadId}: ${publicErrorMessage(error)}`);
      });
    }
    return thread;
  } catch (error) {
    await thread?.delete?.("Unable to establish the required private workroom audience").catch(() => undefined);
    console.warn(`Unable to create a private task thread for ${task.id}: ${publicErrorMessage(error)}`);
    return undefined;
  }
}

async function resolveAmbientThreadAudience(
  channel: unknown,
  project: ProjectEntry,
  appConfig: AppConfig,
  requesterId: string
): Promise<{ memberIds: Set<string>; controllerIds: Set<string> }> {
  const guild = (channel as GuildTextBasedChannel | undefined)?.guild;
  if (!guild) {
    throw new Error("A server guild is required to resolve private workroom membership.");
  }
  const guildMembers = await guild.members.fetch();
  const memberIds = new Set<string>([requesterId]);
  const controllerIds = new Set<string>();
  for (const member of guildMembers.values()) {
    if (member.user.bot || !isAllowedGuildMember(member, appConfig) || !isAllowedGuildMemberForProject(member, project)) {
      continue;
    }
    memberIds.add(member.id);
    if (isControllerUser(member.id, appConfig)) controllerIds.add(member.id);
  }
  for (const botId of appConfig.peerBotIds) {
    if (isPeerAllowedForProject(project, botId)) memberIds.add(botId);
  }
  return { memberIds, controllerIds };
}

function isAllowedGuildMember(member: GuildMember, appConfig: AppConfig): boolean {
  return isAccessSubjectAllowed(
    {
      userId: member.id,
      nameSource: {
        username: member.user.username,
        globalName: member.user.globalName,
        tag: member.user.tag,
        displayName: member.displayName
      },
      roleIds: [...member.roles.cache.keys()]
    },
    appConfig
  );
}

function isAllowedGuildMemberForProject(member: GuildMember, project: ProjectEntry): boolean {
  const policy = project.metadata.policy;
  const hasAllowList = policy.allowedUsers.length > 0 || policy.allowedUsernames.length > 0 || policy.allowedRoles.length > 0;
  if (!hasAllowList) return true;
  return policy.allowedUsers.includes(member.id)
    || isApprovedDiscordUsername({
      username: member.user.username,
      globalName: member.user.globalName,
      tag: member.user.tag,
      displayName: member.displayName
    }, policy.allowedUsernames)
    || member.roles.cache.some((role) => policy.allowedRoles.includes(role.id));
}

function ambientThreadName(task: TaskRecord, project: ProjectEntry): string {
  const summary = task.text.replace(/[`*_~|>#[\]\n\r]/g, " ").replace(/\s+/g, " ").trim().slice(0, 62);
  const suffix = task.id.split("-").at(-1) ?? task.id;
  return `${project.name} | ${summary || "task"} | ${suffix}`.slice(0, 100);
}

function proposalCardForTask(task: TaskRecord) {
  const intent = classifyNaturalIntent(task.text);
  return confirmToActProposalCard({
    proposalId: proposalEntityId(task.id, task.proposalRevision ?? 1),
    project: task.projectName,
    title: intent.summary.replace(/^Proposed action:\s*/i, "") || "Proposed project change",
    proposal: task.text,
    rationale: `Devbot read this as a ${intent.risk}-risk project change. Nothing will be edited until a controller approves it.`,
    scope: task.includePatterns.length ? task.includePatterns : ["Selected project only", "Dedicated task branch"],
    requestedBy: task.requester,
    selectedRoles: ambientRolesForTask(task),
    disabled: task.status !== "awaiting-approval"
  });
}

async function handleAmbientContextMenu(
  interaction: MessageContextMenuCommandInteraction,
  appConfig: AppConfig
): Promise<void> {
  const project = (await projectForConfiguredRoom(interaction.channelId, appConfig))
    ?? preferredProjectForInteraction(appConfig, interaction);
  if (!project || !isAllowedForProject(interaction, project)) {
    await interaction.reply({ content: "No configured project is available to you in this room.", flags: MessageFlags.Ephemeral });
    return;
  }
  const text = interaction.targetMessage.content.trim();
  if (!text) {
    await interaction.reply({ content: "That message has no text to turn into a workroom proposal.", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const parentTask = await taskStore.findByThread(interaction.channelId);
  const task = await createAmbientProposal({
    appConfig,
    project,
    text,
    includePatterns: [],
    requester: interaction.user.tag,
    requesterId: interaction.user.id,
    channelId: interaction.channelId,
    channel: interaction.channel,
    source: "context-menu",
    ...(parentTask ? { parentTaskId: parentTask.id } : {})
  });
  await userPreferences.setSelectedProject(interaction.user.id, project.name);
  await interaction.editReply(
    task.threadId ? `Private workroom ready: <#${task.threadId}>.` : `Proposal \`${task.id}\` is ready in this room.`
  );
}

async function handleAmbientButton(
  interaction: ButtonInteraction,
  appConfig: AppConfig,
  action: AmbientAction,
  entityId: string
): Promise<void> {
  if (action === "inbox-refresh") {
    await interaction.deferUpdate();
    await interaction.editReply(await needsMePayload(interaction, appConfig));
    return;
  }
  const proposalReference = parseProposalEntityId(entityId);
  const task = await taskStore.get(proposalReference?.taskId ?? entityId);
  if (!task) {
    await interaction.reply({ content: "That task is no longer available.", flags: MessageFlags.Ephemeral });
    return;
  }
  const project = findProject(appConfig.projects, task.projectName);
  if (!project || !canAccessTask(interaction, task, appConfig)) {
    await interaction.reply({ content: "That task's project is unavailable to you.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (action.startsWith("proposal-") && proposalReference?.revision !== task.proposalRevision) {
    await interaction.reply({
      content: "This proposal changed after these controls were rendered. Reopen the latest proposal before deciding.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (action === "proposal-edit") {
    if (!canManageProposal(interaction.user.id, task, appConfig)) {
      await interaction.reply({ content: "Only the requester or a controller can edit this proposal.", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.showModal(proposalEditModal(entityId, task.text));
    return;
  }
  if (action === "proposal-decline") {
    if (!canManageProposal(interaction.user.id, task, appConfig)) {
      await interaction.reply({ content: "Only the requester or a controller can decline this proposal.", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferUpdate();
    const denied = await taskStore.deny(task.id, interaction.user.tag, proposalReference?.revision);
    if (!denied) {
      await interaction.followUp({ content: `This proposal is already ${task.status}.`, flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.editReply(proofFirstCompletionCard({
      taskId: task.id,
      project: task.projectName,
      title: "Proposal declined",
      summary: `No project work was started. Declined by ${interaction.user.tag}.`,
      proof: [{ label: "Safety boundary", detail: "The proposal was closed before Codex received write access.", status: "info" }],
      showProofButton: false
    }));
    return;
  }
  if (action === "proposal-confirm") {
    if (!isControllerUser(interaction.user.id, appConfig)) {
      await interaction.reply({ content: "Only the owner or an approved controller can approve write-capable work.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (isWriteBlockedBySafeMode(appConfig, "action")) {
      await interaction.reply({ content: safeModeActionMessage("this proposal"), flags: MessageFlags.Ephemeral });
      return;
    }
    await executeApprovedAmbientTask(interaction, appConfig, task, project, "action", proposalReference?.revision);
    return;
  }
  if (action === "proposal-readonly") {
    if (!canManageProposal(interaction.user.id, task, appConfig)) {
      await interaction.reply({ content: "Only the requester or a controller can choose how this proposal proceeds.", flags: MessageFlags.Ephemeral });
      return;
    }
    await executeApprovedAmbientTask(interaction, appConfig, task, project, "answer", proposalReference?.revision);
    return;
  }
  if (action === "progress-cancel") {
    if (!isControllerUser(interaction.user.id, appConfig)) {
      await interaction.reply({ content: "Only the owner or an approved controller can cancel work.", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const canceled = await taskStore.cancel(task.id, `Canceled by ${interaction.user.tag}.`);
    activeTaskControllers.get(task.id)?.abort();
    await interaction.editReply(
      canceled?.status === "canceled" ? "Task canceled. Its isolated workspace was preserved." : `This task is already ${canceled?.status ?? "unavailable"}.`
    );
    return;
  }
  if (action === "completion-proof") {
    await interaction.reply({ content: formatTaskDetail(task), flags: MessageFlags.Ephemeral });
    return;
  }
  if (action === "completion-reviewed") {
    if (!taskNeedsUser(task, interaction.user.id, appConfig)) {
      await interaction.reply({ content: "Only the requester or a controller can close this review item.", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await taskStore.markReviewed(task.id);
    await interaction.editReply("Marked reviewed and removed from Needs Me.");
    return;
  }
  if (action === "inbox-open") {
    await interaction.reply({
      content: [task.threadId ? `Workroom: <#${task.threadId}>` : undefined, formatTaskDetail(task)].filter(Boolean).join("\n\n"),
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] }
    });
  }
}

async function handleAmbientTeamSelect(
  interaction: StringSelectMenuInteraction,
  appConfig: AppConfig,
  entityId: string
): Promise<void> {
  const proposalReference = parseProposalEntityId(entityId);
  const task = await taskStore.get(proposalReference?.taskId ?? entityId);
  const roles = parseAmbientRoleSelection(interaction.values);
  if (!task || !roles || task.status !== "awaiting-approval" || proposalReference?.revision !== task.proposalRevision) {
    await interaction.reply({ content: "That proposal or team selection is no longer available.", flags: MessageFlags.Ephemeral });
    return;
  }
  const project = findProject(appConfig.projects, task.projectName);
  if (!project || !canAccessTask(interaction, task, appConfig) || !canManageProposal(interaction.user.id, task, appConfig)) {
    await interaction.reply({ content: "You cannot change this proposal's team.", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferUpdate();
  const updated = await taskStore.updateProposal(task.id, {
    agentRoles: roles,
    ...(proposalReference ? { expectedRevision: proposalReference.revision } : {})
  });
  if (!updated) {
    await interaction.followUp({ content: "That proposal changed before the team update was saved.", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.editReply(proposalCardForTask(updated));
}

async function handleAmbientProposalEdit(
  interaction: ModalSubmitInteraction,
  appConfig: AppConfig,
  entityId: string
): Promise<void> {
  const proposalReference = parseProposalEntityId(entityId);
  const task = await taskStore.get(proposalReference?.taskId ?? entityId);
  if (
    !task
    || task.status !== "awaiting-approval"
    || proposalReference?.revision !== task.proposalRevision
    || !canManageProposal(interaction.user.id, task, appConfig)
  ) {
    await interaction.reply({ content: "That proposal can no longer be edited.", flags: MessageFlags.Ephemeral });
    return;
  }
  const project = findProject(appConfig.projects, task.projectName);
  if (!project || !canAccessTask(interaction, task, appConfig)) {
    await interaction.reply({ content: "That task's project is unavailable to you.", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferUpdate();
  const updated = await taskStore.updateProposal(task.id, {
    text: interaction.fields.getTextInputValue("request").trim(),
    ...(proposalReference ? { expectedRevision: proposalReference.revision } : {})
  });
  if (!updated) {
    await interaction.followUp({ content: "That proposal changed before the edit was saved.", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.editReply(proposalCardForTask(updated));
}

async function executeApprovedAmbientTask(
  interaction: ButtonInteraction,
  appConfig: AppConfig,
  task: TaskRecord,
  project: ProjectEntry,
  mode: CodexRequestMode,
  expectedRevision: number | undefined
): Promise<void> {
  await interaction.deferUpdate();
  const started = await taskStore.begin(task.id, {
    mode,
    actor: interaction.user.tag,
    ...(expectedRevision !== undefined ? { expectedRevision } : {})
  });
  if (!started) {
    await interaction.followUp({
      content: "This proposal changed or was already handled. Review the latest revision before trying again.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }
  await interaction.editReply(progressCard({
    taskId: task.id,
    project: project.name,
    title: task.text,
    phase: mode === "action" ? "Assembling workroom" : "Reading project",
    detail: mode === "action"
      ? `${ambientRolesForTask(started).map(agentRole).join(", ") || "Devbot"} ${ambientRolesForTask(started).length === 1 ? "is" : "are"} preparing a shared brief.`
      : "Devbot is keeping this request read-only.",
    roles: mode === "action" ? ambientRolesForTask(started) : [],
    percent: 5,
    canCancel: mode === "action"
  }));

  const workroomController = new AbortController();
  activeTaskControllers.set(started.id, workroomController);
  try {
    const preflight = mode === "action"
      ? await runAgentWorkroomPreflight(started, project, appConfig, workroomController.signal)
      : [];
    const current = await taskStore.get(started.id);
    if (workroomController.signal.aborted || current?.status !== "running") {
      throw new Error(current?.error ?? "Canceled by user request.");
    }
    const executionText = preflight.length ? ambientExecutionPrompt(started.text, preflight) : started.text;
    const result = await runProjectRequest({
      appConfig,
      project,
      text: executionText,
      displayText: started.text,
      includePatterns: started.includePatterns,
      mode,
      requester: started.requester,
      ...(started.requesterId ? { requesterId: started.requesterId } : {}),
      ...(started.channelId ? { channelId: started.channelId } : {}),
      ...(started.threadId ? { threadId: started.threadId } : {}),
      source: `ambient:${started.source}`,
      existingTaskId: started.id,
      agentRoles: ambientRolesForTask(started),
      signal: workroomController.signal,
      onProgress: async (progress) => {
        await interaction.editReply(progressCardForEvent(progress, started));
      }
    });
    const completed = (await taskStore.get(started.id)) ?? started;
    await interaction.editReply(completionCardForTask(completed, result.answer, result.route));
  } catch (error) {
    const failed = (await taskStore.get(started.id)) ?? started;
    const canceled = failed.status === "canceled";
    await interaction.editReply(progressCard({
      taskId: failed.id,
      project: failed.projectName,
      title: failed.text,
      phase: canceled ? "Canceled" : "Needs attention",
      detail: canceled
        ? "The task was canceled. Its isolated workspace and any partial evidence were preserved."
        : "The task stopped before completion. Its branch and any partial evidence were preserved.",
      ...(!canceled ? { blocker: error instanceof Error ? error.message : String(error) } : {}),
      roles: ambientRolesForTask(failed),
      percent: 100,
      canCancel: false
    }));
  } finally {
    if (activeTaskControllers.get(started.id) === workroomController) {
      activeTaskControllers.delete(started.id);
    }
  }
}

async function runAgentWorkroomPreflight(
  task: TaskRecord,
  project: ProjectEntry,
  appConfig: AppConfig,
  signal: AbortSignal
): Promise<Array<{ role: AmbientRole; answer: string }>> {
  const roles = ambientRolesForTask(task);
  const results = await Promise.allSettled(
    roles.map(async (role) => {
      const result = await runProjectRequest({
        appConfig,
        project,
        text: buildAgentPrompt(task.text, agentRole(role)),
        includePatterns: task.includePatterns,
        mode: "answer",
        requester: `${task.requester} (${role})`,
        ...(task.requesterId ? { requesterId: task.requesterId } : {}),
        accessScope: "workroom",
        internal: true,
        source: `workroom:agent:${role}`,
        parentTaskId: task.id,
        signal
      });
      return { role, answer: result.answer };
    })
  );
  return results.flatMap((result, index) => {
    if (result.status === "fulfilled") return [result.value];
    const role = roles[index];
    return role ? [{ role, answer: `This seat was unavailable: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}` }] : [];
  });
}

function ambientExecutionPrompt(request: string, contributions: Array<{ role: AmbientRole; answer: string }>): string {
  return [
    "Implement the approved developer request below.",
    "Use the workroom contributions as advisory context, verify their claims against the repository, and keep the final scope focused.",
    "",
    "Approved request:",
    request,
    "",
    "Workroom contributions:",
    ...contributions.map(({ role, answer }) => `\n[${role.toUpperCase()}]\n${answer.slice(0, 4_000)}`)
  ].join("\n");
}

function progressCardForEvent(progress: TaskProgressEvent, task: TaskRecord) {
  const details: Record<TaskProgressEvent["phase"], { phase: string; detail: string; percent: number }> = {
    routing: { phase: "Choosing an approach", detail: "Selecting Luna, Terra, or Sol and the right amount of project context.", percent: 15 },
    "gathering-context": { phase: "Reading the project", detail: "Gathering the repository context needed for this task.", percent: 35 },
    "running-codex": { phase: "Working", detail: "The approved task is running in its dedicated workspace.", percent: 60 },
    failed: { phase: "Needs attention", detail: "The task failed before completion.", percent: 100 },
    canceled: { phase: "Canceled", detail: "The task was canceled before completion.", percent: 100 }
  };
  const current = details[progress.phase];
  return progressCard({
    taskId: progress.taskId,
    project: progress.projectName,
    title: task.text,
    phase: current.phase,
    detail: current.detail,
    ...(progress.error ? { blocker: progress.error } : {}),
    roles: ambientRolesForTask(task),
    percent: current.percent,
    canCancel: progress.phase !== "failed" && progress.phase !== "canceled"
  });
}

function completionCardForTask(task: TaskRecord, answer: string, route: RequestRoute) {
  const proof = [
    ...(task.verification ?? []).map((detail) => ({
      label: proofStatusForEvidence(detail) === "failed" ? "Attention" : "Recorded evidence",
      detail,
      status: proofStatusForEvidence(detail)
    })),
    ...(task.captureNote ? [{ label: "Visual proof", detail: task.captureNote, status: "info" as const }] : []),
    { label: "Model route", detail: formatRoute(route), status: "info" as const }
  ];
  return proofFirstCompletionCard({
    taskId: task.id,
    project: task.projectName,
    title: task.text,
    summary: answer,
    proof,
    ...(task.changedFiles ? { changedFiles: task.changedFiles } : {}),
    roles: ambientRolesForTask(task),
    showProofButton: true
  });
}

function proofStatusForEvidence(detail: string): "passed" | "failed" | "info" {
  if (/\b(unavailable|failed|uncommitted|partial changes)\b/i.test(detail)) return "failed";
  if (/^No\b|\bnot run\b/i.test(detail)) return "info";
  return "passed";
}

async function handleNeedsMeCommand(interaction: ChatInputCommandInteraction, appConfig: AppConfig): Promise<void> {
  const projectName = interaction.options.getString("project") ?? undefined;
  if (projectName) {
    const project = mustFindProject(appConfig.projects, projectName);
    if (!isAllowedForProject(interaction, project)) {
      await interaction.reply({ content: `You are not allowed to use project \`${project.name}\`.`, flags: MessageFlags.Ephemeral });
      return;
    }
  }
  const payload = await needsMePayload(interaction, appConfig, projectName, interaction.options.getInteger("limit") ?? 10);
  await interaction.reply({
    ...payload,
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2
  });
}

async function needsMePayload(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  appConfig: AppConfig,
  projectName?: string,
  limit = 10
) {
  const allowedProjects = new Set(
    appConfig.projects.filter((project) => isAllowedForProject(interaction, project)).map((project) => project.name)
  );
  const tasks = (await taskStore.listNeedsAttention({ limit: Math.max(limit, 25), ...(projectName ? { projectName } : {}) }))
    .filter((task) => allowedProjects.has(task.projectName) && taskNeedsUser(task, interaction.user.id, appConfig))
    .slice(0, limit);
  return needsMeInbox({
    inboxId: `inbox-${interaction.user.id}`,
    items: tasks.map((task) => ({
      id: task.id,
      project: task.projectName,
      title: task.text,
      reason: task.attention === "approval"
        ? "Approve, edit, keep read-only, or decline this proposed action."
        : task.attention === "blocked"
          ? task.error ?? "This task is blocked and needs a decision."
          : "Review the saved proof and choose the next step.",
      urgency: task.attention === "blocked" ? "high" as const : "normal" as const
    }))
  });
}

function canManageProposal(userId: string, task: TaskRecord, appConfig: AppConfig): boolean {
  return task.requesterId === userId || isControllerUser(userId, appConfig);
}

function taskNeedsUser(task: TaskRecord, userId: string, appConfig: AppConfig): boolean {
  return isControllerUser(userId, appConfig) || task.requesterId === userId;
}

function ambientRolesForTask(task: TaskRecord): AmbientRole[] {
  return (task.agentRoles ?? []).filter(
    (role): role is AmbientRole => role === "builder" || role === "reviewer" || role === "verifier"
  );
}

function agentRole(role: AmbientRole): AgentRole {
  return role === "builder" ? "Builder" : role === "reviewer" ? "Reviewer" : "Verifier";
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
  requestText = "",
  actor = "requester"
): Promise<BotResponse> {
  let content = await getWorkStatusMessage(appConfig, requestedProject);

  if (wantsImage) {
    const project = requestedProject ?? defaultProject(appConfig.projects);
    const screenshotPolicy = screenshotPolicyMessage(project, actor);
    if (screenshotPolicy) {
      return { content: `${content}\n\n${screenshotPolicy}` };
    }
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
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
    await interaction.editReply(
      formatTaskList(tasks.filter((task) => !task.internal && allowedProjectNames.has(task.projectName) && canAccessTask(interaction, task, appConfig)))
    );
    return;
  }

  if (subcommand === "show" || subcommand === "status") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const id = interaction.options.getString("id", true);
    const saved = await taskStore.get(id);
    if (!saved || !allowedProjectNames.has(saved.projectName) || !canAccessTask(interaction, saved, appConfig)) {
      await interaction.editReply(`No accessible saved task found for \`${id}\`.`);
      return;
    }
    const { task, freshness } = await refreshTaskBranchState(saved, findProject(appConfig.projects, saved.projectName));
    await interaction.editReply(
      freshness
        ? [formatTaskDetail(task), "", `Branch freshness: ${freshness.available ? describeBranchFreshness(freshness) : freshness.message}`].join("\n")
        : formatTaskDetail(task)
    );
    return;
  }

  if (subcommand === "freshness") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const project = mustFindProject(appConfig.projects, interaction.options.getString("project", true));
    if (!allowedProjectNames.has(project.name)) {
      await interaction.editReply(`You are not allowed to use project \`${project.name}\`.`);
      return;
    }
    const limit = interaction.options.getInteger("limit") ?? 10;
    const candidates = (await taskStore.listRecent({ projectName: project.name, limit: 25 }))
      .filter((task) => !task.internal && canAccessTask(interaction, task, appConfig))
      .filter((task) => task.workspaceIsolated && task.branchName)
      .slice(0, limit);
    if (candidates.length === 0) {
      await interaction.editReply(`No saved tasks with isolated branches found for \`${project.name}\`.`);
      return;
    }
    const defaultBranch = project.metadata.defaultBranch ?? "main";
    const lines: string[] = [];
    for (const candidate of candidates) {
      const { freshness } = await refreshTaskBranchState(candidate, project);
      const summary = !freshness ? "no branch evidence" : freshness.available ? describeBranchFreshness(freshness) : freshness.message;
      lines.push(`- \`${candidate.id}\` \`${candidate.branchName}\`: ${summary}`);
    }
    await editInteractionWithChunks(
      interaction,
      { content: [`Branch freshness for \`${project.name}\` against \`${defaultBranch}\`:`, ...lines].join("\n") },
      true
    );
    return;
  }

  if (subcommand === "sync") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const id = interaction.options.getString("task", true);
    const task = await taskStore.get(id);
    if (!task || !allowedProjectNames.has(task.projectName) || !canAccessTask(interaction, task, appConfig)) {
      await interaction.editReply(`No accessible saved task found for \`${id}\`.`);
      return;
    }
    const project = mustFindProject(appConfig.projects, task.projectName);
    const refusal = taskSyncRefusal(task, {
      userId: interaction.user.id,
      projectAllowed: allowedProjectNames.has(task.projectName),
      controller: isControllerUser(interaction.user.id, appConfig),
      safeMode: appConfig.safeMode
    });
    if (refusal) {
      await interaction.editReply(taskSyncRefusalMessage(refusal));
      return;
    }
    const { workspacePath, branchName, baseBranch } = task;
    if (!workspacePath || !branchName || !baseBranch) {
      await interaction.editReply(taskSyncRefusalMessage("no-isolated-branch"));
      return;
    }
    const actionKey = `${task.id}:sync`;
    if (activeTaskActions.has(actionKey)) {
      await interaction.editReply("That task action is already running.");
      return;
    }
    activeTaskActions.add(actionKey);
    try {
      const result = await syncTaskBranch({
        worktree: { sourcePath: project.root, path: workspacePath, branch: branchName, baseRevision: baseBranch },
        defaultBranch: project.metadata.defaultBranch ?? "main",
        taskId: task.id
      });
      await concludeTaskSync(interaction, appConfig, project, task, workspacePath, result);
    } finally {
      activeTaskActions.delete(actionKey);
    }
    return;
  }

  if (subcommand === "logs") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const id = interaction.options.getString("id", true);
    const task = await taskStore.get(id);
    await interaction.editReply(
      task && allowedProjectNames.has(task.projectName) && canAccessTask(interaction, task, appConfig)
        ? formatTaskLogs(task)
        : `No accessible saved task found for \`${id}\`.`
    );
    return;
  }

  if (subcommand === "cancel") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const id = interaction.options.getString("id", true);
    const existing = await taskStore.get(id);
    if (!existing || !allowedProjectNames.has(existing.projectName) || !canAccessTask(interaction, existing, appConfig)) {
      await interaction.editReply(`No accessible saved task found for \`${id}\`.`);
      return;
    }
    activeTaskControllers.get(id)?.abort();
    const task = await taskStore.cancel(id, `Canceled by ${interaction.user.tag}.`);
    await interaction.editReply(task ? `Task \`${id}\` is now ${task.status}.` : `No saved task found for \`${id}\`.`);
    return;
  }

  if (subcommand === "retry") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const id = interaction.options.getString("id", true);
    const task = await taskStore.get(id);
    if (!task) {
      await interaction.editReply(`No saved task found for \`${id}\`.`);
      return;
    }
    if (!allowedProjectNames.has(task.projectName) || !canAccessTask(interaction, task, appConfig)) {
      await interaction.editReply(`No accessible saved task found for \`${id}\`.`);
      return;
    }
    if (!taskActionMatchesState("retry", task)) {
      await interaction.editReply(`Task \`${id}\` is ${task.status}; only failed, canceled, or interrupted tasks can be retried.`);
      return;
    }

    if (await executionLedger.hasUnresolvedWorker(task.id)) {
      // Derived from the durable ledger so a dismissal or other status change
      // cannot wash the gate away between restarts.
      await interaction.editReply(RETRY_CLEANUP_BLOCKED_MESSAGE);
      return;
    }

    if (isWriteBlockedBySafeMode(appConfig, task.mode === "action" ? "action" : "answer")) {
      await interaction.editReply(safeModeActionMessage("/task retry"));
      return;
    }

    const project = mustFindProject(appConfig.projects, task.projectName);
    await executeInteractionRequest({
      interaction,
      appConfig,
      project,
      text: task.text,
      includePatterns: task.includePatterns,
      mode: task.mode === "action" ? "action" : "answer",
      requester: interaction.user.tag,
      requesterId: task.requesterId ?? interaction.user.id,
      ...(task.accessScope ? { accessScope: task.accessScope } : {}),
      ...(resumeWorkspaceForRetry(task) ?? {}),
      source: `retry:${task.id}`,
      parentTaskId: task.id,
      dedupeKey: `task-retry:${task.id}`,
      ephemeral: true
    });
    return;
  }

  if (subcommand === "preview") {
    await handleTaskPreviewCommand(interaction, appConfig);
    return;
  }

  if (subcommand === "stale") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
      (task) => !task.internal && allowedProjectNames.has(task.projectName) && canAccessTask(interaction, task, appConfig) && new Date(task.startedAt).getTime() < cutoff
    );
    await interaction.editReply(stale.length ? formatTaskList(stale) : `No running tasks older than ${minutes}m.`);
  }
}

async function refreshTaskBranchState(
  task: TaskRecord,
  project: ProjectEntry | undefined
): Promise<{ task: TaskRecord; freshness: BranchFreshnessResult | undefined }> {
  if (!project || !task.workspaceIsolated || !task.branchName) {
    return { task, freshness: undefined };
  }
  const freshness = await inspectBranchFreshness({
    repositoryPath: project.root,
    branch: task.branchName,
    defaultBranch: project.metadata.defaultBranch ?? "main"
  });
  if (freshness.available && freshness.merged !== Boolean(task.branchMerged)) {
    const updated = await taskStore.setBranchSync(task.id, { merged: freshness.merged });
    return { task: updated ?? task, freshness };
  }
  return { task, freshness };
}

function taskSyncRefusalMessage(refusal: TaskSyncRefusal): string {
  if (refusal === "safe-mode") return safeModeActionMessage("/task sync");
  if (refusal === "task-active") return "This task is still open; wait for it to finish or cancel it before syncing its branch.";
  if (refusal === "requester-or-controller") return "Only the task requester, the owner, or an approved controller can sync a task branch.";
  if (refusal === "no-isolated-branch") return "This task has no isolated branch and worktree to sync.";
  return "No accessible saved task found.";
}

async function concludeTaskSync(
  interaction: ChatInputCommandInteraction,
  appConfig: AppConfig,
  project: ProjectEntry,
  task: TaskRecord,
  workspacePath: string,
  result: SyncTaskBranchResult
): Promise<void> {
  if (result.outcome === "blocked") {
    await interaction.editReply(`Sync for \`${task.id}\` did not run: ${result.message}`);
    return;
  }

  if (result.outcome === "already-merged") {
    await taskStore.setBranchSync(task.id, { merged: true });
    await interaction.editReply(
      `Branch \`${result.freshness.branch}\` is already fully merged into \`${result.freshness.defaultBranch}\`; nothing to sync. The isolated worktree is eligible for pruning.`
    );
    return;
  }

  if (result.outcome === "up-to-date") {
    await interaction.editReply(
      `Branch \`${result.freshness.branch}\` is already up to date with \`${result.freshness.defaultBranch}\`${result.freshness.ahead > 0 ? ` and ahead by ${result.freshness.ahead}` : ""}; nothing to sync.`
    );
    return;
  }

  if (result.outcome === "conflict") {
    const more = result.conflictedFileCount - result.conflictedFiles.length;
    await appendTaskSyncEvidence(task.id, [
      `Sync onto ${result.defaultBranch} aborted on ${result.conflictedFileCount} conflicted ${result.conflictedFileCount === 1 ? "file" : "files"}; branch ${result.restored ? "restored to" : "preserved at"} ${shortSha(result.previousTip)} via ${result.backupRef}.`
    ]);
    await editInteractionWithChunks(
      interaction,
      {
        content: [
          `Sync for \`${task.id}\` stopped: ${result.message}`,
          "",
          "Conflicted files:",
          ...result.conflictedFiles.map((file) => `- \`${file}\``),
          ...(more > 0 ? [`- and ${more} more`] : [])
        ].join("\n")
      },
      true
    );
    return;
  }

  await taskStore.setBranchSync(task.id, { baseBranch: result.defaultTip });
  await appendTaskSyncEvidence(task.id, [
    `Branch ${result.branch} rebased onto ${result.defaultBranch} at ${shortSha(result.defaultTip)}; ${result.replayedCommits} ${result.replayedCommits === 1 ? "commit" : "commits"} replayed.`,
    `Pre-sync tip ${shortSha(result.previousTip)} preserved at ${result.backupRef}.`
  ]);
  const lines = [
    `Synced \`${result.branch}\` onto \`${result.defaultBranch}\` at \`${shortSha(result.defaultTip)}\` in the isolated worktree.`,
    `Replayed ${result.replayedCommits} ${result.replayedCommits === 1 ? "commit" : "commits"}; new tip \`${shortSha(result.newTip)}\`.`,
    `The pre-sync tip \`${shortSha(result.previousTip)}\` is preserved at \`${result.backupRef}\`.`
  ];

  if (configuredCommandNames(project).length === 0) {
    await interaction.editReply(lines.join("\n"));
    return;
  }
  if (!isControllerUser(interaction.user.id, appConfig)) {
    lines.push("Configured validation was not run automatically; ask the owner or a controller to run `/review validate` for this task.");
    await interaction.editReply(lines.join("\n"));
    return;
  }
  try {
    const results = await validateReview({ ...project, root: workspacePath });
    await appendTaskSyncEvidence(task.id, [
      `Post-sync validation ${results.every((item) => item.ok) ? "passed" : "failed"}: ${results.map((item) => item.kind).join(", ")}.`
    ]);
    await editInteractionWithChunks(interaction, { content: [...lines, "", formatValidationResults(project, results)].join("\n") }, true);
  } catch (error) {
    await appendTaskSyncEvidence(task.id, [`Post-sync validation could not run: ${publicErrorMessage(error)}`]);
    await editInteractionWithChunks(interaction, { content: [...lines, "", `Post-sync validation could not run: ${publicErrorMessage(error)}`].join("\n") }, true);
  }
}

async function appendTaskSyncEvidence(taskId: string, lines: string[]): Promise<void> {
  const current = await taskStore.get(taskId);
  await taskStore.setEvidence(taskId, { verification: [...(current?.verification ?? []), ...lines].slice(-12) });
}

function shortSha(value: string): string {
  return value.slice(0, 10);
}

async function handleTaskPreviewCommand(interaction: ChatInputCommandInteraction, appConfig: AppConfig): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const taskId = interaction.options.getString("task", true);
  const action = (interaction.options.getString("action") ?? "start") as PreviewControlAction;
  const task = await taskStore.get(taskId);
  if (!task || !canAccessTask(interaction, task, appConfig)) {
    await interaction.editReply(`No accessible saved task found for \`${taskId}\`.`);
    return;
  }
  const project = findProject(appConfig.projects, task.projectName);
  if (!project) {
    await interaction.editReply(`The project for task \`${task.id}\` is no longer configured.`);
    return;
  }
  const authorization = authorizeTaskPreview(action, task, previewAccessContext(interaction, project, appConfig));
  if (!authorization.allowed) {
    await interaction.editReply(authorization.message);
    return;
  }

  if (action === "status") {
    const instances = previewManager.list(task.id);
    await interaction.editReply(
      instances.length
        ? instances.map(formatPreviewInstance).join("\n\n")
        : `No preview has been started for task \`${task.id}\` since Devbot last started.`
    );
    return;
  }

  if (action === "stop") {
    const open = latestOpenPreview(task.id);
    if (!open) {
      await interaction.editReply(`No running preview was found for task \`${task.id}\`.`);
      return;
    }
    const stopped = await previewManager.stop(open.id, "requested");
    await interaction.editReply(stopped.instance ? formatPreviewInstance(stopped.instance) : stopped.ok ? "Preview stopped." : stopped.message);
    return;
  }

  if (!task.workspaceIsolated || !task.workspacePath || !task.branchName || !task.baseBranch) {
    await interaction.editReply(`Task \`${task.id}\` has no recorded isolated workspace, so there is nothing to preview.`);
    return;
  }
  const inspection = await inspectTaskWorktree(
    { sourcePath: project.root, path: task.workspacePath, branch: task.branchName, baseRevision: task.baseBranch },
    0
  );
  if (!inspection.available) {
    await interaction.editReply(`Cannot preview task \`${task.id}\`: ${inspection.message}`);
    return;
  }
  const resolved = await resolvePreviewCommand(project, task.workspacePath);
  if (!resolved.ok) {
    await interaction.editReply(resolved.message);
    return;
  }
  const result = await previewManager.start({
    taskId: task.id,
    projectName: project.name,
    branch: task.branchName,
    workspacePath: task.workspacePath,
    command: resolved.command
  });
  if (!result.ok) {
    await interaction.editReply(result.instance ? `${result.message}\n\n${formatPreviewInstance(result.instance)}` : result.message);
    return;
  }
  const publishNote = await publishPreviewCard(task, project, result.instance);
  await interaction.editReply({
    content: [formatPreviewInstance(result.instance), publishNote].filter(Boolean).join("\n\n"),
    components: [previewControlRow(result.instance.id)]
  });
}

async function handlePreviewControlButton(
  interaction: ButtonInteraction,
  appConfig: AppConfig,
  action: PreviewButtonAction,
  previewId: string
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const instance = previewManager.status(previewId);
  if (!instance) {
    await interaction.editReply("That preview control has expired.");
    return;
  }
  const task = await taskStore.get(instance.taskId);
  const project = task ? findProject(appConfig.projects, task.projectName) : undefined;
  if (!task || !project || !canAccessTask(interaction, task, appConfig)) {
    await interaction.editReply("That preview's task is unavailable to you.");
    return;
  }
  const authorization = authorizeTaskPreview(action, task, previewAccessContext(interaction, project, appConfig));
  if (!authorization.allowed) {
    await interaction.editReply(authorization.message);
    return;
  }
  if (action === "status") {
    await interaction.editReply(formatPreviewInstance(instance));
    return;
  }
  const stopped = await previewManager.stop(previewId, "requested");
  await interaction.editReply(stopped.instance ? formatPreviewInstance(stopped.instance) : stopped.ok ? "Preview stopped." : stopped.message);
}

function previewAccessContext(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  project: ProjectEntry,
  appConfig: AppConfig
): { userId: string; controller: boolean; projectAllowed: boolean; safeMode: boolean } {
  return {
    userId: interaction.user.id,
    controller: isControllerUser(interaction.user.id, appConfig),
    projectAllowed: isAllowedForProject(interaction, project),
    safeMode: appConfig.safeMode
  };
}

function latestOpenPreview(taskId: string): PreviewInstance | undefined {
  return previewManager
    .list(taskId)
    .filter((instance) => instance.state === "pending" || instance.state === "active" || instance.state === "stopping")
    .at(-1);
}

async function publishPreviewCard(task: TaskRecord, project: ProjectEntry, instance: PreviewInstance): Promise<string | undefined> {
  const channelId = task.threadId ?? setupStore.snapshot().projectRoomIds[project.name];
  if (!channelId) {
    return "No task workroom or bound project room exists, so the preview details stay in this private reply.";
  }
  try {
    const channel = await client.channels.fetch(channelId);
    await sendToTextChannel(channel, {
      content: formatPreviewInstance(instance),
      components: [previewControlRow(instance.id)],
      allowedMentions: { parse: [] }
    });
    return `Preview details were posted to <#${channelId}>.`;
  } catch (error) {
    return `The preview is running, but its card could not be posted to <#${channelId}>: ${publicErrorMessage(error)}. Use the controls in this reply.`;
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
  if (!project || !canAccessTask(interaction, task, appConfig)) {
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
  const canControl = isControllerUser(interaction.user.id, appConfig);
  const canRecover = canControl || (Boolean(task.requesterId) && task.requesterId === interaction.user.id);

  if (action === "actions") {
    const rows = taskActionRows(task, {
      canControl,
      safeMode: appConfig.safeMode,
      hasChecks: configuredCommandNames(project).length > 0,
      canRecover
    });
    const safeModeBlocksRecovery =
      appConfig.safeMode && mode === "action" && (task.status === "failed" || task.status === "canceled" || task.status === "interrupted");
    await interaction.reply({
      content: [
        `**${project.name} task actions**`,
        `Status: ${task.status} | ${mode === "action" ? "write-capable" : "read-only"}`,
        `Request: \`${inlineDiscordCode(truncateForLog(task.text))}\``,
        "",
        safeModeBlocksRecovery
          ? "Safe mode is on, so write-capable recovery is unavailable until it is disabled locally and Devbot restarts."
          : rows.length > 0
            ? "Choose an available action."
            : "No additional actions are available for your access level and this task state."
      ].join("\n"),
      components: rows,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (action === "retry" && (await executionLedger.hasUnresolvedWorker(task.id))) {
    // Gate derived from the durable execution ledger, not the task's mutable
    // status: a dismissed (now canceled) task still refuses retry while its
    // ledger record holds an unresolved worker, and a restart re-derives it.
    await interaction.reply({
      content: RETRY_CLEANUP_BLOCKED_MESSAGE,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (!taskActionMatchesState(action, task)) {
    await interaction.reply({
      content: `That action is not available while this task is ${task.status}. Open Actions to see the current choices.`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (action === "followup" || action === "promote" || action === "adjust") {
    if ((action === "promote" || (action === "adjust" && mode === "action")) && !canControl) {
      await interaction.reply({
        content: "Only the owner or an approved controller can start write-capable work.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    const requestedMode: CodexRequestMode = action === "promote" ? "action" : action === "adjust" ? mode : "answer";
    if (isWriteBlockedBySafeMode(appConfig, requestedMode)) {
      await interaction.reply({ content: safeModeActionMessage("this task action"), flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.showModal(taskRequestModal(action, task));
    return;
  }

  if (action === "review") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const packet = await createReviewPacket(await projectForTaskWorkspace(project, task), task);
    await editButtonReplyWithChunks(interaction, formatReviewPacket(packet));
    return;
  }

  if (action === "ship") {
    if (!canControl) {
      await interaction.reply({ content: "Only the owner or an approved controller can compose a ship card.", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const shipBuild = await buildShipCard(project, task);
    await interaction.editReply({
      content: shipCardCaption(project, task, shipBuild),
      files: [new AttachmentBuilder(shipBuild.card, { name: `devbot-ship-${task.id}.png` })]
    });
    return;
  }

  if (action === "cancel") {
    if (!canControl) {
      await interaction.reply({ content: "Only the owner or an approved controller can cancel work.", flags: MessageFlags.Ephemeral });
      return;
    }
    activeTaskControllers.get(task.id)?.abort();
    const canceled = await taskStore.cancel(task.id, `Canceled by ${interaction.user.tag}.`);
    await interaction.reply({
      content: canceled?.status === "canceled" ? "Task canceled." : `This task is already ${canceled?.status ?? "unavailable"}.`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (action === "validate") {
    if (!canControl) {
      await interaction.reply({ content: "Only the owner or an approved controller can run project checks.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (appConfig.safeMode) {
      await interaction.reply({ content: safeModeActionMessage("project checks"), flags: MessageFlags.Ephemeral });
      return;
    }
    if (configuredCommandNames(project).length === 0) {
      await interaction.reply({ content: "No project checks are configured yet.", flags: MessageFlags.Ephemeral });
      return;
    }
    await runTaskActionOnce(interaction, `${task.id}:validate`, async () => {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const reviewProject = await projectForTaskWorkspace(project, task);
      const results = await validateReview(reviewProject);
      await editButtonReplyWithChunks(interaction, formatValidationResults(project, results));
    });
    return;
  }

  if (action === "dismiss") {
    if (!canRecover) {
      await interaction.reply({
        content: "Only the requester or an approved controller can dismiss interrupted work.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    const dismissed = await taskStore.dismiss(task.id, interaction.user.tag);
    if (dismissed) {
      await refreshDismissedNotice(dismissed);
    }
    await interaction.reply({
      content: dismissed
        ? "Interrupted task dismissed. Its preserved workspace remains available for review until normal cleanup."
        : `This task is already ${(await taskStore.get(task.id))?.status ?? "unavailable"}.`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (action !== "retry") {
    return;
  }
  const retryRefusal = taskRetryRefusal({
    interrupted: task.status === "interrupted",
    writeCapable: mode === "action",
    globalAllowed: isAllowed(interaction, appConfig),
    projectAllowed: isAllowedForProject(interaction, project),
    controller: canControl,
    requester: Boolean(task.requesterId) && task.requesterId === interaction.user.id
  });
  if (retryRefusal) {
    await interaction.reply({ content: taskRetryRefusalMessage(retryRefusal), flags: MessageFlags.Ephemeral });
    return;
  }
  if (isWriteBlockedBySafeMode(appConfig, mode)) {
    await interaction.reply({ content: safeModeActionMessage("this retry"), flags: MessageFlags.Ephemeral });
    return;
  }

  await runTaskActionOnce(interaction, `${task.id}:retry`, async () => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await executeInteractionRequest({
      interaction,
      appConfig,
      project,
      text: task.text,
      includePatterns: task.includePatterns,
      mode,
      requester: interaction.user.tag,
      requesterId: task.requesterId ?? interaction.user.id,
      ...(task.accessScope ? { accessScope: task.accessScope } : {}),
      ...(resumeWorkspaceForRetry(task) ?? {}),
      source: `button:retry:${task.id}`,
      ephemeral: true,
      parentTaskId: task.id,
      dedupeKey: `task-retry:${task.id}`
    });
  });
}

async function handleScreenshotFixControl(
  interaction: ButtonInteraction,
  appConfig: AppConfig,
  action: ScreenshotFixAction,
  id: string
): Promise<void> {
  const record = await screenshotFixStore.get(id);
  if (!record) {
    await interaction.reply({ content: "That screenshot analysis is no longer available.", flags: MessageFlags.Ephemeral });
    return;
  }
  const project = findProject(appConfig.projects, record.projectName);
  if (!project || !isAllowedForProject(interaction, project)) {
    await interaction.reply({ content: "That analysis's project is unavailable to you.", flags: MessageFlags.Ephemeral });
    return;
  }

  const actor: ScreenshotFixActionContext = {
    userId: interaction.user.id,
    controller: isControllerUser(interaction.user.id, appConfig)
  };

  if (action === "dismiss") {
    if (!canActOnScreenshotFix("dismiss", record, actor)) {
      await interaction.reply({
        content: "Only the person who reported this screenshot, or an approved controller, can dismiss it.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    await screenshotFixStore.remove(id);
    await interaction.update({ content: "Dismissed.", components: [] });
    return;
  }

  if (!canActOnScreenshotFix("fix", record, actor)) {
    await interaction.reply({
      content: "You have view access, but only the owner or an approved controller can start write-capable work.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }
  if (isWriteBlockedBySafeMode(appConfig, "action")) {
    await interaction.reply({ content: safeModeActionMessage("Fix it"), flags: MessageFlags.Ephemeral });
    return;
  }

  await runTaskActionOnce(interaction, `snap-fix:${id}`, async () => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await executeInteractionRequest({
      interaction,
      appConfig,
      project,
      text: buildFixTaskPrompt(record),
      includePatterns: [],
      mode: "action",
      requester: interaction.user.tag,
      source: `button:snap-fix:${id}`,
      ephemeral: true,
      dedupeKey: `snap-fix:${id}`,
      onTaskStarted: async () => {
        await screenshotFixStore.remove(id);
      }
    });
  });
}

function taskRetryRefusalMessage(refusal: TaskRetryRefusal): string {
  switch (refusal) {
    case "not-allowed":
      return "You are not allowed to use this bot.";
    case "not-project":
      return "That task's project is unavailable to you.";
    case "needs-controller":
      return "Only the owner or an approved controller can retry write-capable work.";
    case "needs-requester-or-controller":
      return "Only the requester or an approved controller can retry work that a restart interrupted.";
  }
}

function resumeWorkspaceForRetry(task: TaskRecord): Pick<ProjectRequestOptions, "resumeWorkspace"> | undefined {
  if (task.status !== "interrupted" || task.mode !== "action" || !task.workspaceIsolated || task.cleanupPending) {
    return undefined;
  }
  if (!task.workspacePath || !task.branchName || !task.baseBranch) {
    return undefined;
  }
  return {
    resumeWorkspace: {
      workspacePath: task.workspacePath,
      branchName: task.branchName,
      baseBranch: task.baseBranch
    }
  };
}

async function refreshDismissedNotice(task: TaskRecord): Promise<void> {
  try {
    const message = await fetchOwnTaskMessage(task);
    if (!message) {
      return;
    }
    await message.edit({
      content: [
        `**${task.projectName} task dismissed**`,
        task.error ?? "The interrupted task was dismissed.",
        task.branchName ? `Branch \`${task.branchName}\` remains preserved for review.` : undefined
      ].filter((line) => line !== undefined).join("\n"),
      components: [],
      allowedMentions: { parse: [] }
    });
  } catch (error) {
    console.warn(`Unable to update the dismissed task notice for ${task.id}: ${publicErrorMessage(error)}`);
  }
}

async function runTaskActionOnce(interaction: ButtonInteraction, key: string, run: () => Promise<void>): Promise<void> {
  if (activeTaskActions.has(key)) {
    await interaction.reply({ content: "That task action is already running.", flags: MessageFlags.Ephemeral });
    return;
  }
  activeTaskActions.add(key);
  try {
    await run();
  } finally {
    activeTaskActions.delete(key);
  }
}

async function handleTaskModal(
  interaction: ModalSubmitInteraction,
  appConfig: AppConfig,
  action: TaskModalAction,
  taskId: string
): Promise<void> {
  const task = await taskStore.get(taskId);
  if (!task) {
    await interaction.reply({ content: "That saved task is no longer available.", flags: MessageFlags.Ephemeral });
    return;
  }
  const project = findProject(appConfig.projects, task.projectName);
  if (!project || !canAccessTask(interaction, task, appConfig)) {
    await interaction.reply({ content: "That task's project is unavailable to you.", flags: MessageFlags.Ephemeral });
    return;
  }
  const originalMode: CodexRequestMode = task.mode === "action" ? "action" : "answer";
  if (!taskActionMatchesState(action, task)) {
    await interaction.reply({
      content: `That action is no longer available because this task is ${task.status}.`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }
  const mode: CodexRequestMode = action === "promote" ? "action" : action === "adjust" ? originalMode : "answer";
  if (mode === "action" && !isControllerUser(interaction.user.id, appConfig)) {
    await interaction.reply({
      content: "Only the owner or an approved controller can start write-capable work.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }
  if (isWriteBlockedBySafeMode(appConfig, mode)) {
    await interaction.reply({ content: safeModeActionMessage("this task action"), flags: MessageFlags.Ephemeral });
    return;
  }

  const request = interaction.fields.getTextInputValue("request").trim();
  await userPreferences.setSelectedProject(interaction.user.id, project.name);
  await executeInteractionRequest({
    interaction,
    appConfig,
    project,
    text: continuationPrompt(action, task, request),
    includePatterns: action === "adjust" ? task.includePatterns : [],
    mode,
    requester: interaction.user.tag,
    requesterId: task.requesterId ?? interaction.user.id,
    ...(task.accessScope ? { accessScope: task.accessScope } : {}),
    source: `task:${action}:${task.id}`,
    parentTaskId: task.id,
    ...(mode === "action" ? { dedupeKey: `task-${action}:${task.id}` } : {}),
    ephemeral: hasProjectAudienceRestriction(project)
  });
}

async function handleWorkspaceButton(
  interaction: ButtonInteraction,
  appConfig: AppConfig,
  action: WorkspaceAction,
  projectName?: string
): Promise<void> {
  if (action === "open") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const project = preferredProjectForInteraction(appConfig, interaction);
    if (!project) {
      await interaction.editReply("No configured project is available to you.");
      return;
    }
    await userPreferences.setSelectedProject(interaction.user.id, project.name);
    await interaction.editReply(await buildWorkspacePanel(interaction, appConfig, project));
    return;
  }

  const project = projectName ? findProject(appConfig.projects, projectName) : undefined;
  if (!project || !isAllowedForProject(interaction, project)) {
    await interaction.reply({ content: "That project is unavailable to you.", flags: MessageFlags.Ephemeral });
    return;
  }
  await userPreferences.setSelectedProject(interaction.user.id, project.name);

  if (action === "ask" || action === "act") {
    if (action === "act" && !isControllerUser(interaction.user.id, appConfig)) {
      await interaction.reply({
        content: "You have view access, but only the owner or an approved controller can make project changes.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    if (action === "act" && appConfig.safeMode) {
      await interaction.reply({ content: safeModeActionMessage("workspace changes"), flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.showModal(workspaceRequestModal(action, project.name));
    return;
  }

  if (action === "refresh") {
    await interaction.deferUpdate();
    await interaction.editReply(await buildWorkspacePanel(interaction, appConfig, project));
    return;
  }

  if (action === "inbox") {
    const payload = await needsMePayload(interaction, appConfig, project.name);
    await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (action === "status") {
    const status = await getStatusSnapshotResponse(scopeStatusToProject(appConfig, project), false, project);
    await editButtonReplyWithChunks(interaction, status.content);
    return;
  }
  if (action === "recent") {
    const tasks = (await taskStore.listRecent({ projectName: project.name, limit: 10 }))
      .filter((task) => !task.internal && canAccessTask(interaction, task, appConfig));
    await editButtonReplyWithChunks(interaction, formatTaskList(tasks));
  }
}

async function handleWorkspaceProjectSelect(
  interaction: StringSelectMenuInteraction,
  appConfig: AppConfig
): Promise<void> {
  const projectName = interaction.values[0];
  const project = projectName ? findProject(appConfig.projects, projectName) : undefined;
  if (!project || !isAllowedForProject(interaction, project)) {
    await interaction.reply({ content: "That project is unavailable to you.", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferUpdate();
  await userPreferences.setSelectedProject(interaction.user.id, project.name);
  await interaction.editReply(await buildWorkspacePanel(interaction, appConfig, project));
}

async function handleWorkspaceModal(
  interaction: ModalSubmitInteraction,
  appConfig: AppConfig,
  action: WorkspaceModalAction,
  projectName: string
): Promise<void> {
  const project = findProject(appConfig.projects, projectName);
  if (!project || !isAllowedForProject(interaction, project)) {
    await interaction.reply({ content: "That project is unavailable to you.", flags: MessageFlags.Ephemeral });
    return;
  }
  const mode: CodexRequestMode = action === "act" ? "action" : "answer";
  if (mode === "action" && !isControllerUser(interaction.user.id, appConfig)) {
    await interaction.reply({
      content: "You have view access, but only the owner or an approved controller can make project changes.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }
  if (isWriteBlockedBySafeMode(appConfig, mode)) {
    await interaction.reply({ content: safeModeActionMessage("workspace changes"), flags: MessageFlags.Ephemeral });
    return;
  }
  await userPreferences.setSelectedProject(interaction.user.id, project.name);
  await executeInteractionRequest({
    interaction,
    appConfig,
    project,
    text: interaction.fields.getTextInputValue("request").trim(),
    includePatterns: [],
    mode,
    requester: interaction.user.tag,
    source: `workspace:${action}`,
    ephemeral: hasProjectAudienceRestriction(project)
  });
}

async function buildWorkspacePanel(
  interaction: ButtonInteraction | StringSelectMenuInteraction | ChatInputCommandInteraction,
  appConfig: AppConfig,
  project: ProjectEntry
) {
  const projects = appConfig.projects.filter((entry) => isAllowedForProject(interaction, entry));
  const status = await getWorkStatusMessage(scopeStatusToProject(appConfig, project), project);
  const recentTasks = (await taskStore.listRecent({ projectName: project.name, limit: 25 }))
    .filter((task) => !task.internal && canAccessTask(interaction, task, appConfig));
  const needsAttentionCount = (await taskStore.listNeedsAttention({ projectName: project.name, limit: 25 }))
    .filter((task) => taskNeedsUser(task, interaction.user.id, appConfig)).length;
  return workspacePanelView({
    projects,
    selectedProject: project,
    canControl: isControllerUser(interaction.user.id, appConfig),
    safeMode: appConfig.safeMode,
    status,
    recentTasks,
    needsAttentionCount
  });
}

async function handleDashboardCommand(interaction: ChatInputCommandInteraction, appConfig: AppConfig): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const projectName = interaction.options.getString("project") ?? undefined;
  const project = projectName
    ? mustFindProject(appConfig.projects, projectName)
    : preferredProjectForInteraction(appConfig, interaction);
  if (!project) {
    await interaction.editReply("No configured project is available to you.");
    return;
  }
  if (!isAllowedForProject(interaction, project)) {
    await interaction.editReply(`You are not allowed to use project \`${project.name}\`.`);
    return;
  }
  await userPreferences.setSelectedProject(interaction.user.id, project.name);
  await interaction.editReply(await buildWorkspacePanel(interaction, appConfig, project));
}

async function handleRunCommand(interaction: ChatInputCommandInteraction, appConfig: AppConfig): Promise<void> {
  const project = selectedProject(appConfig.projects, interaction.options.getString("project"));
  const privateReply = hasProjectAudienceRestriction(project);
  await interaction.deferReply(privateReply ? { flags: MessageFlags.Ephemeral } : undefined);
  if (appConfig.safeMode) {
    await interaction.editReply("Safe mode is on, so configured project command runs are disabled.");
    return;
  }

  if (!(await ensureProjectAccess(interaction, project))) {
    return;
  }
  const command = interaction.options.getString("command", true);
  const result = await runConfiguredProjectCommand(project, command);
  await editInteractionWithChunks(interaction, { content: formatProjectCommandResult(result) }, privateReply);
}

async function handleReviewCommand(interaction: ChatInputCommandInteraction, appConfig: AppConfig): Promise<void> {
  const subcommand = interaction.options.getSubcommand();
  const project = mustFindProject(appConfig.projects, interaction.options.getString("project", true));
  const privateReply = hasProjectAudienceRestriction(project);
  if (!(await ensureProjectAccess(interaction, project))) {
    return;
  }

  if (subcommand === "packet") {
    await interaction.deferReply(privateReply ? { flags: MessageFlags.Ephemeral } : undefined);
    const taskId = interaction.options.getString("task") ?? undefined;
    const task = taskId ? await taskStore.get(taskId) : undefined;
    if (task && (task.projectName !== project.name || !canAccessTask(interaction, task, appConfig))) {
      await interaction.editReply(`No accessible saved task found for \`${task.id}\`.`);
      return;
    }
    const packet = await createReviewPacket(await projectForTaskWorkspace(project, task), task);
    await editInteractionWithChunks(interaction, { content: formatReviewPacket(packet) }, privateReply);
    return;
  }

  if (appConfig.safeMode) {
    await interaction.reply({ content: "Safe mode is on, so review validation commands are disabled.", flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply(privateReply ? { flags: MessageFlags.Ephemeral } : undefined);
  const commandNames = parseCommandNames(interaction.options.getString("commands"));
  if (subcommand === "validate") {
    const results = await validateReview(project, commandNames);
    await editInteractionWithChunks(interaction, { content: formatValidationResults(project, results) }, privateReply);
    return;
  }

  if (subcommand === "gates") {
    const result = await evaluateMergeGates(project, commandNames);
    await editInteractionWithChunks(interaction, { content: formatMergeGateResult(project, result) }, privateReply);
  }
}

async function handleShipCommand(interaction: ChatInputCommandInteraction, appConfig: AppConfig): Promise<void> {
  const taskId = interaction.options.getString("task", true);
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
  if (task.status !== "succeeded") {
    await interaction.reply({
      content: `Task \`${task.id}\` is ${task.status}, not completed. \`/ship\` needs a succeeded task.`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const privateReply = hasProjectAudienceRestriction(project);
  await interaction.deferReply(privateReply ? { flags: MessageFlags.Ephemeral } : undefined);
  const shipBuild = await buildShipCard(project, task);
  await interaction.editReply({
    content: shipCardCaption(project, task, shipBuild),
    files: [new AttachmentBuilder(shipBuild.card, { name: `devbot-ship-${task.id}.png` })]
  });
}

interface ShipCardBuild {
  card: Buffer;
  hasScreenshot: boolean;
  isolatedBranch?: string;
}

async function buildShipCard(project: ProjectEntry, task: TaskRecord): Promise<ShipCardBuild> {
  const source = await resolveShipImage(task, project);
  const image = source && !source.isolated ? source.image : undefined;
  const card = await composeShipCard({
    projectName: project.name,
    summary: task.text,
    ...(image ? { image } : {})
  });
  return {
    card,
    hasScreenshot: Boolean(image),
    ...(source?.isolated ? { isolatedBranch: source.branch ?? "unknown" } : {})
  };
}

function shipCardCaption(project: ProjectEntry, task: TaskRecord, build: ShipCardBuild): string {
  const header = `Ship card for \`${project.name}\` task \`${task.id}\`.`;
  if (build.isolatedBranch) {
    return `${header} Visual proof unavailable for isolated branch \`${build.isolatedBranch}\`: Devbot has no managed preview of that isolated workspace, so no screenshot was attempted. The card is text-only; review the branch directly.`;
  }
  return build.hasScreenshot
    ? `${header} Attach and post anywhere.`
    : `${header} No screenshot was available for this task, so the card is text-only.`;
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
          console.warn(`Unable to update council progress for ${conversation.id}: ${publicErrorMessage(error)}`);
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
            summary: `Local council seat failed: ${publicErrorMessage(error, 240)}`,
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
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
    const stale = running.filter(
      (task) => !task.internal && canAccessTask(interaction, task, appConfig) && new Date(task.startedAt).getTime() < cutoff
    );
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
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const project = mustFindProject(appConfig.projects, interaction.options.getString("project", true));
    if (!(await ensureProjectAccess(interaction, project))) {
      return;
    }
    const target = interaction.options.getString("target", true);
    const taskId = interaction.options.getString("task") ?? undefined;
    const task = taskId ? await taskStore.get(taskId) : undefined;
    if (task && (task.projectName !== project.name || !canAccessTask(interaction, task, appConfig))) {
      await interaction.editReply(`No accessible saved task found for \`${task.id}\`.`);
      return;
    }
    const packet = await createReviewPacket(await projectForTaskWorkspace(project, task), task);
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
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const project = mustFindProject(appConfig.projects, interaction.options.getString("project", true));
    if (!(await ensureProjectAccess(interaction, project))) {
      return;
    }
    const taskId = interaction.options.getString("task") ?? undefined;
    const task = taskId ? await taskStore.get(taskId) : undefined;
    if (task && (task.projectName !== project.name || !canAccessTask(interaction, task, appConfig))) {
      await interaction.editReply(`No accessible saved task found for \`${task.id}\`.`);
      return;
    }
    const packet = await createReviewPacket(await projectForTaskWorkspace(project, task), task);
    const conversation = await startLabConversation(interaction, subcommand, project, "Boss Fight Review");
    const commandNames = parseCommandNames(interaction.options.getString("commands"));
    const commandApprovalRequired = commandsNeedApproval(project, commandNames);
    const reviewProject = await projectForTaskWorkspace(project, task);
    const gates = appConfig.safeMode || commandApprovalRequired
      ? undefined
      : await evaluateMergeGates(reviewProject, commandNames).then((result) => formatMergeGateResult(reviewProject, result));
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
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const project = mustFindProject(appConfig.projects, interaction.options.getString("project", true));
    if (!(await ensureProjectAccess(interaction, project))) {
      return;
    }
    const taskId = interaction.options.getString("task") ?? undefined;
    const task = taskId ? await taskStore.get(taskId) : undefined;
    if (task && (task.projectName !== project.name || !canAccessTask(interaction, task, appConfig))) {
      await interaction.editReply(`No accessible saved task found for \`${task.id}\`.`);
      return;
    }
    const packet = await createReviewPacket(await projectForTaskWorkspace(project, task), task);
    const recentTasks = (await taskStore.listRecent({ limit: 5, projectName: project.name }))
      .filter((item) => !item.internal && canAccessTask(interaction, item, appConfig));
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
      console.warn(`Unable to publish workroom panel in thread ${conversation.threadId}: ${publicErrorMessage(error)}`);
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
    console.warn(`Unable to refresh workroom panel ${conversation.controlMessageId}: ${publicErrorMessage(error)}`);
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
      console.warn(`Unable to send workroom update to ${channelId}: ${publicErrorMessage(error)}`);
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
      console.warn(`Unable to lock workroom thread ${conversation.threadId}: ${publicErrorMessage(error)}`);
    }
  } catch (error) {
    console.warn(`Unable to archive workroom thread ${conversation.threadId}: ${publicErrorMessage(error)}`);
  }
}

async function maybeHandlePeerMessage(message: Message, appConfig: AppConfig): Promise<void> {
  if (
    !client.user
    || !appConfig.peerBotIds.has(message.author.id)
    || !(await isAuthorizedPeerChannel(message, appConfig))
  ) {
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

  if (envelope.from !== message.author.id || !message.mentions.users.has(client.user.id)) {
    return;
  }

  if (!(await collabStore.claimDelivery(`legacy:${message.author.id}:${envelope.requestId}`))) {
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
    const status = await getStatusSnapshotResponse(scopeStatusToProject(appConfig, project), false, project, envelope.target ?? "");
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

async function isAuthorizedPeerChannel(message: Message, appConfig: AppConfig): Promise<boolean> {
  const coordinationChannelId = appConfig.coordinationChannelId ?? effectivePrivateRoomId();
  if (
    !coordinationChannelId
    || message.guildId !== appConfig.discordGuildId
    || message.channelId !== coordinationChannelId
  ) {
    return false;
  }
  return (await verifyPrivateRoom(coordinationChannelId)) === coordinationChannelId;
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
    const status = await getStatusSnapshotResponse(
      scopeStatusToProject(appConfig, project),
      false,
      project,
      String(envelope.payload.target ?? "")
    );
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
    if (task && (task.projectName !== project.name || task.accessScope === "workroom" || task.internal)) {
      await replyWithCollabResult(message, appConfig, envelope, false, `Task ${task.id} is not accessible for this peer request.`);
      return;
    }
    const packet = await createReviewPacket(await projectForTaskWorkspace(project, task), task);
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

async function editInteractionWithChunks(
  interaction: ChatInputCommandInteraction,
  response: BotResponse,
  ephemeral = false
): Promise<void> {
  const chunks = splitDiscordMessage(response.content);
  const files = attachmentFiles(response);
  const privateFollowUps = ephemeral || interaction.ephemeral === true;
  await interaction.editReply({ content: chunks[0] ?? "No status generated.", files });

  for (const chunk of chunks.slice(1)) {
    await interaction.followUp({ content: chunk, ...(privateFollowUps ? { flags: MessageFlags.Ephemeral } : {}) });
  }
}

async function followUpWithChunks(
  interaction: ChatInputCommandInteraction,
  response: BotResponse,
  ephemeral = false
): Promise<void> {
  const chunks = splitDiscordMessage(response.content);
  const files = attachmentFiles(response);
  const privateFollowUps = ephemeral || interaction.ephemeral === true;
  await interaction.followUp({
    content: chunks[0] ?? "No status generated.",
    files,
    ...(privateFollowUps ? { flags: MessageFlags.Ephemeral } : {})
  });

  for (const chunk of chunks.slice(1)) {
    await interaction.followUp({ content: chunk, ...(privateFollowUps ? { flags: MessageFlags.Ephemeral } : {}) });
  }
}

async function editButtonReplyWithChunks(interaction: ButtonInteraction, content: string): Promise<void> {
  const chunks = splitDiscordMessage(content);
  await interaction.editReply(chunks.shift() ?? "No result generated.");
  for (const chunk of chunks) {
    await interaction.followUp({ content: chunk, flags: MessageFlags.Ephemeral });
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
  _interaction: ChatInputCommandInteraction,
  appConfig: AppConfig,
  content: string,
  targetBotId?: string
): Promise<void> {
  const payload = {
    content,
    allowedMentions: targetBotId ? { parse: [] as const, users: [targetBotId] } : { parse: [] as const }
  };
  const coordinationChannelId = appConfig.coordinationChannelId ?? effectivePrivateRoomId();
  if (!coordinationChannelId || (await verifyPrivateRoom(coordinationChannelId)) !== coordinationChannelId) {
    throw new Error("Peer coordination requires a configured private text channel or private thread.");
  }
  const channel = await client.channels.fetch(coordinationChannelId);
  if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.PrivateThread)) {
    throw new Error(`Configured coordination channel ${coordinationChannelId} is not a private text room.`);
  }
  if (channel.guild.id !== appConfig.discordGuildId) {
    throw new Error("The peer coordination room must belong to the configured Discord server.");
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
    (!project || !hasProjectAudienceRestriction(project)) &&
    interaction.channelId === setupStore.snapshot().privateChannelId &&
    interaction.channel?.type === ChannelType.PrivateThread
      ? interaction.channel
      : undefined;
  const thread = sharedRoomThread ?? (await createLabThread(interaction, conversation.id, intent, title, project));
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
    console.warn(`Unable to initialize lab thread ${thread.id}: ${publicErrorMessage(error)}`);
    return conversation;
  }
  return (await collabStore.setThread(conversation.id, thread.id)) ?? withThread;
}

async function createLabThread(
  interaction: ChatInputCommandInteraction,
  conversationId: string,
  intent: CollabIntent,
  title: string,
  project: ProjectEntry | undefined
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
    const privateWorkroom = intent === "council" || Boolean(project);
    const thread = await threaded.threads.create({
      name: labThreadName(conversationId, intent, title),
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      ...(privateWorkroom ? { type: ChannelType.PrivateThread, invitable: false } : {}),
      reason: "Devbot collaboration lab session"
    });
    if (privateWorkroom) {
      try {
        if (!thread.members?.add) {
          throw new Error("Private thread membership API is unavailable.");
        }
        const memberIds = project
          ? (await resolveAmbientThreadAudience(interaction.channel, project, config, interaction.user.id)).memberIds
          : new Set([interaction.user.id, ...config.allowedUserIds]);
        for (const userId of memberIds) {
          await thread.members.add(userId).catch((error) => {
            console.warn(`Unable to add authorized viewer ${userId} to lab thread ${thread.id}: ${publicErrorMessage(error)}`);
          });
        }
      } catch (error) {
        await thread.delete?.("Unable to establish the authorized private lab audience").catch(() => undefined);
        throw error;
      }
    }
    return thread;
  } catch (error) {
    console.warn(`Unable to create lab thread for ${conversationId}: ${publicErrorMessage(error)}`);
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
  signal?: AbortSignal,
  onSpawn?: (pid: number) => void | Promise<void>,
  onExit?: () => void | Promise<void>
): Promise<string> {
  return answerWithProjectContext({
    codex: appConfig.codex,
    question: text,
    context,
    mode,
    ...(route.model ? { model: route.model } : {}),
    ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
    tier: route.tier,
    contextMode: route.contextMode,
    ...(signal ? { signal } : {}),
    ...(onSpawn ? { onSpawn } : {}),
    ...(onExit ? { onExit } : {})
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
    await interaction.respond(
      taskChoices(
        tasks.filter((task) => !task.internal && allowedProjectNames.has(task.projectName) && canAccessTask(interaction, task, appConfig)),
        value
      )
    );
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

async function projectForTaskWorkspace(project: ProjectEntry, task: TaskRecord | undefined): Promise<ProjectEntry> {
  if (!task?.workspaceIsolated || !task.workspacePath) return project;
  if (!task.branchName || !task.baseBranch) {
    throw new Error(`Task ${task.id} is missing isolated workspace identity evidence.`);
  }
  const inspection = await inspectTaskWorktree({
    sourcePath: project.root,
    path: task.workspacePath,
    branch: task.branchName,
    baseRevision: task.baseBranch
  }, 0);
  if (!inspection.available) {
    throw new Error(`Task ${task.id} workspace cannot be trusted: ${inspection.message}`);
  }
  return { ...project, root: task.workspacePath };
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

function selectedProjectForInteraction(
  appConfig: AppConfig,
  interaction: ChatInputCommandInteraction,
  requestedName: string | null
): ProjectEntry {
  if (requestedName) {
    return mustFindProject(appConfig.projects, requestedName);
  }
  const preferred = preferredProjectForInteraction(appConfig, interaction);
  if (!preferred) {
    throw new Error("No configured project is available to you.");
  }
  return preferred;
}

function preferredProjectForInteraction(
  appConfig: AppConfig,
  interaction:
    | ChatInputCommandInteraction
    | MessageContextMenuCommandInteraction
    | ButtonInteraction
    | StringSelectMenuInteraction
    | ModalSubmitInteraction
): ProjectEntry | undefined {
  const allowedProjects = appConfig.projects.filter((project) => isAllowedForProject(interaction, project));
  const roomProjectName = Object.entries(setupStore.snapshot().projectRoomIds).find(([, roomId]) => roomId === interaction.channelId)?.[0];
  if (roomProjectName) {
    return allowedProjects.find((project) => project.name === roomProjectName);
  }
  const preferredName = userPreferences.selectedProject(interaction.user.id);
  return allowedProjects.find((project) => project.name === preferredName) ?? defaultProjectIfAvailable(allowedProjects);
}

function projectsWithUserPreference(projects: ProjectEntry[], userId: string): ProjectEntry[] {
  const preferredName = userPreferences.selectedProject(userId);
  if (!preferredName || !projects.some((project) => project.name === preferredName)) {
    return projects;
  }
  return projects.map((project) => ({ ...project, isDefault: project.name === preferredName }));
}

function defaultProjectIfAvailable(projects: ProjectEntry[]): ProjectEntry | undefined {
  return projects.find((project) => project.isDefault) ?? projects[0];
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
  const compact = redactSensitiveText(value).replace(/\s+/g, " ").trim();
  return compact.length > 220 ? `${compact.slice(0, 217)}...` : compact;
}

function inlineDiscordCode(value: string): string {
  return value.replace(/`/g, "'").replace(/[\r\n]+/g, " ");
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

function isAllowed(
  interaction:
    | ChatInputCommandInteraction
    | MessageContextMenuCommandInteraction
    | ButtonInteraction
    | AutocompleteInteraction
    | StringSelectMenuInteraction
    | ModalSubmitInteraction,
  appConfig: AppConfig
): boolean {
  return isAccessSubjectAllowed(
    {
      userId: interaction.user.id,
      nameSource: interactionNameSource(interaction),
      roleIds: interactionRoleIds(interaction)
    },
    appConfig
  );
}

function interactionRoleIds(
  interaction:
    | ChatInputCommandInteraction
    | MessageContextMenuCommandInteraction
    | ButtonInteraction
    | AutocompleteInteraction
    | StringSelectMenuInteraction
    | ModalSubmitInteraction
): string[] {
  if (interaction.member instanceof GuildMember) {
    return [...interaction.member.roles.cache.keys()];
  }
  const memberRoles = interaction.member?.roles;
  return Array.isArray(memberRoles) ? memberRoles : [];
}

function isAllowedForProject(
  interaction:
    | ChatInputCommandInteraction
    | MessageContextMenuCommandInteraction
    | ButtonInteraction
    | AutocompleteInteraction
    | StringSelectMenuInteraction
    | ModalSubmitInteraction,
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

function hasProjectAudienceRestriction(project: ProjectEntry): boolean {
  const policy = project.metadata.policy;
  return policy.allowedUsers.length > 0 || policy.allowedUsernames.length > 0 || policy.allowedRoles.length > 0;
}

function canAccessTask(
  interaction:
    | ChatInputCommandInteraction
    | MessageContextMenuCommandInteraction
    | ButtonInteraction
    | AutocompleteInteraction
    | StringSelectMenuInteraction
    | ModalSubmitInteraction,
  task: TaskRecord,
  appConfig: AppConfig
): boolean {
  const project = findProject(appConfig.projects, task.projectName);
  return canAccessTaskRecord(task, {
    userId: interaction.user.id,
    projectAllowed: Boolean(project && isAllowedForProject(interaction, project)),
    controller: isControllerUser(interaction.user.id, appConfig)
  });
}

function isAllowedMessage(message: Message, appConfig: AppConfig): boolean {
  return isAccessSubjectAllowed(
    {
      userId: message.author.id,
      nameSource: messageNameSource(message),
      roleIds: message.member ? [...message.member.roles.cache.keys()] : []
    },
    appConfig
  );
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
  if (interaction.commandName === "do" || interaction.commandName === "run" || interaction.commandName === "ship") {
    return true;
  }
  const subcommand = interaction.options.getSubcommand(false);
  if (interaction.commandName === "review") {
    return subcommand === "validate" || subcommand === "gates";
  }
  if (interaction.commandName === "task") {
    return subcommand === "cancel" || subcommand === "retry";
  }
  return interaction.commandName === "lab" && (subcommand === "approve" || subcommand === "bossfight");
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

async function ensureConfiguredRoom(
  interaction:
    | ChatInputCommandInteraction
    | MessageContextMenuCommandInteraction
    | ButtonInteraction
    | StringSelectMenuInteraction
    | ModalSubmitInteraction
): Promise<boolean> {
  const privateChannelId = effectivePrivateRoomId();
  if (await isConfiguredRoomId(interaction.channelId)) {
    return true;
  }
  if (!privateChannelId) {
    await interaction.reply({
      content: "Devbot setup is not ready. The owner must run `/setup wizard` first.",
      flags: MessageFlags.Ephemeral
    });
    return false;
  }
  await interaction.reply({
    content: `Devbot is configured for its private room: <#${privateChannelId}>.`,
    flags: MessageFlags.Ephemeral
  });
  return false;
}

async function isConfiguredRoomId(channelId: string | null): Promise<boolean> {
  if (!channelId) return false;
  if (channelId === effectivePrivateRoomId()) return true;
  const state = setupStore.snapshot();
  const projectRoom = Object.entries(state.projectRoomIds).find(([, roomId]) => roomId === channelId);
  if (projectRoom) {
    if (!(await verifyPrivateRoom(channelId))) return false;
    const lastVerified = verifiedProjectRoomAudiences.get(channelId) ?? 0;
    if (Date.now() - lastVerified < 60_000) return true;
    const project = findProject(config.projects, projectRoom[0]);
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!project || !channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.PrivateThread)) return false;
    const problem = await projectRoomAudienceProblem(channel, project, config);
    if (problem) {
      console.warn(`Project room ${channelId} failed its audience check: ${problem}`);
      return false;
    }
    verifiedProjectRoomAudiences.set(channelId, Date.now());
    return true;
  }
  const task = await taskStore.findByThread(channelId);
  return Boolean(task && (await verifyPrivateRoom(channelId)));
}

async function projectForConfiguredRoom(channelId: string, appConfig: AppConfig): Promise<ProjectEntry | undefined> {
  const state = setupStore.snapshot();
  const projectEntry = Object.entries(state.projectRoomIds).find(([, roomId]) => roomId === channelId);
  if (projectEntry) {
    return findProject(appConfig.projects, projectEntry[0]);
  }
  const task = await taskStore.findByThread(channelId);
  return task ? findProject(appConfig.projects, task.projectName) : undefined;
}

function effectivePrivateRoomId(): string | undefined {
  return verifiedPrivateRoomId;
}

async function ensureWorkspaceLauncher(appConfig: AppConfig): Promise<void> {
  const roomId = effectivePrivateRoomId();
  if (!roomId || appConfig.projects.length === 0 || !client.user) {
    return;
  }
  const channel = await client.channels.fetch(roomId);
  if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.PrivateThread)) {
    throw new Error("The configured private room cannot host the workspace launcher.");
  }
  const room = channel as GuildTextBasedChannel;
  const state = setupStore.snapshot();
  let launcher = state.workspaceMessageId
    ? await room.messages.fetch(state.workspaceMessageId).catch(() => undefined)
    : undefined;
  if (launcher && launcher.author.id !== client.user.id) {
    launcher = undefined;
  }
  if (launcher) {
    await launcher.edit(workspaceLauncherView());
  } else {
    launcher = await room.send(workspaceLauncherView());
    await setupStore.setWorkspaceMessage(launcher.id);
  }
  if (!launcher.pinned && launcher.pinnable) {
    await launcher.pin("Devbot workspace launcher").catch(() => undefined);
  }
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

function interactionNameSource(
  interaction:
    | ChatInputCommandInteraction
    | MessageContextMenuCommandInteraction
    | ButtonInteraction
    | AutocompleteInteraction
    | StringSelectMenuInteraction
    | ModalSubmitInteraction
) {
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

  const message = `Error: ${publicErrorMessage(error)}`;
  if (interaction.deferred && !interaction.replied) {
    try {
      await interaction.editReply({ content: message, components: [] });
      return;
    } catch {
      await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral });
      return;
    }
  }
  if (interaction.replied) {
    await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
}
