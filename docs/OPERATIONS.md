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
  "webapp": "${DEVBOT_PROJECT_ROOT}"
}
```

Keep machine-specific paths in `.env`, for example:

```bash
DEVBOT_PROJECT_ROOT=/path/to/local/webapp
```

For quick local testing, you can also set `PROJECTS_JSON` in `.env`; when it is
omitted, devbot reads `config/projects.json`.

Optional per-project metadata lives inside the target project:

```text
/path/to/local/webapp/.devbot/project.json
```

Use `.devbot/project.example.json` from this repo as the template.

Project metadata can also include a `policy` block:

```json
{
  "policy": {
    "visibility": "team",
    "allowedUsers": [],
    "allowedRoles": [],
    "allowedPeers": ["123456789012345678"],
    "screenshotPolicy": "approval",
    "readOnlyCommands": ["test", "lint"],
    "approvalRequiredCommands": ["verify", "deploy"]
  }
}
```

Empty `allowedUsers` and `allowedRoles` preserve the global bot allow-list for project-specific commands. Empty `allowedPeers` means any globally allow-listed peer can ask about the project. `screenshotPolicy` can be `allow`, `approval`, or `deny`.

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
- `.devbot/collab.json`

Override these paths with:

- `DEVBOT_TASK_STORE`
- `DEVBOT_PEER_STORE`
- `DEVBOT_COLLAB_STORE`

Relative override paths are resolved from the devbot process working directory.
Use absolute paths if you want state stored outside this repo.

These files are intentionally not committed.

## Safe Mode

Set this to disable configured command execution and review validation:

```bash
DEVBOT_SAFE_MODE=true
```

Safe mode still allows read-only status, ask, screenshots, task reads, dashboards, and peer read-only coordination. It blocks `/act`, action-style mentions, `/task retry` for action tasks, `/run`, `/review validate`, and `/review gates`.

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
BOT_OWNER=local
BOT_DISPLAY_NAME=local-devbot
PEER_BOT_IDS=123456789012345678,234567890123456789
COORDINATION_CHANNEL_ID=123456789012345678
```

Then run:

```text
/devbot announce
/devbot peers
/peer status bot:<peer-bot-id> project:webapp
/peer snip bot:<peer-bot-id> project:webapp target:browse page
```

Peer actions are read-only in this MVP. File edits, pushes, merges, and arbitrary commands remain human-initiated locally.

## Collaboration Lab

Use `/lab` for private devbot collaboration in Discord:

```text
/lab roundtable project:webapp prompt:what should we build first?
/lab see project:webapp target:browse page
/lab bossfight project:webapp task:<task-id>
/lab handoff project:webapp task:<task-id> target:<peer-bot-id-or-human>
/lab fix-from-snip project:webapp target:/settings complaint:the spacing feels broken
/lab campfire minutes:30
/lab roster
/lab ritual project:webapp task:<task-id>
/lab events id:<collab-id>
/lab approve id:<collab-id> decision:approve action:validate project:webapp commands:test note:run tests only
/lab safety project:webapp
```

Lab sessions write an append-only local index to `.devbot/collab.json`. Discord remains the human-visible audit trail; the local store exists so the bot can list recent lab sessions, inspect events, record approvals, and correlate peer replies.

Peer lab requests use versioned envelopes. Read-only peer actions can return status, screenshots, plans, and review packets. Validation and gates can be run after `/lab approve`; arbitrary command execution, writes, pushes, merges, deploys, installs, and secret/config changes should show an approval card and wait for the owner.

## Review Workflow

Recommended flow:

1. Ask devbot to implement with `/act`.
2. Inspect `/task show <id>`.
3. Generate `/review packet project:<name> task:<id>`.
4. Run `/review validate project:<name>`.
5. Run `/review gates project:<name>`.
6. Commit, push, and merge outside devbot unless you have added a separate controlled merge integration.

`/review gates` checks that the working tree is clean and configured validation commands pass. It does not merge.
