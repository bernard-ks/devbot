# Devbot Product Plan

Updated: 2026-07-09

## Purpose

Devbot is a local Discord interface for Codex-backed development work. It answers project questions, runs focused local Codex tasks, reports active work, and attaches live UI screenshots without requiring an OpenAI API key.

The small-team foundation now exists: owner-managed private setup, durable local tasks, peer discovery, sealed councils, approval records, and review handoffs. The next product step is to make those capabilities feel as natural as ordinary Discord conversation while deepening evidence-backed multi-agent work.

## Ambient Workrooms: Ideas 1-8

The ambient workroom slice is now implemented:

1. Natural `@devbot` requests are classified as answer requests or proposed actions. Action-shaped mentions receive a confirmation preview with **Approve and start**, **Edit**, **Answer only**, and **Decline**; no write begins from the mention alone.
2. Each proposal is persisted as an approval-gated task and gets a private Discord task thread when the room supports private thread creation and membership management.
3. Approved write tasks run in a separate `devbot/task/<task-name>` Git branch and worktree outside the source checkout. Completion records the branch, changed files, and bounded diff-status evidence while leaving changes uncommitted for human review. Devbot does not merge or push.
4. `/inbox` and dashboard **Needs Me** show pending decisions for the current user, with private task detail and refresh controls.
5. Completion cards put recorded proof before the result and provide an **Open proof** action for the saved task record.
6. Owner-only `/setup project-room action:bind project:<name> channel:<channel>` binds a private channel or private thread to one project; `action:remove` removes the binding.
7. Workroom roles are Builder, Reviewer, and Verifier. They provide read-only implementation, review, and evidence perspectives before approved work executes, and can be selected on the proposal card.
8. Proposal, progress, proof, and inbox surfaces use bounded Discord Components V2 payloads, strict custom-ID parsing, sanitized text, and state-aware controls.

The safety contract is explicit: only the requester or an approved controller can edit or decline; only the owner or approved controller can approve write work; safe mode blocks write execution; scoped-audience projects decline channel-mention output; scoped proposals close if a private task thread cannot be created; and unavailable Git isolation stops the action before write access. Activity idea 9 is deferred and is not represented as an implemented feature.

## Current Features

- Initial setup:
  - `npm run setup` opens a loopback-only browser wizard.
  - The wizard validates the Discord bot, opens installation, discovers servers, chooses the server owner, registers a local repository, creates the private room, deploys commands, and starts Devbot.
  - Discord application creation and bot-token retrieval remain the only required Developer Portal step.
- Discord slash commands:
  - `/setup wizard` provides resumable owner setup for viewers, controllers, peer bots, a private room, and runtime project roots.
  - `/setup doctor` diagnoses the complete local and Discord setup path, including detected coding-agent backends.
  - `/setup backend` lists detected coding agents with versions and selects the active one.
  - `/projects` lists configured local projects.
  - `/status` reports a decision-ready brief: confirmed bot work and phases, external runs, activity-unknown app sessions, repository evidence, risks, and a recommended next step.
  - `/status image:true` can attach a live local UI screenshot when a web dev server is detected.
  - `/dashboard` opens a personal Discord-native workspace with authorized project selection and modal Ask / Change flows.
  - `/refresh` rebuilds the in-memory project file index.
  - `/ask` answers read-only project questions with local context.
  - `/do` asks local Codex to perform focused project work.
  - Guild command definitions synchronize automatically at startup.
- Mention support:
  - Direct bot mentions can invoke the bot without requesting the privileged Message Content intent.
  - Status-style mentions avoid unnecessary Codex runs.
  - Read-only mentions answer directly; action-shaped mentions open the implemented approval preview and private task workroom flow.
  - Mentioning the bot with an image attachment (stack trace, console error, or broken UI) routes to screenshot-to-fix instead, ahead of the natural-intent/ambient-workroom flow.
- Ambient workrooms:
  - Natural intent previews with approve, edit, answer-only, and decline controls.
  - Private task threads, isolated task branches/worktrees, proof-first completion, and `/inbox` / dashboard Needs Me.
  - Owner-bound project rooms through `/setup project-room`.
  - Builder, Reviewer, and Verifier roles with bounded Components V2 cards.
- Screenshot-to-fix:
  - Mentioning the bot with an image attachment (stack trace, console error, or broken UI) transcribes the visible error using an image-capable local Codex call, then locates the likely file/symbol using the existing project context ranking seeded by the transcribed text.
  - Treats all image content as untrusted error-report data; the analysis prompts explicitly instruct the model never to follow instructions that appear inside the screenshot.
  - Replies with the transcribed error, suspected location, and suggested approach, plus a restart-stable one-tap **Fix it** button (owner/controller-gated) that starts a `/do` task pre-filled with the finding, and a **Dismiss** button.
  - Honestly reports when no error-looking text is visible instead of inventing one; non-image attachments and unauthorized users are ignored per the deny-by-default access model.
- Local project context:
  - Scans static or owner-registered project roots and supports a selected default on multi-project hosts.
  - Ignores dependency/build folders and common secret files.
  - Redacts secret-looking values from indexed text.
  - Ranks local files against the user request before building the Codex prompt.
- Bring-your-own coding-agent backends:
  - Pluggable executor abstraction with Codex CLI as the default and reference backend (unchanged flags) and Claude Code as an opt-in, answers-only alternative.
  - Selection is explicit: `DEVBOT_AGENT_BACKEND`, then the `/setup backend` choice; only Codex is ever auto-selected, so an incidentally installed CLI never becomes the executor.
  - Every backend declares an explicit, tested capability contract (environment policy, user-config/plugin isolation, network behavior, read-only enforcement, action-workspace confinement, cancellation, prompt/output transport, image input) and inherits Codex's hardening: a minimal child environment that never carries Devbot secrets and admits only exact named keys (no prefix admission), and prompts delivered over stdin rather than argv.
  - Both modes are fail-closed from the capability contract: a backend that cannot guarantee read-only refuses answer mode, and a backend that cannot confine writes to the task workspace refuses action mode (Claude answers run under `--safe-mode` with a read-only tool allow list; only Codex runs actions). Screenshot transcription is fail-closed the same way: a request carrying image paths is refused unless the active backend declares `acceptsImageInput`, so a backend whose command builder does not actually forward the image (only Codex does today) can never be asked to inspect one it never receives. Gemini CLI and opencode are detection-only until they pass real-CLI verification; they never execute. Claude compatibility is probed against `--help` for every required safety flag, and Luna / Terra / Sol tiers map to a backend's own model when configured.
- Local Codex execution:
  - Uses the installed Codex CLI/app session instead of OpenAI API keys.
  - Supports read-only answer mode and workspace-write action mode.
  - Routes requests through Luna, Terra, or Sol and chooses none, focused, or full prepacked project context before execution.
  - Tracks active work in memory and persists task history locally.
  - Updates one Discord task message through routing, context preparation, work, failure, cancellation, and completion.
  - Uses restart-stable task controls for follow-up, review, validation, adjustment, retry, and cancellation.
  - Tracks task branch freshness and merged state against the local default branch (`/task freshness`, `/task show`) and rebases stale task branches inside their isolated worktrees on request (`/task sync`) with a backup ref, conflict-abort safety, and honest reporting.
- Agent-vs-agent duel review:
  - `/review duel task:<task-id>` and a **Duel review** button on completed action tasks let a fresh, different-tier Codex session adversarially review the task's actual diff.
  - The reviewer must return a structured verdict citing file:line evidence, or state plainly that a clean diff has no substantive issues rather than inventing nits.
  - The original author gets one rebuttal round to concede, rebut, or withdraw each issue; there is no third round.
  - Results post to a dedicated thread with a resolved issue list (conceded / disputed / withdrawn) and owner **Accept & fix** (pre-fills a `/do` task from conceded issues) / **Dismiss** controls, recorded in the local collaboration store.
- External local Codex awareness:
  - Detects local Codex app/CLI sessions whose working directory belongs to a configured project.
  - Separates confirmed external runs from open app sessions whose activity cannot be known.
  - Reports sanitized repository evidence without leaking process IDs or command prompts.
- UI screenshot support:
  - Detects running local web dev servers such as Next, Vite, React Scripts, Astro, and Nuxt.
  - Opens the running app and navigates through visible links/buttons based on request language.
  - Handles requests like "browse page" or "watchlist view" without reading framework routes from disk.
  - Supports explicit URLs and paths such as `/cards/op01-016` when the user wants an exact target.
- Ship cards (`/ship`-only; see HANDOFF "Review round 1" for why this is narrower than automatic before/after capture):
  - `/do` action tasks always run in an isolated Git worktree (see task-worktree.ts); Devbot has no managed preview of that isolated workspace, so it never screenshots the source checkout's dev server and calls it "proof" of an isolated task's change. Completed action tasks instead get an explicit `captureNote` ("Visual proof unavailable...") on the task record, visible via `/task show`.
  - `/ship task:<task-id>` (also a "Ship it" button on completed action tasks, owner/controller-gated) composes a 1200x675 shareable card with the project name and task summary. For isolated tasks the card is text-only with a "visual proof unavailable for isolated branch" caption; for non-isolated tasks (e.g. answer-mode) it attempts one stabilized live screenshot of the project's detected dev server, when the project's screenshot policy allows it.
  - Screenshots wait for two consecutive identical frames (animations/transitions disabled, `prefers-reduced-motion` emulated) before being used, so loading spinners and blinking carets don't get misread as content.
  - Any screenshot `/ship` does persist lands under `.devbot/captures` with owner-only directory/file permissions (0700/0600), a validated basename-only filename, and pruning to the most recent 200 files.
  - The before/after pixel-diff engine (`visual-diff.ts`: grid-cell clustering, dimension-change-aware, no external image-diff dependency) is retained as tested, reusable primitives for a future managed-preview integration, but nothing wires it automatically today.

## Current Constraints

- Active process tracking is in memory, while task, setup, peer, and collaboration history use local JSON stores rather than a shared database.
- Review packets and approval records are durable. Local branch merge state and freshness are now synchronized on demand: `/task freshness` and `/task show` detect merged and stale task branches, mark merged state durably, and `/task sync` rebases a task branch onto the local default branch inside its isolated worktree with a backup ref and conflict-abort safety. Provider (pull request) merge state remains unsynchronized; Devbot stays local-git only.
- The context scanner is text-only and does not understand repository structure beyond path/content ranking.
- Screenshot targeting can click one visible matching UI control, but it does not yet plan multi-step flows, log in, seed test data, or navigate complex dynamic states.
- Local Codex process detection is heuristic and depends on command-line shape.
- Discord setup state is a local atomic JSON store rather than a shared database; run one Devbot process per setup file.
- A setup-managed private room controls new message visibility, but it cannot retroactively hide messages previously posted in other channels.
- The audit trail spans Discord messages, local task/collaboration stores, and git history; it is not yet centralized or tamper-evident.
- The v2 collaboration protocol supports allow-listed discovery and coordination, but transport is still Discord-specific and peer writes remain human-gated.
- Ambient workroom activity aggregation and the deferred Activity idea 9 are not implemented.

## Improvement Themes

### 1. Reliability And State

- Add a lightweight SQLite store for:
  - active tasks
  - completed tasks
  - Discord message/thread IDs
  - project aliases
  - review links or branch references and merge state
  - screenshot URLs and capture metadata
- Migrate durable local task state to SQLite while keeping task IDs out of normal conversation UI.
- Persist recoverable active execution across bot restarts instead of closing interrupted tasks as canceled.
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
- Make `/do` optionally produce a branch and review packet instead of editing main directly.
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

- `alex-devbot`
- `casey-devbot`
- `riley-devbot`

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
  - "Casey Devbot, what are you working on?"
  - "Alex Devbot, do you have the web frontend running?"
- Request a screenshot from the peer who owns the UI:
  - "Alex Devbot, send a snip of the browse page."
- Ask another bot to validate a branch:
  - "Riley Devbot, pull PR 42 and run backend tests."
- Handoff a task:
  - "Alex Devbot, hand off PR 42 to Casey Devbot for review."
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
- Add screenshot diagnostics: console errors, failed requests, bad HTTP responses, URL, viewport, and timestamp. Done.

### Phase 2: Review-Centered Workflow

- Add branch/review packet creation mode for `/do`. MVP implemented as `/review packet`, which can include a saved task ID and local git state.
- Add review status and verification commands. MVP implemented with `/review validate`.
- Add review validation command that runs configured tests. Done through project metadata commands.
- Add merge gate logic. MVP implemented as `/review gates`; it checks clean working tree plus configured validation without merging.
- Add a handoff packet generator. Done through `/review packet`.

### Phase 3: Multi-Bot Server MVP

- Add bot identity and peer allowlist config. Done with `BOT_OWNER`, `BOT_DISPLAY_NAME`, and `PEER_BOT_IDS`.
- Add `/devbot announce` and `/devbot peers`. Done.
- Add structured peer requests over Discord. Done with JSON envelopes.
- Support peer status and peer screenshot requests. Done for allow-listed peers.
- Add versioned collaboration envelopes for lab workflows. Done with v2 collab request/result/approval/event envelopes.
- Support peer planning and review-packet requests. Done through `/lab` workflows.
- Support peer review validation requests. Implemented as approval-card requests; command execution remains owner-gated.
- Keep edits and merges human-confirmed. Done by keeping write, command, push, merge, deploy, install, and secret/config operations behind approval boundaries.

### Phase 4: Team Workflow Automation

- Add durable task queues.
- Add reviewer assignment.
- Add verification/check summarization.
- Add cross-bot handoff threads. MVP implemented as `/lab handoff` cards and peer review-packet requests; lab sessions now create Discord audit threads where the channel supports them.
- Add project dashboards in Discord. Implemented as a personal interactive `/dashboard` workspace plus a shared setup launcher.
- Add automatic stale task reminders. MVP implemented as `/task stale`; automatic timed reminders remain deferred to avoid surprise channel noise.
- Add private devbot collaboration lab. MVP implemented with `/lab council`, `/lab roundtable`, `/lab see`, `/lab handoff`, `/lab bossfight`, `/lab jam`, `/lab argue`, `/lab fix-from-snip`, `/lab campfire`, `/lab roster`, `/lab ritual`, `/lab recent`, `/lab events`, `/lab approve`, and `/lab safety`.

### Phase 5: Multiplayer Agent Workrooms

- Add persistent workroom phases, stable participants, contribution records, decisions, and control-message references. Baseline implemented in collaboration state version 2.
- Add independent sealed proposals before synthesis to reduce first-answer anchoring. Implemented with 2-4 parallel local council seats plus correlated peer contributions in `/lab council`.
- Add native human controls for challenge, reveal, synthesis, approval, denial, and close. Implemented with Discord buttons; decisions do not execute mutations.
- Correlate peer invitations and reject forged, duplicate, or late contributions. Implemented for council requests and results.
- Publish the provider-neutral collaboration envelope and workroom contract. Baseline documented in `docs/COLLABORATION_PROTOCOL.md`.
- Add bot capability passports and evidence-backed trust levels.
- Add an experiment arena that compares isolated implementations and independent evaluation.
- Add provenance-backed team memory and cross-repository contract negotiation.
- Add adapters for coding agents beyond the local Codex runtime. Delivered so far: the pluggable backend contract with Codex (answers and actions, unchanged) and opt-in Claude Code read-only answers; Gemini CLI and opencode are detection-only placeholders. Future work is real-CLI verification for the placeholder adapters, action-workspace confinement beyond Codex, and deeper per-backend model routing.

## Near-Term Backlog

- Update README for live UI screenshot behavior. Done.
- Add `docs/OPERATIONS.md` for setup, restart, and troubleshooting. Done.
- Add `.devbot/project.example.json`. Done.
- Add `/snip` as a dedicated command instead of overloading `/status image:true`. Done.
- Add `/task` command group. Baseline done.
- Add `/review` command group. Done.
- Add `BOT_OWNER`, `BOT_DISPLAY_NAME`, and `PEER_BOT_IDS` config. Done.
- Add a coordination channel ID config. Done with `COORDINATION_CHANNEL_ID`.
- Add structured result envelopes for bot-to-bot messages. Done.
- Add collaboration event persistence. Done with `.devbot/collab.json`.
- Add tests for peer message parsing and permission enforcement. Peer parsing tests added; permission enforcement is handled by `PEER_BOT_IDS` and should get deeper integration tests when Discord handlers are split out.

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
