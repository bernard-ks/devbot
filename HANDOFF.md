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
