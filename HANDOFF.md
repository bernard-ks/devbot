# HANDOFF — Lane B: Video proof-of-work + live watch mode

Branch: `claude/video-proof`

## What was built

1. **`src/project-video.ts`** (new) — flow recording built on the existing Playwright/screenshot infrastructure:
   - `recordProjectFlow(project, requestText, options)`: detects a running dev server via the existing `findProjectWebUrls`, derives up to 4 scored steps from the request text (`deriveFlowSteps`), records a Playwright video (1280x720, ~30s cap, ~1.5s dwell per step) while performing those steps (click via the existing `bestNavigationCandidate` scoring against visible clickable elements, or scroll via `page.mouse.wheel`), then reads back the `.webm`. If `ffmpeg` is on PATH it transcodes to `.mp4` for maximum inline-playback compatibility (verified working end-to-end with the ffmpeg on this machine); otherwise it attaches the `.webm` as-is.
   - Size-cap handling: `decideSizeCap` is a pure decision function (accept / shrink / fallback) against Discord's 8MB default attachment limit. On first oversize, one retry happens at a reduced viewport (960x540) and duration (18s). If still oversized, `recordProjectFlow` returns a `screenshot-fallback` outcome instead of a video.
   - `isUiRelatedTask(taskText, changedFiles)`: pure heuristic (UI vocabulary in the task text, or UI-flavored changed file extensions/directories) used to decide whether a completed `/do` task deserves proof capture.
   - `listChangedFiles(project)`: `git diff --name-only HEAD` + untracked files, feeding the heuristic above.
   - `selectRecentFrames` / `computeGifPageLayout` / `buildTimelapseGif`: pure frame-selection and sharp page-layout math, plus the actual animated-GIF composition (verified end-to-end with real sharp-generated frames in tests — produces a valid multi-page `GIF89a` buffer).
   - Exported two small previously-private helpers from `src/project-screenshot.ts` (`canReach`, `sanitizeFilePart`) for reuse instead of duplicating them.

2. **`/clip` command** (`src/commands.ts`, handled in `src/index.ts` near the existing `/snip` handler): `target` (required, natural language or path/URL), optional `project` (autocomplete, reuses the existing `project` autocomplete wiring — no changes needed there since it's keyed by option name), optional `steps` (free-text extra actions). Follows the exact same access pattern as `/snip`: `ensureProjectAccess`, then additionally gated by the existing `screenshotPolicyMessage` (deny/approval project policy), since recording is more sensitive than a single screenshot. Posts the recording (or, on fallback/unavailable, a screenshot or an explicit reason) with metadata: URL, viewport, steps actually performed, console errors seen.

3. **Auto proof on `/do`**: `/do` now runs through a new `executeDoInteraction` (kept separate from the shared `executeInteractionRequest` used by `/ask`, retries, etc. to avoid touching those paths). After a successful action-mode task, it checks `isUiRelatedTask(task text, git-changed files)`; if related, it calls `recordProjectFlow` and attaches the resulting video (or screenshot fallback, or an explicit "Proof capture unavailable: ..." note — never silent). Recording failures are caught and degrade to a note; they never fail the task itself.

4. **Live watch mode**: while `/do` runs, if `watch` (new boolean option, default `true`) is on and a dev server is detected for the project, a session captures a screenshot via the existing `captureProjectScreenshot` roughly every 20s and swaps it onto the running task message (same message the progress/task-control UI already lives on) without disturbing the progress text/components. All edits to that Discord message (progress-phase edits and watch-frame edits) are serialized through a small promise-chain queue to avoid interleaved/racing `editReply` calls. On completion, the last up-to-12 captured frames are stitched into an animated GIF (`buildTimelapseGif`, via `sharp`'s `{ raw, animated, pageHeight }` page-composition, confirmed working) and attached alongside the proof video/screenshot in the final message edit. Watch mode is skipped entirely (no capture, no note) when project policy blocks/gates screenshots, consistent with the deny-by-default access model.

5. Docs: added a `/clip` bullet and updated the `/do` bullet in `README.md`; added a "Video proof-of-work and live watch mode" bullet under Current Features in `docs/DEVBOT_PRODUCT_PLAN.md`.

## Files touched
- `src/project-video.ts` (new)
- `src/project-video.test.ts` (new)
- `src/project-screenshot.ts` (exported `canReach`, `sanitizeFilePart`)
- `src/commands.ts` (`/clip` command, `/do` `watch` option)
- `src/index.ts` (`/clip` handler, `executeDoInteraction`, `startWatchSession`, `captureCompletionProof`, `replyWithVideoOutcome`, `formatVideoReply`)
- `README.md`, `docs/DEVBOT_PRODUCT_PLAN.md`

## How to verify manually in Discord
1. Start a local frontend dev server for a configured project (Next/Vite/etc.) so `findProjectWebUrls` detects it.
2. `/clip target:"click settings, then scroll down" project:<name>` — expect a playable video attachment (webm or mp4 if `ffmpeg` is on PATH) with a metadata message (URL, viewport, steps performed, console errors).
3. `/do task:"change the button color on the settings page" project:<name> watch:true` — expect the task message to swap in fresh screenshots roughly every 20s while it runs (visible if the task runs long enough to hit a 20s tick), and on completion see either an attached recording, a screenshot-fallback note, or an explicit "Proof capture unavailable" note, plus an attached timelapse GIF if watch mode captured any frames.
4. `/do task:"..." watch:false` — confirm no periodic screenshot swaps happen.
5. Set a project's `.devbot/project.json` `screenshotPolicy` to `deny` and confirm `/clip` shows the policy-blocked approval card instead of recording, and that `/do` on that project produces no proof note at all changes (watch/proof are silently skipped, matching the deny-by-default policy).

I did not start the bot against Discord — verified via `npm test` (build + `node --test`) plus standalone Node scripts that exercise `recordProjectFlow` end-to-end against a real local HTTP server (confirmed a working `.mp4` with correctly derived steps, and a correct "no server detected" `unavailable` outcome) and `buildTimelapseGif` against real sharp-generated frames.

## Known limitations / risks
- Watch mode launches a fresh headless Chromium via `captureProjectScreenshot` on every ~20s tick; on a slow machine or a long-running task this is a non-trivial number of browser launches. Acceptable given the existing per-request screenshot pattern elsewhere in the codebase, but a future lane could add a longer-lived single browser/page for watch mode instead of relaunching.
- `deriveFlowSteps`'s phrase-splitting heuristic is intentionally simple (split on commas/semicolons/"then", filter to short-or-actionable phrases). It will sometimes pick fewer than 4 steps or none at all for oddly-phrased requests; `recordProjectFlow` still records a plain dwell-and-screenshot flow of the landing page in that case, and `stepsPerformed` in the reply metadata reports exactly what was attempted so this is never silently wrong.
- The final `/do` message edit intentionally omits `files` on progress-phase edits (routing/gathering-context/running-codex) so a previously-swapped watch screenshot isn't wiped out early; only actual watch ticks and the final completion edit change attachments.
- Size-cap fallback-to-screenshot path and the reduced-size retry path are covered by the `decideSizeCap` unit tests and manually reasoned through, but weren't exercised end-to-end with an actual >8MB recording (would require an artificially large capture to trigger in this environment).
- No changes were made to `mention.ts` / `executeMessageRequest` (the `@devbot do ...` mention path); auto-proof and watch mode are scoped to the `/do` slash command per the brief's explicit wording. If the wave wants parity for mention-triggered action tasks, that would be a follow-up.
