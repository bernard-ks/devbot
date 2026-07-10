# Lane H — Voice note to task

## What was built

Devbot now handles Discord voice messages (and regular audio-file attachments)
sent by authorized users in the private room, transcribes them locally, and
turns the ramble into an Ask or Make-change task.

- `src/transcribe.ts` — no new npm dependencies. Detects `ffmpeg` and a
  whisper.cpp binary (`whisper-cli`, `whisper-cpp`, or `main`) on PATH plus
  common local install locations (`/opt/homebrew/bin`, `/usr/local/bin`,
  `~/whisper.cpp`, `~/whisper-cpp`), honoring `DEVBOT_WHISPER_BIN`. Resolves a
  whisper.cpp `ggml-*.bin` model from `DEVBOT_WHISPER_MODEL` or by scanning
  `~/whisper-models` / `~/whisper.cpp/models` and picking the smallest file
  found. Builds the `ffmpeg` (16kHz mono wav) and whisper.cpp command lines,
  enforces a 5-minute audio cap (using Discord's own `duration`/`size` fields
  on the attachment, no ffprobe needed) and a 120s whisper timeout via
  `execFile`'s built-in `timeout` option, and always cleans up its temp
  directory in a `finally` block.
- `src/voice-store.ts` — durable, atomic-write JSON store
  (`.devbot/voice-notes.json`, override with `DEVBOT_VOICE_STORE`) that keeps
  each transcript keyed by a `voice-<id>` record so Discord buttons only ever
  carry a short, validated ID (never raw transcript text) in their custom ID
  — this is what makes the buttons restart-stable, matching the `task-store`
  pattern.
- `src/voice-controls.ts` — builds/parses the Ask / Make change / Dismiss
  button row and the "confirm or edit" modal shown for Make change.
- `src/index.ts`:
  - `maybeHandleVoiceMessage` runs first in `messageCreate` (before the
    `@mention` gate, since voice notes don't mention the bot), checks the
    private room + `isAllowedMessage` + per-project `.devbot` policy, applies
    the duration/size gate, detects the local pipeline (replying with concise
    setup instructions and returning if anything is missing — no crash, no
    retry loop), transcribes, and replies with the quoted transcript (full
    text attached as `transcript.txt` when it exceeds ~1500 chars) plus the
    button row. Targets the requester's selected/default project the same
    way mentions do, and defers to `hasProjectAudienceRestriction` exactly
    like the mention flow (no scoped-audience project is exposed in a shared
    voice-note reply).
  - `handleVoiceControl` / `handleVoiceActModal` wire the three buttons:
    **Ask** runs the transcript through the same read-only path as
    `/ask`/mentions (`executeInteractionRequest`, mode `answer`). **Make
    change** is owner/controller-gated and safe-mode-gated, and — like the
    workspace "Make change" button — opens a modal pre-filled with the
    transcript so the controller must confirm or edit it before anything
    runs; submitting executes mode `action` with a `dedupeKey` (mirroring how
    the codebase already throttles write-capable retries) so a double
    submit can't trigger the change twice. **Dismiss** clears the buttons and
    deletes the stored transcript.
  - `/setup doctor` gained a "Voice notes" section reporting ffmpeg /
    whisper.cpp / model detection (or that voice is disabled via
    `DEVBOT_VOICE_ENABLED=false`), independent of the existing readiness
    gate so it doesn't change `/setup doctor`'s overall pass/fail count.
  - `voice.enabled` (`AppConfig.voice.enabled`, `src/types.ts`/`src/config.ts`)
    defaults to `true` via `DEVBOT_VOICE_ENABLED` (parsed with the existing
    `parseBoolean` helper); when binaries/model are missing the feature just
    degrades to a setup message per voice note, so "ON by default" is safe.

## Files touched

- `src/transcribe.ts`, `src/transcribe.test.ts` (new)
- `src/voice-store.ts`, `src/voice-store.test.ts` (new)
- `src/voice-controls.ts`, `src/voice-controls.test.ts` (new)
- `src/index.ts` (voice message handling, button/modal routing, setup doctor section)
- `src/types.ts`, `src/config.ts` (`AppConfig.voice`)
- `src/setup-store.test.ts` (added `voice` to the test `AppConfig` fixture)
- `README.md`, `docs/DEVBOT_PRODUCT_PLAN.md`, `.env.example` (docs)

## How to verify manually in Discord

1. Install `ffmpeg` (`brew install ffmpeg`) and whisper.cpp (build it, or grab
   a release with a `whisper-cli`/`whisper-cpp`/`main` binary) plus a
   `ggml-*.bin` model under `~/whisper-models`.
2. Run `/setup doctor` and confirm the new "Voice notes" section reports
   `READY` for all three lines. Temporarily rename a binary or unset
   `DEVBOT_WHISPER_MODEL`/empty the models dir to see the `FIX` messages.
3. In the private Devbot room, record and send a Discord voice message (the
   mic button on mobile) asking a question or describing a change. Confirm:
   - Devbot shows typing, then replies with the quoted transcript and
     Ask / Make change / Dismiss buttons, naming the target project.
   - **Ask** produces a normal read-only answer (same routing/progress UI as
     `/ask`).
   - **Make change** (as owner/controller, safe mode off) opens a modal
     pre-filled with the transcript; edit or confirm and submit — it runs the
     normal write-capable task flow. As a viewer, or with safe mode on, the
     button is disabled/blocked with an explanatory ephemeral reply.
   - **Dismiss** clears the buttons.
4. Send a long voice note (or a large attached audio file) to see the 5‑minute
   gate message; send a non-audio attachment to confirm it's ignored; try it
   from a channel other than the private room to confirm nothing happens.
5. Send a regular audio file attachment (e.g. a `.m4a` voice memo) instead of
   a native Discord voice message — same flow should trigger.

## Known limitations / risks

- No real audio/ffmpeg/whisper invocation is exercised in the automated
  tests, per the lane brief — `npm test` only covers discovery ordering,
  command construction, gating math, and store/control round-trips. The live
  ffmpeg → whisper.cpp pipeline (`transcribeAttachment`) has not been run
  against a real Discord attachment in this sandbox; it should get a manual
  smoke test before shipping.
- The 5-minute cap trusts Discord's own attachment `duration`/`size`
  metadata for true voice messages; a regular audio-file attachment with no
  `duration` metadata falls back to a 20MB size heuristic rather than a true
  duration check (no `ffprobe` dependency was introduced to avoid adding a
  second external binary requirement).
- Whisper model auto-discovery always picks the *smallest* `ggml-*.bin` found
  (fastest/least accurate) when `DEVBOT_WHISPER_MODEL` is unset — intentional
  per the brief, but owners who drop multiple models in `~/whisper-models`
  should know the small one wins by default.
- `ffmpegArgs`/`whisperArgs` assume whisper.cpp's common CLI flags
  (`-m -f -otxt -of -nt -l auto`); this is consistent across `whisper-cli`,
  `whisper-cpp`, and `main` in current whisper.cpp releases, but a very old or
  heavily forked build could use different flags.
- Voice note transcripts persist in `.devbot/voice-notes.json` (git-ignored,
  owner-only file mode) until Dismiss is clicked or the 200-record retention
  cap evicts them; there is no auto-expiry by age.

## Rebase note

Rebased onto `85e2530` (origin/main after bernard's "Add ambient Discord
workrooms and security hardening", `dd0af6b`). One real conflict, in
`src/index.ts`: bernard's new ambient-proposal block (`AmbientProposalRequest`
and friends) and this lane's `maybeHandleVoiceMessage`/`handleVoiceControl`/
`handleVoiceActModal` block were both inserted after `taskStatusForProgress`.
Resolved by keeping both function blocks back-to-back (ambient proposal code
first, voice handling second) — they don't call each other. The
`messageCreate` call site merged cleanly on its own: `maybeHandleVoiceMessage`
still runs immediately after the `message.author.bot` check and before
bernard's new `threadTask`/`mentionsBot`/natural-intent flow, so voice notes
are still detected and short-circuit (`return`) independently of the new
ambient-workroom/natural-intent proposal path. `src/config.ts` and
`src/types.ts` (`AppConfig.voice`) merged with no conflicts.

Also adopted bernard's new conventions in this lane:
- `src/transcribe.ts`: `ffmpeg`/`whisper` are now spawned via `execFile` with
  `env: minimalChildEnvironment()` (from the new `src/security.ts`) so they
  don't inherit the Discord bot token or other application secrets.
- `maybeHandleVoiceMessage`'s transcription-failure reply now uses
  `publicErrorMessage(error)` instead of raw `(error as Error).message`,
  matching how every other Discord-facing error reply in `index.ts` redacts
  secrets before display.

`npm test`: 145/145 passing after the rebase (build + full `node --test`
suite), confirmed on two consecutive runs (no flake observed in
`security.test.ts`'s "configured project commands receive an empty temporary
home" test this time).
