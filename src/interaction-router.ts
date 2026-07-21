import { MessageFlags } from "discord.js";
import type {
  AutocompleteInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
  Interaction,
  MessageContextMenuCommandInteraction,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
  UserSelectMenuInteraction
} from "discord.js";
import { parseAmbientCustomId, type AmbientAction } from "./ambient-ui.js";
import type { LogFields, LogLevel } from "./logger.js";
import { publicErrorMessage } from "./security.js";
import {
  parseScreenshotApprovalControl,
  type ScreenshotApprovalAction
} from "./screenshot-approval.js";
import { parseScreenshotFixControl, type ScreenshotFixAction } from "./screenshot-fix.js";
import { parseSetupWizardAction, type SetupWizardAction } from "./setup-wizard.js";
import { parseStudioControl, type StudioAction } from "./studio-ui.js";
import {
  parsePreviewControl,
  parseTaskControl,
  type PreviewButtonAction,
  type TaskControlAction
} from "./task-controls.js";
import { parseTaskModal, type TaskModalAction } from "./task-ui.js";
import type { AppConfig } from "./types.js";
import { parseWorkspaceControl, parseWorkspaceModal, type WorkspaceAction, type WorkspaceModalAction } from "./workspace-ui.js";
import { parseWorkroomButton } from "./workroom-controls.js";

type AllowedInteraction =
  | ChatInputCommandInteraction
  | MessageContextMenuCommandInteraction
  | ButtonInteraction
  | AutocompleteInteraction
  | StringSelectMenuInteraction
  | ModalSubmitInteraction;

type RoomCheckedInteraction =
  | ChatInputCommandInteraction
  | MessageContextMenuCommandInteraction
  | ButtonInteraction
  | StringSelectMenuInteraction
  | ModalSubmitInteraction;

export interface InteractionRouterDependencies {
  isConfiguredRoomId(channelId: string | null): Promise<boolean>;
  isAllowed(interaction: AllowedInteraction, appConfig: AppConfig): boolean;
  ensureConfiguredRoom(interaction: RoomCheckedInteraction): Promise<boolean>;
  isOwner(userId: string, appConfig: Pick<AppConfig, "ownerUserId">): boolean;
  isControllerUser(userId: string, appConfig: AppConfig): boolean;
  handleAutocomplete(interaction: AutocompleteInteraction, appConfig: AppConfig): Promise<void>;
  handleScreenshotApprovalButton(
    interaction: ButtonInteraction,
    appConfig: AppConfig,
    action: ScreenshotApprovalAction,
    id: string
  ): Promise<void>;
  handleAmbientButton(
    interaction: ButtonInteraction,
    appConfig: AppConfig,
    action: AmbientAction,
    entityId: string
  ): Promise<void>;
  handleStudioButton(
    interaction: ButtonInteraction,
    appConfig: AppConfig,
    action: StudioAction,
    scope: string
  ): Promise<void>;
  handleWorkspaceButton(
    interaction: ButtonInteraction,
    appConfig: AppConfig,
    action: WorkspaceAction,
    projectName?: string
  ): Promise<void>;
  handleSetupWizardButton(
    interaction: ButtonInteraction,
    appConfig: AppConfig,
    action: SetupWizardAction
  ): Promise<void>;
  handlePreviewControlButton(
    interaction: ButtonInteraction,
    appConfig: AppConfig,
    action: PreviewButtonAction,
    previewId: string
  ): Promise<void>;
  handleTaskControl(
    interaction: ButtonInteraction,
    appConfig: AppConfig,
    action: TaskControlAction,
    taskId: string
  ): Promise<void>;
  handleScreenshotFixControl(
    interaction: ButtonInteraction,
    appConfig: AppConfig,
    action: ScreenshotFixAction,
    id: string
  ): Promise<void>;
  handleWorkroomButton(interaction: ButtonInteraction, appConfig: AppConfig): Promise<void>;
  handleAmbientTeamSelect(
    interaction: StringSelectMenuInteraction,
    appConfig: AppConfig,
    entityId: string
  ): Promise<void>;
  handleStudioSelect(
    interaction: StringSelectMenuInteraction,
    appConfig: AppConfig,
    action: StudioAction,
    scope: string
  ): Promise<void>;
  handleWorkspaceProjectSelect(interaction: StringSelectMenuInteraction, appConfig: AppConfig): Promise<void>;
  handleSetupUserSelect(
    interaction: UserSelectMenuInteraction,
    appConfig: AppConfig,
    action: SetupWizardAction
  ): Promise<void>;
  handleSetupProjectSelect(
    interaction: StringSelectMenuInteraction,
    appConfig: AppConfig,
    action: SetupWizardAction
  ): Promise<void>;
  handleAmbientProposalEdit(
    interaction: ModalSubmitInteraction,
    appConfig: AppConfig,
    entityId: string
  ): Promise<void>;
  handleWorkspaceModal(
    interaction: ModalSubmitInteraction,
    appConfig: AppConfig,
    action: WorkspaceModalAction,
    projectName: string
  ): Promise<void>;
  handleTaskModal(
    interaction: ModalSubmitInteraction,
    appConfig: AppConfig,
    action: TaskModalAction,
    taskId: string
  ): Promise<void>;
  handleSetupRepoModal(
    interaction: ModalSubmitInteraction,
    appConfig: AppConfig,
    action: SetupWizardAction
  ): Promise<void>;
  handleAmbientContextMenu(
    interaction: MessageContextMenuCommandInteraction,
    appConfig: AppConfig
  ): Promise<void>;
  handleSetupCommand(interaction: ChatInputCommandInteraction, appConfig: AppConfig): Promise<void>;
  handleCommand(interaction: ChatInputCommandInteraction, appConfig: AppConfig): Promise<void>;
  replyWithError(interaction: Interaction, error: unknown): Promise<void>;
  logEvent(level: LogLevel, event: string, fields?: LogFields): void;
  logError(event: string, error: unknown, fields?: LogFields): void;
  warn(message: string): void;
}

export function createInteractionRouter(
  appConfig: AppConfig,
  dependencies: InteractionRouterDependencies
): (interaction: Interaction) => Promise<void> {
  return async (interaction) => {
    dependencies.logEvent("info", "discord.interaction.received", {
      requestId: interaction.id,
      kind: interactionKind(interaction),
      command: interaction.isCommand() ? interaction.commandName : undefined
    });
    try {
      if (interaction.isAutocomplete()) {
        if (!(await dependencies.isConfiguredRoomId(interaction.channelId))) {
          await interaction.respond([]);
          return;
        }
        if (!dependencies.isAllowed(interaction, appConfig)) {
          await interaction.respond([]);
          return;
        }
        await dependencies.handleAutocomplete(interaction, appConfig);
        return;
      }

      if (interaction.isButton()) {
        const screenshotApproval = parseScreenshotApprovalControl(interaction.customId);
        if (screenshotApproval) {
          if (!dependencies.isAllowed(interaction, appConfig)) {
            await interaction.reply({ content: "You are not allowed to use this bot.", flags: MessageFlags.Ephemeral });
            return;
          }
          if (!(await dependencies.ensureConfiguredRoom(interaction))) return;
          await dependencies.handleScreenshotApprovalButton(
            interaction,
            appConfig,
            screenshotApproval.action,
            screenshotApproval.id
          );
          return;
        }
        const ambientControl = parseAmbientCustomId(interaction.customId);
        if (ambientControl && ambientControl.action !== "team-select") {
          if (!dependencies.isAllowed(interaction, appConfig)) {
            await interaction.reply({ content: "You are not allowed to use this bot.", flags: MessageFlags.Ephemeral });
            return;
          }
          if (!(await dependencies.ensureConfiguredRoom(interaction))) return;
          await dependencies.handleAmbientButton(interaction, appConfig, ambientControl.action, ambientControl.entityId);
          return;
        }
        const studioControl = parseStudioControl(interaction.customId);
        if (studioControl) {
          if (!dependencies.isAllowed(interaction, appConfig)) {
            await interaction.reply({ content: "You are not allowed to use this bot.", flags: MessageFlags.Ephemeral });
            return;
          }
          if (!(await dependencies.ensureConfiguredRoom(interaction))) return;
          if (!dependencies.isControllerUser(interaction.user.id, appConfig)) {
            await interaction.reply({ content: "Only the owner or an approved controller can use Devbot Studio.", flags: MessageFlags.Ephemeral });
            return;
          }
          await dependencies.handleStudioButton(interaction, appConfig, studioControl.action, studioControl.scope);
          return;
        }
        const workspaceControl = parseWorkspaceControl(interaction.customId);
        if (workspaceControl) {
          if (!dependencies.isAllowed(interaction, appConfig)) {
            await interaction.reply({ content: "You are not allowed to use this bot.", flags: MessageFlags.Ephemeral });
            return;
          }
          if (!(await dependencies.ensureConfiguredRoom(interaction))) {
            return;
          }
          await dependencies.handleWorkspaceButton(
            interaction,
            appConfig,
            workspaceControl.action,
            workspaceControl.projectName
          );
          return;
        }
        const setupAction = parseSetupWizardAction(interaction.customId);
        if (setupAction) {
          if (!dependencies.isOwner(interaction.user.id, appConfig)) {
            await interaction.reply({ content: "Only the configured Devbot owner can use setup controls.", flags: MessageFlags.Ephemeral });
            return;
          }
          await dependencies.handleSetupWizardButton(interaction, appConfig, setupAction);
          return;
        }
        const previewControl = parsePreviewControl(interaction.customId);
        if (previewControl) {
          if (!dependencies.isAllowed(interaction, appConfig)) {
            await interaction.reply({ content: "You are not allowed to use this bot.", flags: MessageFlags.Ephemeral });
            return;
          }
          if (!(await dependencies.ensureConfiguredRoom(interaction))) {
            return;
          }
          await dependencies.handlePreviewControlButton(interaction, appConfig, previewControl.action, previewControl.previewId);
          return;
        }
        const taskControl = parseTaskControl(interaction.customId);
        if (taskControl) {
          if (!dependencies.isAllowed(interaction, appConfig)) {
            await interaction.reply({ content: "You are not allowed to use this bot.", flags: MessageFlags.Ephemeral });
            return;
          }
          if (!(await dependencies.ensureConfiguredRoom(interaction))) {
            return;
          }
          await dependencies.handleTaskControl(interaction, appConfig, taskControl.action, taskControl.taskId);
          return;
        }
        const screenshotFixControl = parseScreenshotFixControl(interaction.customId);
        if (screenshotFixControl) {
          if (!dependencies.isAllowed(interaction, appConfig)) {
            await interaction.reply({ content: "You are not allowed to use this bot.", flags: MessageFlags.Ephemeral });
            return;
          }
          if (!(await dependencies.ensureConfiguredRoom(interaction))) {
            return;
          }
          await dependencies.handleScreenshotFixControl(
            interaction,
            appConfig,
            screenshotFixControl.action,
            screenshotFixControl.id
          );
          return;
        }
        if (!parseWorkroomButton(interaction.customId)) {
          return;
        }
        if (!dependencies.isAllowed(interaction, appConfig)) {
          await interaction.reply({ content: "You are not allowed to use this bot.", flags: MessageFlags.Ephemeral });
          return;
        }
        if (!(await dependencies.ensureConfiguredRoom(interaction))) {
          return;
        }
        await dependencies.handleWorkroomButton(interaction, appConfig);
        return;
      }

      if (interaction.isUserSelectMenu() || interaction.isStringSelectMenu()) {
        const ambientControl = parseAmbientCustomId(interaction.customId);
        if (ambientControl?.action === "team-select" && interaction.isStringSelectMenu()) {
          if (!dependencies.isAllowed(interaction, appConfig)) {
            await interaction.reply({ content: "You are not allowed to use this bot.", flags: MessageFlags.Ephemeral });
            return;
          }
          if (!(await dependencies.ensureConfiguredRoom(interaction))) return;
          await dependencies.handleAmbientTeamSelect(interaction, appConfig, ambientControl.entityId);
          return;
        }
        const studioControl = parseStudioControl(interaction.customId);
        if (studioControl && interaction.isStringSelectMenu()) {
          if (!dependencies.isAllowed(interaction, appConfig)) {
            await interaction.reply({ content: "You are not allowed to use this bot.", flags: MessageFlags.Ephemeral });
            return;
          }
          if (!(await dependencies.ensureConfiguredRoom(interaction))) return;
          if (!dependencies.isControllerUser(interaction.user.id, appConfig)) {
            await interaction.reply({ content: "Only the owner or an approved controller can use Devbot Studio.", flags: MessageFlags.Ephemeral });
            return;
          }
          await dependencies.handleStudioSelect(interaction, appConfig, studioControl.action, studioControl.scope);
          return;
        }
        const workspaceControl = parseWorkspaceControl(interaction.customId);
        if (workspaceControl?.action === "project" && interaction.isStringSelectMenu()) {
          if (!dependencies.isAllowed(interaction, appConfig)) {
            await interaction.reply({ content: "You are not allowed to use this bot.", flags: MessageFlags.Ephemeral });
            return;
          }
          if (!(await dependencies.ensureConfiguredRoom(interaction))) {
            return;
          }
          await dependencies.handleWorkspaceProjectSelect(interaction, appConfig);
          return;
        }
        const setupAction = parseSetupWizardAction(interaction.customId);
        if (!setupAction) {
          return;
        }
        if (!dependencies.isOwner(interaction.user.id, appConfig)) {
          await interaction.reply({ content: "Only the configured Devbot owner can use setup controls.", flags: MessageFlags.Ephemeral });
          return;
        }
        if (interaction.isUserSelectMenu()) {
          await dependencies.handleSetupUserSelect(interaction, appConfig, setupAction);
        } else {
          await dependencies.handleSetupProjectSelect(interaction, appConfig, setupAction);
        }
        return;
      }

      if (interaction.isModalSubmit()) {
        const ambientControl = parseAmbientCustomId(interaction.customId);
        if (ambientControl?.action === "proposal-edit") {
          if (!dependencies.isAllowed(interaction, appConfig)) {
            await interaction.reply({ content: "You are not allowed to use this bot.", flags: MessageFlags.Ephemeral });
            return;
          }
          if (!(await dependencies.ensureConfiguredRoom(interaction))) return;
          await dependencies.handleAmbientProposalEdit(interaction, appConfig, ambientControl.entityId);
          return;
        }
        const workspaceModal = parseWorkspaceModal(interaction.customId);
        if (workspaceModal) {
          if (!dependencies.isAllowed(interaction, appConfig)) {
            await interaction.reply({ content: "You are not allowed to use this bot.", flags: MessageFlags.Ephemeral });
            return;
          }
          if (!(await dependencies.ensureConfiguredRoom(interaction))) {
            return;
          }
          await dependencies.handleWorkspaceModal(
            interaction,
            appConfig,
            workspaceModal.action,
            workspaceModal.projectName
          );
          return;
        }
        const taskModal = parseTaskModal(interaction.customId);
        if (taskModal) {
          if (!dependencies.isAllowed(interaction, appConfig)) {
            await interaction.reply({ content: "You are not allowed to use this bot.", flags: MessageFlags.Ephemeral });
            return;
          }
          if (!(await dependencies.ensureConfiguredRoom(interaction))) {
            return;
          }
          await dependencies.handleTaskModal(interaction, appConfig, taskModal.action, taskModal.taskId);
          return;
        }
        const setupAction = parseSetupWizardAction(interaction.customId);
        if (!setupAction) {
          return;
        }
        if (!dependencies.isOwner(interaction.user.id, appConfig)) {
          await interaction.reply({ content: "Only the configured Devbot owner can use setup controls.", flags: MessageFlags.Ephemeral });
          return;
        }
        await dependencies.handleSetupRepoModal(interaction, appConfig, setupAction);
        return;
      }

      if (interaction.isMessageContextMenuCommand()) {
        if (interaction.commandName !== "Start Devbot workroom") return;
        if (!dependencies.isAllowed(interaction, appConfig)) {
          await interaction.reply({ content: "You are not allowed to use this bot.", flags: MessageFlags.Ephemeral });
          return;
        }
        if (!(await dependencies.ensureConfiguredRoom(interaction))) return;
        await dependencies.handleAmbientContextMenu(interaction, appConfig);
        return;
      }

      if (!interaction.isChatInputCommand()) {
        return;
      }

      if (interaction.commandName === "setup") {
        if (!appConfig.ownerUserId) {
          await interaction.reply({
            content: "Devbot has no configured owner. Set `DEVBOT_OWNER_USER_ID` locally, restart, then run `/setup wizard`.",
            flags: MessageFlags.Ephemeral
          });
          return;
        }
        if (!dependencies.isOwner(interaction.user.id, appConfig)) {
          await interaction.reply({ content: "Only the configured Devbot owner can run `/setup`.", flags: MessageFlags.Ephemeral });
          return;
        }
        await dependencies.handleSetupCommand(interaction, appConfig);
        return;
      }

      if (!dependencies.isAllowed(interaction, appConfig)) {
        await interaction.reply({ content: "You are not allowed to use this bot.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (!(await dependencies.ensureConfiguredRoom(interaction))) {
        return;
      }

      await dependencies.handleCommand(interaction, appConfig);
    } catch (error) {
      dependencies.logError("discord.interaction.failed", error, {
        requestId: interaction.id,
        kind: interactionKind(interaction),
        command: interaction.isCommand() ? interaction.commandName : undefined
      });
      try {
        await dependencies.replyWithError(interaction, error);
      } catch (replyError) {
        dependencies.warn(`Unable to send the interaction error response: ${publicErrorMessage(replyError)}`);
      }
    }
  };
}

export function interactionKind(interaction: Interaction): string {
  if (interaction.isAutocomplete()) return "autocomplete";
  if (interaction.isButton()) return "button";
  if (interaction.isStringSelectMenu()) return "string-select";
  if (interaction.isUserSelectMenu()) return "user-select";
  if (interaction.isModalSubmit()) return "modal";
  if (interaction.isMessageContextMenuCommand()) return "message-command";
  if (interaction.isChatInputCommand()) return "chat-command";
  return "other";
}
