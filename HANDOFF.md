# Lane C handoff — before/after visual diff + shipped-it clips

Branch: `claude/visual-diff-clips`

## Rebased onto 85e2530 (2026-07-10)

Rebased onto `origin/main` after bernard's "Add ambient Discord workrooms and security hardening" merge (`dd0af6b`, PR #15), which restructured `runProjectRequest` to execute every action-mode task inside an **isolated Git worktree** (`src/task-worktree.ts`) and hardened `src/project-screenshot.ts` (SSRF-safe `canReach`/`isAllowedScreenshotResource` with an `allowedOrigins` param, tighter URL normalization).

Conflicts (3 files, all textual "both sides added adjacent lines" conflicts, no logic actually competing for the same lines):

- **`src/task-store.ts`** — `formatTaskDetail`'s array literal: main added `changedFiles`/`diffStat`/`verification` lines, this lane added `captureChangedPercent`/`captureNote` lines, both after the same `includePatterns` line. Resolution: kept both blocks, worktree-evidence lines first, capture lines after (matches the chronological order they're populated in `runProjectRequest`).
- **`src/commands.ts`** — the exported command array: main added a `Start Devbot workroom` context-menu command as the last array element ending the array; this lane added the `/ship` slash command the same way. Resolution: `/ship` slash command, then the context-menu command, then the closing `satisfies Array<...>` / `commandDefinitions` lines from main (main's version is stricter than this lane's plain `.map(...)`, so kept main's).
- **`src/index.ts`** — two spots:
  1. Import block: main added `task-access.js`/`task-worktree.js` imports where this lane's `visual-capture.js`/`ship-card.js` imports also landed. Trivial — kept both import groups (this lane's imports were on the other side of the hunk and merged in cleanly without a marker).
  2. `runProjectRequest`, right after `runCodex(...)` resolves: main added `if (isolatedWorktree) { await recordTaskWorktreeEvidence(...) }`, this lane added the `finishVisualCapture`/`taskStore.recordCapture` block. Both needed — see the isolated-worktree semantic note below for how they were combined (not just concatenated).

### Isolated-worktree capture semantics — decision and reasoning

This lane's before/after screenshots hit the project's **detected local dev server** (`findProjectWebUrls`/`captureProjectScreenshot`), which watches and serves the **source checkout** (`options.project.root`). Bernard's isolation change means an action-mode task's file edits now land in a *separate* `git worktree add` checkout (`executionProject.root`, e.g. `~/.devbot/worktrees/<task>`) on a new review branch, and are explicitly **left uncommitted there for human review** — `recordTaskWorktreeEvidence` never merges or copies them back into the source checkout. I checked for a "promotion" step that might land the change in the source checkout before task completion (there's a `promote` task action, but it only re-runs a *different* task in action mode from a followup modal — it does not merge or fast-forward the isolated branch into the source checkout). So there is no in-flow hook to wait on before capturing "after".

Net effect: the dev server the after-capture hits essentially never reflects this task's edits by the time `finishVisualCapture` runs, since they're not in that checkout at all. A 0%-changed (or noise-level) diff after an isolated action task is therefore not evidence the task had no visual effect — it just hasn't been merged yet. Silently showing "no diff" (or worse, attaching a "before/after, 0.2% changed" card) would misrepresent that as "verified no visual impact," which is false.

Chose the second option offered in the lane brief: **keep the existing threshold gate** (`shouldAttachDiffCard`, still only attaches a card above ~0.5% changed pixels — still useful for catching real cases like static/public-asset changes, dev-server health regressions, or non-git-tracked state) **and always attach an explicit isolation caveat** as `captureNote` on the task record whenever `isolatedWorktree` was used for that task and an after-capture was actually attempted (see the comment + `recordCapture` call right after `finishVisualCapture` in `runProjectRequest`, `src/index.ts`). The note names the review branch and says the comparison won't reflect that branch until merged; it surfaces via `/task show id:<id>` (`formatTaskDetail`'s existing "Visual diff note:" line, unchanged from before the rebase). Did not also inject the caveat into the public completion message (`visualDiffNote`) — that helper only fires when a card is attached, and always adding a "may not reflect isolated changes" line to every action-task completion (most of which have no visual capture attempted at all) seemed like more noise than signal; task detail is the right place since that's already where isolation/branch state (`Branch: ... (isolated)`) is surfaced.

Did not change `beginVisualCapture`/`finishVisualCapture` themselves (still called with `options.project`, the source checkout) — that's correct as-is: `findProjectWebUrls` → `detectLocalWebUrlsFromPs` matches running dev-server processes against `project.root`, so pointing at the isolated worktree path would find no running server at all, not a more-accurate one.

`npm test`: 136/136 passing, two consecutive full runs (build + `node --test`), including the flaky-under-load `security.test.ts` "configured project commands receive an empty temporary home" case, which passed cleanly both times.

## What was built

1. **`src/visual-diff.ts`** — pure, dependency-free pixel diffing on top of `sharp`:
   - `diffImages(beforePng, afterPng, options?)`: normalizes both images to a shared canvas size, computes a per-pixel RGB diff, clusters changed pixels into a grid (default 24px cells, 12% change ratio) and returns `{ width, height, changedPixelPercent, regions }`.
   - `clusterChangedCells(grid, cellWidth, cellHeight, imageWidth?, imageHeight?)`: pure flood-fill bounding-box clustering over a boolean grid, exported and unit-tested independent of image I/O.
   - `commonCanvasSize`, `shouldAttachDiffCard` (threshold decision, default 0.5% changed pixels): pure helpers.
   - `composeBeforeAfter(before, after, regions)`: side-by-side PNG card with BEFORE/AFTER SVG labels and red highlight rectangles over changed regions on the AFTER panel (max panel width 560px, scales down large screenshots).

2. **`src/ship-card.ts`** — the "shipped it" social card:
   - `composeShipCard({ projectName, summary, image?, changedPercent? })`: fixed 1200x675 PNG card with project name, truncated one-line summary, optional changed-percent badge, the supplied image letterboxed into the remaining area (or a "No screenshot captured" placeholder), and a `devbot` wordmark corner tag.
   - `truncateShipSummary`, `containSize` (aspect-preserving fit-within-box math): pure, unit-tested.

3. **`src/visual-capture.ts`** — orchestration + durable storage:
   - `canAutoCaptureProject(project)`: gates automatic capture on the project's `screenshotPolicy` (only `"allow"`; `"approval"`/`"deny"` skip automatic capture since there's no synchronous human to approve a background capture).
   - `beginVisualCapture(project, requestText)`: checks for a detected local dev server (`findProjectWebUrls`) and captures a "before" screenshot via the existing `project-screenshot.ts` scoring/navigation, reusing it as-is.
   - `finishVisualCapture(session, project, taskId)`: captures the "after" screenshot at the same resolved URL, runs `diffImages`, always persists the after screenshot to `.devbot/captures/<taskId>-after.png`, and — only when `shouldAttachDiffCard` passes — composes and persists `.devbot/captures/<taskId>-diff-card.png`.
   - `resolveShipImage(task, project)`: picks the best available image for `/ship` — diff card → after screenshot → (if capture is still allowed) a fresh live screenshot — used both by `/ship` and its button twin.
   - Capture files are written atomically (temp file + rename), same pattern as `task-store.ts`/`user-preferences.ts`.

4. **`src/task-store.ts`**: added `captureBeforeUrl/At`, `captureAfterUrl/At`, `captureChangedPercent`, `captureAfterFile`, `captureCardFile`, `captureNote` to `TaskRecord`, a `recordCapture()` mutator, and a "Visual diff: X% changed (...)" / "Visual diff note: ..." line in `formatTaskDetail`.

5. **`src/index.ts`** wiring:
   - `runProjectRequest` (the shared engine behind `/do`, action mentions, and all follow-up/retry/adjust action flows) now: kicks off `beginVisualCapture` concurrently with context packing when `mode === "action"`, awaits it before calling into Codex (so file writes never race the "before" screenshot), captures "after" + diffs once Codex succeeds, records capture metadata on the task unconditionally, and returns an optional `visualDiff` (`changedPercent`, `cardBuffer`, `cardFileName`) only when the change crosses the threshold.
   - `executeInteractionRequest` / `executeMessageRequest` attach the composed card (`AttachmentBuilder`) and append a "Visual diff: X% of the page changed." line to the completion message when present.
   - All capture failures are caught and degrade to a `captureNote` on the task (visible via `/task show`) plus a `console.warn`; they never throw and never fail the task.
   - New `/ship task:<task-id>` command (`handleShipCommand`) and a "Ship it" button on completed action tasks (`task-controls.ts`, gated the same way as "Run checks"/"Cancel": owner or controller only). Both funnel through the shared `buildShipCard`/`shipCardCaption` helpers.
   - `/ship` and the button are gated via `commandRequiresController`/`canControl` respectively — same owner/controller model as `/do` and `/run`.

6. **`src/commands.ts`**: added the `/ship` slash command definition (`task` option, autocomplete already generically wired for any `task`/`id`-named option in `autocomplete.ts`/`handleAutocomplete`).

7. **`src/task-controls.ts`**: added `"ship"` to `TaskControlAction`, the button (only when `canControl` and the task is a completed action task), and the `parseTaskControl` regex.

8. Docs: added a `/ship` bullet to `README.md`'s Advanced Command Reference, and a "Visual diff and ship cards" bullet under Current Features in `docs/DEVBOT_PRODUCT_PLAN.md`.

## Tests

New dedicated test files (matching the existing `*.test.ts`-next-to-source pattern, e.g. `task-ui.test.ts`):
- `src/visual-diff.test.ts` — `commonCanvasSize`, `shouldAttachDiffCard` threshold edges, `clusterChangedCells` (synthetic grids: merged block + isolated corner cell clipped to image bounds, all-clear grid), `diffImages` end-to-end with synthetic sharp-rendered "red square moved" PNGs (region location + changed-percent bounds), `diffImages` on identical images (0% / no regions), `composeBeforeAfter` with and without regions.
- `src/ship-card.test.ts` — `truncateShipSummary` (whitespace collapse, exact-length ellipsis truncation), `containSize` (both axes, degenerate zero-size), `composeShipCard` with and without an image (fixed 1200x675 output).
- `src/visual-capture.test.ts` — `canAutoCaptureProject` per policy value, `captureFileName`, `resolveShipImage` priority order (card > after > blocked-policy undefined) using a temp capture directory, no network/browser calls.
- Extended the existing task-controls tests in `src/context.test.ts` (where `taskActionRows`/`parseTaskControl` are already tested) with a "ship" case: button appears for controllers on completed action tasks, absent for viewers and for answer-mode tasks, and `parseTaskControl` round-trips the new action.

`npm test` (tsc build + `node --test dist/**/*.test.js`): **92/92 passing**, 0 failures.

## How to verify manually in Discord

1. Point a configured project at a running local dev server (Vite/Next/etc.), run `/do task:"tweak the header color"` (or an action-mode `@devbot` mention) as the owner/controller.
2. Watch the completed task message: if the change is visually detectable, a before/after PNG is attached with a "Visual diff: X% of the page changed." note; `/task show id:<id>` shows the same percent plus the before/after URLs.
3. Click "Actions" → "Ship it" on that completed task, or run `/ship task:<id>` directly — expect an ephemeral (or channel, depending on project audience policy) reply with a 1200x675 card attached.
4. Set a project's screenshot policy to `deny` or `approval` (`.devbot/project.json`) and confirm `/do` runs complete normally with no capture attempt, and `/ship` on such a task falls back to a text-only card.

## Known limitations / risks

- **Latency**: the "before" screenshot capture is awaited before Codex starts (to avoid racing dev-server hot-reload against the screenshot), adding roughly 1-5s to action-task start when a dev server is detected. It runs concurrently with context packing to hide part of that cost.
- **Heuristic diffing**: the grid-cell clustering (24px cells, 12% cell-change ratio, ~0.5% overall threshold) is tuned for typical desktop-viewport screenshots; very small or very large UI changes may need retuning of the constants in `visual-diff.ts` (`DEFAULT_PIXEL_THRESHOLD`, `DEFAULT_GRID_CELL_SIZE`, `DEFAULT_CELL_CHANGE_RATIO`, `DEFAULT_DIFF_ATTACH_THRESHOLD_PERCENT`).
- **No cross-restart capture recovery test with a live browser**: `resolveShipImage`'s live-fallback path (when no capture was ever saved) calls `captureProjectScreenshot`, which launches Playwright; this was not exercised in automated tests per the lane's "never start the bot / hit a live browser in tests" boundary — it's the same, already-used code path as `/snip`, so risk is limited to the new call site wiring, which is covered indirectly by `resolveShipImage`'s file-based tests plus the type-checked build.
- **Disk usage**: captured PNGs accumulate under `.devbot/captures/` per task with no pruning/GC in this lane; `task-store.ts` already caps retained task *records* (`maxRecords`), but the on-disk image files for pruned tasks are not deleted. Worth a follow-up lane if capture volume becomes noticeable.
- Did not encounter any instruction-shaped content in repo files while exploring (no injected agent-directed text found).

## Review round 1 (2026-07-10)

Bernard requested changes on `a587fa1` (see `REVIEW.md` at the worktree root — an untracked file dropped for this fix pass, not committed). His follow-up on top of the formal review was explicit and is treated as binding over the original acceptance checklist where the two conflict: **skip automatic before/after capture and diff-card attachment entirely for isolated tasks** (every action task is isolated — see below) rather than build a full managed-preview lifecycle in this pass, and narrow the whole visual-evidence surface to `/ship`, on demand, honestly captioned. That is the design implemented below. New commits on top of `a587fa1`; no history rewritten.

**Key fact that shaped every fix**: `runProjectRequest` (`src/index.ts`) calls `createTaskWorktree` for *every* `mode === "action"` task and fails the whole task if isolation is unavailable (`isolationError`) — there is no code path where a completed action task ran un-isolated. So "isolated tasks" and "action tasks" are the same set today; there was never a valid target for an automatic before/after diff against the source checkout's dev server.

1. **Visual diff targets the source checkout instead of the isolated task workspace.** Fixed by removal, not redirection: `runProjectRequest` no longer calls `beginVisualCapture`/`finishVisualCapture` at all (both deleted from `visual-capture.ts`). Since 100% of completed action tasks are isolated, there was no safe way to "target the isolated workspace" without a managed preview (see #2), so the false-evidence path is eliminated rather than patched. `src/index.ts` (`runProjectRequest`), `src/visual-capture.ts`.

2. **No isolated preview lifecycle.** Per Bernard's follow-up, this is not built in this round (would compete with PR #13's evidence-capture subsystem — see #6). Instead: completed action tasks unconditionally get an honest `captureNote` — `` Visual proof unavailable: this task ran on isolated branch `<branch>`. Run `/ship task:<id>` for details, or review the branch directly. `` — visible via `/task show` (`formatTaskDetail` in `task-store.ts`, now prefixed "Visual proof:"). `src/index.ts` (`runProjectRequest`, success path).

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
