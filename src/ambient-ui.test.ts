import assert from "node:assert/strict";
import test from "node:test";
import { ComponentType, MessageFlags } from "discord.js";
import {
  AMBIENT_UI_LIMITS,
  ambientCustomId,
  confirmToActProposalCard,
  needsMeInbox,
  parseAmbientCustomId,
  parseAmbientRole,
  parseAmbientRoleSelection,
  parseProposalEntityId,
  progressCard,
  proposalEditModal,
  proofFirstCompletionCard,
  proposalEntityId,
  roleTeamSelector
} from "./ambient-ui.js";

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
  assert.equal(findControl(json, "schedule-revoke"), undefined);
  assertDiscordBounds(json);
});

test("standing-approval completion card carries a routable revoke control", () => {
  const payload = proofFirstCompletionCard({
    taskId: "task-3",
    project: "devbot",
    title: "Scheduled maintenance",
    proof: [{ label: "Standing approval", detail: "Run 1 of 3, granted by tom.", status: "info" }],
    summary: "Rotated the deploy logs.",
    standingApprovalScheduleId: "sched-abc-123"
  });
  const json = serialize(payload);
  const revoke = findControl(json, "schedule-revoke");
  assert.equal(revoke?.label, "Revoke standing approval");
  assert.deepEqual(parseAmbientCustomId(revoke!.custom_id!), { action: "schedule-revoke", entityId: "sched-abc-123" });
  assertDiscordBounds(json);
});

test("Needs Me inbox caps visible decisions and keeps every control routable", () => {
  const payload = needsMeInbox({
    inboxId: "inbox-main",
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
  assert.match(textContent(json), /3 more items not shown/);
  assert.ok((json.components?.length ?? 0) <= 10);
  assertDiscordBounds(json);
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
