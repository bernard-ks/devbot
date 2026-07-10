import { ApplicationCommandType, ContextMenuCommandBuilder, SlashCommandBuilder } from "discord.js";

const commandBuilders = [
  new SlashCommandBuilder().setName("projects").setDescription("List configured local projects."),
  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Owner-only Devbot access, peer, room, and repository setup.")
    .addSubcommand((subcommand) => subcommand.setName("wizard").setDescription("Open the guided, resumable Devbot setup."))
    .addSubcommand((subcommand) => subcommand.setName("doctor").setDescription("Check owner, room, repo, Codex, routing, and command readiness."))
    .addSubcommand((subcommand) => subcommand.setName("show").setDescription("Show the current private Devbot configuration."))
    .addSubcommand((subcommand) =>
      subcommand
        .setName("user")
        .setDescription("Add or remove a viewer or controller.")
        .addStringOption((option) =>
          option
            .setName("action")
            .setDescription("Whether to add or remove access.")
            .setRequired(true)
            .addChoices({ name: "add", value: "add" }, { name: "remove", value: "remove" })
        )
        .addUserOption((option) => option.setName("user").setDescription("Discord user to configure.").setRequired(true))
        .addStringOption((option) =>
          option
            .setName("permission")
            .setDescription("View can use Devbot; control can also run privileged actions.")
            .setRequired(true)
            .addChoices({ name: "view", value: "view" }, { name: "control", value: "control" })
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("devbot")
        .setDescription("Add or remove a peer bot from private collaboration.")
        .addStringOption((option) =>
          option
            .setName("action")
            .setDescription("Whether to add or remove the peer.")
            .setRequired(true)
            .addChoices({ name: "add", value: "add" }, { name: "remove", value: "remove" })
        )
        .addUserOption((option) => option.setName("bot").setDescription("Discord bot account to configure.").setRequired(true))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("repo")
        .setDescription("Add, remove, or select a local project root.")
        .addStringOption((option) =>
          option
            .setName("action")
            .setDescription("Repository action.")
            .setRequired(true)
            .addChoices(
              { name: "add or update", value: "add" },
              { name: "remove", value: "remove" },
              { name: "make default", value: "default" }
            )
        )
        .addStringOption((option) => option.setName("name").setDescription("Short project name, such as devbot.").setRequired(true))
        .addStringOption((option) =>
          option.setName("path").setDescription("Local absolute path; required when adding a repo.").setRequired(false)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("room")
        .setDescription("Create or resync the private Devbot room.")
        .addStringOption((option) =>
          option.setName("name").setDescription("Channel name used when creating the room.").setRequired(false).setMaxLength(80)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("project-room")
        .setDescription("Bind or remove a project's ambient Discord workroom.")
        .addStringOption((option) =>
          option
            .setName("action")
            .setDescription("Whether to bind or remove the project room.")
            .setRequired(true)
            .addChoices({ name: "bind", value: "bind" }, { name: "remove", value: "remove" })
        )
        .addStringOption((option) =>
          option.setName("project").setDescription("Configured project name.").setRequired(true).setAutocomplete(true)
        )
        .addChannelOption((option) =>
          option.setName("channel").setDescription("Discord channel to use when binding the project room.").setRequired(false)
        )
    ),
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show current work, blockers, repository evidence, and the best next step.")
    .addStringOption((option) =>
      option.setName("project").setDescription("Optional project for repository evidence or deeper inspection.").setRequired(false).setAutocomplete(true)
    )
    .addStringOption((option) =>
      option
        .setName("question")
        .setDescription("Optional read-only repository inspection question.")
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
              { name: "awaiting approval", value: "awaiting-approval" },
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
    .setDescription("Open your interactive project workspace.")
    .addStringOption((option) =>
      option.setName("project").setDescription("Configured project name.").setRequired(false).setAutocomplete(true)
    ),
  new SlashCommandBuilder()
    .setName("inbox")
    .setDescription("Show work that needs your attention across configured projects.")
    .addStringOption((option) =>
      option.setName("project").setDescription("Optional configured project name.").setRequired(false).setAutocomplete(true)
    )
    .addIntegerOption((option) =>
      option.setName("limit").setDescription("Number of items to show, 1-25.").setRequired(false).setMinValue(1).setMaxValue(25)
    ),
  new SlashCommandBuilder()
    .setName("run")
    .setDescription("Run a configured project command preset.")
    .addStringOption((option) =>
      option
        .setName("command")
        .setDescription("Configured command name such as test, build, lint, verify, or a project preset.")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption((option) =>
      option.setName("project").setDescription("Optional project; defaults to the selected setup repo.").setRequired(false).setAutocomplete(true)
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
    .setName("lab")
    .setDescription("Run private devbot collaboration lab workflows.")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("council")
        .setDescription("Collect independent sealed agent proposals, then reveal and synthesize them.")
        .addStringOption((option) =>
          option
            .setName("prompt")
            .setDescription("Question or decision for the council, up to 500 characters.")
            .setRequired(true)
            .setMaxLength(500)
        )
        .addStringOption((option) =>
          option.setName("project").setDescription("Optional project; defaults to the selected setup repo.").setRequired(false).setAutocomplete(true)
        )
        .addIntegerOption((option) =>
          option
            .setName("seats")
            .setDescription("Independent local agent seats, 2-4. Defaults to 3.")
            .setRequired(false)
            .setMinValue(2)
            .setMaxValue(4)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("roundtable")
        .setDescription("Invite devbots to give role-based angles on a project question.")
        .addStringOption((option) =>
          option.setName("project").setDescription("Configured project name.").setRequired(true).setAutocomplete(true)
        )
        .addStringOption((option) => option.setName("prompt").setDescription("Question or decision for the room.").setRequired(true))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("see")
        .setDescription("Collect local and peer screenshots for a target.")
        .addStringOption((option) => option.setName("target").setDescription("Natural-language target or route.").setRequired(true))
        .addStringOption((option) =>
          option.setName("project").setDescription("Configured project name.").setRequired(false).setAutocomplete(true)
        )
        .addStringOption((option) =>
          option
            .setName("viewport")
            .setDescription("Local screenshot viewport.")
            .setRequired(false)
            .addChoices(
              { name: "desktop", value: "desktop" },
              { name: "tablet", value: "tablet" },
              { name: "mobile", value: "mobile" }
            )
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("handoff")
        .setDescription("Create a baton-pass card for a task or review.")
        .addStringOption((option) =>
          option.setName("project").setDescription("Configured project name.").setRequired(true).setAutocomplete(true)
        )
        .addStringOption((option) => option.setName("target").setDescription("Human, bot, or team receiving the baton.").setRequired(true))
        .addStringOption((option) => option.setName("task").setDescription("Optional saved task ID.").setRequired(false).setAutocomplete(true))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("bossfight")
        .setDescription("Build a merge-readiness boss bar from review gates and peer evidence.")
        .addStringOption((option) =>
          option.setName("project").setDescription("Configured project name.").setRequired(true).setAutocomplete(true)
        )
        .addStringOption((option) => option.setName("task").setDescription("Optional saved task ID.").setRequired(false).setAutocomplete(true))
        .addStringOption((option) =>
          option.setName("commands").setDescription("Optional comma-separated configured validation commands.").setRequired(false).setAutocomplete(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("jam")
        .setDescription("Brainstorm playful options and convert the best one into a task.")
        .addStringOption((option) =>
          option.setName("project").setDescription("Configured project name.").setRequired(true).setAutocomplete(true)
        )
        .addStringOption((option) => option.setName("theme").setDescription("Theme or rough idea to riff on.").setRequired(true))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("argue")
        .setDescription("Ask devbots to challenge a proposal from several angles.")
        .addStringOption((option) =>
          option.setName("project").setDescription("Configured project name.").setRequired(true).setAutocomplete(true)
        )
        .addStringOption((option) => option.setName("proposal").setDescription("Proposal to pressure-test.").setRequired(true))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("fix-from-snip")
        .setDescription("Turn a visual complaint into a scoped fix plan and approval card.")
        .addStringOption((option) =>
          option.setName("project").setDescription("Configured project name.").setRequired(true).setAutocomplete(true)
        )
        .addStringOption((option) => option.setName("target").setDescription("UI target or route to screenshot.").setRequired(true))
        .addStringOption((option) => option.setName("complaint").setDescription("What looks wrong or should change.").setRequired(true))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("campfire")
        .setDescription("Show stale running tasks and recovery options.")
        .addIntegerOption((option) =>
          option.setName("minutes").setDescription("Age threshold in minutes.").setRequired(false).setMinValue(1).setMaxValue(1440)
        )
        .addStringOption((option) =>
          option.setName("project").setDescription("Configured project name.").setRequired(false).setAutocomplete(true)
        )
    )
    .addSubcommand((subcommand) => subcommand.setName("roster").setDescription("Show peer devbot capability cards."))
    .addSubcommand((subcommand) =>
      subcommand
        .setName("ritual")
        .setDescription("Create a merge ritual card from task, review packet, validation, and safety state.")
        .addStringOption((option) =>
          option.setName("project").setDescription("Configured project name.").setRequired(true).setAutocomplete(true)
        )
        .addStringOption((option) => option.setName("task").setDescription("Optional saved task ID.").setRequired(false).setAutocomplete(true))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("recent")
        .setDescription("List recent collaboration lab sessions.")
        .addIntegerOption((option) =>
          option.setName("limit").setDescription("Number of sessions to show, 1-25.").setRequired(false).setMinValue(1).setMaxValue(25)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("events")
        .setDescription("Show recent events for one collaboration lab session.")
        .addStringOption((option) => option.setName("id").setDescription("Collaboration session ID.").setRequired(true))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("approve")
        .setDescription("Record a human approval or denial for a lab session.")
        .addStringOption((option) => option.setName("id").setDescription("Collaboration session ID.").setRequired(true))
        .addStringOption((option) =>
          option
            .setName("decision")
            .setDescription("Approval decision.")
            .setRequired(true)
            .addChoices({ name: "approve", value: "approve" }, { name: "deny", value: "deny" }, { name: "read-only", value: "read-only" })
        )
        .addStringOption((option) =>
          option
            .setName("action")
            .setDescription("Optional approved action to run now.")
            .setRequired(false)
            .addChoices({ name: "record only", value: "record" }, { name: "run validation", value: "validate" }, { name: "run merge gates", value: "gates" })
        )
        .addStringOption((option) =>
          option.setName("project").setDescription("Project for the approved action.").setRequired(false).setAutocomplete(true)
        )
        .addStringOption((option) =>
          option.setName("commands").setDescription("Optional comma-separated validation commands.").setRequired(false).setAutocomplete(true)
        )
        .addStringOption((option) => option.setName("note").setDescription("Optional approval note or condition.").setRequired(false))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("safety")
        .setDescription("Show active collaboration safety rules.")
        .addStringOption((option) =>
          option.setName("project").setDescription("Configured project name.").setRequired(false).setAutocomplete(true)
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
      option.setName("question").setDescription("What you want to know or inspect.").setRequired(true)
    )
    .addStringOption((option) =>
      option.setName("project").setDescription("Optional project; defaults to the selected setup repo.").setRequired(false).setAutocomplete(true)
    )
    .addStringOption((option) =>
      option
        .setName("include")
        .setDescription("Optional comma-separated path patterns, e.g. src/*,README.md,*.json.")
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("do")
    .setDescription("Intentionally ask Devbot to make a focused project change.")
    .addStringOption((option) =>
      option.setName("task").setDescription("The concrete change or command workflow to run.").setRequired(true)
    )
    .addStringOption((option) =>
      option.setName("project").setDescription("Optional project; defaults to the selected setup repo.").setRequired(false).setAutocomplete(true)
    )
    .addStringOption((option) =>
      option
        .setName("include")
        .setDescription("Optional comma-separated path patterns, e.g. src/*,README.md,*.json.")
        .setRequired(false)
    ),
  new ContextMenuCommandBuilder()
    .setName("Start Devbot workroom")
    .setType(ApplicationCommandType.Message),
  new SlashCommandBuilder()
    .setName("queue")
    .setDescription("Stack overnight tasks and run them one at a time.")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("add")
        .setDescription("Append a task to the queue.")
        .addStringOption((option) => option.setName("task").setDescription("The task or question to queue.").setRequired(true))
        .addStringOption((option) =>
          option.setName("project").setDescription("Optional project; defaults to the selected setup repo.").setRequired(false).setAutocomplete(true)
        )
        .addStringOption((option) =>
          option
            .setName("mode")
            .setDescription("Ask (read-only) or do (write-capable). Defaults to do.")
            .setRequired(false)
            .addChoices({ name: "ask", value: "ask" }, { name: "do", value: "do" })
        )
    )
    .addSubcommand((subcommand) => subcommand.setName("list").setDescription("List queued, running, and recently finished items."))
    .addSubcommand((subcommand) =>
      subcommand
        .setName("remove")
        .setDescription("Remove a queued item by its list position.")
        .addIntegerOption((option) => option.setName("position").setDescription("Position shown by /queue list.").setRequired(true).setMinValue(1))
    )
    .addSubcommand((subcommand) => subcommand.setName("clear").setDescription("Remove all pending queued items."))
    .addSubcommand((subcommand) =>
      subcommand
        .setName("start")
        .setDescription("Begin running the queue sequentially, one item at a time.")
        .addBooleanOption((option) =>
          option.setName("stop-on-failure").setDescription("Halt the queue if an item fails. Defaults to false.").setRequired(false)
        )
    )
    .addSubcommand((subcommand) => subcommand.setName("stop").setDescription("Stop the queue after the current item finishes."))
    .addSubcommand((subcommand) => subcommand.setName("digest").setDescription("Re-post the morning digest for the current queue.")),
  new SlashCommandBuilder()
    .setName("schedule")
    .setDescription("Owner-only recurring devbot tasks.")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("add")
        .setDescription("Create a recurring task.")
        .addStringOption((option) =>
          option
            .setName("spec")
            .setDescription("daily HH:MM, weekdays HH:MM, or every <N>h, e.g. daily 07:00.")
            .setRequired(true)
        )
        .addStringOption((option) => option.setName("task").setDescription("The task or question to run on schedule.").setRequired(true))
        .addStringOption((option) =>
          option.setName("project").setDescription("Optional project; defaults to the selected setup repo.").setRequired(false).setAutocomplete(true)
        )
        .addStringOption((option) =>
          option
            .setName("mode")
            .setDescription("Ask (read-only) or do (write-capable). Defaults to do.")
            .setRequired(false)
            .addChoices({ name: "ask", value: "ask" }, { name: "do", value: "do" })
        )
    )
    .addSubcommand((subcommand) => subcommand.setName("list").setDescription("List scheduled tasks."))
    .addSubcommand((subcommand) =>
      subcommand
        .setName("remove")
        .setDescription("Delete a scheduled task.")
        .addStringOption((option) => option.setName("id").setDescription("Schedule ID from /schedule list.").setRequired(true))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("pause")
        .setDescription("Pause a scheduled task.")
        .addStringOption((option) => option.setName("id").setDescription("Schedule ID from /schedule list.").setRequired(true))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("resume")
        .setDescription("Resume a paused scheduled task.")
        .addStringOption((option) => option.setName("id").setDescription("Schedule ID from /schedule list.").setRequired(true))
    )
] satisfies Array<Pick<SlashCommandBuilder, "toJSON"> | Pick<ContextMenuCommandBuilder, "toJSON">>;

export const commandDefinitions = commandBuilders.map((command) => command.toJSON());
