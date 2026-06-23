# Devbot

A local Discord bot that lets you ask development questions from Discord while the bot pulls read-only context from configured projects on the machine where it is running.

It uses:

- Discord slash commands for `/ask`, `/projects`, and `/refresh`
- OpenAI Responses API for model answers
- Local project scanning with default ignores for `.git`, `node_modules`, build output, lock artifacts, and secret-looking files

This queries an OpenAI API model, not this exact Codex session. The useful part is that the bot can package the relevant local project files into each request so the model answers with your repo context.

## Setup

1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID`, and `OPENAI_API_KEY`.
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

The optional `include` field accepts comma-separated path patterns. `*` is supported as a wildcard, so examples like `src/*`, `README.md`, or `*.json` work.

## Project Context Behavior

The scanner is intentionally read-only. It ranks files by path and content matches against your question, then sends a bounded set of relevant snippets to OpenAI.

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

The bot needs permission to read and send messages in the channels where you use the slash commands.
