# Lane J — Agent-vs-agent duel review

## What this adds (current scope: stage 1, read-only)

A second, independent Codex session adversarially reviews a completed write-capable task's
change evidence, an author-side session gets one rebuttal round, and the resolved outcome
(conceded / disputed) surfaces to the owner in a dedicated Discord thread. The duel is
deliberately read-only in this stage: it never creates write tasks. Automated "Accept & fix"
returns as stage 2, once the reviewed snapshot is reproducible for a fix task and the
decision-to-task transition is atomic (see "Review round 2 — stage-1 rescope" below).

- `/review duel task:<task-id>` — owner/controller-only slash command.
- A **Duel review** button on completed action-mode task cards (owner/controller-gated), next to
  Follow up / Review changes / Run checks.
- Reviewer round: a fresh read-only Codex session, always on a *different* Luna/Terra/Sol tier than
  the author used (fast/standard → reviewer runs deep; deep → reviewer runs standard), given
  evidence built against the task's recorded base revision — committed, staged, unstaged, and
  bounded untracked changes, sensitive paths excluded, redacted, byte-budgeted, and pinned by a
  SHA-256 patch hash — and asked to return a structured `VERDICT:` + `ISSUE severity=... file=...
  line=... claim=...` block, or approve plainly when the diff is clean.
- Rebuttal round: only runs if the reviewer raised at least one issue. An author-side session (a
  fresh session on the author's tier, no continuity with the original run) gets the same evidence
  plus the reviewer's issues and must respond with one `RESPONSE id=... stance=concede|rebut
  reasoning=...` line per issue. No unilateral withdraw, no third round.
- Verdict parsing fails closed: approve requires zero issues, request-changes requires at least
  one valid issue, and anything empty, malformed, or contradictory is `indeterminate` — surfaced
  as UNRESOLVED with its parser warnings, never as a clean pass.
- The duel is recorded as a `CollabStore` conversation (new `"duel"` intent) with a dedicated
  audit thread, plus a durable, versioned `DuelStore` record created *before* model work runs
  (running/succeeded/failed, restart-safe). Clean, failed, and dismissed duels close their
  conversation terminally so they never pile up against the open-collaboration limit.
- Thread message: summary (verdict, tiers, reviewer-independence status, snapshot identity,
  evidence coverage, warnings, N issues: X conceded / Y disputed) + the issue list with
  severities, file:line, reviewer claim, and author response.
- If any issue was conceded, a **Copy fix prompt** button (owner/controller only, bound to the
  duel's own control message) replies ephemerally with a copyable `/do`-style follow-up prompt and
  a truthful explanation that this stage never starts the task itself; **Dismiss** records a
  `deny` decision one-shot and closes the duel.

## Files touched

- `src/duel.ts` (new) — engine + pure logic: diff budgeting/truncation, verdict/rebuttal tolerant
  parsers, issue-status resolution matrix, reviewer-tier selection, prompt builders, Discord
  summary/issue formatting, `gatherDuelChangeEvidence` (impure `git diff` + truncation), and
  `runDuelReview` (the two-round engine, with an injectable `complete` fn for testing, mirroring
  `request-router.ts`'s pattern).
- `src/duel.test.ts` (new) — 16 unit tests covering diff truncation (empty/small/oversized-file/
  budget-exhausted), verdict parsing (well-formed/malformed/empty/approve-with-stray-text),
  rebuttal parsing (well-formed/empty/unknown-id), the issue-status resolution matrix, tier
  selection, tier labels, fix-task prompt construction, and two engine-level tests (clean diff
  skips rebuttal; issue found runs both rounds) using an injected fake `complete`.
- `src/duel-ui.ts` (new) — Discord button customId encoding and tolerant parsing plus the
  control-message binding predicate: `devbot:duel-control:review:<taskId>`,
  `devbot:duel-control:prompt|dismiss:<conversationId>`.
- `src/task-controls.ts` — imports `duelReviewButton`; adds it to `taskActionRows` for
  succeeded action-mode tasks when the viewer can control.
- `src/collab-protocol.ts` — added `"duel"` to `CollabIntent` (type + runtime array); no other
  protocol changes.
- `src/commands.ts` — added `/review duel task:<task-id>` subcommand (autocomplete reuses the
  existing generic `task`-named-option autocomplete handler, no new autocomplete wiring needed).
- `src/index.ts` — `handleReviewDuelCommand`, `handleDuelControl`,
  `runDuelForTask` (shared by the slash command and the button), `recordDuelAudit`;
  a new customId dispatch branch for the duel buttons;
  widened `startLabConversation`/`createLabThread` parameter types to also accept
  `ButtonInteraction` (both already only used `.channel`/`.user`/`.channelId`, which both
  interaction kinds have) so the button-triggered duel can reuse the exact same thread-creation
  path as `/lab` commands.
- `README.md`, `docs/DEVBOT_PRODUCT_PLAN.md` — feature bullets.
- `formatDevbotHelp` in `src/index.ts` — one discovery line under `/devbot help`.

## How to verify manually in Discord

1. Run a `/do` task that touches at least one file and let it succeed.
2. Click **Duel review** on the completed task card (or run `/review duel task:<id>`).
3. Confirm a new thread appears (named like `duel Duel review: task-... <suffix>`) with the
   posting bot's header, then the verdict/issue summary.
4. If issues were raised, confirm the author's response lines appear per issue and the
   conceded/disputed counts in the summary match, along with the snapshot identity, evidence
   coverage, and any parser warnings.
5. If ≥1 issue was conceded, click **Copy fix prompt**, confirm you get an ephemeral copyable
   `/do`-style prompt plus an explanation that this stage never starts the task itself, and
   confirm no task starts.
6. Click **Dismiss** and confirm it records the decision and closes the duel, and that clicking
   either decision button again says the duel was already decided.
7. Confirm a non-owner/non-controller account cannot trigger `/review duel`, the button, or the
   decision buttons, and that the decision buttons refuse clicks relayed from any message other
   than the duel's own control message.
8. Run a duel against a clean change (reviewer approves, nothing conceded) and confirm its
   workroom conversation is closed automatically rather than left open.

## Known limitations / risks

- Diff evidence is captured at duel time against the task's recorded base revision and pinned by a
  patch hash, but it still reads the task workspace as it exists when the duel runs; if the
  workspace changed since the task finished, the review honestly covers the current state (and
  records that identity), not a time-of-completion archive. Task records don't retain a
  time-of-completion snapshot today; that archival snapshot is a stage-2 prerequisite.
- The reviewer/rebuttal prompts ask the model to follow an exact line format; the parsers are
  tolerant (regex-based, warn-and-degrade on drift) but a badly-misbehaving model could still
  produce output with no parseable verdict on a genuinely dirty diff. That now resolves to an
  `indeterminate` result surfaced as UNRESOLVED with warnings — never a silent approve — but it
  does mean a duel can end without a usable verdict when the reviewer ignores the format entirely.
- No repo file contained instruction-shaped text directed at AI agents; nothing to flag there.
- Two full Codex read-only invocations per duel (reviewer + optional rebuttal) can take a while
  back-to-back for a `deep`/Sol-tier reviewer; the slash command and button both defer the reply
  immediately and the thread/summary land once both rounds finish, so Discord's interaction timeout
  should not be hit, but this is slower than every other single-round command in devbot today.

## Rebased onto 85e2530

Rebased onto `origin/main` at `85e2530` ("Add ambient Discord workrooms and security hardening",
`dd0af6b`), which landed isolated per-task git worktrees (`src/task-worktree.ts`), a hardened
`codex-client.ts` (stdin prompts, isolated env, redaction, concurrency limits), and
`security.ts`/`publicErrorMessage()`. Only conflict was the import block at the top of
`src/index.ts` (both sides added imports); resolved by keeping both.

Semantic fix required beyond the textual merge: `runDuelForTask` was still gathering diff evidence
and setting the reviewer's `cwd` from the raw `project` passed in. With isolated task worktrees, a
completed action task's actual changes live in `task.workspacePath`, not the source checkout, so
the duel would review a diff with nothing in it (or the wrong code). Fixed by resolving the diff
target through bernard's existing `projectForTaskWorkspace(project, task)` helper (same one
`review.ts`'s packet/validate paths already use) before calling `gatherDuelChangeEvidence` and
before building `runDuelReview`'s `projectRoot`:

```ts
const diffProject = await projectForTaskWorkspace(project, task);
const diff = await gatherDuelChangeEvidence(diffProject);
const result = await runDuelReview({
  ...,
  projectRoot: diffProject.root,
  diff,
  ...
});
```

The original (non-resolved) `project` is still used for `startLabConversation`/`recordDuelResult`
since those need the registered project's identity/metadata, not the ephemeral worktree path.

No changes were needed for the other two carryover requirements: `duel.ts` already imports
`completeCodexPrompt` from `./codex-client.js`, so the reviewer and rebuttal rounds automatically
run through the merged, hardened client (stdin prompt delivery, isolated temp `$HOME`, credential
redaction) with no code change on this side. Discord-facing errors from every duel entry point
(`/review duel`, the Duel review button, the Accept & fix modal) already funnel through the
top-level `interactionCreate` `try/catch` → `replyWithError`, which already calls
`publicErrorMessage()` — the duel handlers never format raw `error.message` themselves.

`npm test`: 134/134 passing after rebase (includes the previously-flagged flaky
`security.test.ts` case "configured project commands receive an empty temporary home" — passed
clean on the first run, no rerun needed).

## Review round 1 (historical)

bernard requested changes on the initial PR (`CHANGES_REQUESTED`). Every numbered blocking issue
was addressed as described below with its fix and the test(s) that cover it. New commits only;
nothing in the reviewed history was rewritten.

> Note: the round-1 responses to issues 3 and 4 built a reproducibility-gated, atomically-claimed
> **Accept & fix** path. That entire write path was subsequently REMOVED in the stage-1 rescope
> (see "Review round 2 — stage-1 rescope" at the end of this document), which resolves those two
> issues by construction instead. The text below is kept as an accurate record of round 1 only.

**1. The "actual diff" is not the task's complete change.** `gatherDuelChangeEvidence()` (`src/duel.ts`)
was rewritten: it now takes the task's isolation info and builds evidence relative to
`task.baseBranch` (the recorded base revision, not just `HEAD`), assembling committed
(`base..HEAD`), staged, unstaged (all via `execFile` + `hardenedGitArguments()`/
`hardenedGitEnvironment()` and `--no-ext-diff --no-textconv --no-color --ignore-submodules=all -M`),
and bounded untracked file content (read directly and rendered as synthetic unified-diff "new
file" hunks, capped per file, path-traversal-checked). A shared sensitive-path predicate
(`isIgnoredProjectPath`, newly exported from `context.ts` — the same policy used for project
context packing) drops hunks/files for secrets, lockfiles, and credential files before anything is
budgeted or reaches a prompt; `redactSensitiveText()` runs over the final combined text too. A
SHA-256 `patchHash` over the pre-truncation combined text, plus `baseRevision`/`headRevision`, is
now part of `DuelChangeEvidence` and is recorded with the duel (see issue 7) — this is the
"immutable snapshot identity" the diff is bound to; "Accept & fix" (issue 3) refuses to proceed if
a re-check shows that hash has drifted. Test: `src/duel.test.ts` "gathers byte-pinned diff evidence
covering committed, staged, unstaged, and untracked changes, excludes sensitive paths, and is
patch-hash stable/sensitive" — a real temporary git repo, no mocks.

**2. Reviewer-output parsing fails open to approval.** `DuelVerdictOverall` gained a third state,
`"indeterminate"`. `parseDuelVerdict()` now enforces the invariant that `approve` implies zero
issues and `request-changes` implies at least one valid issue; empty output, a missing VERDICT
line, an `approve` verdict with issues attached, and a `request-changes` verdict with zero
parsable issues all resolve to `indeterminate` with a warning, never to a silent approve.
`formatDuelSummary()` renders indeterminate results as "UNRESOLVED, not approved" and never uses
"clean"/"approved" language when the verdict is indeterminate or the evidence was truncated.
Parser warnings were already collected; they are now meaningfully differentiated by outcome.
Tests: "verdict parsing treats an empty response as indeterminate, never approve", "...a
contradictory approve-with-issues as indeterminate, not approve", "...request-changes with zero
parsable issues as indeterminate, not clean", plus the existing well-formed/malformed cases updated
to expect `indeterminate` instead of a bare fallback to `approve`.

**3. "Accept & fix" starts from the wrong codebase state.** New `resolveDuelFixWorkspace()` /
`verifyDuelFixReproducible()` in `src/duel.ts`: given the *original reviewed task* (not the
registered project), it re-verifies the task's isolated worktree via `inspectTaskWorktree()`,
recomputes evidence and compares its patch hash against the one recorded at review time (refusing
on drift), and — only in the mutating path — commits any still-uncommitted reviewed changes via
`commitTaskWorktree()` so the fix task can branch from a revision that actually contains them.
`handleDuelFixModal()` now passes `project: { ...project, root: workspace.root }` (the *task's own
workspace*) into `executeInteractionRequest()` instead of the registered project's `HEAD`, so the
new fix task's isolated worktree branches from the exact reviewed state. If the state cannot be
reproduced (no isolation recorded, worktree gone, or drifted), the accept button shows a truthful
ephemeral refusal with a copyable fix prompt instead of offering "Accept & fix" — no modal, no
task. Tests: "Accept & fix resolves the exact reviewed workspace (surviving an untracked file) and
refuses once the workspace drifts" (real repo + real isolated worktree, asserts the untracked file
content is visible in the resolved workspace and the source checkout is never touched, then asserts
a real content change after evidence was captured is refused) and "refuses Accept & fix when the
task has no isolated workspace to reproduce".

**4. Acceptance is race-prone and can permanently record work that never started.** New
`src/duel-store.ts` (`DuelStore`) is the durable, single-writer-queue source of truth for
acceptance state, mirroring `TaskStore`/`CollabStore`'s atomic mutate-and-rename pattern.
`claimAcceptance()` atomically flips `acceptance.state` from `none`/`failed` to `claimed`; only the
caller that performs that flip gets `claimed: true`, so two concurrent modal submissions can no
longer both proceed (the previous code called `collabStore.decide()` but ignored its `undefined`
return on a lost race). In `handleDuelFixModal()`, the claim now happens *before* any mutating
workspace resolution (an earlier draft of this fix called `resolveDuelFixWorkspace()`, which can
`git commit`, before claiming — that would have let two concurrent submissions race into a commit
on the same worktree; reordered so the cheap atomic claim always happens first). `completeAcceptance()`
records the resulting task id only once `executeInteractionRequest()` (now returning the created
task's id) actually produces one; `failAcceptance()` resets to a retryable `"failed"` state
(`claimAcceptance` also accepts reclaiming from `"failed"`) instead of leaving a permanent
`"claimed"`/approved decision with no task. Tests: `src/duel-store.test.ts` — "concurrent accept
attempts: only one claim succeeds even when both race past earlier checks" (literally
`Promise.all` of two claims), "a claim cannot be re-claimed, and dismiss is refused once accepted",
"completeAcceptance records the resulting task id; failAcceptance makes the claim retryable",
"dismiss is exclusive with acceptance and cannot be re-dismissed".

**5. Hidden evidence truncation still yields "clean" language.** `truncateDiffForDuel()`'s
budgeting now uses `Buffer.byteLength()` throughout (both the running total and `capChunkBytes()`'s
per-chunk cap, which now slices a `Buffer` instead of a JS string) instead of `.length`, which was
counting UTF-16 code units, not bytes. `formatDuelSummary()` now always renders "Evidence coverage:
X/Y changed section(s) included" plus the snapshot identity line (base/head revision, patch hash)
in every result, and explicitly labels a truncated-but-approved result as "a partial review, not a
clean pass" rather than "approved as clean". Test: "diff truncation budgets by UTF-8 byte length,
not JS string length" (asserts truncation triggers correctly on a purely-multibyte string where JS
`.length` and byte length diverge sharply).

**6. "Withdrawn" and "original author" overstate the protocol.** `DuelStance` and `DuelIssueStatus`
dropped `"withdraw"`/`"withdrawn"` entirely — the author-side session can only `concede` or `rebut`
(a `stance=withdraw` line is now simply unrecognized, same as any other malformed stance, and
warns). All prompts, contribution actor names, and summary text now say "author-side rebuttal (no
session continuity)" instead of implying it's literally "the author" continuing their earlier
session. `RunDuelInput.task` now includes `model` (the original task's actually-recorded model,
plumbed through from `TaskRecord`), and a new `reviewerIndependenceFor()` compares it against the
reviewer's resolved model string; the result carries `reviewerIndependence: "independent" |
"same-model" | "unknown"`, and the summary surfaces a clear warning for `"same-model"` and
`"unknown"` rather than silently calling the review independent. Tests: "rebuttal parsing no longer
accepts a unilateral withdraw stance", "issue status resolution matrix maps stances and missing
responses to conceded/disputed only", "reviewer independence compares actual recorded models, not
just tier labels", "reviewer independence is flagged when the reviewer resolves to the same model
as the author".

**7. Duel lifecycle and stored resolution are not durable.** `DuelStore` (issue 4) also owns the
run lifecycle: `start()` creates a `"running"` record *before* `runDuelReview()`'s Codex calls
happen (in `runDuelForTask()`), and — since a crashed process can't clean up — a new `start()` for
the same task first supersedes ("failed") any earlier still-`"running"` record for that task,
closing the durable-audit gap. `succeed()`/`fail()` transition it; `interruptRunning()` (wired into
the `clientReady` startup handler next to `taskStore.interruptRunning()`) marks any still-`running`
record `failed` on restart, same pattern as the existing task-recovery flow. The structured,
machine-critical result (evidence summary, verdict, resolved issues, bounded/capped at 100 issues
and 2,000 chars per string field) now lives in this typed, versioned store instead of a
JSON-stringified `CollabStore` contribution capped at 12,000 characters (`recordDuelAudit()`,
formerly `recordDuelResult()`, now only writes human-readable raw reviewer/rebuttal text to the
collaboration thread's audit trail; `duelResolvedIssuesFromConversation()`'s JSON round-trip is
gone, replaced by `duelStore.get()`). Tests: `src/duel-store.test.ts` — "start creates a running
record; succeed and get round-trip the typed result", "starting a new duel for the same task
supersedes an earlier still-running one", "fail transitions a running duel and records the error",
"interruptRunning marks running duels as failed for restart-safe recovery".

**8. Apply project policy to every decision control.** `handleDuelControl()`'s accept/dismiss branch
now re-checks `isAllowedForProject()` against the duel's own project (previously only the
slash-command/button *entry points* checked it, not the decision buttons themselves), and both the
buttons and the modal submission are now bound to the exact Discord message/channel the duel posted
its decision controls in (`isBoundDuelControl()`, mirroring `handleWorkroomButton()`'s existing
`controlMessageId`/`controlChannelId` binding pattern) via a new `collabStore.setControlMessage()`
call once the duel's summary message (with the decision row) is sent. Excluded controllers,
non-project-allowed users, and stale/wrong-message clicks are all rejected before any state check.
No dedicated new unit test for the Discord-interaction wiring itself (this codebase doesn't unit
test `index.ts`'s interaction handlers directly, matching the existing `handleWorkroomButton`
convention — verify manually per the updated steps below); the underlying binding/policy logic
each reuses (`isAllowedForProject`, `collabStore.setControlMessage`) already has coverage from
before this change.

### Other changes worth flagging
- `executeInteractionRequest()` now returns the created task's id (`Promise<string | undefined>`
  instead of `Promise<void>`) so `handleDuelFixModal()` can record it via
  `duelStore.completeAcceptance()`. All other call sites already ignored the return value, so this
  is source-compatible.
- README.md / `docs/DEVBOT_PRODUCT_PLAN.md` duel bullets updated: dropped the now-nonexistent
  "withdrawn" outcome and "the task's actual diff"/plain "author" language, and mention evidence
  coverage, snapshot identity, and reviewer-independence status now surfacing in the thread.

### Test suite / flakiness note
Rewrote `src/duel.test.ts` for the new API (26 tests, up from 16) and added `src/duel-store.test.ts`
(8 tests) — net +18 tests, 134 → 152. New real-git integration tests deliberately share one fixture
per test (rather than one per assertion) to limit total subprocess spawns.

Under full concurrent `npm test`, the two real-child-process tests in `security.test.ts`
("Codex receives prompts over stdin..." and "configured project commands receive an empty
temporary home") were found to intermittently miss their hardcoded 5-second timeouts once this
lane's additional real-`git`-subprocess integration tests (required by issues 1 and 3 above) added
to concurrent system load — confirmed both tests pass 11/11 in isolation, so this was a
load-sensitivity issue in a pre-existing, unrelated test, not a regression in the reviewed feature.
Rather than dropping the review-mandated real-repo tests, bumped those two tests' own local
timeouts (5,000ms → 20,000ms in `security.test.ts`; this only widens how much concurrent load they
tolerate, it does not change what they assert) and reduced the new tests' own subprocess footprint
(consolidated 4 heavy git-fixture tests down to 2, and dropped an unneeded isolated-worktree
creation from the evidence-gathering test). `npm test` now passes 152/152 green across multiple
consecutive full runs.

### How to verify manually in Discord (round 1 additions)
1. Run a duel, let it record issues, click **Accept & fix**: confirm the thread/summary now shows
   an "Evidence coverage" line and a "Snapshot: base ... -> head ... patch ..." line, and (if the
   reviewer happened to resolve to the same model as the author) an explicit same-model warning.
2. Click **Accept & fix** twice in quick succession from two different accounts (or resubmit the
   modal twice): confirm only one fix task starts and the second gets "already accepted or
   dismissed".
3. Delete/relocate a reviewed task's isolated worktree directory (or duel-review a task whose
   worktree is otherwise gone) and click **Accept & fix**: confirm it refuses with a truthful
   explanation and a copyable fix prompt instead of opening a modal.
4. Confirm dismiss/accept both refuse if clicked from a different message than the one the duel
   posted its own decision row on (e.g. by manually re-sending the same customIds in another
   message during testing).

## Review round 2 — stage-1 rescope (read-only duel, no write controls)

Following the recommended two-stage product shape from review round 1, this branch now lands
**stage 1 only**: a read-only, immutable, fail-closed duel result with explicit evidence coverage
and no write controls.

What changed relative to the round-1 state:

- **"Accept & fix" is removed entirely** — the modal, the `devbot:duel-fix-modal:*` dispatch,
  `handleDuelFixModal`, `resolveDuelFixWorkspace`/`verifyDuelFixReproducible`, and the
  `DuelStore` acceptance-claim machinery are gone. The write-path race (round-1 issue 4) and the
  wrong-codebase-state seed (issue 3) are resolved by construction: there is no write path.
  Conceded issues instead get a **Copy fix prompt** button that replies ephemerally with a
  copyable `/do`-style follow-up prompt and a truthful explanation that this stage never starts
  the task itself. Stage 2 re-adds automated fixes only once the reviewed snapshot is reproducible
  and the decision-to-task transition is atomic and auditable.
- **Parser and rebuttal warnings now surface in Discord** — `DuelResult.warnings` aggregates
  reviewer-verdict and rebuttal parser warnings and `formatDuelSummary` renders them, so an
  indeterminate or partially parsed run shows *why*.
- **Terminal conversation closure** — clean (nothing conceded), failed, and dismissed duels close
  their `CollabStore` conversation instead of counting against the 200-open-conversation limit
  forever. Only duels with conceded issues stay open, until dismissed.
- **Decision controls fail closed on project policy** — a duel whose project is no longer
  registered (or not allowed to the clicker) refuses prompt/dismiss, instead of skipping the
  project check when lookup fails. Binding to the duel's own control message/channel moved to
  `duel-ui.ts` (`isBoundDuelControl`) with direct tests for wrong-message/wrong-channel/unbound
  cases; the store-level dismiss race (duplicate submissions) is tested with concurrent calls.
- **Persisted duel state is validated on load** — records that don't match the typed schema are
  dropped rather than trusted, an unsupported state-file version is refused, and new tests cover
  issue-count/field-length bounding and the record-cap eviction.
- README / product plan / this handoff now describe the stage-1 read-only scope explicitly.

`npm test`: 163/163 green (`npm run build` + `node --test` over `dist`), `git diff --check` clean.

## Review round 5 — coverage honesty for omitted content + refuse untrustworthy base

Rebased onto origin/main `a5ac5ee` (PR #11 merged); HANDOFF took the lane's copy per convention; the
security.test.ts 20s child-process timeout widening is preserved. Two blocking issues addressed:

1. **Omitted/redacted content was reported as fully reviewed, and different omitted contents shared
   one patch identity.** A change whose only content was an ignored path (e.g. `package-lock.json`)
   returned `fileCount: 1, includedFileCount: 1, truncated: false` and could surface as "approved as
   clean" even though the content was a constant placeholder that was also all that got hashed.
   - Coverage: `DuelChangeEvidence` gained `omittedFileCount`; every policy placeholder (ignored/secret
     path, path escaping the root, non-regular, oversized, binary, unreadable) now counts as omitted and
     is subtracted from `includedFileCount`, so a lockfile-only change reads `0/1`, never `1/1 clean`
     (`src/duel.ts` `gatherDuelChangeEvidence`/`omitSensitivePaths`/`syntheticUntrackedDiff`).
   - Verdict: `applyCoverageHonesty` downgrades an `approve` to `indeterminate` whenever any content was
     omitted, and `runDuelReview` applies it before returning; `formatDuelSummary` treats omission as
     incomplete coverage and never prints clean/approved language.
   - Patch identity: placeholders now embed a SHA-256 digest of the underlying bytes (the diff hunk for
     tracked files, a streamed file hash for untracked ones), so the patch hash changes with content
     without exposing it (`safeContentDigest`/`hashFileContent`).
   - Tests (`src/duel.test.ts`): ignored-only `package-lock.json` (asserts `0/1`, not `1/1 clean`),
     mixed visible+ignored, different-omitted-content patch identities differ, plus verdict/summary
     coverage-honesty tests.
2. **Legacy non-isolated succeeded actions with no trustworthy base revision were reviewed anyway.**
   `gatherDuelChangeEvidence` now refuses (`DuelEvidenceError`) when the task is not workspace-isolated
   or has no recorded base, instead of diffing whatever the current working tree contains. Test:
   "evidence gathering refuses a legacy non-isolated succeeded action with no trustworthy base revision".

`npm test`: 311/311 green (`npm run build` + `node --test` over `dist`).
