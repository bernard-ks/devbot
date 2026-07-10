# Lane K — Community Bug Intake

> **Superseded by Review round 1 (below).** The rebase-status invariants (screenshot call
> shape, "twice, both `mode: answer`" classification claim, in-memory rate limits, private-room-only
> delivery) describe the pre-review code. See "Review round 1" at the end of this file for what
> changed and why.

## Rebase status

Rebased onto 85e2530 (origin/main: "Merge pull request #15 from bernard-ks/codex/ambient-workrooms", which merged dd0af6b "Add ambient Discord workrooms and security hardening").

- Conflicts: `src/commands.ts` (import line only — merged `ApplicationCommandType`/`ContextMenuCommandBuilder` from ours with `ChannelType` from theirs into one import) and `src/index.ts` (auto-merged cleanly by git; verified by hand — see below). No other files conflicted; `.env.example`, `README.md`, `docs/DEVBOT_PRODUCT_PLAN.md`, `HANDOFF.md` all applied without markers.
- Invariants re-verified against the merged tree:
  1. Read-only intake flow: `handleIntakeMessage` still calls `answerWithProjectContext` with a hardcoded `mode: "answer"` literal, twice (grep `mode:` inside that function — 2 hits, both `"answer"`). The only `mode: "action"` reachable from intake is in `handleIntakeAcceptModal`, fired only from the owner/controller-gated Accept button. Whole-file grep for `mode: "action"` shows exactly 3 hits: `/do` (slash command), `createAmbientProposal` (bernard's ambient/natural-intent path, itself a proposal awaiting approval, not a direct write), and `handleIntakeAcceptModal`.
  2. Intake channel claims first: in the rebased `messageCreate` handler (src/index.ts:512), the intake-channel check (`intakeStore.snapshot()` / `handleIntakeMessage`) sits immediately after the bot-author filter and returns before bernard's `mentionsBot`/`threadTask`/`isAllowedMessage`/ambient-proposal logic ever runs. Confirmed there is only one `messageCreate` listener in the file. This means even if an intake channel were coincidentally also configured as a project's ambient workroom, intake handling wins and the ambient/natural-intent flow never sees the message.
  3. Screenshot hardening: intake's screenshot call (`captureProjectScreenshot(project, { requestText: message.content })`) is the same shared function bernard hardened with SSRF origin allowlists — no separate/bypassing code path was introduced for intake.
  4. Discord-facing errors: the outer `messageCreate` try/catch (which is what would surface any uncaught intake error to Discord) already replies via `` `Error: ${publicErrorMessage(error)}` ``. Internal intake failure paths (classification/screenshot/repro-assessment/triage-card-post failures) are caught locally and only `console.warn`'d server-side — they are never echoed to Discord, so no separate remediation was needed there.
- `npm run build` and `npm test` both green (134/134) across two consecutive runs; the known-flaky `security.test.ts` "configured project commands receive an empty temporary home" case passed both times, no flake observed this round.

## What was built

A public-channel bug intake pipeline that lets a community (not just approved teammates) file bug reports, which devbot triages with a strictly read-only repro attempt before ever reaching the owner.

- `/intake set channel:<channel> project:<name>` (owner-only): designates one public text channel as the intake pipeline for one project. Off by default.
- `/intake off` / `/intake status` (owner-only): disable, or show the current channel/project and recent reports.
- Message handler on the designated channel (any non-bot author, no mention required):
  1. Per-user (2/hour) and channel-wide (10/hour) rate limits, checked first. Over-limit messages get a quiet ⏳ reaction only, no reply.
  2. 👀 reaction to acknowledge, then a cheap read-only Codex call classifies whether the report has enough detail (what/where/expected). Incomplete reports get one templated reply asking for the missing specifics — no further action.
  3. Complete reports get a read-only repro attempt: project context ranked against the report text, an optional dev-server screenshot with console/network evidence via the existing screenshot machinery, then a second read-only Codex call judges `confirmed` / `unconfirmed` / `needs-info` with cited evidence.
  4. The report is normalized into a dedupe signature (shared error text or shared route) and linked to a prior report if found.
  5. A triage card (reporter, report text explicitly marked untrusted, status, evidence, duplicate note, link to the original message, optional screenshot) posts only to the private room with **Accept as task**, **Ask reporter**, and **Dismiss** buttons — all owner/controller-gated.
  6. The public channel gets exactly one reply: "logged for triage" (+ status if confirmed/unconfirmed/needs-info).
- **Accept as task** opens a modal pre-filled with a `/do`-equivalent draft; submitting it runs the existing `executeInteractionRequest` path in `mode: "action"`, gated by the existing controller check — this is the only escalation point out of the read-only intake flow.
- **Ask reporter** posts a fixed template `@mention` follow-up back in the intake channel.
- **Dismiss** marks the record dismissed and removes the card's buttons.

## Read-only invariant (how to verify it holds)

The entire automated intake path (`handleIntakeMessage` in `src/index.ts`) only calls `answerWithProjectContext` with a hardcoded `mode: "answer"` literal, twice — once for completeness classification, once for the repro assessment. Grep confirms it:

```
grep -n "mode:" src/index.ts   # inside handleIntakeMessage: both say mode: "answer"
```

The only `mode: "action"` in the whole feature lives in `handleIntakeAcceptModal`, which is unreachable from the public channel — it only fires from a controller-gated button click in the private room, exactly mirroring the existing `/do` and task-modal `promote` pathways already in the codebase.

The intake channel check is inserted in `messageCreate` immediately after the bot-author filter and before the existing mention/private-room logic, so non-intake channels are completely unaffected — the deny-by-default model (`isAllowed`, `isAllowedMessage`, `ensureConfiguredRoom`) is untouched everywhere else.

## Files touched / added

- `src/intake-store.ts` (new): atomic JSON store (`.devbot/intake.json` by default, `DEVBOT_INTAKE_STORE` override) for the channel/project config and intake records, following the existing `TaskStore`/`SetupStore` mutate-queue pattern.
- `src/intake.ts` (new): pure logic — rate-limit windows, classification prompt + tolerant parser, repro prompt + tolerant parser, duplicate-signature normalization, triage-card assembly with length limits, fixed reply templates.
- `src/intake-controls.ts` (new): button row + customId parsing for Accept/Ask/Dismiss, and the pre-filled Accept-as-task modal.
- `src/intake.test.ts` (new): `node:test` coverage for all of the above (24 new tests).
- `src/commands.ts`: added the `/intake` command (`set`/`off`/`status`).
- `src/index.ts`: wired the `/intake` command (owner-only, mirrors `/setup`'s dispatch), the intake-channel message intercept, button/modal handlers, and the triage-card post/refresh helpers.
- `README.md`, `docs/DEVBOT_PRODUCT_PLAN.md`, `.env.example`: documented the feature and the `DEVBOT_INTAKE_STORE` override.

## How to verify manually in Discord

1. As the owner, run `/setup room` (if not already done), then `/intake set channel:#bug-reports project:<name>`.
2. From a non-approved account, post a vague message in `#bug-reports` (e.g. "it's broken") — expect a 👀 reaction then a templated request for more detail, no triage card.
3. Post a detailed report (what/where/expected) — expect 👀, then a "logged for triage" reply, and a triage card in the private room with Accept/Ask/Dismiss buttons.
4. Post 3+ reports as the same user within an hour — the 3rd+ should get only a quiet ⏳ reaction.
5. In the private room, click **Accept as task** — a modal opens pre-filled with a draft; submitting runs a normal write-capable task through the existing task UI. Click **Ask reporter** — a templated follow-up appears in the public channel. Click **Dismiss** — the card's buttons disappear.
6. Confirm all of the above only work through `#bug-reports`; posting in any other public channel as an unapproved user still gets "You are not allowed to use this bot," unchanged.

## Known limitations / risks

- Rate-limit counters are in-memory (`Map` in `index.ts`), so they reset on restart; this is a soft anti-spam measure, not a durability requirement per the brief, but a determined abuser could restart-time it.
- Duplicate linking is intentionally fuzzy (shared error-type token + short text window, or shared route prefix); it will both under- and over-match on real-world phrasing — acceptable per the brief's "fuzzy" framing, but worth tuning with real reports.
- If the configured intake project is later removed from `appConfig.projects`, messages in the channel are silently ignored (logged as a warning) rather than replied to, to avoid noise in a public channel from a misconfiguration only the owner can see/fix via `/intake status`.
- The repro assessment's read-only Codex call and the classification call both spend a Codex invocation per qualifying message; a very active public channel could generate meaningful local Codex load. The existing per-user/channel rate limits are the only backpressure.
- No new npm dependencies were added; the screenshot/console-evidence path reuses the existing Playwright-based `project-screenshot.ts` unchanged.

## Review round 1

bernard's review requested changes across screenshot safety, project authorization, room privacy,
model/repo exposure, store hardening, dedupe/acceptance races, intent handling, channel readiness,
truthful acknowledgments, and rate-limit durability. Each numbered item below maps to his review
text, the fix, and the test/verification for it. All fixes are new commits on top of the reviewed
history — nothing already on the branch was rewritten.

1. **Screenshot policy + intake-driven UI actions.** `handleIntakeMessage` (`src/index.ts`) now
   skips screenshot capture entirely when `isScreenshotBlocked(project)` or
   `screenshotRequiresApproval(project)` — an unattended pipeline cannot honor an interactive
   approval prompt, so "approval" is treated as "don't capture." The call no longer passes
   `requestText`, so reporter text can no longer pick an explicit path/URL or drive
   `navigateByVisibleUi`'s click-through — the capture always shoots the project's own
   configured/detected entry point. All console/network evidence is redacted
   (`boundEvidence` in `src/intake.ts`, backed by `redactSensitiveText`) and capped to 6 lines
   before it is ever used in a prompt, stored, or posted. Covered by
   `boundEvidence redacts secrets and caps how many lines are kept` in `src/intake.test.ts`.

2. **Project-specific authorization on every control/modal.** `handleIntakeButton` and
   `handleIntakeAcceptModal` (`src/index.ts`) now resolve the record's project and call the
   existing `isAllowedForProject(interaction, project)` guard before doing anything else, for
   *all three* buttons (Accept/Ask/Dismiss) and the Accept modal submit — not just the global
   controller check that already existed at the dispatch layer. A controller excluded by a
   project's `.devbot` allowlist now gets the same `"...not allowed to use project ... under its
   .devbot policy"` reply used everywhere else in the bot.

3. **Scoped-project privacy for triage delivery.** New `resolveIntakeDeliveryRoomId(project)`
   (`src/index.ts`) prefers the project's own bound ambient room (verified live via the existing
   `isConfiguredRoomId`, which already checks privacy + audience match) and only falls back to the
   global private room when the project has *no* scoped audience
   (`hasProjectAudienceRestriction`). If a project has a scoped audience but no bound room, the
   card is not delivered anywhere rather than leaking to the broader private room.
   `postIntakeTriageCard` and `refreshIntakeCard` both use this resolver (the record now carries
   `triageChannelId`) instead of always targeting `effectivePrivateRoomId()`.

4. **No repo access driven by public text; no model free-text echo.** The classification step is
   now fully deterministic (`classifyIntakeReport` in `src/intake.ts`): no Codex call, no project
   directory access at all, so a public message cannot use "is this report complete?" as an entry
   point to an agent with repository read access. `IntakeClassification.missing` is a fixed
   `"what" | "where" | "expected"` union, so the reply to the public channel can never contain
   model-generated free text (`buildClassificationQuestion`/`parseClassificationResponse` were
   removed along with their exploitable design). The remaining repro-assessment Codex call (which
   does need repo access to judge a repro) is bounded to `INTAKE_MAX_CONTEXT_CHARS = 8_000`
   characters of packed context — far below the default 120,000-char budget authenticated flows
   use — and its evidence is redacted before storage. Covered by
   `classifyIntakeReport is deterministic...` and the "fixed vocabulary" test in
   `src/intake.test.ts`.

5. **Store hardening.** `src/intake-store.ts` now mirrors `setup-store.ts`/`task-store.ts`
   exactly: directories created with `PRIVATE_DIRECTORY_MODE` (`0o700`) plus
   `hardenPrivateDirectoryPermissions`, files written with `PRIVATE_FILE_MODE` (`0o600`) and
   re-hardened after every load and save. Every loaded record is validated field-by-field
   (`normalizeLoadedIntakeRecord`) — malformed entries are dropped instead of surfacing garbage —
   and `text`/`evidence` are redacted and length/count-bounded on both write and load
   (`boundText`, `boundEvidenceList`). Covered by `intake store hardens its directory and file to
   owner-only permissions` and `intake store drops malformed loaded records and redacts secrets...`.

6. **Atomic, recoverable acceptance.** `IntakeStore.transitionStatus` (`src/intake-store.ts`) is a
   compare-and-set primitive: it only moves a record's status when the current status is in an
   allowed set, all inside the store's existing serialized mutation queue, so two racing
   "Accept" submissions cannot both proceed — the second sees `ok: false` and gets an ephemeral
   "already accepting/accepted" reply. `handleIntakeAcceptModal` transitions
   `open → accepting` before creating anything, pre-creates the task itself via
   `taskStore.start({..., dedupeKey: "intake-accept:<id>"})` for a second layer of idempotency,
   then transitions `accepting → accepted` with `acceptedTaskId` only once the task exists, and
   `accepting → accept-failed` (a recoverable, retryable state — back in
   `OPEN_INTAKE_STATUSES`) if task creation throws. `executeInteractionRequest` is then called
   with `existingTaskId` so it runs the pre-created task instead of starting a second one.
   Covered by `intake store transitionStatus is compare-and-set: only one of two racing accepts
   can win`.

7. **Message Content Intent handled explicitly.** `messageContentIntentEnabled` is computed once
   at startup and reused for the gateway intent, `/intake set` (which now refuses to configure
   intake until it is on, with the Portal-toggle/env-var/restart steps spelled out), and a new
   `/setup doctor` check (`"Community intake message content"`) that only fails when intake is
   configured and the intent is off. `README.md` no longer claims Devbot never requests the
   privileged intent unconditionally.

8. **Channel/delivery readiness on `/intake set`.** Before enabling, `/intake set` now rejects the
   private room or any project room as the intake channel (`isPubliclyVisibleChannel` +
   `Object.values(projectRoomIds)` check — otherwise intake would preempt normal room handling in
   `messageCreate`, since the intake check runs first), verifies `@everyone` can actually view the
   channel (`isPubliclyVisibleChannel`), verifies the bot holds View/Send/History/AddReactions
   there (`missingBotChannelPermissions`), and requires `resolveIntakeDeliveryRoomId` to resolve to
   a verified destination before turning intake on.

9. **Truthful acknowledgments.** `postIntakeTriageCard` now returns a boolean; the public reply is
   `loggedForTriageReply(...)` only when delivery actually succeeded, otherwise
   `recordedWithoutDeliveryReply(...)` (new in `src/intake.ts`), which never claims the report
   reached triage. `/intake status` now flags undelivered reports (`(not delivered)`) and shows
   whether a delivery room is currently verified. The **Ask reporter** button now checks whether
   the follow-up message actually posted and replies honestly either way instead of always
   claiming success.

10. **Rate-limit durability + a dedicated intake lane.** Rate-limit state moved from an in-memory
    `Map` into `IntakeStore` (`getRateLimitState`/`setRateLimitState`, persisted the same way as
    everything else in the store) so restarts don't reset a would-be abuser's window.
    `recordIntakeAttempt` also opportunistically drops any other user's fully-expired timestamps
    so the persisted map doesn't grow without bound. A new `createConcurrencyLimiter(1)` gate
    (`intakeCodexGate` in `src/index.ts`) wraps intake's one remaining Codex call so it never
    holds more than one of the shared `MAX_CONCURRENT_CODEX_RUNS = 4` slots at a time, leaving the
    rest for owner/task work. Deterministic validation (rate limit, then the model-free
    classifier) always runs before the one remaining model call. A user who is already
    rate-limited does not get an extended lockout from a correlated follow-up (see below) — the
    correlation path itself is exempt from the limiter, and a limited message never calls
    `recordIntakeAttempt` a second time for the same slot.

**Also addressed from the review's closing notes:**

- *Incomplete-report correlation.* A reply to Devbot's own "need more detail" prompt is now
  matched back to the original report via `message.reference.messageId` against a new
  `IntakeRecord.followupPromptMessageId` field (`IntakeStore.findByFollowupPrompt`). The follow-up
  is merged into the same record (`mergeIntakeFollowup`, bounded to 4,000 chars) instead of
  spending a second rate-limit slot on what is one bug report split across messages. Covered by
  `intake store correlates a reporter's reply to its own incomplete-report prompt`.
- *Attachments.* Left unimplemented, as the review's own phrasing was conditional ("if attachment
  support is intended"). Image-only reports still do not work; this is a feature gap, not a
  regression, and should get its own pass (Discord-CDN origin validation, byte limits, MIME
  sniffing, redirect denial) if the maintainer wants it added.

**Verification:** `npm test` — 145/145 green (was 134; +11 net new tests, 0 removed net after
swapping the two classification-prompt tests for two deterministic-classifier tests). The known
flaky `security.test.ts` "configured project commands receive an empty temporary home" case failed
once under load and passed clean on an immediate rerun (145/145), consistent with the brief's
description of that flake. `npx tsc -p tsconfig.json --noEmit` is clean.

**New/changed files:** `src/intake.ts`, `src/intake-store.ts`, `src/index.ts`, `src/intake.test.ts`,
`README.md`, `docs/DEVBOT_PRODUCT_PLAN.md`, `.env.example`. No changes to `src/commands.ts`,
`src/intake-controls.ts`, or `src/project-screenshot.ts` — the fixes for issues 1 and 4 are call-site
changes (stop passing reporter text into shared, already-hardened machinery; cap context size)
rather than changes to that shared machinery itself.
