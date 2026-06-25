# Devbot Operations

## Local Start

```bash
npm install
npm run commands:deploy
npm run dev
```

Use production mode when you do not need hot reload:

```bash
npm run build
npm start
```

## Required Discord Setup

- `DISCORD_TOKEN`
- `DISCORD_CLIENT_ID`
- `DISCORD_GUILD_ID`

The Discord application needs the `bot` and `applications.commands` scopes. Mention support requires the Message Content Intent.

## Project Setup

Configure project roots with `config/projects.json`:

```json
{
  "pullprice": "/Users/bernard/Documents/PullPrice"
}
```

Optional per-project metadata lives inside the target project:

```text
/Users/bernard/Documents/PullPrice/.devbot/project.json
```

Use `.devbot/project.example.json` from this repo as the template.

## Common Commands

```bash
npm run build
npm test
npm run commands:deploy
```

Slash commands are guild-scoped. After changing `src/commands.ts`, run:

```bash
npm run commands:deploy
```

## Runtime State

By default, devbot writes local runtime state under `.devbot/` in this repo:

- `.devbot/tasks.json`
- `.devbot/peers.json`

Override these paths with:

- `DEVBOT_TASK_STORE`
- `DEVBOT_PEER_STORE`

These files are intentionally not committed.

## Safe Mode

Set this to disable configured command execution and review validation:

```bash
DEVBOT_SAFE_MODE=true
```

Safe mode still allows read-only status, ask, screenshots, task reads, and peer read-only coordination.

## Screenshot Troubleshooting

Devbot chooses screenshot targets in this order:

1. Explicit local URL in the request.
2. Explicit route path in the request.
3. Project metadata `frontendUrl`.
4. `PROJECT_SCREENSHOT_URL`.
5. `PROJECT_SCREENSHOT_URLS_JSON`.
6. Detected local dev server process for the configured project root.

Screenshot replies include:

- final URL
- viewport
- capture timestamp
- console errors
- failed requests
- bad HTTP responses

If screenshots always hit the wrong app, set `frontendUrl` in the target project's `.devbot/project.json`.

## Peer Bot Setup

Each developer should run a unique Discord bot application. Configure:

```bash
BOT_OWNER=shadow
BOT_DISPLAY_NAME=shadow-devbot
PEER_BOT_IDS=123456789012345678,234567890123456789
COORDINATION_CHANNEL_ID=1519068605613080790
```

Then run:

```text
/devbot announce
/devbot peers
/peer status bot:<peer-bot-id> project:pullprice
/peer snip bot:<peer-bot-id> project:pullprice target:browse page
```

Peer actions are read-only in this MVP. File edits, pushes, merges, and arbitrary commands remain human-initiated locally.

## Review Workflow

Recommended flow:

1. Ask devbot to implement with `/act`.
2. Inspect `/task show <id>`.
3. Generate `/review packet project:<name> task:<id>`.
4. Run `/review validate project:<name>`.
5. Run `/review gates project:<name>`.
6. Commit, push, and merge outside devbot unless you have added a separate controlled merge integration.

`/review gates` checks that the working tree is clean and configured validation commands pass. It does not merge.
