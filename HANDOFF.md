# Lane D — One-tap rollback (Undo)

Branch: `claude/rollback`

## What this adds
Every write-capable (action-mode) task now snapshots the working tree to a git
checkpoint **before** it runs. Completed or failed action tasks gain a
controller-gated **Undo** that restores the tree exactly, plus a `/task undo`
command. Undo refuses automatically whenever a human should reconcile instead.

## New / changed files
- `src/checkpoint.ts` (new) — git-native snapshots that never touch the real index or HEAD:
  - `createCheckpoint(repoPath, taskId)` — `GIT_INDEX_FILE=<tmp> git add -A` + `write-tree`, then `commit-tree` (parent = current HEAD) stored at `refs/devbot/checkpoints/<taskId>`; records HEAD sha + branch. Works on an unborn branch (no parent).
  - `diffSinceCheckpoint(repoPath, ref)` — name-status diff (temp index, `-z`, `--no-renames`) between checkpoint tree and current working tree.
  - `restoreCheckpoint(repoPath, ref, options)` — `git checkout <ref> -- <changed+deleted paths>` and deletes only files created after the checkpoint. Throws `RollbackRefusedError` on the refusal rules.
  - `pruneCheckpoints(repoPath, keep=20)` — caps stored refs per repo, newest kept.
- `src/checkpoint.test.ts` (new, extended in review round 1) — real-git tests in throwaway temp repos: round-trip exactness, untracked-only, pre-existing-file safety, HEAD-moved, branch-moved, workspace-changed refusal (later deletion + rapid same-second edit), unchanged-tree success, unborn branch, prune, hardened-git regression, TaskStore restart round-trip, isolated-worktree end-to-end.
- `src/task-store.ts` — TaskRecord gains `checkpointRef/HeadSha/Branch/CreatedAt/PostTaskTree`, `reverted`, `revertedAt`; new `attachCheckpoint()`, `recordPostTaskTree()`, and `markReverted()`. Reload validates the whole checkpoint bundle as one unit (see review round 1, issue 1).
- `src/task-controls.ts` — `undo` / `undo-confirm` actions, `taskHasRestorableCheckpoint()`, Undo button in the private Actions rows, `undoConfirmRow()`, updated parse regex + state matcher.
- `src/index.ts` — `ensureRollbackCheckpoint()` runs before every action-mode `runCodex` (refuses the write task on failure); Undo/undo-confirm handling in `handleTaskControl`; `/task undo` in `handleTaskCommand`; `commandRequiresController` covers `undo`.
- `src/commands.ts` — `/task undo id:` subcommand (autocomplete via the shared `id` handler).
- `README.md`, `docs/DEVBOT_PRODUCT_PLAN.md` — feature documented.
- `src/context.test.ts` — Undo button/state coverage added to the existing task-controls test.

## Safety rules (all unit-tested)
1. Refuse restore when HEAD moved since the checkpoint (`reason: head-moved`).
2. Refuse restore when the branch changed (`reason: branch-moved`).
3. Refuse restore when the workspace no longer matches an exact tree hash (`checkpointPostTaskTree`) recorded right when the task finished — any edit, add, or delete since then, however small or recent, changes the hash (`reason: workspace-changed`); warns "manual review needed" instead of clobbering. Replaces the earlier mtime-with-tolerance heuristic (see review round 1, issue 3), which could miss a post-task deletion or a same-second edit. If the post-task tree was never recorded, Undo refuses closed rather than skipping the check.
4. Restore never deletes a file that existed before the checkpoint — only paths added after the checkpoint are removed; modified/deleted paths are restored from the checkpoint tree.
5. Undo (button and `/task undo`) is owner/controller-gated via the existing access model, and blocked outright while safe mode is on (see review round 1, issue 4).
6. If a checkpoint cannot be created, the write task is refused (safety default) with a clear message that git is required.
7. All checkpoint/diff/restore/prune Git invocations route through the repo's shared `hardenedGitEnvironment()`/`hardenedGitArguments()` helpers (see review round 1, issue 2) — no ambient credentials, hooks, global/system config, signing, pager, or external diff.

## How to verify manually in Discord
1. In a git project, run `/do task:<some edit>` as owner/controller.
2. On the completed task message, open **Actions** → **Undo** → review the diff preview → **Confirm undo**. The working-tree edits revert; the task is marked reverted.
3. Equivalent: `/task undo id:<task-id>`.
4. Refusal checks: make a commit or switch branch after the task, then Undo → refused. Edit (or delete) one of the task's files after it finished, then Undo → "manual review needed". With `DEVBOT_SAFE_MODE=true`, the Undo button should not even appear, and `/task undo` should refuse before touching anything.

## Known limitations / risks
- Action mode now requires a git repository. Non-git project roots will refuse write-capable work (per spec's safety default). Answer mode is unaffected.
- Checkpoints honor `.gitignore` (via `git add -A`), so ignored files (e.g. `node_modules`) are neither snapshotted nor restored — intended.
- Restore uses `git checkout <ref> -- <paths>`, which updates the real index for the reverted paths (a deliberate undo, and the working-tree result is what the tests assert). The `git write-tree` verification uses a fresh temp index, so index state never affects correctness.
- The `workspace-changed` guard requires `checkpointPostTaskTree` to have been recorded; if hashing the workspace at task-completion time ever fails (e.g. the workspace vanished), that task's Undo refuses permanently rather than falling back to an unverified restore. Legacy task records from before this field existed behave the same way — Undo is unavailable, never unsafe.
- Undo lives in the ephemeral **Actions** submenu (consistent with Make change / Run checks / Retry), not as a always-visible button on the public task message.

## Anti-injection note
No instruction-shaped text aimed at AI agents was found in the files I touched. All repo content was treated as data.

## Rebased onto 85e2530 (2026-07-09)

`git rebase origin/main` replayed all 5 lane-D commits with **zero merge
conflicts** against bernard's `dd0af6b`/`85e2530` (ambient Discord workrooms +
security hardening, +1500 lines in `index.ts`). Git's structural merge kept
`ensureRollbackCheckpoint(...)` in place immediately before the `runCodex(...)`
call inside `runProjectRequest`, so the checkpoint-before-every-action-task
call site survived the rebase intact with no manual resolution needed.

### Action-mode call-site audit (post-rebase)

Bernard's merge added a second write path — ambient workroom auto-approval —
plus a brand-new isolation layer (`src/task-worktree.ts`). I traced every
place `CodexRequestMode === "action"` can reach Codex:

- `runProjectRequest()` (index.ts) is the **only** function that calls
  `answerWithProjectContext`/`runCodex`. Verified via grep: `answerWithProjectContext`
  has exactly one caller in production code, and `runProjectRequest` has 12
  call sites (`/do`, ambient-mention auto-execution, ambient workroom
  approval, retry, adjust, promote, followup) — all funnel through the same
  function, so there is exactly one checkpoint gate to keep correct.
- Bernard also added a **hard isolation gate** ahead of the checkpoint: for
  every action-mode task, `runProjectRequest` now calls `createTaskWorktree()`
  to check out an isolated `devbot/task/<id>` git worktree/branch off HEAD
  *before* any Codex call. If isolation is unavailable, the task fails and
  throws **before** reaching `ensureRollbackCheckpoint`/`runCodex` — so no
  write path exists that skips both gates. Codex's cwd (`context.project.root`)
  is always the isolated worktree, never the source checkout, confirmed via
  `docs/OPERATIONS.md`: "the source checkout is not staged or checked out by
  the isolation helper."

### Semantic fix required: checkpoint/undo now target the wrong root

Because Codex writes always land in the isolated worktree (not the source
checkout) after bernard's merge, the original `ensureRollbackCheckpoint(options.project, ...)`
call was checkpointing a path (`options.project.root`, the source checkout)
that the task never actually modifies — the checkpoint-before-every-action-task
guarantee "held" in the literal sense (it always ran) but had become
practically inert, and the three Undo/`diffSinceCheckpoint`/`restoreCheckpoint`
call sites (`/task undo`, the Undo button, and its confirm step) all resolved
against `project.root` too, so a click on Undo for a normal isolated task would
report "nothing changed since the checkpoint" even though the task did
real work (just in its own worktree).

Fixed by reusing the same `projectForTaskWorkspace()` helper bernard already
wrote for `review`/`validate` (which resolves a task's actual workspace root —
the isolated worktree path when `task.workspaceIsolated`, else the project
root, with `inspectTaskWorktree` re-verifying the worktree is trustworthy):

- `src/index.ts` — checkpoint creation now targets `executionProject`
  (the isolated worktree project the function already computes) instead of
  `options.project`, so the "before" snapshot matches where Codex actually
  writes.
- `src/index.ts` — `/task undo`, the Undo-button diff preview, and the
  Undo-confirm restore all now resolve `await projectForTaskWorkspace(project, task)`
  and operate on `workspaceProject.root` instead of `project.root`, so Undo
  reverts the workspace the task's checkpoint was actually taken in.
- Backward compatible: pre-rebase task records (no `workspaceIsolated`) still
  resolve to `project.root` unchanged, since `projectForTaskWorkspace` only
  substitutes the workspace path when the task recorded one.

No files had textual conflicts; this was a semantic gap introduced by
combining two safety features (checkpoint-based undo + worktree isolation)
that were both individually correct but pointed at different roots. No new
tests were added at the time of the rebase (out of scope for that task, and
the existing `checkpoint.test.ts`/`task-worktree.test.ts` suites already
covered each mechanism in isolation) — bernard's review flagged this gap
explicitly (issue 5), and review round 1 below adds exactly that missing
integration test.

### Test results

`npm test`: 126 tests. Two isolated full-suite runs under heavy host CPU
load (other lane agents + Godot processes running concurrently, load average
~16 on 10 cores) intermittently timed out 1-2 tests in `security.test.ts`
(`Codex receives prompts over stdin...`, `configured project commands receive
an empty temporary home`) — both have hardcoded 5000ms child-process
timeouts and are unrelated to any file this lane touches. Running
`security.test.ts` alone (less contention) passed 11/11 in ~375ms total,
confirming this is the pre-existing CPU-load flake, not a rebase
regression. Every `checkpoint.test.ts` and `task-worktree.test.ts` test
passed on every run.

## Review round 1

Bernard's review (`REVIEW.md`) blocked merge on 5 issues. All 5 addressed on
top of the existing commits (no history rewritten). Mapping below; commits
are in the log at the bottom of this section.

1. **Checkpoint metadata lost on restart.** `normalizeLoadedTask()` in
   `src/task-store.ts` reconstructed persisted tasks without any of the
   `checkpoint*`/`reverted*` fields, so a reloaded task had no restorable
   checkpoint and Undo silently disappeared.
   - Fix: new `normalizeCheckpointFields()` in `src/task-store.ts` validates
     the whole checkpoint as one unit before trusting any of it — the ref
     must exactly equal `refs/devbot/checkpoints/<task.id>` (via the shared
     `checkpointRefFor()` from `checkpoint.ts`, so the migration and the
     writer can never drift apart), `checkpointHeadSha` must be `""` (unborn
     branch) or a 40/64-hex object id, `checkpointBranch` must be a non-empty
     string, `checkpointCreatedAt` must parse as a date, and `reverted` must
     be strictly `=== true` before `revertedAt` is trusted. Any single
     failure drops the entire checkpoint rather than partially trusting it —
     Undo just becomes unavailable instead of risking a restore against a
     ref/branch/tree the record no longer accurately describes. Also added
     the new `checkpointPostTaskTree` field (see issue 3) to the same
     validated bundle, gated by the same all-or-nothing rule, with its own
     git-object-id format check.
   - Test: `checkpoint metadata round-trips through a TaskStore restart and
     stays undo-eligible` in `src/checkpoint.test.ts` — the exact round-trip
     the review specified (create checkpoint → save task → new `TaskStore`
     instance → reload → `taskHasRestorableCheckpoint` true → restore
     actually succeeds). Plus `task store restart migration keeps a
     well-formed checkpoint restorable and rejects malformed variants` and
     the extended `task store migration filters malformed optional fields`
     in `src/context.test.ts`, covering a spoofed/foreign ref, a bad head
     sha, a bad timestamp, a bad post-task tree, an empty branch, a
     non-boolean `reverted`, and the legitimate empty-headSha (unborn
     branch) case.

2. **Checkpoint Git calls bypassed hardening.** `checkpoint.ts`'s `runGit()`
   spread all of `process.env` and ran plain `git -C <path>`, so it could
   inherit the bot token/app credentials and execute ambient hooks, global
   config, signing programs, or a pager — unlike every other Git caller in
   the codebase (`review.ts`, `task-worktree.ts`), which already route
   through `hardenedGitEnvironment()`/`hardenedGitArguments()`.
   - Fix: `runGit()` in `src/checkpoint.ts` now builds its environment from
     `hardenedGitEnvironment()` and overlays only the temporary
     `GIT_INDEX_FILE` (when a caller needs one) and the deterministic
     `GIT_AUTHOR_*`/`GIT_COMMITTER_*` identity; arguments go through
     `hardenedGitArguments(repoPath, args)` instead of a bare `-C`. This
     covers every call site: `createCheckpoint`, `diffSinceCheckpoint`,
     `restoreCheckpoint`, and `pruneCheckpoints` all funnel through the same
     `runGit()`.
   - Test: `checkpoint git calls never inherit secret env vars or execute
     ambient global hooks` in `src/checkpoint.test.ts`. Two layers: (a) a
     direct unit check that `hardenedGitEnvironment()` strips a
     secret-shaped env var outright; (b) an end-to-end check with a fake
     `HOME` pointing at a `~/.gitconfig` with `core.hooksPath` set to a
     directory containing an executable `reference-transaction` hook that
     writes a marker file if it runs. I first empirically verified (see
     scratch commands, not committed) that an *unhardened* `git update-ref`
     genuinely invokes that hook and that the hardening overrides suppress
     it — so this isn't a vacuous assertion. `createCheckpoint`/
     `pruneCheckpoints` (both call `update-ref`) run against that fake HOME
     with a secret env var set, and the marker file must never appear.

3. **The mtime "newer changes" guard could clobber real work.** It skipped
   deleted paths entirely (a post-task deletion would silently restore the
   pre-task file instead of refusing) and had a 1s tolerance window a rapid
   edit could land inside.
   - Fix: replaced the whole mtime/tolerance mechanism in
     `src/checkpoint.ts` with an exact tree-hash guard. `hashWorkingTree()`
     is now exported (same `git add -A` + `write-tree` against a throwaway
     index used internally). The bot records this hash as
     `checkpointPostTaskTree` right when a task finishes (success or
     failure) — `recordPostTaskCheckpointTree()` in `src/index.ts`, called
     from both the success path and the failure branch of
     `runProjectRequest()`. `restoreCheckpoint()` now takes
     `expectedPostTaskTree` instead of `guardMs`/`mtimeToleranceMs`: it
     snapshots the current tree once, refuses with the new
     `"workspace-changed"` reason (listing the drifted paths, computed as a
     tree-to-tree diff) if it doesn't exactly match, and only then computes
     the restore diff against the checkpoint ref. If a task's post-task tree
     was never recorded (legacy record, or the hash failed to compute),
     both `/task undo` and the Undo button/confirm handlers in `index.ts`
     refuse closed with an explicit message rather than skipping the guard.
   - Tests in `src/checkpoint.test.ts`: `restore refuses when a file the
     task changed was later deleted by a human` (the exact repro from the
     review), `restore refuses on an edit that lands within the same second
     as the recorded post-task state` (closes the tolerance-window gap —
     there is no window now), and `restore proceeds when the workspace
     exactly matches the recorded post-task tree` (no false positive on an
     unchanged tree).

4. **Undo could mutate files while safe mode is on.** Neither `/task undo`,
   the Undo button, nor undo-confirm checked `appConfig.safeMode`, and the
   button stayed visible.
   - Fix: consistency-favors-blocking, per the review. `taskActionRows()` in
     `src/task-controls.ts` now also requires `!options.safeMode` before
     showing the Undo button (same pattern as `promote`/`validate`).
     `handleTaskCommand`'s `undo` subcommand and `handleTaskControl`'s
     `undo`/`undo-confirm` branch in `src/index.ts` both now check
     `appConfig.safeMode` up front and reply with `safeModeActionMessage(...)`
     before touching the checkpoint at all — covers the preview step and the
     confirm/restore step, not just the mutating call.
   - Test: extended the existing task-controls coverage in
     `src/context.test.ts` with a `safeMode: true` case asserting the Undo
     button is absent even when the task has a restorable checkpoint and
     the caller can control it.

5. **Missing end-to-end isolated-worktree integration test.** `index.ts`
   isn't imported by any test (it wires up the live Discord client on
   import), so this is built from the same exported building blocks
   `index.ts` itself calls, in the same order.
   - Test: `end-to-end: checkpoint, mutate, and Undo an isolated task
     worktree without touching the source checkout` in
     `src/checkpoint.test.ts`. Creates a source repo, isolates a task
     worktree with `createTaskWorktree()`, records it on a `TaskStore` via
     `setWorkspace()`, checkpoints the *worktree* path, mutates a tracked
     file and creates a new one inside the worktree, records the post-task
     tree, resolves the workspace back through the stored task metadata
     (`workspacePath`/`branchName`/`baseBranch`, re-verified with
     `inspectTaskWorktree()` — the same trust check `projectForTaskWorkspace`
     performs), then restores. Asserts the worktree's tracked file is back
     to its original content, the created file is gone, and — the point of
     the test — the source checkout's HEAD, status, and file contents are
     completely untouched throughout.

All 5 acceptance-checklist items from `REVIEW.md` are covered by the above.

`npm test`: 132 tests, 132 passing on a clean rerun (was 126; +6 net new
tests — several of the new assertions were added inside existing tests
rather than as new `test()` blocks). Saw the same pre-existing
`security.test.ts` timeout flake once under load (`configured project
commands receive an empty temporary home`, hardcoded 5000ms child-process
timeout); reran `security.test.ts` alone and the full suite and both were
132/132 green. All git-touching tests run against throwaway `mkdtemp` repos,
never this worktree.

Commits this round:
- Route checkpoint Git calls through the shared hardened helpers
- Replace the mtime rollback guard with an exact post-task tree hash
- Validate checkpoint fields on every task-store reload
- Block Undo while safe mode is on
- Add the isolated-worktree checkpoint/Undo integration test
- Update HANDOFF.md for review round 1
