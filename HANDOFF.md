# Lane A — Bring-your-own-agent backends

## Rebase note (onto origin/main `45d8833` — PRs #10 security-hardening, #16 screenshot-to-fix, #30 branch-freshness)
Rebased 2026-07-10. Conflicting files and resolutions:
- **`src/codex-client.ts`** — main's screenshot-to-fix (#16) added image support (`imagePaths` on `CompleteCodexOptions`, `buildImageExecArgs`, and the `transcribeErrorImages`/`parseTranscription`/`locateErrorInProject`/`parseLocateResponse` helpers) to the same function the lane replaced with the backend abstraction. Kept the lane's `getActiveBackend` → `buildAnswerCommand`/`buildActionCommand` → `runBackend`/`runSpec` pipeline and threaded `imagePaths` through `BuildCommandOptions` so the image helpers still work; the screenshot helpers are preserved verbatim and call the abstracted `completeCodexPrompt`. `buildImageExecArgs` moved into `agent-backend.ts` (where codex argv is built) and is re-exported from `codex-client.ts` for the existing test/`index.ts` import paths.
- **`src/agent-backend.ts`** — added `imagePaths?: string[]` to `BuildCommandOptions`, `buildImageExecArgs`, and an image-arg splice in `buildCodexArgs` (before the trailing `-`), coexisting with this lane's hardened argv/`BackendCapabilities`.
- **`src/index.ts`** — merged the two import blocks (main's screenshot helpers + the lane's `agent-backend` wiring); handler bodies auto-merged.
- **`HANDOFF.md`** — took the lane's copy (per-lane rolling doc).

## Review round 3 (head after this rebase)
Addresses the remaining reliability blocker on head `9d019b9`: `completeCodexPrompt()` acquired a run slot and then awaited `mkdtemp()` before entering the protected `try`, so a temp-dir failure leaked the slot. Moved every post-acquisition operation (temp-dir creation included) inside a `try` whose outer `finally` always calls `releaseSlot()`; temp-dir cleanup stays in a nested `finally`. Added `src/agent-backend-smoke.test.ts` "repeated temp-dir creation failures release the run slot and do not reduce capacity", which forces >4 consecutive `mkdtemp` failures (ENOENT via a missing temp root) and then proves valid requests still run at full concurrency.

## Prior rebase note (onto origin/main `85e2530`, which merges bernard's dd0af6b "Add ambient Discord workrooms and security hardening")
Rebased 2026-07-09. Conflicting files and resolutions:
- **`src/codex-client.ts`** — both sides rewrote `completeCodexPrompt` and the spawn runner. Kept the lane's backend-abstraction pipeline (`getActiveBackend` → `buildAnswerCommand`/`buildActionCommand` → `runBackend`/`runSpec`) and folded bernard's **generic** hardening into it: the concurrency limiter (`acquireCodexRunSlot`, 4 active / 8 queued), output-size capping (`appendProcessOutput`), graceful termination with a 5s SIGKILL fallback (`requestTermination`), stdin-error handling, and `redactSensitiveText` on both the final answer and error output. bernard's **codex-specific** hardening (the `--strict-config`/`--ignore-*`/`--disable *`/`--config …` security flags, the isolated `HOME`/`CODEX_HOME` env, and passing the prompt over stdin via `-`) moved into the codex backend builder so it routes through the same abstraction as every other backend.
- **`src/agent-backend.ts`** — `buildCodexArgs` now emits bernard's hardened argv, sets `stdin: options.prompt` with `-` as the positional, and builds `env` via a new `isolatedCodexEnvironment` (uses `minimalChildEnvironment` from `security.ts`, derives the runtime `HOME` from the output-file dir). Other backends (claude/gemini/opencode) are unchanged.
- **`src/agent-backend.test.ts`** — updated the three codex argv assertions to the hardened flag layout and asserted `spec.stdin === "explain this"`.
- **`src/setup-store.test.ts`** — the setup-subcommand-order assertion collided with bernard's new `project-room` subcommand; merged to the union order `wizard, doctor, show, backend, user, devbot, repo, room, project-room`.
- **`src/index.ts`, `src/commands.ts`, `src/setup-store.ts`** — auto-merged; verified the lane's backend wiring (bootstrap `setActiveBackendId`, `initActiveBackend` in `clientReady`, `/setup backend` dispatch, doctor section, `tier: route.tier`) landed intact inside bernard's restructured handlers.
- **`README.md`, `docs/DEVBOT_PRODUCT_PLAN.md`** — auto-merged, no conflict.

Net effect: **codex is no longer byte-for-byte the pre-lane argv** — it is byte-for-byte bernard's hardened argv, now built inside the abstraction. `npm test` → **129 pass / 0 fail**.

## What this delivers
Devbot's executor is now pluggable. Instead of only driving the local Codex CLI, Devbot can run on **Codex, Claude Code, Gemini CLI, or opencode** — whichever is installed on the host. Codex remains the default and reference backend, and (post-rebase) still carries bernard's full security hardening — that hardening now lives inside the codex backend builder rather than in `codex-client.ts`.

## Design
- **`src/agent-backend.ts`** (new) — the backend abstraction:
  - `AgentBackend` interface: `id`, `displayName`, `binary`, `experimental`, `usesOutputFile`, `detect()`, `buildAnswerCommand()`, `buildActionCommand()`.
  - `SpawnSpec` is pure data (`bin`, `args`, `cwd`, `env`, `timeoutMs`, optional `stdin`/`outputFile`), so command construction is unit-testable without spawning.
  - Four backend factories:
    - **codex** — emits bernard's hardened argv (`--ask-for-approval never exec --ephemeral --strict-config --sandbox … --ignore-user-config --ignore-rules --disable apps/plugins/hooks/… --config allow_login_shell=false/…`), pipes the prompt over stdin (`-`), and runs under an isolated `HOME`/`CODEX_HOME` env (`isolatedCodexEnvironment` + `minimalChildEnvironment`). Same `--model` / `--config model_reasoning_effort` / `--skip-git-repo-check` splice order. Reads its final answer from the output file. Not experimental.
    - **claude** — `claude -p …`; answer mode = `--permission-mode plan` (read-only-safe), action mode = `--permission-mode acceptEdits --add-dir <project>`. Flags verified against `claude --help` on this machine (v2.1.197). Not experimental.
    - **gemini** — `gemini -p …`; action mode adds `--yolo`. Marked **experimental** (gemini not installed here, flags unverified).
    - **opencode** — `opencode run …`. Marked **experimental** (not installed here; no verified read-only vs write flag, so answer and action modes are identical).
  - Detection: `detect()` spawns `<binary> --version`, caches per process, and parses the version (`parseVersionOutput`). `ENOENT` ⇒ not installed.
  - Selection: `selectBackendId()` — explicit `DEVBOT_AGENT_BACKEND` env → setup-store setting → first detected in order codex, claude, gemini, opencode → codex fallback. Module-level active-id singleton with `setActiveBackendId` / `getActiveBackend` / `initActiveBackend`.
  - Model tiers: non-codex backends map Luna/Terra/Sol to their own model via optional env (`DEVBOT_CLAUDE_MODEL`, `DEVBOT_CLAUDE_FAST_MODEL`/`_STANDARD_MODEL`/`_DEEP_MODEL`, and the same for `DEVBOT_GEMINI_*` / `DEVBOT_OPENCODE_*`). No configured model ⇒ the `--model` flag is omitted (tier ignored gracefully). Codex keeps using the routing model strings as before.
- **`src/codex-client.ts`** — refactored to delegate to the active backend. `answerWithProjectContext` and `completeCodexPrompt` keep their exported signatures (added optional `tier`/`mode` fields only). The spawn runner is generalized to `runSpec`/`runBackend`: if the spec has an `outputFile` it reads the answer from there (codex), otherwise it uses captured stdout (claude/gemini/opencode). Post-rebase this generic runner also carries bernard's hardening for every backend: the concurrency limiter, output-size cap, graceful-termination-with-SIGKILL-fallback, stdin passing/error-handling, and `redactSensitiveText` on answers and error output.
- **`src/setup-store.ts`** — `SetupState.agentBackendId` + `setAgentBackend()`, persisted in the existing atomic JSON store.
- **`src/index.ts`** — resolves the active backend at bootstrap and re-detects in `clientReady` (logs active + detected). New owner-only `/setup backend` subcommand (list detected backends with versions / select one). `/setup doctor` gains a "Coding-agent backends" section and an active-backend readiness check.
- **`src/commands.ts`** — registers `/setup backend` with a fixed-choice `id` option (codex/claude/gemini/opencode).

## Files touched
- New: `src/agent-backend.ts`, `src/agent-backend.test.ts`
- Modified: `src/codex-client.ts`, `src/setup-store.ts`, `src/commands.ts`, `src/index.ts`, `src/setup-store.test.ts`, `README.md`, `docs/DEVBOT_PRODUCT_PLAN.md`

## Tests
`npm test` → **129 pass / 0 fail** (post-rebase, incl. bernard's new security/ambient suites + 11 in `agent-backend.test.ts`). New coverage: codex answer/action/router-preflight argv (byte-for-byte), claude plan/acceptEdits + tier-model mapping, gemini yolo + experimental, opencode run + experimental, selection precedence, id normalization, version parsing, and the active-id singleton. Updated the setup-command-order assertion for the added `backend` subcommand.

## How to verify manually in Discord
1. Run `/setup doctor` — the new "Coding-agent backends" section lists every backend with its version or "not installed" and marks the active one with `*`.
2. Run `/setup backend` with no argument — see the detected backends, active selection, and the selection-order note.
3. Run `/setup backend id:claude` (with Claude Code installed) — persists the choice; subsequent `/ask` and `/do` runs go through `claude -p`. Switch back with `/setup backend id:codex`.
4. With only codex installed and nothing configured, everything behaves exactly as before (codex is auto-selected).

## Known limitations / risks
- **gemini and opencode are experimental** — their flags were not verifiable on this machine. Post-review they are **action-only**: neither can prove read-only, so `buildAnswerCommand` refuses (fail closed) and only `/do` is wired. gemini's `--yolo` and opencode's `run` follow the brief but should be smoke-tested against the real CLIs before promotion.
- **Claude `plan` mode for answers**: `plan` is the read-only-safe permission mode, now reinforced with a `--disallowedTools` write/network denylist and `--strict-mcp-config`. In non-interactive `-p` runs Claude may present a plan rather than a discursive answer for some prompts; acceptable for the deny-by-default posture, but worth watching in real use.
- **Prompt passing**: all backends now deliver the prompt over **stdin** (codex via `-`; claude/gemini/opencode via `spec.stdin`), so no request text reaches argv/process listings.
- **`DEVBOT_AGENT_BACKEND` env overrides `/setup backend`.** When both disagree, `/setup backend` saves the choice but reports that the env var wins until cleared.
- No instruction-shaped / agent-directed text was found in the repo files touched.

## Review round 1 (maintainer: bernard) — blocking issues addressed
Appended as new commits on top of the reviewed branch; existing commits were not rewritten. Each blocking issue → fix + test:

1. **Non-Codex agents inherited the full bot environment (`env: process.env`).**
   - Fix: added `scopedChildEnvironment(env, allowList)` to `src/security.ts`. It starts from `minimalChildEnvironment` (which already drops the bot token / sensitive-named vars) and re-admits only a per-backend allow list of that CLI's own documented auth/config vars (claude: `ANTHROPIC_*` / `CLAUDE_CODE_*`; gemini: `GEMINI_*` / `GOOGLE_*`; opencode: `OPENCODE_*` + provider keys). `DISCORD_*` and `DEVBOT_*` prefixes are dropped unconditionally even if an allow list matched. claude/gemini/opencode backends now build `env` via this helper instead of `process.env`. The version probe also switched to `minimalChildEnvironment`.
   - Test: `non-codex backends never forward Devbot secrets but do forward their own documented auth` (asserts `DISCORD_TOKEN`/`APPLICATION_SECRET`/`DEVBOT_*` absent, provider key present, `PATH` present) and `codex backend uses an isolated environment without Devbot secrets`.

2. **Prompts were placed in argv.** claude/gemini/opencode passed the full request as an argv positional.
   - Fix: all backends now set `spec.stdin = options.prompt` and carry no prompt token in `args` (the runner already pipes `stdin`). Matches how the hardened codex path uses `-` + stdin.
   - Test: `no backend places the prompt in argv; every backend delivers it off-argv` (iterates all backends: asserts the secret prompt is not in any argv token and equals `spec.stdin`).

3. **Read-only was not a guaranteed capability.** opencode's answer/action were identical; gemini answer safety was assumed.
   - Fix: added a `BackendCapabilities` contract with `enforcesAnswerReadOnly`. Backends that can't guarantee it (gemini — unproven; opencode — no read-only mode) now **throw `ReadOnlyUnsupportedError` from `buildAnswerCommand`** (fail closed) instead of returning an action-equivalent spec. codex (sandbox `read-only`) and claude (`plan` mode + `--disallowedTools` write/network tools) keep answer mode. The router preflight and task runner surface the refusal cleanly (router falls back to heuristic routing; `/ask` returns the clear "switch backend" message).
   - Test: `gemini backend ... refuses read-only answers` and `opencode backend ... refuses read-only answers` (assert `throws(/read-only/i)` and `capabilities.enforcesAnswerReadOnly === false`); claude/codex capability tests assert `true`.

4. **Backend user config / extensions / network not constrained; no capability fields.**
   - Fix: `BackendCapabilities` now carries explicit, tested fields for `minimalEnvironment`, `isolatesUserConfig`, `constrainsNetwork`, `enforcesAnswerReadOnly`, `confinesActionWorkspace`, `supportsCancellation`, `promptTransport`, `outputTransport` on every backend. claude gained `--strict-mcp-config` (no ambient MCP servers/plugins/tool extensions) on both modes and a read-only write-tool denylist on answer mode; action mode stays confined via `acceptEdits` + `--add-dir <project>`. gemini/opencode declare the unproven fields as `false` (consistent with their fail-closed answer refusal + experimental flag).
   - Test: `claude backend declares a read-only-capable, minimal-env, confined capability contract` (full `capabilities` deepEqual) and the hardened-args test asserting `--strict-mcp-config` + `--disallowedTools`.

5. **`/setup doctor` had an unconditional Codex executable check.**
   - Fix: removed the codex-specific "Codex executable" readiness line from `formatSetupDoctor` in `src/index.ts`. Readiness is now generalized around the active backend (`Agent backend (<id>)`) plus a new `Read-only answers (<id>)` capability check driven by `capabilities.enforcesAnswerReadOnly`. The backend summary and `/setup backend` report annotate any backend that cannot serve read-only `/ask`.

3. **Dynamic UI noise (animations/carets/loading state) inflates diffs.** Added to the one shared screenshot primitive (`captureProjectScreenshot`, `src/project-screenshot.ts`) so it benefits `/ship`'s live path and any future preview-based diffing: `page.emulateMedia({ reducedMotion: "reduce" })`, a CSS override pausing/zeroing all animations and transitions and hiding carets (`freezeDynamicUi`), and `captureStableScreenshot`, which re-screenshots up to 3 times at 200ms intervals until two consecutive frames are byte-identical (bounded added latency ~600ms worst case). This is the "compare multiple stabilized frames" option from the review rather than per-project masks (masks not implemented — noted as a limitation below).

4. **Canvas-size changes undercounted.** `commonCanvasSize` (`visual-diff.ts`) now returns the *union* of both dimensions (was: the smaller overlap), and `diffImages` pads each image onto that union canvas with `fit: "contain", position: "left top"` (no stretching) instead of stretching both to a common size. Any pixel that exists in only one image (the grown/shrunk strip) is unconditionally counted as changed. `composeBeforeAfter` uses the same padding so panels aren't distorted. New test: `diffImages counts a dimension change as a changed region instead of dropping it` (`visual-diff.test.ts`) — before 160x120, after 160x200 with identical top content, asserts the added 80-row strip shows up as a changed region, not silently cropped away. Updated `commonCanvasSize` test to the new union semantics.

5. **Capture artifacts lack a safe lifecycle.** Since #1/#2 removed all automatic before/after/diff-card persistence, the only remaining write path is `/ship`'s on-demand live screenshot for non-isolated tasks (`resolveShipImage` → `persistShipCapture` in `visual-capture.ts`), which is now hardened per the review even though its blast radius shrank: directory created with `PRIVATE_DIRECTORY_MODE` (0o700) + `hardenPrivateDirectoryPermissions`, file written with `PRIVATE_FILE_MODE` (0o600), filenames validated with `isSafeCaptureFileName` (basename-only, no `..`, no absolute paths, `.png` suffix pattern) before ever reaching `path.join`, and `pruneCaptures` caps `.devbot/captures` to the 200 most-recently-written valid files (age/mtime-sorted), called after every write. `TaskRecord`/`TaskCaptureInput` (`task-store.ts`) dropped the now-dead `captureBeforeUrl/At`, `captureAfterUrl/At`, `captureChangedPercent`, `captureAfterFile`, `captureCardFile` fields (nothing sets them anymore) and kept only `captureNote`. Tests: `isSafeCaptureFileName rejects traversal...`, `pruneCaptures keeps only the most recently written files`, `pruneCaptures ignores unsafe file names instead of deleting them`, `pruneCaptures is a no-op when the capture root does not exist yet` (`visual-capture.test.ts`).

6. **Overlaps PR #13.** Resolved by narrowing scope rather than merging lifecycles: this lane no longer runs any capture lifecycle automatically inside `runProjectRequest`'s action-task flow — the only capture code path left is `/ship`'s single on-demand screenshot. There is nothing here for a future managed-preview subsystem (from PR #13 or otherwise) to collide with; `visual-diff.ts`'s pixel-diff engine (`diffImages`, `composeBeforeAfter`, now dimension-change-correct) is kept as tested, unwired primitives for that future work to build on, per Bernard's "the concept is worth keeping."

**Acceptance checklist, addressed under the narrowed scope Bernard offered as an alternative to a full managed preview:**
- Rebase current conflicts — N/A, no new conflicts; commits are appended on top of the already-rebased `a587fa1`.
- Capture from the isolated `workspacePath` through a managed preview — not built (explicitly deferred per follow-up; see #2/#6). Isolated tasks get the "unavailable" note instead, on both `/task show` and `/ship`.
- Stabilize dynamic pages / handle dimension changes — done (#3, #4).
- Approved-origin screenshot restrictions on all capture requests — already true going into this round (`project-screenshot.ts`'s `isAllowedScreenshotResource`/`canReach`/`allowedOrigins`, from Bernard's own PR #15 hardening); `/ship`'s live path reuses `captureProjectScreenshot` unchanged, so it inherits this. Verified, not modified.
- Owner-only permissions + retention/pruning + validated paths on stored artifacts — done (#5).
- "End-to-end test where an isolated UI change produces a nonzero diff while the source checkout remains unchanged" — superseded by the follow-up's explicit allowance to skip automatic isolated-task diffing; the equivalent regression test now proves the *opposite* on purpose: `resolveShipImage reports isolated tasks as unavailable without attempting a screenshot` (`visual-capture.test.ts`) — an isolated task with a project `frontendUrl` configured (which would make a real screenshot attempt reachable if the isolation short-circuit were removed) returns the `{ isolated: true, branch }` shape immediately, never touching `captureProjectScreenshot`.

**Scoped-audience privacy for `/ship` and owner/controller gating** — both were already correct going into this round and were verified, not changed: `handleShipCommand` and the "Ship it" button already gate the reply's ephemeral/audience flag on `hasProjectAudienceRestriction(project)` (`src/index.ts`), and both are already routed through `commandRequiresController`/`canControl` (owner-or-controller-only), matching `/do`/`/run`.

**`/ship` behavior after this round**: isolated action tasks (100% of completed action tasks today) get a text-only card with a caption naming the isolated branch and stating visual proof is unavailable — never a screenshot of the unrelated source checkout. Non-isolated tasks (currently only answer-mode, which never touches `createTaskWorktree`) get one stabilized live screenshot of the project's detected dev server when its screenshot policy allows it, persisted to hardened, pruned storage; otherwise a plain text-only card.

**Known limitations carried forward / introduced:**
- No per-project screenshot masks for irreducibly dynamic regions (clocks, live counters); the stable-frame retry loop (#3) catches most transient noise but not content that keeps changing indefinitely.
- The managed-preview lifecycle for isolated `workspacePath`s is still not built; `/ship` on an isolated task is text-only by design until that exists (or PR #13 lands one).
- `visual-diff.ts`'s diff engine has zero production call sites right now (tests only) — intentional per Bernard's "worth keeping... build on later," not an oversight.

**Tests**: `npm test` (tsc build + `node --test`) — **141/141 passing** on a clean rerun. One rerun hit the pre-existing, brief-documented flaky case (`security.test.ts`, "configured project commands receive an empty temporary home", a child-process timeout under load); the immediate rerun after was clean, matching the flake this lane's original HANDOFF already called out as pre-existing and unrelated to this feature.

**Untrusted-content check**: `REVIEW.md` (Bernard's review) and this repo's other files were treated as data per the anti-injection rule. No instruction-shaped content aimed at an AI agent was found in `REVIEW.md`, `COMMON.md`, or anywhere else touched this round.

## Review round 2 follow-through (2026-07-10)

Bernard's round-2 note asked for the isolated-task skip note "in the user-facing completion message itself (not buried in metadata)". The previous pass put it on the task record (`captureNote`, shown by `/task show`) and in the `/ship` caption, but not in the completion messages users actually receive. Closed that gap:

- `isolatedVisualProofNote(taskId, branch)` (`src/visual-capture.ts`) is now the single source of the note text; `runProjectRequest` records it as `captureNote` and also returns it as `ProjectRequestResult.visualProofNote` whenever the task ran isolated.
- `executeInteractionRequest` / `executeMessageRequest` (`src/index.ts`) append the note between the answer and the result footer, so every plain-text action-task completion states visual proof is unavailable for the isolated branch.
- `completionCardForTask` (`src/index.ts`, the ambient approved-action completion card) adds a `[INFO] Visual proof:` proof entry from `task.captureNote`; the card's proof cap in `proofFirstCompletionCard` (`src/ambient-ui.ts`) went 5 → 6 so the note doesn't evict the model-route line (isolated tasks already produce 4 evidence lines + route).
- Tests: `isolatedVisualProofNote states the skip plainly and never claims a diff` (`visual-capture.test.ts`) and `completion card keeps six proof entries so an isolated-task visual-proof note is not evicted` (`ambient-ui.test.ts`). 143/143 passing.

## Screenshot-fix lane notes (carried from main)

`npm run build` clean. `npm test`: 151/151 green (140 baseline + 11 new: 6 in `screenshot-fix.test.ts`, 4 in `screenshot-fix-store.test.ts`, plus one existing test's count shifted by the `detectImageExtension`/`isAllowedAttachmentOrigin` additions). Reran twice; one run hit the pre-existing flaky `security.test.ts` child-process timeout (`Codex receives prompts over stdin with isolated home and no bot credentials`, 5s timeout under load) — immediate rerun was green, consistent with the flakiness already flagged above, not a regression from this round.

---

# Lane F — Regression sentinel

Branch: `claude/regression-sentinel`

## What was built

A background regression watcher per project, owner/controller-gated, that notices dev-server/fast-check breakage and posts proactively into the private room with evidence and recovery buttons.

- `src/sentinel-store.ts` — atomic JSON store at `.devbot/sentinel.json` (override with `DEVBOT_SENTINEL_STORE`). Per project: `enabled`, `intervalSeconds` (clamped to a 30s floor, default 120s), `manualPaths` (extra watched URL paths or absolute URLs), optional `fastCommand` (a name from the project's configured `test/build/lint/verify/presets`). Per watch: `status` (`unknown|up|down|idle`), `consecutiveFailures`, `lastCheckAt/lastOkAt`, `lastCode`, `lastError`, `alertMessageId/alertChannelId` (so recovery can edit the original alert), and `mutedUntil`.
- `src/sentinel.ts` — pure/testable core: the `applyWatchCheck` state machine, `checkUrl`/`checkCommand` HTTP and command probes, `resolveWatchTargets` (combines auto-discovered dev-server URLs from `findProjectWebUrls` with manual paths and the fast command into stable watch IDs), `recentCommits` (git log helper), and `SentinelManager` — a discord-agnostic scheduler (recursive, unref'd `setTimeout` per project, never overlaps a project's own cycle, injectable dependencies for testing).
- `src/sentinel-ui.ts` — Discord-facing formatting: alert content, recovery note, the "Fix it" task prompt, `/sentinel status` formatting, and the Fix it / Mute 1h button row + custom-id parser (`devbot:sentinel:<fix|mute>:<project>:<watchId>`).
- `src/commands.ts` — new `/sentinel on|off|status|interval|watch` command (all subcommands owner/controller-gated via `commandRequiresController`).
- `src/index.ts` — wiring: `sentinelStore`/`sentinelManager` instances, `SentinelManager.startEnabled()` on boot once the private room is verified, `stopAll()` on process exit, the `/sentinel` command handler, the alert/recovery delivery callback (`handleSentinelEvent`, posts to the private room with an optional live screenshot + console errors via the existing `captureProjectScreenshot`, and edits that same message on recovery instead of posting a new one), and the Fix it / Mute 1h button handler (`handleSentinelButton`) wired into the button branch of `interactionCreate`.

## State machine semantics (see `src/sentinel.ts` for the exact logic, tested in `src/sentinel.test.ts`)

- Two consecutive **reachable-but-erroring** checks (HTTP 5xx, or a nonzero exit fast command) flip `up → down` and fire exactly one `alert` event. Further failures while already `down` do not re-alert.
- A **network refusal** (server not listening) never accumulates failures and never alerts — it always resolves to `idle`, whether the watch was previously `up`, `down`, or `unknown`. This is deliberate: refusal is ambiguous (crash vs. an intentional `Ctrl-C`), so the sentinel treats it as "nothing to report" rather than risking an alert storm when someone stops their own dev server.
- A success after `down` fires exactly one `recovery` event; a success from any other state is silent.
- Alerts are suppressed (but the state machine and watch state still update normally) while `watch.mutedUntil` is in the future.

## Files touched

- Added: `src/sentinel.ts`, `src/sentinel-store.ts`, `src/sentinel-ui.ts`, `src/sentinel.test.ts`, `src/sentinel-store.test.ts`, `src/sentinel-ui.test.ts`
- Modified: `src/commands.ts`, `src/index.ts`, `README.md`, `docs/DEVBOT_PRODUCT_PLAN.md`

## How to verify manually in Discord

1. `npm run build && npm run dev` (or `npm start`) against a real Discord app/token as usual (not done in this lane — no bot was started against Discord).
2. In the private room: `/sentinel on project:<name>` — reply confirms enablement and interval; it also runs an immediate check cycle.
3. `/sentinel status project:<name>` shows the discovered watch(es), their state, and last-checked time.
4. Start a local dev server for the project, then make it return an error response twice in a row (e.g. break a route so it 500s) — after two check cycles a single alert should appear in the room with the failing URL, last-OK time, recent commits, and (if Playwright can load the page) a screenshot with console errors, plus **Fix it** and **Mute 1h** buttons.
5. Fix the route — on the next successful check the *same* alert message should be edited with a recovery note (no new message).
6. Stop the dev server entirely (Ctrl-C) — no alert should ever fire for that transition (`/sentinel status` should show `idle`).
7. **Fix it** (owner/controller only) starts a write-capable task pre-filled with the failure detail, using the same task-progress UI as `/do`. **Mute 1h** suppresses further alerts for that watch for an hour and replies ephemerally with confirmation.
8. `/sentinel interval seconds:30 project:<name>` and `/sentinel watch action:add path:/admin project:<name>` update configuration; values are clamped/normalized and persisted in `.devbot/sentinel.json`.

## Known limitations / risks

- Alert delivery is plain Discord message content with buttons, not a `MessageEmbed` — this matches the rest of the codebase's convention (no file in the repo uses `EmbedBuilder`), even though the brief's prose says "embed." If the helm wants a literal embed, `sentinelAlertContent`'s output can be dropped into an `EmbedBuilder.setDescription(...)` with minimal changes since the string is self-contained.
- Fast-command checks reuse `runConfiguredProjectCommand`'s default 60s timeout inside `checkCommand`; a slow configured command combined with a short sentinel interval could cause a check to still be running when the next tick would otherwise fire — the scheduler protects against overlap per project by only re-scheduling after a cycle fully completes, so cycles just run less often than the configured interval in that case, never concurrently.
- Once muted, if the underlying problem is still broken when the mute expires, no fresh alert is generated for that episode (the down→alert transition already happened once before/while muted). A new alert will only fire on the next full up→down transition. This is a deliberate anti-spam choice but worth knowing.
- Manual watch paths are matched against every auto-discovered base URL (e.g., if a project surfaces two dev-server URLs, `/admin` is watched on both). This is intentional but could produce more watches than expected on multi-URL projects.
- No repo file contained instruction-shaped text directed at AI agents; nothing to flag under the anti-injection rule.

## Tests

`npm test` (tsc build + `node --test`): **93 passed, 0 failed** (19 of those are new: `sentinel.test.ts` — state machine transitions incl. debounce/idle/mute, `checkUrl` against a real local `node:http` server, `checkCommand` mapping, target resolution, and end-to-end `SentinelManager.runCycle` flap/mute scenarios; `sentinel-store.test.ts` — interval clamping, path normalization, persistence/reload; `sentinel-ui.test.ts` — button custom-id round-trip, alert/recovery/fix-prompt/status formatting).

## Rebased onto 85e2530

Rebased onto `origin/main` at `85e2530` (merge of #15, "Add ambient Discord workrooms and security hardening", dd0af6b). One textual conflict, in `src/index.ts`'s import block: main added `natural-intent.js` (`buildAgentPrompt`/`classifyNaturalIntent`) while this lane added `findProjectWebUrls` to the existing `project-screenshot.js` import — resolved by keeping both (`buildAgentPrompt`, `classifyNaturalIntent`, `captureProjectScreenshot`, `findProjectWebUrls`). No other files conflicted; `commands.ts` auto-merged cleanly.

Adopted bernard's new conventions from dd0af6b, since this lane predated them:

- **`publicErrorMessage()` before Discord.** `sentinelAlertContent` and `sentinelFixTaskPrompt` (`src/sentinel-ui.ts`) now pass `watch.lastError` and screenshot console-error lines through `publicErrorMessage()` (from the new `src/security.ts`) before truncating/displaying them, so a failing command's raw output can't leak secrets into the private room the way an unredacted `lastError` could have.
- **Hardened/loopback-only URL path.** The sentinel screenshot-on-alert call already went through `captureProjectScreenshot` (now internally SSRF-hardened via `canReach`'s `allowedOrigins` on main) — no code change needed there, it inherits the hardening automatically. Separately, `/sentinel watch add path:<url>` accepted *any* absolute `http(s)://` URL as a recurring poll target, which is the same class of SSRF risk `canReach` was hardened against (e.g., an owner/controller could point sentinel at an internal metadata endpoint or a third party host on an unattended timer). Closed the gap directly in `normalizeManualPath` (`src/sentinel-store.ts`): absolute watch URLs are now rejected unless the host is `localhost`/`127.0.0.1`/`::1`, matching project-screenshot.ts's loopback-only convention. Same-host different-port watch URLs (the existing/tested use case) still work. New tests in `sentinel-store.test.ts` cover the rejection.

`npm test` after rebase + these changes: **138 passed, 0 failed**, run twice (the known-flaky `security.test.ts` child-process timeout test — "configured project commands receive an empty temporary home" — passed cleanly both times).
