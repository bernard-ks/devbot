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
- `src/checkpoint.test.ts` (new) — real-git tests in throwaway temp repos (round-trip exactness, untracked-only, pre-existing-file safety, HEAD-moved, branch-moved, newer-changes refusal, unborn branch, prune).
- `src/task-store.ts` — TaskRecord gains `checkpointRef/HeadSha/Branch/CreatedAt`, `reverted`, `revertedAt`; new `attachCheckpoint()` and `markReverted()`.
- `src/task-controls.ts` — `undo` / `undo-confirm` actions, `taskHasRestorableCheckpoint()`, Undo button in the private Actions rows, `undoConfirmRow()`, updated parse regex + state matcher.
- `src/index.ts` — `ensureRollbackCheckpoint()` runs before every action-mode `runCodex` (refuses the write task on failure); Undo/undo-confirm handling in `handleTaskControl`; `/task undo` in `handleTaskCommand`; `commandRequiresController` covers `undo`.
- `src/commands.ts` — `/task undo id:` subcommand (autocomplete via the shared `id` handler).
- `README.md`, `docs/DEVBOT_PRODUCT_PLAN.md` — feature documented.
- `src/context.test.ts` — Undo button/state coverage added to the existing task-controls test.

## Safety rules (all unit-tested)
1. Refuse restore when HEAD moved since the checkpoint (`reason: head-moved`).
2. Refuse restore when the branch changed (`reason: branch-moved`).
3. Refuse restore when any covered file was edited after the task finished — mtime > task `finishedAt` + 1s tolerance (`reason: newer-changes`); warns "manual review needed" instead of clobbering.
4. Restore never deletes a file that existed before the checkpoint — only paths added after the checkpoint are removed; modified/deleted paths are restored from the checkpoint tree.
5. Undo (button and `/task undo`) is owner/controller-gated via the existing access model.
6. If a checkpoint cannot be created, the write task is refused (safety default) with a clear message that git is required.

## How to verify manually in Discord
1. In a git project, run `/do task:<some edit>` as owner/controller.
2. On the completed task message, open **Actions** → **Undo** → review the diff preview → **Confirm undo**. The working-tree edits revert; the task is marked reverted.
3. Equivalent: `/task undo id:<task-id>`.
4. Refusal checks: make a commit or switch branch after the task, then Undo → refused. Edit one of the task's files after it finished, then Undo → "manual review needed".

## Known limitations / risks
- Action mode now requires a git repository. Non-git project roots will refuse write-capable work (per spec's safety default). Answer mode is unaffected.
- Checkpoints honor `.gitignore` (via `git add -A`), so ignored files (e.g. `node_modules`) are neither snapshotted nor restored — intended.
- Restore uses `git checkout <ref> -- <paths>`, which updates the real index for the reverted paths (a deliberate undo, and the working-tree result is what the tests assert). The `git write-tree` verification uses a fresh temp index, so index state never affects correctness.
- The `newer-changes` guard is mtime-based (1s tolerance); a filesystem with coarse or lying mtimes could miss a very-recent manual edit. HEAD/branch guards are exact.
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
tests were added for this fix (out of scope for the rebase task and the
existing `checkpoint.test.ts`/`task-worktree.test.ts` suites already cover
each mechanism in isolation); a follow-up lane should add an integration
test that runs an isolated action task end-to-end and confirms `/task undo`
reverts files inside `task.workspacePath`.

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
