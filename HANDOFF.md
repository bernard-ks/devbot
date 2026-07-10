# Lane E — Overnight queue + scheduled tasks

Branch: `claude/task-queue-schedule`

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
`npm test` (tsc build + `node --test` on dist): **103 passed, 0 failed** — 74 pre-existing plus 29 new (14 in `queue-store.test.ts`, 15 in `schedule-store.test.ts`).
