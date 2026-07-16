# Devbot Collaboration Protocol

Devbot's collaboration protocol lets independently operated bots exchange project context without depending on a particular model provider. Version 2 is used by `/lab` workflows, including sealed councils. The current transport is a JSON object in a Discord message, usually inside a `json` code fence; the envelope itself contains no provider- or model-specific fields.

The protocol coordinates requests and records decisions. It does not grant remote peers authority to mutate a project.

## Envelope v2

Every v2 message uses this shape:

| Field | Meaning |
| --- | --- |
| `type` | `devbot.peer.request`, `devbot.peer.result`, `devbot.peer.event`, or `devbot.peer.approval`. An approval message reports an approval boundary; it is not an authorization token. |
| `version` | Exactly `2`. |
| `id` | Unique ID for this envelope instance. |
| `conversationId` | Stable ID shared by all messages and state in one collaboration room. |
| `requestId` | Stable ID for the logical request. Results preserve the request's value. |
| `correlationId` | Optional ID of the request being answered. Results should set it to the originating `requestId`. |
| `from` | Actor metadata: required `botId` and `owner`, plus optional `botName`. |
| `to` | Optional destination `botId` and canonical project name. |
| `capability` | Requested operation: `status.read`, `screenshot.read`, `task.plan`, `task.execute`, `review.packet`, `review.validate`, `run.command`, `git.push`, or `git.merge`. |
| `intent` | Workflow context: `council`, `roundtable`, `see`, `handoff`, `bossfight`, `jam`, `argue`, `fix-from-snip`, `campfire`, `roster`, `ritual`, or `approval`. |
| `mode` | Expected effect class: `read`, `think`, `validate`, or `write`. |
| `requiresApproval` | Declares that local human approval is required. It never bypasses receiver policy when `false` and never proves approval when `true`. |
| `payload` | Capability-specific JSON data. |
| `artifacts` | Zero or more typed references with `id`, `kind`, `label`, and optional `summary` or `url`. Kinds are `screenshot`, `review-packet`, `validation`, `plan`, `log`, `task`, or `approval`. |
| `createdAt` | ISO 8601 creation timestamp. |

Receivers should reject malformed envelopes, unsupported versions, and unsupported capabilities without attempting a write. Extra fields inside `payload` or artifact objects may be ignored for forward compatibility.

## Identity and correlation

Discord's authenticated message author is the security identity. Current Devbot receivers only inspect messages from bot IDs in `PEER_BOT_IDS`, require `from.botId` to equal the Discord author, verify the destination bot and guild, enforce the configured coordination channel, reject envelopes outside the freshness window, apply the destination project's `allowedPeers` policy, and require an explicit mention before processing a request. `owner` and `botName` remain display metadata and never override the transport identity.

A workroom uses stable participant IDs:

- The human requester starts as `active`.
- Each peer bot is recorded as `invited` with the unique `requestId` sent to that peer.
- A peer becomes `contributed` only when a result arrives from that transport-authenticated bot and its `correlationId` (falling back to `requestId`) matches the stored invitation.

All fan-out requests share one `conversationId`, but each invited peer gets its own `requestId`. A sealed council supports one outstanding invitation per peer participant.

## Workroom lifecycle

Persistent workrooms are stored in `~/.devbot/state/collab.json` by default. A sealed council normally moves through these phases:

1. `collecting`: Two to four role-based local agent seats run independently in parallel, invited peer proposals are accepted, and every answer remains sealed. One additional challenge may also be added without seeing other proposals.
2. `deliberating`: Reveal makes all collected contributions visible and closes collection; late peer results are not accepted as council contributions.
3. `synthesized`: A chair weighs the revealed proposals, evidence, risk, reversibility, and testability. Synthesis waits for invited peers unless the human chooses Reveal to proceed with responses already present.
4. `decided`: A human records `approve`, `deny`, or `read-only`. The workroom's Approve button requires synthesis first.
5. `closed`: The room is terminal. A human may close an open room at any point.

Decisions and phase changes are persisted as events. Workroom decision buttons only record the decision; they do not execute code, commands, validation, pushes, or merges.

The local JSON store serializes mutations within one process and preserves open-room records ahead of retention limits. It is not a shared multi-process database; each independently operated bot must use its own state file.

## What sealing means

Sealing is an application-level visibility rule designed to prevent anchoring. While a council is collecting, normal workroom reads and renderers omit sealed contribution bodies. Reveal changes those records to visible and adds a `revealedAt` timestamp.

Sealing is **not encryption**. Contribution text is plaintext in local state, model input/output, and the peer transport message that carries a result. It may also appear in logs or attachments. Devbot requires a dedicated private coordination channel or thread before a council can invite peers and creates the human workroom as a separate private thread. A configured coordination thread is automatically unarchived and the target peer is added before delivery. Operators must restrict this room to approved humans and allow-listed peer bots. Use appropriate host access controls and encrypted transport/storage where confidentiality is required; do not put secrets in collaboration payloads.

## Approval boundaries

Receiver-local policy is authoritative:

- `status.read`, `task.plan`, and `review.packet` may run read-only inside an allow-listed project.
- `screenshot.read` is also subject to the project's screenshot policy and may be allowed, approval-gated, or denied.
- `review.validate`, `task.execute`, `run.command`, `git.push`, `git.merge`, and any other mutating or side-effecting request require explicit approval from the receiving bot's human owner.
- Writes, shell commands, deploys, dependency installs, migrations, and secret or configuration changes cannot be authorized by a peer envelope.

When a request reaches an approval boundary, Devbot returns `devbot.peer.approval` with `requiresApproval: true` and an approval card. That response means "owner action is required"; it is not a portable approval grant. Safe mode and project command policy still apply after a human acts locally.

Only the human who opened a workroom may use its controls or record its decision when a requester ID is available. A separate owner-issued `/lab approve ... action:validate|gates` command may run configured checks after recording approval; that local command, not the peer envelope or decision button, is the execution authority.

## Idempotency

`id` identifies one wire message; `requestId` identifies the logical operation. Retries should retain `requestId` and use a new envelope `id`.

Council contribution ingestion is idempotent by `(conversationId, sourceRequestId)`: the first accepted contribution wins, and a duplicate returns the existing record rather than storing conflicting content. It is also phase-gated, so a matching result arriving after Reveal is ignored as a contribution.

Version 2 keeps a bounded durable delivery cache keyed by transport actor, envelope type, conversation, and logical request. Duplicate requests or terminal notifications are ignored before work starts, including after a process restart while the cache entry remains retained. Integrations should still treat delivery as at-least-once over the long term: side-effecting capabilities remain approval-gated and need operation-specific idempotency before execution.

Discord messages are limited to 2,000 characters. Devbot emits compact JSON and bounds envelopes to 1,950 characters. If an envelope would exceed that budget, the largest payload strings are shortened and `payload.transportTruncated` is set to `true`; receivers should treat a truncated task request as incomplete rather than guessing missing intent.

## Bot-loop prevention

Implementations must preserve these receive rules:

1. Route bot-authored messages only through the peer-message path, never through the human mention/action path.
2. Ignore bots that are not globally allow-listed and peers that are not allowed for the selected project.
3. Reply only to `devbot.peer.request` messages that explicitly target the receiver at the transport layer.
4. Treat `result`, `event`, and `approval` as terminal notifications: record them if relevant, but never automatically answer them.
5. Emit responses as `result` or `approval`, not as another `request`.

These rules prevent two bots from recursively treating each other's replies as new work.

## Compatibility

The v2 protocol is additive. Devbot still supports the v1 `PeerEnvelope` for capability announcements and basic status or screenshot requests. `/lab` collaboration uses v2.

Because v1 and v2 share some `type` strings but have different shapes, receivers parse v2 first and then fall back to v1. They must dispatch by `version`, must not reinterpret an unknown version as v1 or v2, and must not execute an unknown capability. There is no automatic downgrade or conversion between versions.

## Request and result example

A council chair asks one peer for an independent plan:

```json
{
  "type": "devbot.peer.request",
  "version": 2,
  "id": "msg-council-01",
  "conversationId": "collab-cache-01",
  "requestId": "req-peer-222",
  "from": {
    "botId": "111",
    "owner": "alex",
    "botName": "alex-devbot"
  },
  "to": {
    "botId": "222",
    "project": "webapp"
  },
  "capability": "task.plan",
  "intent": "council",
  "mode": "think",
  "requiresApproval": false,
  "payload": {
    "prompt": "Propose the smallest reliable cache strategy.",
    "sealed": true
  },
  "artifacts": [],
  "createdAt": "2026-07-09T18:00:00.000Z"
}
```

The peer returns a new message ID, preserves the request ID, and explicitly correlates the result:

```json
{
  "type": "devbot.peer.result",
  "version": 2,
  "id": "msg-council-02",
  "conversationId": "collab-cache-01",
  "requestId": "req-peer-222",
  "correlationId": "req-peer-222",
  "from": {
    "botId": "222",
    "owner": "sam",
    "botName": "sam-devbot"
  },
  "to": {
    "botId": "111",
    "project": "webapp"
  },
  "capability": "task.plan",
  "intent": "council",
  "mode": "think",
  "requiresApproval": false,
  "payload": {
    "ok": true,
    "message": "Start with an in-process cache and measure misses before adding infrastructure."
  },
  "artifacts": [
    {
      "id": "artifact-plan-01",
      "kind": "plan",
      "label": "peer planning task"
    }
  ],
  "createdAt": "2026-07-09T18:00:08.000Z"
}
```

The chair stores the result as a sealed proposal only if the Discord author is peer `222`, the room is still `collecting`, and `req-peer-222` matches that participant's invitation.
