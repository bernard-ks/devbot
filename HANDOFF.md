# Lane J — Agent-vs-agent duel review

## What this adds

A second, independent Codex session adversarially reviews a completed write-capable task's
actual diff, the original author gets one rebuttal round, and the resolved outcome (conceded /
disputed / withdrawn) surfaces to the owner in a dedicated Discord thread.

- `/review duel task:<task-id>` — owner/controller-only slash command.
- A **Duel review** button on completed action-mode task cards (owner/controller-gated), next to
  Follow up / Review changes / Run checks.
- Reviewer round: a fresh read-only Codex session, always on a *different* Luna/Terra/Sol tier than
  the author used (fast/standard → reviewer runs deep; deep → reviewer runs standard), given the
  task's actual `git diff HEAD` (budgeted/truncated per file and in total) and asked to return a
  structured `VERDICT:` + `ISSUE severity=... file=... line=... claim=...` block, or approve plainly
  when the diff is clean.
- Rebuttal round: only runs if the reviewer raised at least one issue. The original author's tier
  gets the same diff plus the reviewer's issues and must respond with one `RESPONSE id=... stance=
  concede|rebut|withdraw reasoning=...` line per issue. No third round.
- Each issue resolves to a final status: `concede` → conceded (real), `rebut` → disputed,
  `withdraw` → withdrawn, no rebuttal recorded → disputed (left open, not silently dropped).
- The duel is recorded as a `CollabStore` conversation (new `"duel"` intent alongside the existing
  lab intents) with a dedicated audit thread — reusing the same `startLabConversation` /
  `createLabThread` machinery every other `/lab` command uses, so `/lab recent`-style history and
  the thread pattern both work for duels without new infrastructure.
- Thread message: summary (verdict, tiers, N issues: X conceded / Y disputed / Z withdrawn) +
  the issue list with severities, file:line, reviewer claim, and author response.
- If any issue was conceded, an **Accept & fix** button (owner/controller only) opens a modal
  pre-filled with a `/do`-style fix task built from the conceded issues (editable before submit,
  respects safe mode); **Dismiss** records a `deny` decision. Both are one-shot — decisions can't
  be re-recorded once made (guarded by `CollabStore.decide`'s existing single-decision rule).

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
- `src/duel-ui.ts` (new) — Discord button/modal customId encoding and tolerant parsing:
  `devbot:duel-control:review:<taskId>`, `devbot:duel-control:accept|dismiss:<conversationId>`,
  `devbot:duel-fix-modal:<conversationId>`.
- `src/task-controls.ts` — imports `duelReviewButton`; adds it to `taskActionRows` for
  succeeded action-mode tasks when the viewer can control.
- `src/collab-protocol.ts` — added `"duel"` to `CollabIntent` (type + runtime array); no other
  protocol changes.
- `src/commands.ts` — added `/review duel task:<task-id>` subcommand (autocomplete reuses the
  existing generic `task`-named-option autocomplete handler, no new autocomplete wiring needed).
- `src/index.ts` — `handleReviewDuelCommand`, `handleDuelControl`, `handleDuelFixModal`,
  `runDuelForTask` (shared by the slash command and the button), `recordDuelResult`,
  `duelResolvedIssuesFromConversation`; new customId dispatch branches for buttons and modal
  submits; widened `startLabConversation`/`createLabThread` parameter types to also accept
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
   conceded/disputed/withdrawn counts in the summary match.
5. If ≥1 issue was conceded, click **Accept & fix**, confirm a modal opens pre-filled with the
   conceded issues, edit if desired, submit, and confirm a new write-capable task starts.
6. Click **Dismiss** on a different duel and confirm it records without starting a task, and that
   clicking either decision button again says the duel was already decided.
7. Confirm a non-owner/non-controller account cannot trigger `/review duel`, the button, or the
   decision buttons.

## Known limitations / risks

- Diff evidence is `git diff HEAD` against the working tree at duel time, not a snapshot pinned to
  when the task actually ran; if further changes land on the project between the task finishing
  and the duel running, the reviewer sees the current working tree, not strictly "that task's"
  diff. This matches the only diff source `review.ts` already offers elsewhere in devbot (task
  records don't track a changed-file list), so it's consistent with existing behavior, not a new
  gap — but worth knowing if multiple tasks land back-to-back before a duel is requested.
- The reviewer/rebuttal prompts ask the model to follow an exact line format; the parsers are
  tolerant (regex-based, warn-and-degrade on drift) but a badly-misbehaving model could still
  produce zero parsed issues on a genuinely dirty diff. This fails toward "approve" rather than
  toward inventing false positives, which matches the acceptance criterion but means a false
  "clean" review is possible if the reviewer ignores the format entirely. Nothing in this codebase
  today validates model output against ground truth beyond structural parsing (the same trust
  boundary `request-router.ts`'s router-response parsing already accepts elsewhere in devbot).
- `duelResolvedIssuesFromConversation` reconstructs conceded issues for **Accept & fix** by reading
  back a JSON-stringified contribution from `CollabStore` rather than a dedicated typed store. This
  keeps the durable-state footprint small and reuses existing infrastructure per the lane brief's
  instruction to follow `collab-store.ts` patterns, but it means duel history isn't independently
  queryable outside that one conversation's contributions today.
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
