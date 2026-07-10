# Lane E — Overnight queue + scheduled tasks

Branch: `claude/task-queue-schedule`

## Rebased onto 85e2530

Rebased onto `origin/main` at `85e2530` (merge of bernard's `dd0af6b` "Add ambient
Discord workrooms and security hardening", +1500 lines in `src/index.ts` plus
changes to `src/commands.ts`, `src/config.ts`, `.env.example`, etc.). This lane's
single commit replayed as `1c75658`.

Conflicted files and how they were resolved:

- **`src/commands.ts`** — both sides appended to the same `commandBuilders` array
  literal at the same spot: bernard added the "Start Devbot workroom" context-menu
  command, this lane added the `/queue` and `/schedule` slash command builders.
  Kept both entries (context-menu command, then `/queue`, then `/schedule`) inside
  the same `commandBuilders` array, preserving bernard's `satisfies Array<Pick<...,
  "toJSON">>` typing and the `commandDefinitions = commandBuilders.map(...)` export
  bernard introduced (this lane's pre-rebase version exported a plain inline
  `.map(...)` off the array literal directly).
- **`src/index.ts`** — three conflict regions, all caused by both branches
  inserting new code at the same anchor points (not overlapping logic edits):
  - Import block: merged bernard's `task-access.ts`/`task-worktree.ts` imports
    with this lane's `queue-store.ts`/`schedule-store.ts` imports — both kept.
  - A ~1000-line region after `taskStatusForProgress()`: bernard inserted the
    entire ambient-workroom proposal system (`AmbientProposalRequest` through
    `agentRole()`) and this lane inserted `handleQueueCommand` through
    `truncateSummary()` at the same point, so diff3 interleaved unrelated `if`
    blocks from each side into one unreadable conflict. Resolved by reconstructing
    both blocks from their source commits verbatim and placing bernard's ambient
    block first, then this lane's queue/schedule block, immediately before
    `getWorkStatusMessage()` (order doesn't matter functionally — both are
    independent top-level function groups).
  - `ProjectRequestOptions` / `runProjectRequest`: bernard extended the options
    interface (`existingTaskId`, `requesterId`, `accessScope`, `internal`,
    `channelId`, `threadId`, `agentRoles`, `displayText`, `signal`) and rewired
    the function body to run write-capable (`mode: "action"`) requests inside an
    **isolated task git worktree** (`createTaskWorktree`) instead of directly
    against the project root. All new fields are optional, so `runQueueItem`'s
    and `runScheduledEntry`'s existing `runProjectRequest({...})` calls needed no
    changes — they pass straight through the same function name and now
    automatically get isolated-worktree execution for `/queue`/`/schedule` `do`
    items, exactly like `/do` does. No new/renamed execution engine to re-route
    to; verified by reading the merged `runProjectRequest` body and confirming
    the required fields this lane supplies (`project`, `text`, `includePatterns`,
    `mode`, `requester`, `source`, `onProgress`) are still accepted unchanged.

Beyond the textual conflicts, integrated this lane with bernard's security
hardening: the queue/schedule code (written before that hardening commit
existed) was surfacing raw `error.message`/`String(error)` to Discord replies,
stored queue/schedule summaries, and console logs. Bernard's commit established
`publicErrorMessage(error)` (from `src/security.ts`, redacts tokens/secrets/keys)
as the sitewide convention for anything error-derived that reaches a user or a
log line. Swapped all of the following to use it: `/queue remove`'s error reply,
`/schedule add`'s error reply, `runQueueItem`'s failure summary, `runScheduledEntry`'s
failure summary, and the six queue/schedule-related `console.warn`/`console.error`
calls added in `clientReady` and `/queue start`.

`.env.example`, `README.md`, `docs/DEVBOT_PRODUCT_PLAN.md` auto-merged cleanly
(bernard's additions and this lane's additions were in different, non-adjacent
spots) — no manual resolution needed there.

Verified post-rebase: `npx tsc -p tsconfig.json --noEmit` clean, `npm test` green
twice in a row (147 passed / 0 failed both runs — 74 pre-existing +29 from this
lane +44 from bernard's security/ambient/worktree test files).

## What was built

### `/queue` — stack tasks, run them one at a time, wake up to a digest
- `src/queue-store.ts`: durable atomic-JSON store (`.devbot/queue.json`, override with `DEVBOT_QUEUE_STORE`) following the `task-store.ts` pattern. Items are append-only: `{ id, project, taskText, mode, state, addedBy, addedAt, taskId?, messageId?, startedAt?, finishedAt?, summary? }`, state one of `queued | running | done | failed | skipped`. A separate `runner` record tracks `{ running, stopOnFailure, startedBy, startedAt, pendingDigest }`.
  - `position` (as used in `/queue remove position:<n>`) is the 1-based index into `list()`'s array order rather than a separately stored field — it's derived, so it can never drift out of sync after removals.
  - `remove`/`clear` mark queued items `skipped` instead of deleting them, so the digest and `/queue list` keep a full record of what was pulled before it ran.
  - `recoverInterrupted()` is called once at boot: any item still `running` when the process died (mirroring `taskStore.interruptRunning()`) is marked `failed` with an "Interrupted when Devbot restarted." summary, so the runner can safely move on to the next item instead of hanging forever on a dead one.
- `src/commands.ts` / `src/index.ts`: `/queue add|list|remove|clear|start|stop|digest`, gated owner/controller (`commandRequiresController` now returns `true` for the whole `queue` command).
  - `add` appends via the exact same `runProjectRequest` engine that backs `/do`/`/ask` — same routing (Luna/Terra/Sol), same task-store record, same restart-stable task controls on the posted message.
  - `start`/`stop` flip a durable `running` flag and kick off `advanceQueue()`, a single-flight loop (guarded by a module-level `queueAdvancing` boolean so concurrent triggers never double-run the queue) that pulls one queued item at a time, posts/updates a message in the private room via `channel.send`/`.edit` (mirrors `executeMessageRequest`), and stops immediately if `stopOnFailure` was set and an item fails. A failed item does not otherwise halt the queue.
  - When the queue drains (no more queued items), `finishQueueDrain()` stops the runner, marks `pendingDigest = true`, and immediately attempts to post the digest (`formatQueueDigest`) to the private room; if the room isn't reachable at that moment, the pending flag survives a restart and is retried once at the next boot (`tryPostQueueDigest` runs in `clientReady`). This is how "digest posts once per drain" holds even across a crash mid-post.
  - `/queue digest` reformats and replies with the current digest on demand, independent of the `pendingDigest` bookkeeping.
  - On boot, if `runner.running` was `true` before the restart, `advanceQueue()` is kicked off again automatically — the queue resumes at the next queued item.

### `/schedule` — recurring tasks, owner-only
- `src/schedule-store.ts`: pure parser (`parseScheduleSpec`) + next-run calculator (`nextRunAfter`) + durable store (`.devbot/schedule.json`, override with `DEVBOT_SCHEDULE_STORE`).
  - Spec grammar: `daily HH:MM`, `weekdays HH:MM`, `every <N>h` (positive integer hours only). Local-time, DST-naive by design (documented in the source) — matches the brief's "DST-naive local time is fine."
  - `reconcileOnBoot()` recomputes every enabled entry's `nextRun` purely from its spec and `lastRun` (or `createdAt` if it never ran). This is what makes restarts safe: an entry that was due while the process was offline stays due exactly once — the 30-second scheduler tick will fire it on its next pass — and one that wasn't due yet keeps its original cadence rather than drifting forward on every restart.
- `src/commands.ts` / `src/index.ts`: `/schedule add|list|remove|pause|resume`. Owner-only is enforced with an explicit `isOwner` check inside the `schedule` branch of `handleCommand` (deliberately not routed through `commandRequiresController`, since that also admits controllers — the brief calls this command owner-only, stricter than `/queue`).
  - The scheduler loop is a single `setInterval` (~30s) started in `clientReady` once the private room is verified; each tick calls `scheduleStore.due()` and runs any due entries through `runProjectRequest`, posting/updating a task message in the private room the same way the queue runner does, noting the trigger ("scheduled: daily 07:00") in the posted content.
  - Pause disables an entry; resume re-enables it and recomputes `nextRun` from "now" so a long-paused entry doesn't immediately fire a backlog.

### Shared plumbing
- Both runners reuse `runProjectRequest` (already used by `/do`/`/ask`/retry/etc.) — no new execution path, no new safety surface. Both respect `isWriteBlockedBySafeMode` for action-mode items/entries.
- Both post through the existing `formatTaskProgress` / `taskControlRow` task-UI components, so a queued or scheduled task gets the same Follow up / Review changes / Retry / Cancel buttons as any other task.

## Files touched
- `src/queue-store.ts` (new), `src/queue-store.test.ts` (new)
- `src/schedule-store.ts` (new), `src/schedule-store.test.ts` (new)
- `src/commands.ts` — added `/queue` and `/schedule` slash command definitions
- `src/index.ts` — store instantiation, boot-time recovery/reconciliation/scheduler start, `handleQueueCommand`, `handleScheduleCommand`, `advanceQueue`, `runQueueItem`, `finishQueueDrain`, `tryPostQueueDigest`, `privateRoomChannel`, `tickSchedules`, `runScheduledEntry`, `commandRequiresController` updated
- `README.md`, `docs/DEVBOT_PRODUCT_PLAN.md` — feature bullets
- `.env.example` — `DEVBOT_QUEUE_STORE` / `DEVBOT_SCHEDULE_STORE` overrides documented

## How to verify manually in Discord
1. In the private room: `/queue add task:"say hi" mode:ask`, `/queue add task:"add a comment to README" mode:do`, `/queue list` (shows both, numbered, state `queued`).
2. `/queue start` — watch the private room: a task message appears for item 1, runs through routing/context/working phases exactly like `/ask`, completes, then item 2 starts automatically.
3. Let it drain fully — a "Morning digest" message posts once, listing both items with state, summary, and a jump link to each task message.
4. `/queue digest` — re-posts the same digest on demand.
5. Restart the bot mid-queue (stop the process while an item is `running`) — on the next boot, that item should show as `failed` ("Interrupted when Devbot restarted.") in `/queue list`, and if the runner was still `running` when it died, the remaining queued items resume automatically.
6. `/schedule add spec:"every 1h" task:"summarize open TODOs" project:<name> mode:ask` as the owner — `/schedule list` shows a future `nextRun`. Wait for it (or temporarily lower the tick interval / backdate the state file for a faster manual check) and confirm a task message posts to the private room noting "Trigger: scheduled: every 1h."
7. `/schedule pause id:<id>` then `/schedule resume id:<id>` — confirm `nextRun` moves to "soon from now" rather than firing a backlog.
8. Confirm a non-owner controller gets rejected by `/schedule` with the owner-only message, while still being able to run `/queue` subcommands (controller-gated, not owner-only).

## Known limitations / risks
- `/queue remove`/`clear` mark items `skipped` rather than deleting them; `retainQueueItems` trims old finished/skipped items once total records exceed 300 (queued/running are never trimmed), mirroring `task-store.ts`'s `retainRunningTasks` budget. A very long-running overnight queue history is bounded but not literally infinite.
- The digest and scheduled-task messages are posted as plain Discord messages with markdown (matching every other formatter in this codebase — no `EmbedBuilder` is used anywhere in `devbot`), not a Discord embed object, despite the brief's "digest embed" wording.
- The scheduler tick is a plain `setInterval(..., 30_000)`; if `runProjectRequest` for a due entry takes longer than 30s (normal for `action` mode), the same entry cannot double-fire because `nextRun` is only advanced after `markRun` completes and `due()` re-reads the persisted `nextRun`, but a second *different* due entry could still start concurrently with the first (no cross-entry mutex). This matches how the queue itself is strictly serial but schedules are independent by design — flagging in case simultaneous Codex runs on the same project are undesirable.
- `every <N>h` only accepts whole hours (matches the brief's `every <N>h` grammar exactly); there's no minutes variant.
- I did not add autocomplete for `/schedule remove|pause|resume id:<id>` — the existing generic autocomplete dispatcher keys off an option literally named `id`/`task` and backs it with `taskStore` (saved Codex tasks), which is the wrong store for schedule IDs. Rather than risk cross-wiring it incorrectly, I left the `id` option without `.setAutocomplete(true)`; the owner copies the ID from `/schedule list`.
- Not run against live Discord (per lane rules — verified via `npm test`, a full `tsc` build, and manual code-path tracing against the existing `/do`/`/ask` execution path only).

## Test results
`npm test` (tsc build + `node --test` on dist): **103 passed, 0 failed** at the time this lane was authored — 74 pre-existing plus 29 new (14 in `queue-store.test.ts`, 15 in `schedule-store.test.ts`). After rebasing onto `85e2530` (see "Rebased onto 85e2530" above), the suite is **147 passed, 0 failed**, run twice to rule out the known CPU-load flake.

## Review round 1

bernard requested changes on the first submission (`REVIEW.md` at the worktree root has his full text). All seven blocking issues plus his acceptance checklist are addressed below, in new commits on top of the reviewed history — nothing already on the branch was rewritten.

Scope decision up front: bernard's review offered two paths for `/schedule` — "read-only-only" (his stated preference) or, if write mode stayed, a list of additional gating requirements (explicit choice, safe-mode reject, standing-approval expiry, per-occurrence approval-gated proposals). His "Recommended scope" section also suggested splitting scheduler writes into their own PR rather than bundling them here. Given that, `/schedule` is now **read-only-only**: the `mode` option was removed from the `/schedule add` command entirely, `ScheduleMode` is the literal type `"answer"`, and `ScheduleStore` always stores `mode: "answer"`. This fully resolves issue 2 without needing proposal/expiry machinery, since a read-only schedule has no write capability for safe mode or an approval gate to protect. `/queue`'s `do` mode is untouched — each queue item is still a single explicit command a controller issues themselves (same shape as `/do`), which is not the "unattended write" pattern the review flagged.

1. **Duplicate execution (scheduler tick).** Fixed by giving both the schedule tick and the queue runner an atomic claim/lease *before* any execution side effect, not after.
   - `ScheduleEntry` gained `running: boolean` + `runStartedAt?`. `ScheduleStore.claimDue(now)` atomically marks every due, enabled, not-already-running entry as `running` and returns only those, in one `mutate()` call — a second tick reading the store mid-run of a long-lived occurrence sees `running: true` and does not reclaim it. `due()` also excludes running entries so it can never suggest a double-claim to a caller. `markRun()` now always releases the lease (`running: false`) and `recoverInterrupted()` releases a lease left over from a crash and makes the entry due again promptly instead of leaking it forever or silently skipping a cycle. `reconcileOnBoot()` skips entries that are still `running`.
   - `tickSchedules()` now calls `scheduleStore.claimDue()` instead of `due()`, and the 30-second `setInterval` itself is guarded by a `scheduleTicking` boolean (`src/index.ts`, `clientReady`) so a slow tick can't pile up concurrent invocations, matching the review's "doesn't await/lock prior ticks" complaint at the orchestration layer as well as the data layer.
   - Test: `schedule-store.test.ts` → `"claimDue atomically marks entries running so a concurrent tick cannot claim them again"` simulates exactly the review's scenario — one occurrence claimed, then a second tick fired against a "later now" well past the 30-second window while the first is still (by construction) unresolved — and asserts the second tick claims zero entries and `due()` also reports zero. This is the overlapping-tick test the review asked for, written at the store layer where the bug actually lived (index.ts isn't unit-testable without a live Discord client, consistent with every other file in this codebase).
   - The same atomic-claim pattern was applied to the queue runner for issue 4 below, since it had the identical defect shape.

2. **Recurring writes violate the explicit-approval contract.** Resolved by removing write capability from `/schedule` entirely (see scope decision above). `commands.ts`'s `/schedule add` no longer has a `mode` option; the command description now says "Owner-only recurring devbot tasks. Read-only: schedules can only ask, never write." `runScheduledEntry` calls `runProjectRequest` with a hardcoded `mode: "answer"`. Safe-mode gating, standing-approval expiry, and per-occurrence approval-gated proposals are all moot because there is no write path left to gate.
   - Test: `schedule-store.test.ts` → `"schedule add computes a future nextRun, defaults to read-only, and rejects a bad spec"` asserts `entry.mode === "answer"`; `AddScheduleInput` no longer accepts a `mode` field at all (compile-time enforced — `tsc` fails if one is passed).

3. **Queue positions cross project-access boundaries.** `QueueItem.id` (already stable, e.g. `queue-lz3k2f-a1b2c3`) is now the only way to remove an item: `/queue remove` takes `id:<id>` instead of `position:<n>` (`commands.ts`, `QueueStore.removeById`). `formatQueueList` prints the id next to each entry so operators can copy it from `/queue list`. The remove handler in `index.ts` re-fetches the item by id, resolves its project, and calls `isAllowedForProject` for the *invoking user* before removing — a controller can no longer discover or clear a hidden-project item via a shared positional index. `/queue clear` now takes an explicit `allowedProjectNames` set computed the same way `/queue list` does and only skips queued items whose project is in that set (`QueueStore.clear(allowedProjectNames)`); `/queue digest` on demand filters to the same allowed-project set before formatting. `QueueItem` gained `addedById` (the Discord snowflake, not just the mutable `.tag`), populated from `interaction.user.id` at `/queue add` time and persisted through reload/redaction.
   - Tests: `"clear only skips queued items whose project is in the allowed set"`, `"clear with an empty allowed set clears nothing"`, plus the id-based tests below for issue 4.
   - `/queue start`/`stop` remain global (single shared background runner — there's one queue, not one per project), but issues 3/4/5 combined mean every item is now individually re-authorized against its own submitter and routed to its own project's safe audience at execution time regardless of who started the runner, which is what actually protects a controller from being able to leak or steer another project's hidden work.

4. **A queued item can be removed and still execute.** `QueueStore.claimNext()` atomically transitions the next queued item straight to `running` in one `mutate()` call, called by `advanceQueue()` *before* `runProjectRequest` starts (previously the item stayed `queued` until the first progress callback minutes later called `markRunning`, leaving a window where `/queue remove` could mark it `skipped` and then the late `markRunning` would stomp it back to `running`). The old `markRunning(id, taskId)` was replaced by `attachTaskId(id, taskId)`, which now *requires* the item to already be `running` (throws otherwise) — it only records the Codex task id once execution is underway, it never flips state. `markFinished` similarly now requires `state === "running"`, enforcing the valid-transition invariant end to end.
   - Tests: `"claimNext atomically transitions the next queued item to running"`, `"claimNext returns undefined once nothing is queued"`, `"removeById rejects the currently running item and cannot be raced by a late claim"`, `"attachTaskId requires the item to already be running"`, `"markFinished requires the item to be running and records a summary"`.

5. **Scoped-project output can leak into the global private room.** New `scopedRoomChannel(appConfig, project, fallback?)` in `index.ts`: prefers the project's bound ambient room (bernard's `projectRoomIds`, re-verified through the existing `isConfiguredRoomId` audience check) when one is configured; falls back to the private room only if the project has *no* audience restriction (`hasProjectAudienceRestriction`); otherwise returns `undefined`, which suppresses posting for that item/entry entirely (the task still runs and its result is still recorded in the store/`/queue list`/`/queue digest`, just not broadcast anywhere the audience can't be guaranteed — the recorded summary is annotated "output suppressed: no audience-safe room for this project"). Both `advanceQueue`/`runQueueItem` and `runScheduledEntry` now resolve output channel per item/entry through this function instead of always using the private room. For digests specifically, `postQueueDigests` (replacing `tryPostQueueDigest`) groups undigested items by project (`groupQueueItemsByProject`) and posts one message per project to that project's own resolved channel — two projects are never combined into a single digest message, and a project whose channel can't be resolved is simply retried on the next drain/boot rather than posted to the wrong room or dropped.
   - Test: `"groupQueueItemsByProject groups items and preserves per-group order"`. The room-resolution logic itself (`scopedRoomChannel`) depends on a live Discord client/guild and is exercised the same way the rest of `index.ts`'s Discord wiring is — manual verification (see below) — consistent with this file having no direct unit tests anywhere in the codebase.

6. **State files not owner-only or schema-hardened.** Both stores now follow the exact `task-store.ts` pattern: `mkdir(..., { mode: PRIVATE_DIRECTORY_MODE })` + `hardenPrivateDirectoryPermissions`, temp-file `writeFile(..., { flag: "wx", mode: PRIVATE_FILE_MODE })` + atomic rename, and `hardenPrivateFilePermissions` on every load. `load()` validates `version` (throws on anything but `1` or absent) and normalizes every record (`normalizeLoadedItem` / `normalizeLoadedEntry`), silently dropping malformed entries instead of trusting raw JSON — id pattern, known state/mode enum, and parseable timestamps are all checked. `taskText`/`summary`/`lastResult` are passed through `redactSensitiveText` (existing secret-redaction from `security.ts`) and a new `neutralizeMentions` helper (`security.ts`) that breaks `@everyone`/`@here`/`<@id>` mention syntax before the text is ever persisted, so a digest or list render can never re-activate a mention even if Discord's global `allowedMentions: { parse: [] }` default were ever overridden on a specific send.
   - Tests: `"queue drops malformed records and rejects an unsupported version on load"`, `"queue redacts secrets and neutralizes mentions in stored text"`, `"schedule drops malformed records and rejects an unsupported version on load"`, `"schedule redacts secrets and neutralizes mentions in stored text"`.

7. **Digests lack a run/batch boundary.** `QueueItem` gained `digestedAt?: string`. `QueueStore.listUndigested()` returns only `done`/`failed` items that haven't been digested yet; `markDigested(ids)` stamps them. `postQueueDigests` (issue 5) only ever pulls from `listUndigested()` and marks exactly the items it successfully posts as digested — a later drain can never re-include a previous drain's already-reported work. The old boolean `runner.pendingDigest` bookkeeping was removed since it's now redundant with the per-item marker (which is idempotent regardless of how many times boot/drain call it). The on-demand `/queue digest` command intentionally does *not* mark items digested — it's a read-only preview of current state (filtered to the caller's allowed projects per issue 3) and stays safe to run repeatedly without affecting what the automatic post-drain digest will later report.
   - Test: `"listUndigested returns finished items until markDigested is called, grouped by project"` explicitly checks a second "drain" never re-surfaces an already-digested item.

### Fail-closed re-authorization (cross-cutting, requested for issues 3/4)
New `requesterAllowedForProject(appConfig, project, requesterId)` in `index.ts` is called immediately before every queue item and schedule occurrence actually executes (inside `advanceQueue` and `runScheduledEntry`, after the atomic claim, before `runProjectRequest`). It re-checks the *original requester's* current membership/roles against the project's policy — including a live guild-member fetch, so a user who lost a role or left the server after enqueueing is caught — and fails closed (returns `false`) for unresolvable/legacy requesters rather than defaulting to trust. A stale-access item is marked `failed`/`skipped` with an explanatory summary instead of running.

### Verification
- `npx tsc -p tsconfig.json --noEmit`: clean.
- `npm test`: **160 passed, 0 failed**, run three times during this round to confirm the only failure seen (`security.test.ts`'s child-process timeout test, under load) is the pre-existing known flake called out in the brief — it passed on every rerun.
- Not run against live Discord (per lane rules — verified via `npm test`, `tsc`, and manual code-path tracing against the existing `/do`/`/queue`/ambient-room execution paths).

### Still worth the maintainer's attention
- `/queue start`/`stop` remain a single global runner by design (see issue 3 note above) — flagging again here in case bernard wants per-project queues in a future round; out of scope for this fix pass.
- `requesterAllowedForProject`'s guild-member fetch adds one Discord API round trip per queue item / schedule occurrence right before execution. For a large overnight queue this is a bounded, sequential cost (queue is already strictly serial) but worth knowing about if guild size or rate limits ever become a concern.
