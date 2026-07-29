# Devbot Next Product Bets

Updated: 2026-07-29

## Product Decision

Devbot should become the **Discord-native control plane for coding agents running on real developer machines**.

The wedge is not "another agent that turns a prompt into a pull request." GitHub Copilot, Cursor, Devin, and Factory already compete heavily on hosted execution and one-prompt-to-PR workflows. Devbot is strongest where those products are least natural:

- the repository, dev server, devices, credentials, and tools already live on a developer's machine
- the team works in Discord rather than an enterprise ticketing suite
- writes need visible human approval and isolated worktrees
- completion needs local proof, not only an agent summary
- different developers or machines can contribute through allow-listed peer Devbots
- the operator wants to bring an existing coding-agent subscription or CLI instead of adopting a Devbot-hosted model backend

The concise positioning is:

> Ask in Discord. Work on the right machine. See the proof. Approve the handoff.

Devbot should keep the local runtime and evidence layer as the product, with Codex, Claude Code, and future agents treated as replaceable workers.

## Competitive Read

| Product | Current strength | What Devbot should learn |
| --- | --- | --- |
| [GitHub Copilot cloud agent](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/integrate-cloud-agent-with-slack) | Starts work from GitHub or Slack, creates pull requests, and uses the conversation as task context. [Automations](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-automations) add scheduled and repository-event triggers with selected tools. [Custom agents, skills, hooks, and MCP](https://docs.github.com/en/copilot/reference/customization-cheat-sheet), plus generated-code security validation, make GitHub the strongest provider-native workflow. | Close the review-state gap, but keep the core provider-neutral. Devbot should sync pull request, CI, and review state back into Discord without becoming a thin GitHub bot. |
| [Cursor background agents](https://docs.cursor.com/en/background-agent/web-and-mobile) | Strong web/mobile handoff, Slack initiation, collaborative diff review, and pull request management. Its [Background Agents API](https://docs.cursor.com/background-agent/api/overview) supports follow-ups and high concurrency. | Add durable queues, follow-ups, and a clear task timeline. Differentiate with the operator's actual local environment instead of another remote VM. |
| [Devin](https://docs.devin.ai/integrations/slack) | Mature chat collaboration, inline control, attachments, and session updates. It also has reusable [skills and playbooks](https://docs.devin.ai/product-guides/skills), [scheduled sessions](https://docs.devin.ai/product-guides/scheduled-sessions), knowledge management, child sessions, session analysis, and [test recordings](https://docs.devin.ai/release-notes/overview). | Add versioned local rituals, safe scheduling, and replayable evidence. Keep these repo-owned and machine-executed rather than building a hosted knowledge product. |
| [Factory Droids](https://factory.ai/product/droids) | Consistent use across terminal, IDE, browser, Slack, and Jira; adjustable autonomy; model routing; and one-prompt-to-PR. Its [desktop product](https://docs.factory.ai/web/getting-started/overview) also works directly on local files and connects to engineering systems. | A local filesystem alone is not a niche. Devbot must win on Discord-native governance, per-machine capability routing, and proof-first collaboration. |
| [OpenHands](https://docs.openhands.dev/overview/faqs) | Open source and runnable on a local workstation, with a cloud option for Git provider and Slack integrations. The local product is explicitly single-user and lacks built-in multi-tenant authentication, isolation, and scalability. | Devbot can own the space between a single-user local agent and a hosted enterprise platform: small-team access control over individually owned local workers. |

## Defensible Advantages To Compound

1. **Real-machine execution**
   Devbot can use the exact checkout, local services, hardware, simulator, device, or private network the developer already has. This is more valuable than generic cloud capacity for UI work, game development, mobile work, hardware-adjacent projects, and private monorepos.

2. **Proof before trust**
   Isolated worktrees, configured validation, managed previews, screenshot diagnostics, review packets, and approval records already form a stronger safety story than a final prose summary.

3. **Discord-native human control**
   Private task rooms, Needs Me, Components V2 cards, and Studio make Discord the operating surface rather than a notification mirror.

4. **Bring-your-own agent**
   The backend capability contract can route work to compatible local agents while failing closed when an agent cannot guarantee read-only access or workspace confinement.

5. **A team of owned machines**
   Peer Devbots can advertise what each developer's machine can safely do. That enables capability-aware delegation without uploading every environment into one shared cloud.

## Prioritized Backlog

### P0 — From Discord To Review

Build a provider-neutral publish and review-state adapter, with GitHub as the first implementation.

MVP:

- add an explicit **Publish for review** action to a completed, committed task
- push only the verified isolated task branch after owner/controller confirmation
- open a draft pull request containing the task summary, changed paths, validation evidence, known risks, and Devbot task reference
- persist the provider, repository, pull request URL/ID, published commit, and last synchronized state
- sync CI, requested reviews, unresolved review threads, mergeability, and merged/closed state into `/task show`, `/inbox`, and Studio
- route new review comments into the existing task workroom as attention items
- refuse publish when branch identity, remote identity, gates, or authorization cannot be proven
- keep merge as a separate explicit approval; do not combine publish and merge in the first slice

Why first: every major competitor has a clean path from agent work to a review surface. Devbot currently stops at a strong local handoff packet, which hides its best work one step before the normal team workflow.

Existing leverage: isolated task branches, `/task commit`, `/review packet`, `/review validate`, `/review gates`, branch freshness, Needs Me, and Studio.

### P0 — Replayable Proof Timeline

Turn the scattered audit trail into one sanitized, append-only task timeline.

MVP:

- record request, routing, approval, worker start/stop, changed-path snapshots, validation runs, preview lifecycle, publish events, review-state changes, and final disposition
- assign stable event IDs and correlation IDs across the Discord gateway, worker, preview, peer, and provider paths
- hash-chain event records and sign periodic checkpoints so continuity breaks are detectable
- render a compact live timeline in Studio and a detailed ephemeral task view
- export a bounded Markdown/JSON proof bundle with secrets, local paths, process IDs, and internal prompts removed
- explicitly distinguish agent claims from Devbot-observed evidence

Why second: proof is Devbot's most defensible product idea. A coherent replay also makes failures diagnosable and gives future schedules, queues, peer trust, and metrics one reliable substrate.

Existing leverage: task records, collaboration events, structured logging, approval records, review packets, preview ledgers, and ship cards.

### P0 — Managed Visual QA Journeys

Connect isolated task previews to repeatable browser proof.

MVP:

- define repo-owned, allow-listed UI journeys in `.devbot/project.json`
- run a journey only against the exact managed preview for the isolated task
- support click, fill, select, wait-for, assertion, and screenshot steps with strict limits
- capture before/after frames, a pixel-diff summary, console errors, failed requests, bad responses, and a Playwright trace or short recording
- support desktop and mobile viewports
- attach the result to the proof timeline and publish packet
- require separate approval for authenticated storage state and keep it project-scoped

Why third: competitors can show session logs, but Devbot can prove that a change works in the developer's real local app. The repository already contains most of the difficult primitives; the missing value is orchestration.

Existing leverage: `TaskPreviewManager`, screenshot policies, stabilized captures, visual-diff primitives, diagnostics, and screenshot-to-fix.

### P1 — Versioned Rituals And Safe Schedules

Create reusable, repo-owned workflows rather than more slash commands.

MVP:

- define a ritual as a versioned file containing purpose, inputs, allowed commands, required proof, approval points, timeout, and completion conditions
- invoke rituals manually from Discord before adding triggers
- add one-time and recurring local schedules with timezone, quiet hours, missed-run behavior, concurrency limits, and failure notifications
- require a dry run for new or changed rituals
- default scheduled work to read-only or proposal-only; write execution remains separately policy-gated
- show the exact ritual revision on every task and proof bundle

First rituals: dependency-health report, stale-branch review, nightly test triage, weekly project brief, and screenshot smoke journey.

Why: Devin and GitHub already make schedules and reusable workflows table stakes. Devbot's version should be transparent, Git-reviewable, and constrained by the local machine's policy.

### P1 — Durable Queue And Capacity Planner

Replace the in-memory execution waitlist with an operator-visible queue.

MVP:

- persist queued tasks with priority, project, requester, required machine capabilities, dependencies, and expiry
- support pause, resume, reorder, cancel, and "run after task"
- enforce per-project and per-backend concurrency
- show why a task is waiting and the estimated next runnable position
- recover queued work after restart without silently starting writes
- route peer work to a machine only when its capability passport and access policy match

Why: Cursor and Devin make parallel background work easy. Devbot's opportunity is a smaller, safer scheduler that understands who owns each machine and what it can prove.

### P1 — Capability Passports And Evidence-Backed Trust

Make peer routing depend on observed capabilities rather than self-description alone.

MVP:

- advertise signed bot identity, supported backends, projects, validation presets, preview support, operating system, and current capacity
- attach freshness and the last successful proof for each claimed capability
- distinguish declared, locally verified, peer-verified, and stale capabilities
- refuse delegation when a required capability is missing, stale, or outside project policy
- show trust reasons in the approval card

Why: this turns multi-bot coordination from a novelty into a defensible local-team system.

### P1 — Experiment Arena

Compare multiple isolated implementations before a human chooses one.

MVP:

- fan one approved task into two bounded isolated branches
- keep implementations hidden from the evaluator until both finish
- run the same configured validation and visual journey against each
- produce a blind comparison on correctness, scope, test quality, visual result, risk, and cost/time
- let a controller select, combine, reject, or request one revision
- preserve all branches and proof until disposition

Why: incumbents emphasize more parallel agents. Devbot can emphasize better decisions from parallel work.

### P2 — Symbol-Aware Context And Repo Skills

- add a lightweight symbol/import/test map instead of relying only on text ranking
- learn which validation preset and UI journey proved similar past changes
- support repo-owned skills with explicit triggers, allowed tools, and proof requirements
- measure retrieval usefulness before adopting a vector database

### P2 — One Discord App, Many Owned Workers

- separate the Discord control plane from local worker identity
- let each developer pair an owned worker to one shared bot application
- maintain end-to-end user, project, machine, and approval attribution
- preserve the current one-owner-per-worker safety model
- avoid this architecture until provider sync, proof timelines, and capability passports are stable

### P2 — Usage And Reliability Scorecards

- measure time to first response, time to review-ready, queue time, validation pass rate, retry rate, human interventions, and task outcome
- report usage by backend/tier without exposing private prompts
- surface recurring failure classes and suggest ritual or project-metadata improvements
- never turn the score into an opaque agent ranking; keep the underlying evidence inspectable

## Recommended Release Sequence

### Release A — Review Bridge

Ship provider-neutral publish state with a GitHub adapter and draft-pull-request flow.

Implementation status: the safe publish baseline is now in place. `/task publish` provides explicit controller confirmation, reruns configured merge gates, verifies the exact clean isolated commit and current remote-base ancestry, pushes without force, creates or reuses a draft GitHub pull request, and persists CI/review state for task details and Studio. Remaining Release A work is event-driven refresh plus broader workroom and Needs Me visibility.

Exit criteria:

- one confirmed Discord action publishes the exact reviewed task commit
- CI and review state return to the task workroom and Studio
- duplicate publish attempts are idempotent
- no merge occurs without a separate human decision
- provider loss or stale branch state fails closed

### Release B — Proof You Can Replay

Ship the task evidence journal and Studio timeline.

Exit criteria:

- every task transition and side effect has one correlated event
- the UI distinguishes observed proof from agent-reported claims
- a sanitized proof bundle can reconstruct why a task was approved or blocked
- event continuity and checkpoint integrity are verifiable

### Release C — See It Work

Ship allow-listed browser journeys on managed isolated previews.

Exit criteria:

- a completed UI task can produce repeatable before/after proof from its own worktree
- console, network, assertion, and visual evidence land on the task
- authenticated state never crosses project or user policy
- the preview and browser process are fully cleaned up after capture

## Killer Demo

1. A user posts a broken UI screenshot in Discord.
2. Devbot transcribes the error and offers **Fix it**.
3. The approved task runs in an isolated local worktree.
4. Devbot starts the managed preview for that exact worktree.
5. A repo-owned UI journey reproduces the flow and records before/after proof.
6. The controller reviews the proof and chooses **Publish for review**.
7. Devbot opens a draft pull request containing the evidence.
8. CI and review comments flow back into the private Discord workroom.

That loop communicates the niche better than a larger command list.

## What Not To Build Yet

- a generic hosted coding-agent runtime
- Slack or Teams parity
- automatic merges before provider state and proof are unified
- a broad Jira/Notion/Linear connector catalog
- more model backends that cannot satisfy the capability contract
- a database migration solely for scale; introduce SQLite when the proof timeline or queue needs transactional queries
- arbitrary natural-language browser automation before allow-listed journeys are reliable
- a public preview tunnel that weakens the current local-only boundary

## Success Measures

- median time from approved task to review-ready pull request
- percentage of published tasks with reproducible validation or visual proof
- percentage of provider status changes reflected in Discord without manual refresh
- retry rate after failed validation or stale-branch detection
- percentage of queued tasks whose waiting reason is visible and actionable
- human interventions per successful task
- regressions found after merge that should have been caught by configured proof
- authorization, isolation, or secret-boundary incidents: target zero
