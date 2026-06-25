import { SlashCommandBuilder } from "discord.js";

export const commandDefinitions = [
  new SlashCommandBuilder().setName("projects").setDescription("List configured local projects."),
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show Codex dev work currently in progress.")
    .addStringOption((option) =>
      option.setName("project").setDescription("Optional project for a deeper status question.").setRequired(false).setAutocomplete(true)
    )
    .addStringOption((option) =>
      option
        .setName("question")
        .setDescription("Optional deeper status question; describe the UI target for screenshots.")
        .setRequired(false)
    )
    .addBooleanOption((option) =>
      option.setName("image").setDescription("Attach a live screenshot of the project UI when available.").setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("snip")
    .setDescription("Attach a live screenshot from a running local project UI.")
    .addStringOption((option) =>
      option.setName("target").setDescription("Natural-language UI target or exact path/URL.").setRequired(true)
    )
    .addStringOption((option) =>
      option.setName("project").setDescription("Configured project name.").setRequired(false).setAutocomplete(true)
    ),
  new SlashCommandBuilder()
    .setName("task")
    .setDescription("Inspect saved devbot task history.")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("recent")
        .setDescription("List recent saved tasks.")
        .addStringOption((option) =>
          option.setName("project").setDescription("Filter by configured project name.").setRequired(false).setAutocomplete(true)
        )
        .addStringOption((option) =>
          option
            .setName("status")
            .setDescription("Filter by task status.")
            .setRequired(false)
            .addChoices(
              { name: "running", value: "running" },
              { name: "succeeded", value: "succeeded" },
              { name: "failed", value: "failed" }
            )
        )
        .addIntegerOption((option) =>
          option.setName("limit").setDescription("Number of tasks to show, 1-25.").setRequired(false).setMinValue(1).setMaxValue(25)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("show")
        .setDescription("Show one saved task.")
        .addStringOption((option) => option.setName("id").setDescription("Task ID.").setRequired(true))
    ),
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
    ),
  new SlashCommandBuilder()
    .setName("act")
    .setDescription("Ask local Codex to perform a focused project task.")
    .addStringOption((option) =>
      option.setName("project").setDescription("Configured project name.").setRequired(true).setAutocomplete(true)
    )
    .addStringOption((option) =>
      option.setName("task").setDescription("The concrete change or command workflow to run.").setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("include")
        .setDescription("Optional comma-separated path patterns, e.g. src/*,README.md,*.json.")
        .setRequired(false)
    )
].map((command) => command.toJSON());
