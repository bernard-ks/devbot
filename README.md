# Devbot

A local Discord bot that lets you ask development questions and request focused project actions from Discord while the bot pulls context from configured projects on the machine where it is running.

It uses:

- Discord slash commands for `/ask`, `/act`, `/projects`, and `/refresh`
- `@devbot` mentions for action-style requests
- the local Codex CLI for model answers
- Local project scanning with default ignores for `.git`, `node_modules`, build output, lock artifacts, and secret-looking files

This does not require an OpenAI API key. Each request runs `codex exec` locally, using your signed-in Codex app/CLI setup.

## Setup

1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, and `DISCORD_GUILD_ID`.
3. Copy `config/projects.example.json` to `config/projects.json` and map project names to local paths.
4. Install dependencies:

   ```bash
   npm install
   ```

5. Deploy slash commands to your test Discord server:

   ```bash
   npm run commands:deploy
   ```

6. Start the bot:

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
- `/refresh project:<name>`: Rebuild the in-memory file index for a project.
- `/ask project:<name> question:<text> include:<optional patterns>`: Ask the model a question with local project context.
- `/act project:<name> task:<text> include:<optional patterns>`: Ask local Codex to perform a focused project task and return a fixed `Project / Request / Actions / Verification / Result` summary.

You can also mention the bot in a channel:

```text
@devbot fix the failing test
@devbot project:api include:src/* add logging around failed webhooks
```

If only one project is configured, mentions default to that project. If multiple projects are configured, include `project:<name>`.

The optional `include` field accepts comma-separated path patterns. `*` is supported as a wildcard, so examples like `src/*`, `README.md`, or `*.json` work.

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

## Discord App Notes

In the Discord Developer Portal, create an application, add a bot, enable the bot token, and invite it to your server with these scopes:

- `bot`
- `applications.commands`

The bot needs permission to read and send messages in the channels where you use it. Mention support also requires the `Message Content Intent` toggle under the bot's privileged gateway intents.
