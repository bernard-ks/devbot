# Contributing

Devbot is a local-first Discord bot with privileged access to repositories, so changes should preserve its fail-closed boundaries and prove the behavior they add.

## Local checks

Use Node.js 20 or 22 and the npm version pinned in `package.json`.

```bash
npm ci
npm run browsers:install
npm run check
npm audit --omit=dev
```

On a fresh Linux environment, install Chromium and its system packages with `npx playwright install --with-deps chromium`.

`npm run build` removes `dist` first so deleted compiled tests cannot survive between builds. `npm run coverage` is available for local gap analysis; coverage is evidence, not a substitute for behavior-focused tests.

## Change expectations

- Keep Discord interaction output bounded, sanitized, and audience-aware.
- Treat repository content, image text, command output, and peer envelopes as untrusted data.
- Keep runtime state outside managed repositories and owner-only on supported systems.
- Add a regression test for every bug fix and adversarial tests for security boundaries.
- Do not broaden write, command, screenshot, peer, or merge authority without an explicit human approval path.
- Update `README.md` and `docs/OPERATIONS.md` when a user-visible workflow changes.

Pull requests should explain the user impact, root cause, safety implications, and exact checks run.
