# Lane A — Bring-your-own-agent backends

## Rebase note (onto origin/main `85e2530`, which merges bernard's dd0af6b "Add ambient Discord workrooms and security hardening")
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

### Residual notes for the maintainer
- gemini and opencode remain **experimental** and are only wired for `/do` (action) after the fail-closed answer refusal; they still need a real-CLI smoke test for action/cancellation/timeout/output parsing before promotion. No real third-party CLI is spawned in tests.
- claude `--strict-mcp-config` blocks ambient MCP/plugin extensions, but the CLI has no flag to fully ignore `~/.claude/settings.json`; in `plan`/read-only answer mode this cannot grant writes, and action mode stays scoped to the project dir. Documented rather than assumed.
- `npm test` → **133 pass / 0 fail** (rerun once: the first run's single failure was the known flaky child-process timeout in `security.test.ts`, green on rerun).
