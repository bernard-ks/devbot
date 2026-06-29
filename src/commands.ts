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
    )
    .addStringOption((option) =>
      option
        .setName("viewport")
        .setDescription("Screenshot viewport.")
        .setRequired(false)
        .addChoices(
          { name: "desktop", value: "desktop" },
          { name: "tablet", value: "tablet" },
          { name: "mobile", value: "mobile" }
        )
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
              { name: "failed", value: "failed" },
              { name: "canceled", value: "canceled" }
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
        .addStringOption((option) => option.setName("id").setDescription("Task ID.").setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("status")
        .setDescription("Show the current state for one saved task.")
        .addStringOption((option) => option.setName("id").setDescription("Task ID.").setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("logs")
        .setDescription("Show the saved request, result preview, and error for one task.")
        .addStringOption((option) => option.setName("id").setDescription("Task ID.").setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("cancel")
        .setDescription("Mark a running saved task as canceled.")
        .addStringOption((option) => option.setName("id").setDescription("Task ID.").setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("retry")
        .setDescription("Retry a saved task with the same project, mode, request, and include patterns.")
        .addStringOption((option) => option.setName("id").setDescription("Task ID.").setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("stale")
        .setDescription("List running tasks older than the selected threshold.")
        .addIntegerOption((option) =>
          option.setName("minutes").setDescription("Age threshold in minutes.").setRequired(false).setMinValue(1).setMaxValue(1440)
        )
        .addStringOption((option) =>
          option.setName("project").setDescription("Filter by configured project name.").setRequired(false).setAutocomplete(true)
        )
    ),
  new SlashCommandBuilder()
    .setName("dashboard")
    .setDescription("Show a compact project dashboard with active work, recent tasks, and configured commands.")
    .addStringOption((option) =>
      option.setName("project").setDescription("Configured project name.").setRequired(false).setAutocomplete(true)
    ),
  new SlashCommandBuilder()
    .setName("run")
    .setDescription("Run a configured project command preset.")
    .addStringOption((option) =>
      option.setName("project").setDescription("Configured project name.").setRequired(true).setAutocomplete(true)
    )
    .addStringOption((option) =>
      option
        .setName("command")
        .setDescription("Configured command name such as test, build, lint, verify, or a project preset.")
        .setRequired(true)
        .setAutocomplete(true)
    ),
  new SlashCommandBuilder()
    .setName("review")
    .setDescription("Create review packets and validate merge readiness.")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("packet")
        .setDescription("Create a provider-neutral review handoff packet.")
        .addStringOption((option) =>
          option.setName("project").setDescription("Configured project name.").setRequired(true).setAutocomplete(true)
        )
        .addStringOption((option) => option.setName("task").setDescription("Optional saved task ID.").setRequired(false).setAutocomplete(true))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("validate")
        .setDescription("Run configured validation commands for a project.")
        .addStringOption((option) =>
          option.setName("project").setDescription("Configured project name.").setRequired(true).setAutocomplete(true)
        )
        .addStringOption((option) =>
          option.setName("commands").setDescription("Optional comma-separated configured commands.").setRequired(false).setAutocomplete(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("gates")
        .setDescription("Check merge gates without merging.")
        .addStringOption((option) =>
          option.setName("project").setDescription("Configured project name.").setRequired(true).setAutocomplete(true)
        )
        .addStringOption((option) =>
          option.setName("commands").setDescription("Optional comma-separated configured commands.").setRequired(false).setAutocomplete(true)
        )
    ),
  new SlashCommandBuilder()
    .setName("devbot")
    .setDescription("Inspect or announce this bot's identity and capabilities.")
    .addSubcommand((subcommand) => subcommand.setName("help").setDescription("Show common devbot workflows."))
    .addSubcommand((subcommand) => subcommand.setName("capabilities").setDescription("Show local bot capabilities."))
    .addSubcommand((subcommand) => subcommand.setName("peers").setDescription("List known peer devbots."))
    .addSubcommand((subcommand) =>
      subcommand
        .setName("announce")
        .setDescription("Announce this bot's capabilities in the current or configured coordination channel.")
    ),
  new SlashCommandBuilder()
    .setName("peer")
    .setDescription("Request read-only status or screenshot work from an allow-listed peer bot.")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("status")
        .setDescription("Ask a peer bot for project status.")
        .addStringOption((option) =>
          option.setName("bot").setDescription("Peer bot user ID or mention.").setRequired(true).setAutocomplete(true)
        )
        .addStringOption((option) => option.setName("project").setDescription("Project name on the peer.").setRequired(false))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("snip")
        .setDescription("Ask a peer bot for a live UI screenshot.")
        .addStringOption((option) =>
          option.setName("bot").setDescription("Peer bot user ID or mention.").setRequired(true).setAutocomplete(true)
        )
        .addStringOption((option) => option.setName("target").setDescription("Natural-language target or route.").setRequired(true))
        .addStringOption((option) => option.setName("project").setDescription("Project name on the peer.").setRequired(false))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("capabilities")
        .setDescription("Ask a peer bot to announce capabilities.")
        .addStringOption((option) =>
          option.setName("bot").setDescription("Peer bot user ID or mention.").setRequired(true).setAutocomplete(true)
        )
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
