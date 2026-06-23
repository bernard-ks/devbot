import {
  Client,
  GatewayIntentBits,
  GuildMember,
} from "discord.js";
import type { AutocompleteInteraction, ChatInputCommandInteraction, Interaction } from "discord.js";
import { loadConfig } from "./config.js";
import { ProjectContextService, parseIncludePatterns } from "./context.js";
import { splitDiscordMessage } from "./messages.js";
import { answerWithProjectContext } from "./openai-client.js";
import type { AppConfig, ProjectEntry } from "./types.js";

const config = loadConfig();
const contextService = new ProjectContextService(config.scanner);
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", async () => {
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
      await interaction.reply({ content: "You are not allowed to use this bot.", ephemeral: true });
      return;
    }

    await handleCommand(interaction, config);
  } catch (error) {
    console.error(error);
    await replyWithError(interaction, error);
  }
});

await client.login(config.discordToken);

async function handleCommand(interaction: ChatInputCommandInteraction, appConfig: AppConfig): Promise<void> {
  if (interaction.commandName === "projects") {
    await interaction.reply({
      content: appConfig.projects.map((project) => `- \`${project.name}\` -> \`${project.root}\``).join("\n"),
      ephemeral: true
    });
    return;
  }

  if (interaction.commandName === "refresh") {
    await interaction.deferReply({ ephemeral: true });
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
    const context = await contextService.pack(project, question, includePatterns);

    const answer = await answerWithProjectContext({
      apiKey: appConfig.openaiApiKey,
      model: appConfig.openaiModel,
      question,
      context
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
  }
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

async function replyWithError(interaction: Interaction, error: unknown): Promise<void> {
  if (!interaction.isRepliable()) {
    return;
  }

  const message = `Error: ${(error as Error).message}`;
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp({ content: message, ephemeral: true });
    return;
  }

  await interaction.reply({ content: message, ephemeral: true });
}
