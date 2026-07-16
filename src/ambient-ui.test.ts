import assert from "node:assert/strict";
import test from "node:test";
import { ComponentType, MessageFlags } from "discord.js";
import {
  AMBIENT_UI_LIMITS,
  ambientCustomId,
  confirmToActProposalCard,
  inboxEntityId,
  inboxProjectKey,
  needsMeInbox,
  parseAmbientCustomId,
  parseAmbientRole,
  parseAmbientRoleSelection,
  parseInboxEntityId,
  parseProposalEntityId,
  progressCard,
  proposalEditModal,
  proofFirstCompletionCard,
  proposalEntityId,
  reviewEvidenceCard,
  reviewPacketCard,
  roleTeamSelector,
  taskCompletionCard,
  taskDetailCard,
  taskProgressCard
} from "./ambient-ui.js";
import { taskControlRow } from "./task-controls.js";

test("ambient controls are stable, bounded, and strictly parsed", () => {
  const longestId = "x".repeat(AMBIENT_UI_LIMITS.entityId);
  const customId = ambientCustomId("proposal-confirm", longestId);
  assert.equal(customId, `devbot:ambient:v1:proposal-confirm:${longestId}`);
  assert.ok(customId.length <= AMBIENT_UI_LIMITS.customId);
  assert.deepEqual(parseAmbientCustomId(customId), { action: "proposal-confirm", entityId: longestId });
  assert.deepEqual(parseAmbientCustomId(ambientCustomId("proposal-confirm", "task-abc_r2")), {
    action: "proposal-confirm",
    entityId: "task-abc_r2"
  });
  assert.equal(parseAmbientCustomId(`${customId}:extra`), undefined);
  assert.equal(parseAmbientCustomId("devbot:ambient:v1:unknown:item-1"), undefined);
  assert.equal(parseAmbientCustomId("devbot:ambient:v1:inbox-open:../secret"), undefined);
  assert.throws(() => ambientCustomId("inbox-open", "x".repeat(65)), RangeError);
});

test("proposal controls bind decisions to a specific saved revision", () => {
  const entityId = proposalEntityId("task-abc-123", 4);
  assert.equal(entityId, "task-abc-123_r4");
  assert.deepEqual(parseProposalEntityId(entityId), { taskId: "task-abc-123", revision: 4 });
  assert.deepEqual(parseProposalEntityId("task-legacy"), { taskId: "task-legacy", revision: 1 });
  assert.equal(parseProposalEntityId("task-abc_r0"), undefined);
  assert.throws(() => proposalEntityId(`task-${"a".repeat(53)}`, 1), RangeError);
});

test("role/team values and selector serialize within Discord limits", () => {
  assert.equal(parseAmbientRole("builder"), "builder");
  assert.equal(parseAmbientRole("owner"), undefined);
  assert.deepEqual(parseAmbientRoleSelection(["builder", "reviewer", "verifier"]), ["builder", "reviewer", "verifier"]);
  assert.equal(parseAmbientRoleSelection(["builder", "builder"]), undefined);
  assert.equal(parseAmbientRoleSelection(["builder", "owner"]), undefined);

  const selector = roleTeamSelector("proposal-1", ["builder", "verifier"]).toJSON();
  assert.equal(selector.type, ComponentType.StringSelect);
  assert.equal(selector.options.length, 3);
  assert.ok(selector.options.length <= AMBIENT_UI_LIMITS.selectOptions);
  assert.deepEqual(selector.options.filter((option) => option.default).map((option) => option.value), ["builder", "verifier"]);
  assert.ok(selector.custom_id.length <= AMBIENT_UI_LIMITS.customId);
  assert.equal(selector.min_values, 1);
  assert.equal(selector.max_values, 3);
});

test("confirm-to-act proposal is a content-free Components V2 payload", () => {
  const payload = confirmToActProposalCard({
    proposalId: "proposal-1",
    project: "devbot",
    title: "Add ambient workrooms",
    proposal: "Create the UI helpers and focused serialization tests.",
    rationale: "This keeps action gated on an explicit human confirmation.",
    scope: ["src/ambient-ui.ts", "src/ambient-ui.test.ts"],
    requestedBy: "Bernard",
    selectedRoles: ["builder", "reviewer", "verifier"]
  });
  const json = serialize(payload);
  assert.equal(payload.flags, MessageFlags.IsComponentsV2);
  assert.equal("content" in payload, false);
  assert.equal(json.type, ComponentType.Container);
  assert.ok((json.components?.length ?? 0) <= 10);
  assert.match(textContent(json), /Confirm to act/);
  assert.deepEqual(controlIds(json).map((id) => parseAmbientCustomId(id)?.action), [
    "team-select",
    "proposal-confirm",
    "proposal-edit",
    "proposal-readonly",
    "proposal-decline"
  ]);
  const modal = proposalEditModal("proposal-1", "Make the request clearer").toJSON();
  assert.deepEqual(parseAmbientCustomId(modal.custom_id), { action: "proposal-edit", entityId: "proposal-1" });
  assertDiscordBounds(json);
});

test("progress card serializes bounded progress, team, and cancel state", () => {
  const payload = progressCard({
    taskId: "task-1",
    project: "devbot",
    title: "Ambient workrooms",
    phase: "Building",
    detail: "x".repeat(6_000),
    completed: Array.from({ length: 30 }, (_, index) => `Step ${index}`),
    blocker: "Waiting for focused tests.",
    nextUpdate: "After build verification.",
    roles: ["builder", "reviewer"],
    percent: 140,
    canCancel: false
  });
  const json = serialize(payload);
  assert.equal("content" in payload, false);
  assert.match(textContent(json), /100%/);
  assert.match(textContent(json), /Builder \/ Reviewer/);
  assert.equal(textContent(json).includes("Step 5"), false);
  const cancel = findControl(json, "progress-cancel");
  assert.equal(cancel?.disabled, true);
  assertDiscordBounds(json);
});

test("completion card puts bounded proof before result", () => {
  const payload = proofFirstCompletionCard({
    taskId: "task-2",
    project: "devbot",
    title: "Ambient UI complete",
    proof: [
      { label: "Focused tests", detail: "All ambient UI tests passed.", status: "passed" },
      { label: "Build", detail: "TypeScript compilation passed.", status: "passed" }
    ],
    summary: "Implemented the requested Components V2 payload helpers.",
    changedFiles: ["src/ambient-ui.ts", "src/ambient-ui.test.ts"],
    roles: ["builder", "verifier"]
  });
  const json = serialize(payload);
  const content = textContent(json);
  assert.ok(content.indexOf("**Proof**") < content.indexOf("**Result**"));
  assert.match(content, /\[PASS\] Focused tests/);
  assert.equal(findControl(json, "completion-proof")?.label, "Open proof");
  assert.equal(findControl(json, "completion-reviewed")?.label, "Mark reviewed");
  assertDiscordBounds(json);
});

test("completion card with task-derived text cannot expand mentions at the transport level", () => {
  const payload = proofFirstCompletionCard({
    taskId: "task-3",
    project: "devbot",
    title: "Notify @everyone about <@123>",
    proof: [{ label: "Check", detail: "Result mentions <@&456> and @here.", status: "info" }],
    summary: "Summary pinging @everyone, <@123>, and <@&456>."
  });
  assert.deepEqual(payload.allowedMentions, { parse: [] });
});

test("completion and review evidence cards hide absolute paths from generated output", () => {
  const completion = serialize(proofFirstCompletionCard({
    taskId: "task-paths",
    project: "devbot",
    title: "Path-safe result",
    proof: [{ label: "Check", detail: "failed in /Users/bernard/private/check.ts", status: "failed" }],
    summary: "Updated C:\\Users\\bernard\\private\\result.ts"
  }));
  assert.doesNotMatch(textContent(completion), /Users\/bernard|C:\\Users/);
  assert.match(textContent(completion), /\[local path\]/);
});

test("completion card keeps six proof entries so an isolated-task visual-proof note is not evicted", () => {
  const payload = proofFirstCompletionCard({
    taskId: "task-3",
    project: "devbot",
    title: "Isolated action complete",
    proof: [
      { label: "Recorded evidence", detail: "Work isolated on branch devbot/task/task-3.", status: "passed" },
      { label: "Recorded evidence", detail: "Inspected staged and unstaged Git diff without storing patch contents.", status: "passed" },
      { label: "Recorded evidence", detail: "No configured validation command was run automatically.", status: "info" },
      { label: "Recorded evidence", detail: "Changes were left uncommitted on the isolated branch for human review.", status: "passed" },
      { label: "Visual proof", detail: "Visual proof unavailable: this task ran on isolated branch `devbot/task/task-3`.", status: "info" },
      { label: "Model route", detail: "standard / focused", status: "info" }
    ],
    summary: "Made the header sticky on the isolated branch."
  });
  const json = serialize(payload);
  const content = textContent(json);
  assert.match(content, /\[INFO\] Visual proof:/);
  assert.match(content, /Visual proof unavailable/);
  assert.match(content, /\[INFO\] Model route/);
  assertDiscordBounds(json);
});

test("Needs Me inbox caps visible decisions and keeps every control routable", () => {
  const payload = needsMeInbox({
    inboxId: inboxEntityId({ limit: 8, page: 0 }),
    nextInboxId: inboxEntityId({ limit: 8, page: 1 }),
    selectedRoles: ["reviewer"],
    items: Array.from({ length: 8 }, (_, index) => ({
      id: `decision-${index}`,
      project: "devbot",
      title: `Decision ${index}`,
      reason: "Choose whether this work should proceed.",
      urgency: index === 0 ? "high" : "normal"
    }))
  });
  const json = serialize(payload);
  const actions = controlIds(json).map((id) => parseAmbientCustomId(id)?.action);
  assert.equal(actions.filter((action) => action === "inbox-open").length, AMBIENT_UI_LIMITS.inboxItems);
  assert.equal(actions.includes("team-select"), false);
  assert.ok(actions.includes("inbox-refresh"));
  assert.ok(actions.includes("inbox-next"));
  assert.match(textContent(json), /Showing 1-5 of 8/);
  assert.ok((json.components?.length ?? 0) <= 10);
  assertDiscordBounds(json);
});

test("Needs Me pagination state is compact and strictly parsed", () => {
  const id = inboxEntityId({ projectName: "devbot", limit: 25, page: 4 });
  assert.deepEqual(parseInboxEntityId(id), { projectKey: inboxProjectKey("devbot"), limit: 25, page: 4 });
  assert.deepEqual(parseInboxEntityId(inboxEntityId({ limit: 10, page: 0 })), { limit: 10, page: 0 });
  assert.equal(parseInboxEntityId("inbox-a-l26-p0"), undefined);
  assert.throws(() => inboxEntityId({ projectName: "../../private", limit: 10, page: 0 }), RangeError);
  const sentinelName = inboxEntityId({ projectName: "all", limit: 10, page: 0 });
  assert.deepEqual(parseInboxEntityId(sentinelName), { projectKey: inboxProjectKey("all"), limit: 10, page: 0 });
  assert.ok(inboxEntityId({ projectName: "project-" + "x".repeat(100), limit: 10, page: 0 }).length <= 64);
});

test("ordinary task cards keep legacy task controls inside bounded Components V2 containers", () => {
  const controls = [taskControlRow("task-abc", { status: "succeeded", mode: "action" })];
  const progress = taskProgressCard({
    project: "devbot",
    title: "Migrate ordinary task cards",
    phase: "Working",
    detail: "Building the bounded task lifecycle card.",
    meta: "write-capable | 1m 5s",
    percent: 60,
    controlRows: controls
  });
  const progressJson = serialize(progress);
  assert.equal(progress.flags, MessageFlags.IsComponentsV2);
  assert.equal("content" in progress, false);
  assert.match(textContent(progressJson), /In progress/);
  assert.ok(controlIds(progressJson).includes("devbot:task-control:details:task-abc"));
  assert.ok(controlIds(progressJson).includes("devbot:task-control:review:task-abc"));
  assertDiscordBounds(progressJson);

  const completion = taskCompletionCard({
    project: "devbot",
    title: "Migrate ordinary task cards",
    summary: "x".repeat(5_000),
    proof: Array.from({ length: 12 }, (_, index) => ({
      label: `Evidence ${index}`,
      detail: "y".repeat(1_000),
      status: index === 0 ? "failed" as const : "passed" as const
    })),
    changedFiles: Array.from({ length: 20 }, (_, index) => `src/file-${index}.ts`),
    controlRows: controls
  });
  const completionJson = serialize(completion);
  assert.match(textContent(completionJson), /Complete with attention needed/);
  assert.match(textContent(completionJson), /\[FAIL\] Evidence 0/);
  assert.equal(textContent(completionJson).includes("Evidence 6"), false);
  assert.ok(controlIds(completionJson).includes("devbot:task-control:actions:task-abc"));
  assertDiscordBounds(completionJson);
});

test("card headings neutralize user Markdown, links, and mention-like labels", () => {
  const payload = taskProgressCard({
    project: "**trusted**",
    title: "[Open proof](https://example.invalid) @everyone",
    phase: "*working*",
    detail: "Deliberate detail blocks may retain Markdown.",
    meta: "read-only"
  });
  const content = textContent(serialize(payload));
  assert.match(content, /\\\[Open proof\\\]\\\(/);
  assert.doesNotMatch(content, /\]\(https:\/\//);
  assert.doesNotMatch(content, /https:\/\//);
  assert.doesNotMatch(content, /@everyone/);
  assert.match(content, /@\u200beveryone/);
  assert.deepEqual(payload.allowedMentions, { parse: [] });
});

test("task detail and review evidence cards are content-free, mention-safe, and bounded", () => {
  const detail = taskDetailCard({
    taskId: "task-abc",
    project: "devbot",
    status: "failed",
    workroom: "<#123>",
    detail: `Requester: @everyone <@123>\n${"z".repeat(6_000)}`
  });
  const detailJson = serialize(detail);
  assert.deepEqual(detail.allowedMentions, { parse: [] });
  assert.match(textContent(detailJson), /Task detail/);
  assertDiscordBounds(detailJson);

  const packet = reviewPacketCard({
    project: "devbot",
    branch: "feature/components-v2",
    defaultBranch: "main",
    lastCommit: "abc123 Add review cards",
    taskId: "task-abc",
    taskStatus: "succeeded",
    taskRequest: "Show review proof in a rich card.",
    changedFiles: `${"M src/file.ts\n".repeat(300)}\`\`\`spoof`,
    diffStat: "src/file.ts | 10 +++++-----".repeat(100),
    suggestedVerification: ["build", "test"]
  });
  const packetJson = serialize(packet);
  assert.match(textContent(packetJson), /Review packet/);
  assert.doesNotMatch(textContent(packetJson), /```spoof/);
  assertDiscordBounds(packetJson);

  const evidence = reviewEvidenceCard({
    title: "Merge gate evidence",
    project: "devbot",
    passed: false,
    summary: ["Working tree: clean.", "Validation: failed."],
    checks: Array.from({ length: 8 }, (_, index) => ({
      name: `check-${index}`,
      command: `npm run check-${index}`,
      ok: index !== 0,
      exitCode: index === 0 ? 1 : 0,
      output: index === 0 ? `early${"output".repeat(1_000)}late failure` : "output".repeat(1_000)
    }))
  });
  const evidenceJson = serialize(evidence);
  assert.match(textContent(evidenceJson), /BLOCKED/);
  assert.match(textContent(evidenceJson), /\[FAIL\] check-0 \| exit 1/);
  assert.match(textContent(evidenceJson), /late failure/);
  assert.doesNotMatch(textContent(evidenceJson), /earlyoutput/);
  assert.equal(textContent(evidenceJson).includes("check-4"), false);
  assertDiscordBounds(evidenceJson);
});

type JsonComponent = {
  type: number;
  content?: string;
  custom_id?: string;
  label?: string;
  disabled?: boolean;
  components?: JsonComponent[];
  accessory?: JsonComponent;
  options?: Array<{ label: string; value: string; description?: string; default?: boolean }>;
};

function serialize(payload: { components: readonly { toJSON(): unknown }[] }): JsonComponent {
  return payload.components[0]?.toJSON() as JsonComponent;
}

function flatten(component: JsonComponent): JsonComponent[] {
  return [component, ...(component.components ?? []).flatMap(flatten), ...(component.accessory ? flatten(component.accessory) : [])];
}

function textContent(component: JsonComponent): string {
  return flatten(component).flatMap((part) => part.content ?? []).join("\n");
}

function controlIds(component: JsonComponent): string[] {
  return flatten(component).flatMap((part) => part.custom_id ?? []);
}

function findControl(component: JsonComponent, action: string): JsonComponent | undefined {
  return flatten(component).find((part) => part.custom_id && parseAmbientCustomId(part.custom_id)?.action === action);
}

function assertDiscordBounds(component: JsonComponent): void {
  const parts = flatten(component);
  assert.ok(parts.length <= 40);
  assert.ok(textContent(component).length <= AMBIENT_UI_LIMITS.textDisplay);
  for (const part of parts) {
    if (part.content !== undefined) assert.ok(part.content.length <= AMBIENT_UI_LIMITS.textDisplay);
    if (part.custom_id !== undefined) assert.ok(part.custom_id.length <= AMBIENT_UI_LIMITS.customId);
    if (part.type === ComponentType.Container) assert.ok((part.components?.length ?? 0) <= 10);
    if (part.type === ComponentType.ActionRow) assert.ok((part.components?.length ?? 0) <= 5);
    if (part.options !== undefined) {
      assert.ok(part.options.length <= AMBIENT_UI_LIMITS.selectOptions);
      for (const option of part.options) {
        assert.ok(option.label.length <= 100);
        assert.ok(option.value.length <= 100);
        assert.ok((option.description?.length ?? 0) <= 100);
      }
    }
  }
}
