# Lane K — Community Bug Intake

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
