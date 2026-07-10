import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder
} from "discord.js";
import type { SetupState } from "./setup-store.js";
import type { AppConfig } from "./types.js";

export type SetupWizardAction = "room" | "repo" | "refresh" | "finish" | "viewer" | "controller" | "peer" | "default" | "repo-modal";

const PREFIX = "devbot:setup:";

export function parseSetupWizardAction(customId: string): SetupWizardAction | undefined {
  const action = customId.startsWith(PREFIX) ? customId.slice(PREFIX.length) : "";
  return isSetupWizardAction(action) ? action : undefined;
}

export function setupWizardView(
  state: SetupState,
  config: AppConfig,
  effectiveRoomId: string | undefined,
  finished = false
) {
  const defaultProject = config.projects.find((project) => project.isDefault);
  const roomReady = Boolean(effectiveRoomId);
  const repoReady = Boolean(defaultProject);
  const readyCount = Number(roomReady) + Number(repoReady);
  const ready = readyCount === 2;
  const content = finished && ready
    ? [
        "Devbot is ready.",
        "",
        `Room: <#${effectiveRoomId}>`,
        `Default repo: \`${defaultProject?.name}\``,
        "",
        "Ask: mention `@devbot` with a question.",
        "Do: use `/do` for an intentional project change.",
        "Check: use `/status` for current work.",
        "",
        "Reopen `/setup wizard` whenever access or repositories change."
      ].join("\n")
    : [
        "Devbot setup",
        `Required: ${readyCount}/2 ready. Every confirmed choice saves immediately.`,
        "",
        `${roomReady ? "READY" : "TODO"}  Private room${effectiveRoomId ? `: <#${effectiveRoomId}>` : ""}`,
        `${repoReady ? "READY" : "TODO"}  Default repo${defaultProject ? `: \`${defaultProject.name}\`` : ""}`,
        "",
        `Optional access: ${state.viewerUserIds.length} viewer(s), ${state.controllerUserIds.length} controller(s), ${state.peerBotIds.length} peer bot(s).`,
        ready
          ? "Setup is ready. Add people if needed, or choose Finish for the three-command quickstart."
          : nextSetupStep(roomReady, repoReady)
      ].join("\n");

  const rows: Array<
    | ActionRowBuilder<ButtonBuilder>
    | ActionRowBuilder<UserSelectMenuBuilder>
    | ActionRowBuilder<StringSelectMenuBuilder>
  > = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${PREFIX}room`)
        .setLabel(roomReady ? "Sync room" : "Use private room")
        .setStyle(roomReady ? ButtonStyle.Secondary : ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`${PREFIX}repo`).setLabel("Add repo").setStyle(repoReady ? ButtonStyle.Secondary : ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`${PREFIX}refresh`).setLabel("Refresh").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`${PREFIX}finish`).setLabel(ready ? "Finish" : "Not ready").setStyle(ButtonStyle.Success).setDisabled(!ready)
    ),
    new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId(`${PREFIX}viewer`)
        .setPlaceholder("Add viewers")
        .setMinValues(1)
        .setMaxValues(10)
    ),
    new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId(`${PREFIX}controller`)
        .setPlaceholder("Add controllers")
        .setMinValues(1)
        .setMaxValues(10)
    ),
    new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId(`${PREFIX}peer`)
        .setPlaceholder("Add peer Devbots (bot accounts only)")
        .setMinValues(1)
        .setMaxValues(10)
    )
  ];

  if (config.projects.length > 1) {
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`${PREFIX}default`)
          .setPlaceholder("Choose the default repository")
          .addOptions(
            ...config.projects.slice(0, 25).map((project) => ({
              label: project.name,
              value: project.name,
              default: Boolean(project.isDefault)
            }))
          )
      )
    );
  }

  return { content, components: rows, allowedMentions: { parse: [] as const } };
}

export function setupRepositoryModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${PREFIX}repo-modal`)
    .setTitle("Add a local repository")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("name")
          .setLabel("Short name")
          .setPlaceholder("pullprice")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(40)
          .setRequired(true)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("path")
          .setLabel("Absolute path on the Devbot machine")
          .setPlaceholder("/Users/me/Projects/pullprice")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(1_000)
          .setRequired(true)
      )
    );
}

function nextSetupStep(roomReady: boolean, repoReady: boolean): string {
  if (!roomReady) {
    return "Next: choose Use private room. Devbot will adopt this private thread or create one safely.";
  }
  if (!repoReady) {
    return "Next: choose Add repo and enter its local name and path.";
  }
  return "Setup is ready.";
}

function isSetupWizardAction(value: string): value is SetupWizardAction {
  return value === "room" || value === "repo" || value === "refresh" || value === "finish" ||
    value === "viewer" || value === "controller" || value === "peer" || value === "default" || value === "repo-modal";
}
