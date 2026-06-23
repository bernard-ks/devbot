import { SlashCommandBuilder } from "discord.js";

export const commandDefinitions = [
  new SlashCommandBuilder().setName("projects").setDescription("List configured local projects."),
  new SlashCommandBuilder()
    .setName("refresh")
    .setDescription("Refresh the indexed context for a project.")
    .addStringOption((option) =>
      option.setName("project").setDescription("Configured project name.").setRequired(true).setAutocomplete(true)
    ),
  new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Ask a development question with local project context.")
    .addStringOption((option) =>
      option.setName("project").setDescription("Configured project name.").setRequired(true).setAutocomplete(true)
    )
    .addStringOption((option) =>
      option.setName("question").setDescription("What you want to know or inspect.").setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("include")
        .setDescription("Optional comma-separated path patterns, e.g. src/*,README.md,*.json.")
        .setRequired(false)
    )
].map((command) => command.toJSON());
