# Architecture

Devbot turns Discord requests into bounded local workflows while keeping project access, write authority, and evidence explicit.

## Request path

1. Discord access and room policy select an allowed project.
2. Natural-language intent chooses an immediate read-only answer or an approval-gated proposal.
3. The router chooses Luna, Terra, or Sol and a bounded context mode.
4. Project context is indexed with protected-path denies, aggregate budgets, and JSON Lines encoding.
5. Read-only work runs against the project; write work runs in a verified isolated worktree and task branch.
6. Durable task and execution ledgers record recovery identity, result evidence, and user attention state.
7. Review packets, validation, merge gates, screenshots, and Discord cards expose the exact checkout and proof used.

## Main modules

- `src/index.ts`: Discord gateway wiring and interaction orchestration.
- `src/commands.ts`: deployed slash-command schema.
- `src/context.ts`: bounded repository indexing and packing.
- `src/agent-backend.ts` and `src/codex-client.ts`: capability-aware agent execution.
- `src/task-store.ts`, `src/task-recovery.ts`, and `src/task-worktree.ts`: durable task lifecycle and isolation.
- `src/runtime-paths.ts`, `src/runtime-state.ts`, and `src/runtime-lock.ts`: protected state paths, upgrade migration, and old/new runtime fencing.
- `src/command-runner.ts` and `src/review.ts`: configured command execution and review evidence.
- `src/project-screenshot.ts` and `src/screenshot-approval.ts`: loopback-only capture and consent.
- `src/setup-*`: local browser setup and Discord provisioning.
- `src/ambient-ui.ts`, `src/workspace-ui.ts`, and `src/studio-*`: bounded Discord-native interfaces.

## Trust boundaries

- Runtime state defaults to `~/.devbot/state` (or `DEVBOT_STATE_DIR`) and migrates legacy checkout-local state on first use.
- Target repositories retain only their intentional `.devbot/project.json` metadata; `.devbot`, `.codex`, and `.env*` never enter packed agent context.
- Agent processes receive minimal environments and prompts over stdin. Unsupported read-only or workspace-confined capabilities fail closed.
- Commands come only from project metadata, run with bounded concurrency/output/time, and require confirmation unless policy marks them read-only.
- Screenshots stay on approved loopback origins and default to approval-gated capture.

See `docs/OPERATIONS.md` for deployment and recovery, and `docs/COLLABORATION_PROTOCOL.md` for peer envelopes and workrooms.
