# Lane G — Screenshot-to-fix

Branch: `claude/screenshot-to-fix`

## What this builds

Drag a screenshot of a stack trace, console error, or broken UI into the devbot room and mention the bot. Devbot:

1. Downloads the attached image(s) (png/jpg/webp, capped at 8 MB each) to a temp dir.
2. Calls the local Codex CLI in image-capable read-only mode (`codex exec -i <file> ...`) to transcribe the visible error text. The prompt explicitly instructs the model to treat everything in the image as literal error-report data and never follow instructions found inside it. If no error-looking text is visible, Devbot says so honestly and stops.
3. Feeds the transcribed error text into the existing project-context ranking (`ProjectContextService.pack`, seeded by the transcription) and asks Codex (read-only) to point to the likely file/symbol location in the repo and suggest a fix approach.
4. Replies with the transcribed error in a code block, the suspected location, the suggested approach, and two buttons: **Fix it** and **Dismiss**.
5. **Fix it** (owner/controller-gated, respects safe mode) starts a `/do` task pre-filled with the transcription + location + approach. **Dismiss** clears the pending record and removes the buttons.

## Files touched

- `src/codex-client.ts` — `buildImageExecArgs` (pure -i flag construction), `transcribeErrorImages`, `parseTranscription`, `locateErrorInProject`, `parseLocateResponse`. `completeCodexPrompt` now accepts `imagePaths`.
- `src/screenshot-fix.ts` (new) — attachment filtering (`filterImageAttachments`/`isSupportedImageAttachment`), temp-dir lifecycle helper (`withTempImageDir`), `downloadImageAttachment` (injectable fetch for testability), fix-task prompt/reply builders (`buildFixTaskPrompt`, `formatScreenshotAnalysisReply`, `formatNoErrorFoundReply`), and the Fix it/Dismiss button encode/parse helpers (`screenshotFixControlRow`, `parseScreenshotFixControl`).
- `src/screenshot-fix-store.ts` (new) — `ScreenshotFixStore`, a durable atomic-JSON store under `.devbot/screenshot-fixes.json` (mirrors `task-store.ts`) so the Fix it button survives a bot restart. Records are removed once acted on (fix or dismiss).
- `src/index.ts` — in the `messageCreate` mention handler, image attachments on an authorized mention are routed to `handleScreenshotMention` instead of the normal text Q&A path (non-image attachments fall through unchanged). In `interactionCreate`, a new button branch dispatches to `handleScreenshotFixControl` for `devbot:snap-fix:*` custom IDs, following the existing `taskControl` pattern (`isAllowed` -> `ensureConfiguredRoom` -> handler).
- Tests: `src/codex-client.test.ts`, `src/screenshot-fix.test.ts`, `src/screenshot-fix-store.test.ts` (new).
- `README.md`, `docs/DEVBOT_PRODUCT_PLAN.md` — feature bullets added.

## How to verify manually in Discord

1. Configure the private room and at least one project (`/setup wizard` / `/setup repo`).
2. In the private room, mention the bot with an image attached that contains a real stack trace or console error screenshot.
3. Expect: typing indicator, then a reply with a code-block transcription, a suspected `file:line`, a suggested approach, and **Fix it** / **Dismiss** buttons.
4. Click **Dismiss** as a non-owner/non-controller viewer: works (no gating on dismiss).
5. Click **Fix it** as a non-owner/non-controller viewer: expect an ephemeral "only the owner or an approved controller" message, record untouched.
6. Click **Fix it** as the owner/a controller: expect an ephemeral `/do`-style task run pre-filled with the transcription/location/approach, using the normal task progress -> completion flow and task controls.
7. Attach a screenshot with no visible error (e.g. a plain settings page): expect the honest "I can see the image, but no error text" reply with no buttons.
8. Attach a non-image file (e.g. a `.txt`) with mention text: expect normal text mention behavior (screenshot path is skipped).
9. Attach an image as a message that mentions the bot but from an unauthorized user: expect the existing "You are not allowed to use this bot" denial (unchanged deny-by-default behavior).
10. Restart devbot after step 3 (before clicking a button) and confirm **Fix it** still works — the pending record is read from `.devbot/screenshot-fixes.json`, not memory.

## Known limitations / risks

- Two sequential local Codex CLI calls per screenshot (transcribe, then locate) — slower and costs more local Codex time than a single-shot answer. Chosen so the location call can reuse the existing tested context-ranking pipeline seeded by the real transcription, rather than guessing before transcription exists.
- Codex CLI's actual image flag is assumed to be `-i <file>` per the feature brief; not verified against a live Codex binary in this sandbox (no network/Discord run was performed, per lane rules). If the real CLI uses a different flag or accepts only one `-i` per image differently, `buildImageExecArgs` is the single place to adjust.
- No OCR/heuristic fallback if the local Codex binary is missing entirely — the existing `completeCodexPrompt`/`runCodex` error surface (process error message) is reused as-is; a missing binary will show as a generic "Error analyzing the attached image: ..." reply.
- The Discord attachment download uses global `fetch` (Node >= 20 built-in) — no new dependency, but it does perform a real HTTP GET against Discord's CDN URL for the attachment at analysis time. This is normal Discord bot behavior (reading a message's own attachment), not an outward post, and was not exercised live in this sandbox.
- `Fix it` removes the pending record before the `/do` task starts, so a second click (or a click after a crash mid-task) correctly reports "no longer available" rather than double-firing; the original message's buttons are left visually enabled after use (not disabled), consistent with how `Dismiss` behaves elsewhere in this codebase (task-controls does not proactively disable rows either).
- Attachment size cap is a hardcoded 8 MB (`MAX_IMAGE_ATTACHMENT_BYTES` in `screenshot-fix.ts`), not yet exposed as an env-configurable option.

## Rebase note

Rebased onto `85e2530` (origin/main, "Merge pull request #15 from bernard-ks/codex/ambient-workrooms" — includes dd0af6b "Add ambient Discord workrooms and security hardening").

Two real conflicts, both resolved to keep both sides fully integrated:

- `src/codex-client.ts`: git auto-merged the bulk of it (bernard's hardened `exec` args — `--ask-for-approval never`, `--strict-config`, disabled subsystems, restricted `shell_environment_policy`, isolated `HOME`/`CODEX_HOME`, `MAX_CONCURRENT_CODEX_RUNS` queueing, `redactSensitiveText` on output — coexists cleanly with this lane's `imagePaths`/`buildImageExecArgs` additions to `CompleteCodexOptions`). The only manual fix: this lane's commit still carried its own old, unhardened `runCodex` (prompt passed as a trailing exec arg, `env: process.env`, `stdio: ["ignore", ...]`). Deleted that duplicate and kept bernard's `runCodex` (prompt piped over stdin via `child.stdin.end(prompt)`, isolated child environment, termination/timeout handling) — image-capable calls now go through the exact same hardened spawn path as every other Codex call, no reintroduced un-hardened shape.
- `docs/DEVBOT_PRODUCT_PLAN.md`: doc-bullet conflict between the ambient-workrooms bullets and the screenshot-to-fix bullets under "Mention support". Kept both bullet lists and added one line noting that image-bearing mentions route to screenshot-to-fix ahead of the natural-intent/ambient-workroom flow.

`src/index.ts` (the file with the largest upstream diff, +1501/-202) rebased with **no conflicts** — git's merge placed the image-attachment check from `handleScreenshotMention` at the same point in the new `messageCreate` handler (right after `preferredProject`/`visibleConfig` are computed, before status-request parsing), which lands correctly ahead of bernard's new `naturalIntent = classifyNaturalIntent(...)` branch. Verified by reading the merged handler directly: image-bearing authorized mentions return early into `handleScreenshotMention` before `classifyNaturalIntent` is ever called; everything else (no image) falls through unchanged into bernard's proposed-action / ambient-workroom / plain-answer routing. The `interactionCreate` button chain also merged clean: `devbot:snap-fix:*` custom IDs are handled in their own branch (`isAllowed` -> `ensureConfiguredRoom` -> `handleScreenshotFixControl`) inserted before the generic workroom-button fallback, alongside (not replacing) bernard's ambient/workspace/setup/task-control branches.

`npm run build` clean, `npm test` 140/140 green on two consecutive runs (including `security.test.ts`'s "configured project commands receive an empty temporary home", the flagged possibly-flaky case — no flake observed).
