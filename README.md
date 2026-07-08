# Devbot

A local Discord bot that lets you ask development questions and request focused project actions from Discord while the bot pulls context from configured projects on the machine where it is running.

It uses:

- Discord slash commands for `/ask`, `/act`, `/status`, `/snip`, `/task`, `/dashboard`, `/run`, `/review`, `/devbot`, `/peer`, `/projects`, and `/refresh`
- `@devbot` mentions for action-style requests
- the local Codex CLI for model answers
- Local project scanning with default ignores for `.git`, `node_modules`, build output, lock artifacts, and secret-looking files

This does not require an OpenAI API key. Each request runs `codex exec` locally, using your signed-in Codex app/CLI setup.

## Setup

1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, and `DISCORD_GUILD_ID`.
3. Copy `config/projects.example.json` to `config/projects.json` and map project names to env-backed local paths on the machine running devbot. For quick one-off setup, you can instead set `PROJECTS_JSON` in `.env`.
4. Optionally copy `.devbot/project.example.json` into each target project at `<project>/.devbot/project.json` and customize URLs, aliases, and validation commands.
5. Install dependencies:

   ```bash
   npm install
   ```

6. Deploy slash commands to your test Discord server:

   ```bash
   npm run commands:deploy
   ```

7. Start the bot:

   ```bash
   npm run dev
   ```

For production, run:

```bash
npm run build
npm start
```

## Discord Commands

- `/projects`: List configured projects.
- `/status project:<optional> question:<optional> image:<optional>`: Show Codex dev work currently running through this bot process, plus local Codex sessions detected for configured project paths. Add a question for a deeper read-only status update, and set `image:true` to attach a live project UI screenshot when a local web app is detected.
- `/snip project:<optional> target:<text>`: Attach a live project UI screenshot by opening the running app and navigating visible UI controls from the target text. Explicit paths and local URLs are also supported.
- `/task recent project:<optional> status:<optional> limit:<optional>`: List recent saved devbot tasks from local task history.
- `/task show id:<task-id>`: Show one saved task with request, status, and result or error preview.
- `/task status id:<task-id>`: Alias for showing one saved task.
- `/task logs id:<task-id>`: Show the saved request, result preview, and error text.
- `/task cancel id:<task-id>`: Mark a running saved task as canceled in local history.
- `/task retry id:<task-id>`: Retry a saved task with the same project, mode, text, and include patterns.
- `/task stale minutes:<optional> project:<optional>`: List running tasks older than a selected threshold.
- `/dashboard project:<optional>`: Show active work, recent tasks, project metadata, and configured commands.
- `/run project:<name> command:<name>`: Run a configured command from `<project>/.devbot/project.json`, such as `test`, `build`, `lint`, `verify`, or a named preset.
- `/review packet project:<name> task:<optional>`: Create a provider-neutral review handoff packet from git status, diff stat, last commit, and optional task context.
- `/review validate project:<name> commands:<optional>`: Run configured validation commands.
- `/review gates project:<name> commands:<optional>`: Check merge gates without merging: clean working tree plus validation pass.
- `/devbot capabilities`: Show this bot's owner, safe mode, projects, and command capabilities.
- `/devbot announce`: Post a structured capability announcement for peer devbots.
- `/devbot peers`: List peer devbots that have announced themselves.
- `/peer status bot:<id-or-mention> project:<optional>`: Ask an allow-listed peer bot for read-only status.
- `/peer snip bot:<id-or-mention> target:<text> project:<optional>`: Ask an allow-listed peer bot for a live UI screenshot.
- `/refresh project:<name>`: Rebuild the in-memory file index for a project.
- `/ask project:<name> question:<text> include:<optional patterns>`: Ask the model a question with local project context.
- `/act project:<name> task:<text> include:<optional patterns>`: Ask local Codex to perform a focused project task and return a fixed `Project / Request / Actions / Verification / Result` summary.

You can also mention the bot in a channel:

```text
@devbot fix the failing test
@devbot project:api include:src/* add logging around failed webhooks
@devbot what's currently in progress
@devbot what's the status on the web build, send me a snip of the browse page
```

If only one project is configured, mentions default to that project. If multiple projects are configured, include `project:<name>`.

Status-style mentions such as `@devbot wip`, `@devbot current dev work`, or `@devbot what's currently in progress` do not invoke Codex. They return the bot's active in-memory work tracker plus sanitized local Codex process matches for configured project paths, or `No Codex dev work is currently in progress.` when idle. If a status mention includes a deeper question, the bot runs a read-only Codex status update. If the message asks for a snip, screenshot, image, or picture, the bot tries to attach a live project UI screenshot. Page hints such as `browse page` or `watchlist` are handled by opening the running app and navigating through visible UI controls instead of reading framework routes from disk. Explicit paths like `/cards/op01-016` are still supported when you want an exact target.

The optional `include` field accepts comma-separated path patterns. `*` is supported as a wildcard, so examples like `src/*`, `README.md`, or `*.json` work.

Task history is stored locally in `.devbot/tasks.json` by default. Peer registry state is stored in `.devbot/peers.json`. Set `DEVBOT_TASK_STORE` or `DEVBOT_PEER_STORE` to use different files; relative paths resolve from the devbot process working directory.

## Project Metadata

Each target project can define optional metadata at `<project>/.devbot/project.json`.

```json
{
  "canonicalName": "webapp",
  "frontendUrl": "http://127.0.0.1:3000",
  "defaultBranch": "main",
  "aliases": ["web", "frontend"],
  "commands": {
    "test": ["npm test"],
    "build": ["npm run build"],
    "verify": ["npm run build && npm test"],
    "presets": {
      "quick-check": "npm run build"
    }
  }
}
```

Devbot only runs commands declared in that metadata file. `DEVBOT_SAFE_MODE=true` disables write-capable work: `/act`, action-style mentions, `/task retry` for action tasks, `/run`, `/review validate`, and `/review gates`.

## Peer Bots

For multi-dev servers, each developer can run a separate bot application and add the other bot user IDs to `PEER_BOT_IDS`.

Use `/devbot announce` to publish capabilities. Peer requests are sent as structured Discord messages and are limited to read-only capabilities in this MVP: capabilities, status, and screenshots. Peer-triggered edits, pushes, and merges are intentionally not enabled.

## Project Context Behavior

The scanner ranks files by path and content matches against your question or task, then passes a bounded set of relevant snippets to local Codex.

By default:

- `/ask` uses `CODEX_SANDBOX=read-only`.
- `/act` and mentions use `CODEX_ACTION_SANDBOX=workspace-write`.

Defaults are conservative:

- Maximum indexed file size: `80 KB`
- Maximum context per file: `12 KB`
- Maximum packed project context: `120,000 characters`
- Default ignored paths include `.git`, `node_modules`, `dist`, `build`, `coverage`, `.env`, private keys, logs, and common binary media files

Tune these in `src/config.ts` if you need a larger or smaller context window.

## License

MIT. See `LICENSE`.

## Discord App Notes

In the Discord Developer Portal, create an application, add a bot, enable the bot token, and invite it to your server with these scopes:

- `bot`
- `applications.commands`

The bot needs permission to read and send messages in the channels where you use it. Mention support also requires the `Message Content Intent` toggle under the bot's privileged gateway intents.
