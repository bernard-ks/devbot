# Devbot Operations

## Local Start

For a first installation:

```bash
npm install
npm run setup
```

The local browser tool validates Discord, opens the bot install flow, discovers the selected server, chooses the server owner as the bootstrap owner, registers a repository, creates the private room, writes ignored local state, deploys commands, and starts Devbot.

For an already-configured installation:

```bash
npm run dev
```

Guild slash commands synchronize automatically on startup. `npm run commands:deploy` remains available as a manual recovery command.

Use production mode when you do not need hot reload:

```bash
npm run build
npm start
```

## Required Discord Setup

- `DISCORD_TOKEN`
- `DISCORD_CLIENT_ID`
- `DISCORD_GUILD_ID`
- `DEVBOT_OWNER_USER_ID` for owner-only Discord setup

The Discord application needs the `bot` and `applications.commands` scopes. Devbot only processes ordinary messages that directly mention it, which Discord documents as an exception to the privileged Message Content intent; no privileged intent toggle is required.

## Project Setup

The recommended flow is the private, resumable owner wizard:

```text
/setup wizard
```

It creates or adopts the private room, registers local repository paths, chooses the default repository, and adds optional viewers, controllers, and peer Devbots with native Discord selectors. For scripted recovery or advanced maintenance, the equivalent commands remain available:

```text
/setup repo action:add name:webapp path:/absolute/path/to/webapp
/setup repo action:add name:api path:/absolute/path/to/api
/setup repo action:default name:webapp
/projects
```

The default repo is used by mentions and by `/ask`, `/do`, `/run`, and `/lab council` when their optional `project` field is omitted. Other project-aware commands retain autocomplete so an operator can choose a different root per request.

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
    "allowedUsernames": [],
    "allowedRoles": [],
    "allowedPeers": ["123456789012345678"],
    "screenshotPolicy": "approval",
    "readOnlyCommands": ["test", "lint"],
    "approvalRequiredCommands": ["verify", "deploy"]
  }
}
```

Empty `allowedUsers`, `allowedUsernames`, and `allowedRoles` preserve the global bot allow-list for project-specific commands. Empty `allowedPeers` means any globally allow-listed peer can ask about the project. `screenshotPolicy` can be `allow`, `approval`, or `deny`.

For global bot access, set one or more of:

```bash
ALLOWED_USER_IDS=123456789012345678
ALLOWED_USERNAMES=alex-dev,team-lead
ALLOWED_ROLE_IDS=234567890123456789
```

If any global allow-list is configured, a Discord user must match at least one configured ID, account username, or role. User IDs are the most stable option. Account usernames are case-insensitive; mutable global display names and guild nicknames are intentionally ignored.

## Owner-Managed Private Setup

`npm run setup` handles the first room and repository automatically. After the bot starts, `/setup wizard` manages additional people, peer Devbots, rooms, and repositories. The owner can also configure the server with individual commands:

```text
/setup user action:add user:@alex permission:view
/setup user action:add user:@casey permission:control
/setup devbot action:add bot:@casey-devbot
/setup room name:devbot-private
/setup show
```

- `view` allows read-only questions, status, screenshots, and planning workflows.
- `control` includes view access and enables `/do`, action-task retries, `/run`, task cancel, review validation/gates, and `/lab approve`.
- Only `DEVBOT_OWNER_USER_ID` can run `/setup`.
- `/setup room` creates a text channel that denies visibility to `@everyone` when the bot has `Manage Channels`. Otherwise it adopts the current private thread or creates an invite-only one with `Create Private Threads`, then synchronizes member IDs directly.
- Once a setup room exists, Devbot rejects normal commands and mentions outside it. `/setup` remains available to the owner from another channel for recovery.
- Discord `/setup` commands only mutate the local setup store. The initial `npm run setup` tool writes the Discord bootstrap values to the ignored `.env` once.

## Common Commands

```bash
npm run build
npm test
npm run setup
npm run commands:deploy
```

Slash commands are guild-scoped and hash-synchronized at startup. To force a manual refresh after changing `src/commands.ts`, run:

```bash
npm run commands:deploy
```

## Runtime State

By default, devbot writes local runtime state under `.devbot/` in this repo:

- `.devbot/tasks.json`
- `.devbot/peers.json`
- `.devbot/collab.json`
- `.devbot/setup.json`
- `.devbot/runtime.pid`

Override these paths with:

- `DEVBOT_TASK_STORE`
- `DEVBOT_PEER_STORE`
- `DEVBOT_COLLAB_STORE`
- `DEVBOT_SETUP_STORE`
- `DEVBOT_RUNTIME_LOCK`

Relative override paths are resolved from the devbot process working directory.
Use absolute paths if you want state stored outside this repo.

These files are intentionally not committed.

## Request Routing

Recommended local routing configuration:

```bash
CODEX_ROUTING_ENABLED=true
CODEX_ROUTER_MODEL=gpt-5.6-luna
CODEX_ROUTER_REASONING_EFFORT=low
CODEX_FAST_MODEL=gpt-5.6-luna
CODEX_FAST_REASONING_EFFORT=low
CODEX_STANDARD_MODEL=gpt-5.6-terra
CODEX_STANDARD_REASONING_EFFORT=medium
CODEX_DEEP_MODEL=gpt-5.6-sol
CODEX_DEEP_REASONING_EFFORT=ultra
CODEX_FOCUSED_CONTEXT_CHARS=24000
```

Luna handles direct requests, Terra handles ordinary focused project work, and Sol is reserved for broad or consequential reasoning. Normal replies use these friendly names; task details and logs retain the concrete model, context mode, route source, and reason.

Routing is not an authorization layer. Mention parsing, owner/controller checks, safe mode, and sandbox selection happen outside the router. Write requests are deterministically clamped to at least Terra with focused context, even if model output says otherwise. If routing is disabled, unavailable, malformed, or timed out, Devbot uses the deterministic fallback policy.

## Safe Mode

Set this to disable configured command execution and review validation:

```bash
DEVBOT_SAFE_MODE=true
```

Safe mode still allows read-only mentions, status, ask, screenshots, task reads, dashboards, and peer read-only coordination. It blocks `/do`, `/task retry` for action tasks, `/run`, `/review validate`, and `/review gates`.

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

For peer-backed `/lab council` sessions, `COORDINATION_CHANNEL_ID` is required and should reference a private text channel or private thread visible only to approved humans and allow-listed peer bots. Devbot automatically unarchives a configured coordination thread and adds a target peer before sending. The human workroom is a separate private thread. If private-thread creation or the coordination room is unavailable, the council deliberately falls back to local-only operation in an ephemeral response.

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
/lab council project:webapp prompt:should we add Redis or keep the cache in process? seats:3
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

Lab sessions persist workroom state to `.devbot/collab.json`. The store tracks lifecycle phase, stable participants, correlated peer invitations, sealed contributions, synthesis, decisions, and an event timeline. Existing version 1 files are migrated in memory and saved as version 2 after the next mutation. Malformed state fails loudly rather than being replaced.

Run only one Devbot process against a given collaboration state file. In-process mutations are serialized and written atomically, but the JSON backend is not a multi-process database. Give each bot its own `DEVBOT_COLLAB_STORE` path.

For `/lab council`, use the workroom buttons in the generated Discord thread:

The command starts three independent local seats in parallel by default: Product Steward, Systems Builder, and Evidence Verifier. Set `seats:2`, `seats:3`, or `seats:4`; the fourth seat is Operations Guardian. Each response is persisted as a separate sealed task and no seat sees another seat's answer.

- `Challenge` adds one independent skeptical contribution before reveal.
- `Reveal` closes collection with the responses already present and publishes them.
- `Synthesize` asks the local chair to weigh the revealed evidence and recommend one next action. It waits while invited peers are pending unless the human explicitly reveals early.
- `Approve` and `Deny` record a decision but execute no code or commands.
- `Close` makes the workroom terminal.

Sealed contributions are hidden by Devbot's workroom APIs and UI until reveal. They are still present in the local state file and travel through the configured private Discord coordination channel, so this is anti-anchoring rather than cryptographic secrecy.

Peer lab requests use versioned envelopes. Read-only peer actions can return status, screenshots, plans, and review packets. Validation and gates can be run after `/lab approve`; arbitrary command execution, writes, pushes, merges, deploys, installs, and secret/config changes should show an approval card and wait for the owner.

## Review Workflow

Recommended flow:

1. Ask Devbot to implement with `/do`.
2. Open the response's **Details** button or use `/task show <id>`.
3. Generate `/review packet project:<name> task:<id>`.
4. Run `/review validate project:<name>`.
5. Run `/review gates project:<name>`.
6. Commit, push, and merge outside devbot unless you have added a separate controlled merge integration.

`/review gates` checks that the working tree is clean and configured validation commands pass. It does not merge.
