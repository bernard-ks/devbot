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

## Review round 1

Bernard requested changes twice (initial review plus a follow-up retest on
`f55faac` that confirmed the `minimalChildEnvironment()` fix and re-listed the
rest of the acceptance checklist). This round addresses every remaining
blocking issue and checklist item except the one real end-to-end smoke test,
which this lane is explicitly barred from adding (see below).

1. **Known-duration attachments bypass the byte limit / unbounded
   `arrayBuffer()` / no origin or media-type validation.**
   - `audioGateMessage` (`src/transcribe.ts`) now enforces the byte cap
     (`MAX_FALLBACK_AUDIO_BYTES`, 20MB) unconditionally instead of only when
     `durationSeconds` is `null` — a short reported duration no longer
     exempts an attachment from the size gate.
   - Added `downloadBoundedAttachment` (`src/transcribe.ts`): fetches with
     `redirect: "manual"`, re-validates `isAllowedAttachmentUrl` on every hop
     (including each redirect target) against an allowlist of Discord's own
     media hosts (`cdn.discordapp.com`, `media.discordapp.net`, https only,
     no embedded credentials), caps redirects (`MAX_ATTACHMENT_REDIRECTS`),
     rejects an oversized `content-length` up front, and — this is the actual
     fix for the unbounded-buffer problem — enforces the same byte cap while
     streaming the response body chunk by chunk via
     `response.body.getReader()`, aborting and throwing the moment the
     running total exceeds the cap, rather than buffering the whole response
     with `arrayBuffer()` first.
   - Added `looksLikeAudioBuffer`: checks the first 12 downloaded bytes
     against magic-byte signatures for Ogg/Opus, WAV, MP3 (ID3 or a raw MPEG
     frame sync), M4A/MP4 (`ftyp` box), and WebM/Matroska (EBML header).
     `transcribeAttachment` now downloads via `downloadBoundedAttachment`,
     rejects anything that fails `looksLikeAudioBuffer` before it ever
     touches disk or `ffmpeg`, and only then writes the input file.
   - There was no pre-existing "bounded, origin-checked attachment helper
     used for images" to reuse in this codebase (the only existing precedent,
     `project-screenshot.ts`'s `isAllowedScreenshotResource`/`canReach`, only
     validates reachability of local dev-server URLs, not a byte-capped
     download) — `downloadBoundedAttachment`/`isAllowedAttachmentUrl` are new,
     but follow that same origin-allowlist-plus-redirect-revalidation shape.
   - Test: `src/transcribe.test.ts` — `audioGateMessage enforces the byte cap
     even when a short duration is reported`, `isAllowedAttachmentUrl only
     trusts Discord's own media hosts over https`, `looksLikeAudioBuffer
     recognizes common audio containers and rejects arbitrary bytes`, and six
     `downloadBoundedAttachment` tests covering host allowlisting, following
     an in-allowlist redirect vs. rejecting one that leaves it, a redirect
     cap, an oversized declared `content-length`, and the streaming byte cap
     with no `content-length` header at all — all via an injected
     `fetchImpl`, no real network calls.

2. **ffmpeg/whisper retain the real HOME despite the minimal environment
   fix.** `transcribeAttachment` now `mkdtemp`s a dedicated `runtimeHome`
   directory (same pattern as `command-runner.ts`'s
   `runConfiguredProjectCommand`) and sets `childEnvironment.HOME` /
   `.USERPROFILE` to it before spawning both `ffmpeg` and `whisper`, removing
   it in the `finally` block alongside the existing temp working directory.
   Also added a small concurrency cap (`MAX_CONCURRENT_TRANSCRIPTIONS = 2`,
   mirroring `project-screenshot.ts`'s `MAX_CONCURRENT_SCREENSHOTS` and
   `codex-client.ts`'s run cap) so a burst of voice notes can't pile up
   unbounded ffmpeg/whisper child processes.
   - Test: covered indirectly by the existing `transcribeAttachment` design
     (no new automated test spawns real ffmpeg/whisper per the lane's "no
     real audio processing in tests" rule); verify manually per the
     "Known limitations" note below.

3. **Any allowed viewer can dismiss another user's pending transcript.**
   Extracted the ownership rule into a new, tested, pure function
   `canManageVoiceNote` in `src/task-access.ts` (`context.controller ||
   record.requesterId === context.userId`), mirroring `canAccessTaskRecord`'s
   existing pattern in the same file. `index.ts`'s `canManageVoiceNote`
   wrapper now resolves `isControllerUser` and calls it; `handleVoiceControl`
   checks it before honoring `dismiss` and replies with an ephemeral denial
   otherwise. `act` was already controller-gated (a strictly stronger check),
   so "consumption" via Make change was already covered; `ask` is read-only
   and stays available to any allowed viewer — the transcript is already
   quoted in the public room reply at ingestion time, so restricting a
   read-only replay of already-visible text would not add privacy.
   - Test: `src/task-access.test.ts` — `canManageVoiceNote restricts a
     pending transcript to its requester or an approved controller`.

4. **State directory not hardened / no schema validation / transcripts not
   redacted before persistence or Discord output.** `src/voice-store.ts` now
   matches `task-store.ts`'s hardening exactly: `save()` creates the
   containing directory with `PRIVATE_DIRECTORY_MODE` and calls
   `hardenPrivateDirectoryPermissions`, and writes the state file with
   `PRIVATE_FILE_MODE` (was a bare `0o600` literal). `load()` calls
   `hardenPrivateFilePermissions` after reading and now runs every loaded
   note through `normalizeLoadedVoiceNote`, which rejects non-object entries,
   entries with an invalid/unsafe `id` (via the existing `isVoiceNoteId`),
   missing/wrong-typed string fields, and falls back to the epoch for an
   unparsable `createdAt` — malformed or unsafe records are dropped instead
   of trusted. Both `create()` and `normalizeLoadedVoiceNote` now run the
   transcript through `redactSensitiveText` before it's stored, and
   `maybeHandleVoiceMessage` in `index.ts` was switched to display
   `record.transcript` (the redacted, stored copy) for both the quoted reply
   preview and the full-text `transcript.txt` attachment, instead of the raw
   `transcript` variable — so redaction actually reaches Discord output, not
   just the on-disk copy.
   - Test: `src/voice-store.test.ts` — `voice store hardens the state file
     and its containing directory to owner-only permissions` (asserts
     `0o600`/`0o700` via `stat`), `voice store redacts secret-shaped text
     before persisting and rejects a corrupt state file`, and `voice store
     drops malformed or unsafe entries when loading legacy state`.

5. **Feature enabled by default with no real end-to-end smoke test.**
   `src/config.ts`: `voice.enabled` now defaults to `false`
   (`parseBoolean(process.env.DEVBOT_VOICE_ENABLED, false)`); the owner must
   set `DEVBOT_VOICE_ENABLED=true` to opt in, matching how `DEVBOT_SAFE_MODE`
   and other safety-relevant toggles in this codebase are env-only (there is
   no wizard UI for those either). `/setup doctor`'s existing "Voice notes"
   section already names that exact env var when the feature is off, so the
   owner is told how to opt in and can then confirm ffmpeg/whisper/model
   detection before ever sending a real voice note. Updated `.env.example`,
   `README.md`, and `docs/DEVBOT_PRODUCT_PLAN.md` to describe voice as
   opt-in/off-by-default.
   - **Not done, deliberately:** the acceptance checklist also asks for "a
     real Discord-to-whisper-to-Ask/Make-change smoke test." This lane's
     instructions explicitly forbid starting the bot against Discord or
     doing any real audio/ffmpeg/whisper processing in automated tests, so
     no such test was added. The default-off change plus the existing manual
     verification steps above (which already walk through installing
     ffmpeg/whisper.cpp, running `/setup doctor`, and testing the full
     Ask/Make change/Dismiss flow with a real voice message) are offered as
     the substitute the review anticipates ("Keep voice handling opt-in
     until setup can verify ... on the supported platform") — this still
     needs a human to actually run that manual pass once before flipping the
     env var on in a real deployment.

Oversized/redirected attachment test coverage requested in the acceptance
checklist is in `src/transcribe.test.ts` (see issue 1 above).

`npm test`: 158/158 passing (was 145; +13 new tests). One rerun was needed —
`security.test.ts`'s "configured project commands receive an empty temporary
home" failed once under load and passed clean on the immediate rerun, matching
the pre-existing known flake, not a regression from this round's changes.
