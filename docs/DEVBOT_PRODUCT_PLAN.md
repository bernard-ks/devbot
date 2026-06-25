# Devbot Product Plan

Date: 2026-06-24

## Purpose

Devbot is a local Discord interface for Codex-backed development work. Its current strength is that it can answer project questions, run focused local Codex tasks, report active Codex work, and attach live UI screenshots without requiring an OpenAI API key.

The next product step is to make devbot useful for a small team, not just one developer. The most interesting direction is a Discord server with multiple developer-owned devbots that can discover each other, exchange status, request help, hand off work, and coordinate review and merge flows.

## Current Features

- Discord slash commands:
  - `/projects` lists configured local projects.
  - `/status` reports active bot work and detected local Codex sessions for configured projects.
  - `/status image:true` can attach a live local UI screenshot when a web dev server is detected.
  - `/refresh` rebuilds the in-memory project file index.
  - `/ask` answers read-only project questions with local context.
  - `/act` asks local Codex to perform focused project work and return a fixed summary.
- Mention support:
  - Direct bot mentions and matching role mentions can invoke the bot.
  - Status-style mentions avoid unnecessary Codex runs.
  - Action-style mentions route to local Codex with workspace-write sandboxing.
- Local project context:
  - Scans configured project roots.
  - Ignores dependency/build folders and common secret files.
  - Redacts secret-looking values from indexed text.
  - Ranks local files against the user request before building the Codex prompt.
- Local Codex execution:
  - Uses the installed Codex CLI/app session instead of OpenAI API keys.
  - Supports read-only answer mode and workspace-write action mode.
  - Tracks bot-owned active work in memory.
- External local Codex awareness:
  - Detects local Codex app/CLI sessions whose working directory belongs to a configured project.
  - Reports sanitized process status without leaking command prompts.
- UI screenshot support:
  - Detects running local web dev servers such as Next, Vite, React Scripts, Astro, and Nuxt.
  - Opens the running app and navigates through visible links/buttons based on request language.
  - Handles requests like "browse page" or "watchlist view" without reading framework routes from disk.
  - Supports explicit URLs and paths such as `/cards/op01-016` when the user wants an exact target.

## Current Constraints

- Runtime state is in memory. Bot restarts lose active task history.
- The bot has no durable concept of task ownership, handoff, review state, or merge state.
- The context scanner is text-only and does not understand repository structure beyond path/content ranking.
- Screenshot targeting can click one visible matching UI control, but it does not yet plan multi-step flows, log in, seed test data, or navigate complex dynamic states.
- Local Codex process detection is heuristic and depends on command-line shape.
- Permissions are coarse: allow-listed users or roles can use broad bot capabilities.
- There is no durable audit trail beyond Discord messages and local git history.
- There is no formal multi-bot protocol. Two devbots in one Discord server currently cannot reliably discover each other or coordinate.

## Improvement Themes

### 1. Reliability And State

- Add a lightweight SQLite store for:
  - active tasks
  - completed tasks
  - Discord message/thread IDs
  - project aliases
  - review links or branch references and merge state
  - screenshot URLs and capture metadata
- Add task IDs to every `/act` and mention-triggered action.
- Add `/task status <id>`, `/task cancel <id>`, `/task logs <id>`, and `/task retry <id>`.
- Persist work status across bot restarts.
- Add structured logs with request IDs.

### 2. Better Project Awareness

- Add project metadata files, for example `.devbot/project.json`, to describe:
  - canonical project name
  - repo URL
  - default branch
  - frontend URL
  - backend URL
  - test commands
  - build commands
  - owner bot
- Use package manager scripts and known framework files to infer common commands.
- Add project-specific command presets, for example `/run test`, `/run build`, `/run lint`.

### 3. Screenshot And UI Inspection

- Extend screenshots from single-click dynamic navigation to workflow capture:
  - natural language targets: `browse`, `card detail`, `portfolio`, `login`
  - scripted actions: click, search, filter, open modal
  - viewport options: desktop, tablet, mobile
  - authenticated storage state per project
- Add `/snip project:<name> target:<natural-language-or-path> viewport:<desktop|mobile>`.
- Attach screenshot metadata in the Discord reply:
  - URL
  - viewport
  - timestamp
  - console errors
  - failed network requests
- Optionally attach a short Playwright trace for deeper debugging.

### 4. Review And Merge Workflows

- Keep review/merge support provider-neutral instead of coupling devbot to one hosting provider or CLI.
- Make `/act` optionally produce a branch and review packet instead of editing main directly.
- Add merge gates:
  - clean working tree
  - tests pass
  - no unresolved review comments when the configured review provider exposes them
  - approval from allowed users or peer bot
- Add a "handoff packet" format:
  - task summary
  - changed files
  - verification commands
  - known risks
  - review URL or branch reference when available
  - next requested action

### 5. Multi-Dev / Multi-Bot Coordination

The most promising collaborative model is each developer running their own devbot locally, all invited into the same Discord server.

Each bot should represent its local machine and owner:

- `shadow-devbot`
- `tom-devbot`
- `a5omic-devbot`

Each bot can expose what it can safely do:

- projects it owns
- repos it has locally
- active tasks
- available commands
- current branch/dirty state
- running servers
- screenshot capabilities
- allowed handoff actions

Recommended protocol:

- Add a bot-to-bot capability announcement command:
  - `/devbot peers`
  - `/devbot announce`
  - `/devbot capabilities`
- Use Discord messages as the first transport because it is already available and auditable.
- Define a compact JSON payload for bot-to-bot messages, sent in hidden or dedicated coordination channels where possible.
- Use signed or allow-listed peer IDs so random bots cannot request local actions.
- Keep destructive actions owner-approved by default.

Useful interactions:

- Query peer status:
  - "Tom Devbot, what are you working on?"
  - "Shadow Devbot, do you have PullPrice frontend running?"
- Request a screenshot from the peer who owns the UI:
  - "Shadow Devbot, send a snip of the browse page."
- Ask another bot to validate a branch:
  - "A5omic Devbot, pull PR 42 and run backend tests."
- Handoff a task:
  - "Shadow Devbot, hand off PR 42 to Tom Devbot for review."
- Merge with peer validation:
  - author bot creates a branch/review request
  - reviewer bot pulls branch and validates
  - owner approves merge
  - merge bot performs final merge and posts result

MVP multi-bot flow:

1. Each bot has a stable `BOT_OWNER`, `BOT_NAME`, and `PEER_BOT_IDS` config.
2. `/devbot announce` posts capabilities into a server channel.
3. `/peer status bot:<name>` asks another bot for active work.
4. `/peer request bot:<name> action:<status|snip|validate-pr>` sends a structured request.
5. Peer bot replies with a structured result and optional attachments.
6. Human confirmation is required before peer-triggered edits, pushes, or merges.

### 6. Permissions And Safety

- Split permissions by capability:
  - read status
  - request screenshots
  - ask read-only questions
  - run local commands
  - modify files
  - create PRs
  - merge PRs
  - request peer actions
- Add per-project permission rules.
- Require explicit confirmation for:
  - pushing
  - merging
  - deleting branches
  - changing secrets/config
  - running arbitrary shell commands
- Add command allowlists for project scripts.
- Add a global "safe mode" that disables writes and merges.

## Suggested Roadmap

### Phase 1: Stabilize Single-User Devbot

- Add durable task persistence. Baseline implemented with local JSON storage; SQLite remains an optional backend upgrade if task history needs query-heavy reporting.
- Add task IDs and task history commands. Baseline implemented with `/task recent` and `/task show`.
- Update README to reflect current screenshot behavior. Done for dynamic UI screenshots and `/snip`.
- Add project metadata config support.
- Add screenshot diagnostics: console errors and failed requests.

### Phase 2: Review-Centered Workflow

- Add branch/review packet creation mode for `/act`.
- Add review status and verification commands.
- Add review validation command that runs configured tests.
- Add merge gate logic.
- Add a handoff packet generator.

### Phase 3: Multi-Bot Server MVP

- Add bot identity and peer allowlist config.
- Add `/devbot announce` and `/devbot peers`.
- Add structured peer requests over Discord.
- Support peer status and peer screenshot requests.
- Support peer review validation requests.
- Keep edits and merges human-confirmed.

### Phase 4: Team Workflow Automation

- Add durable task queues.
- Add reviewer assignment.
- Add verification/check summarization.
- Add cross-bot handoff threads.
- Add project dashboards in Discord.
- Add automatic stale task reminders.

## Near-Term Backlog

- Update README for live UI screenshot behavior. Done.
- Add `docs/OPERATIONS.md` for setup, restart, and troubleshooting.
- Add `.devbot/project.example.json`.
- Add `/snip` as a dedicated command instead of overloading `/status image:true`. Done.
- Add `/task` command group. Baseline done.
- Add `/review` command group.
- Add `BOT_OWNER`, `BOT_DISPLAY_NAME`, and `PEER_BOT_IDS` config.
- Add a coordination channel ID config.
- Add structured result envelopes for bot-to-bot messages.
- Add tests for peer message parsing and permission enforcement.

## Open Questions

- Should each developer run a unique bot application, or should one Discord application support multiple local workers?
- Should peer bot requests happen in public project channels, private bot coordination channels, or Discord threads?
- What actions should be peer-callable without human approval?
- Should merge authority live with the PR author, repo owner, or a designated release bot?
- Should project metadata live in this repo, each target project, or both?
- Should devbot eventually expose an HTTP local API, or should Discord remain the only transport?

## Recommendation

Build toward a peer-bot model, but do it in layers. First make devbot durable and review-aware for one user. Then add peer discovery and read-only peer queries. Only after that should peer bots be allowed to request validation, pushes, or merges.

The safest initial multi-dev experience is:

1. Everyone runs their own devbot locally.
2. Bots can announce capabilities and answer read-only status/screenshot requests.
3. Bots can generate handoff packets for review requests.
4. Peer validation is allowed with explicit human approval.
5. Merges stay gated by tests, review state, and an explicit owner command.
