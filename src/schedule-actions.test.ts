import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runActionOccurrence, type ActionOccurrenceDeps } from "./schedule-actions.js";
import { ScheduleStore, type ScheduleEntry } from "./schedule-store.js";
import { TaskStore, type TaskRecord } from "./task-store.js";

interface Harness {
  scheduleStore: ScheduleStore;
  taskStore: TaskStore;
  entry: ScheduleEntry;
  proposals: TaskRecord[];
  executions: Array<{ entry: ScheduleEntry; runsUsed: number }>;
  deps: ActionOccurrenceDeps;
}

async function harness(overrides: Partial<ActionOccurrenceDeps> = {}): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-schedule-actions-"));
  const scheduleStore = new ScheduleStore(path.join(root, "schedule.json"));
  const taskStore = new TaskStore(path.join(root, "tasks.json"));
  const entry = await scheduleStore.add({
    spec: "every 1h",
    project: "web",
    taskText: "rotate the deploy logs",
    mode: "action",
    addedBy: "tom",
    addedById: "user-1"
  });
  const proposals: TaskRecord[] = [];
  const executions: Array<{ entry: ScheduleEntry; runsUsed: number }> = [];
  const deps: ActionOccurrenceDeps = {
    scheduleStore,
    taskStore,
    safeMode: false,
    createProposal: async (occurrence) => {
      const task = await taskStore.propose({
        source: `schedule:${occurrence.id}`,
        mode: "action",
        projectName: occurrence.project,
        requester: occurrence.addedBy,
        requesterId: occurrence.addedById,
        text: occurrence.taskText
      });
      proposals.push(task);
      return task;
    },
    executeStandingRun: async (occurrence, approval) => {
      executions.push({ entry: occurrence, runsUsed: approval.runsUsed });
      return "completed the standing run";
    },
    ...overrides
  };
  return { scheduleStore, taskStore, entry, proposals, executions, deps };
}

async function claimOnly(scheduleStore: ScheduleStore, id: string): Promise<ScheduleEntry> {
  const current = await scheduleStore.get(id);
  const claimed = await scheduleStore.claimDue(new Date(current!.nextRun));
  const occurrence = claimed.find((item) => item.id === id);
  assert.ok(occurrence, "expected the entry to be due and claimable");
  return occurrence;
}

function futureGrant(overrides: Partial<{ expiresAt: Date; maxRuns: number; reviewAfterRuns: number; reviewAt: Date }> = {}) {
  return {
    grantedBy: "tom",
    grantedById: "user-1",
    expiresAt: new Date(Date.now() + 24 * 3_600_000),
    maxRuns: 5,
    reviewAfterRuns: 5,
    ...overrides
  };
}

test("an action occurrence without a standing approval creates one proposal and never executes", async () => {
  const { scheduleStore, taskStore, entry, proposals, executions, deps } = await harness();
  const occurrence = await claimOnly(scheduleStore, entry.id);

  const outcome = await runActionOccurrence(occurrence, deps);
  assert.equal(outcome.kind, "proposed");
  assert.equal(outcome.kind === "proposed" && outcome.reason, "none");
  assert.equal(executions.length, 0);
  assert.equal(proposals.length, 1);

  const proposal = await taskStore.get(proposals[0]!.id);
  assert.equal(proposal?.status, "awaiting-approval");

  const updated = await scheduleStore.get(entry.id);
  assert.equal(updated?.running, false);
  assert.equal(updated?.lastProposalTaskId, proposals[0]!.id);
  assert.ok(new Date(updated!.nextRun).getTime() > new Date(occurrence.nextRun).getTime());
  assert.match(updated?.lastResult ?? "", /Posted approval card/);
});

test("a later occurrence skips instead of stacking cards while the previous proposal is pending", async () => {
  const { scheduleStore, entry, proposals, deps } = await harness();
  await runActionOccurrence(await claimOnly(scheduleStore, entry.id), deps);

  const outcome = await runActionOccurrence(await claimOnly(scheduleStore, entry.id), deps);
  assert.equal(outcome.kind, "skipped");
  assert.equal(proposals.length, 1);
  const updated = await scheduleStore.get(entry.id);
  assert.equal(updated?.running, false);
  assert.match(updated?.lastResult ?? "", /still awaiting approval/);
});

test("a declined proposal never executes and the next occurrence posts a fresh card", async () => {
  const { scheduleStore, taskStore, entry, proposals, executions, deps } = await harness();
  await runActionOccurrence(await claimOnly(scheduleStore, entry.id), deps);

  const declined = await taskStore.deny(proposals[0]!.id, "tom", 1);
  assert.equal(declined?.status, "canceled");
  assert.equal(await taskStore.begin(proposals[0]!.id, { mode: "action", actor: "tom" }), undefined);

  const outcome = await runActionOccurrence(await claimOnly(scheduleStore, entry.id), deps);
  assert.equal(outcome.kind, "proposed");
  assert.equal(proposals.length, 2);
  assert.notEqual(proposals[1]!.id, proposals[0]!.id);
  assert.equal(executions.length, 0);
});

test("approving a schedule proposal starts it exactly once under the CAS revision guard", async () => {
  const { scheduleStore, taskStore, entry, proposals, deps } = await harness();
  await runActionOccurrence(await claimOnly(scheduleStore, entry.id), deps);
  const proposalId = proposals[0]!.id;

  const results = await Promise.all([
    taskStore.begin(proposalId, { mode: "action", actor: "tom", expectedRevision: 1 }),
    taskStore.begin(proposalId, { mode: "action", actor: "sam", expectedRevision: 1 })
  ]);
  assert.equal(results.filter((task) => task !== undefined).length, 1);
  assert.equal((await taskStore.get(proposalId))?.status, "running");
  assert.equal(await taskStore.begin(proposalId, { mode: "action", actor: "tom", expectedRevision: 1 }), undefined);
});

test("an edited proposal invalidates approvals rendered against the old revision", async () => {
  const { scheduleStore, taskStore, entry, proposals, deps } = await harness();
  await runActionOccurrence(await claimOnly(scheduleStore, entry.id), deps);
  const proposalId = proposals[0]!.id;

  const edited = await taskStore.updateProposal(proposalId, { text: "rotate only staging logs", expectedRevision: 1 });
  assert.equal(edited?.proposalRevision, 2);
  assert.equal(await taskStore.begin(proposalId, { mode: "action", actor: "tom", expectedRevision: 1 }), undefined);
  assert.equal((await taskStore.begin(proposalId, { mode: "action", actor: "tom", expectedRevision: 2 }))?.status, "running");
});

test("a valid standing approval executes with an atomically consumed budget", async () => {
  const { scheduleStore, entry, proposals, executions, deps } = await harness();
  await scheduleStore.grantStandingApproval(entry.id, futureGrant({ maxRuns: 2, reviewAfterRuns: 2 }));

  const outcome = await runActionOccurrence(await claimOnly(scheduleStore, entry.id), deps);
  assert.equal(outcome.kind, "executed");
  assert.equal(executions.length, 1);
  assert.equal(executions[0]?.runsUsed, 1);
  assert.equal(proposals.length, 0);

  const updated = await scheduleStore.get(entry.id);
  assert.equal(updated?.standingApproval?.runsUsed, 1);
  assert.equal(updated?.running, false);
  assert.match(updated?.lastResult ?? "", /Standing-approval run 1\/2: completed the standing run/);
});

test("an exhausted run budget falls back to a proposal card", async () => {
  const { scheduleStore, entry, proposals, executions, deps } = await harness();
  await scheduleStore.grantStandingApproval(entry.id, futureGrant({ maxRuns: 1, reviewAfterRuns: 1 }));
  await runActionOccurrence(await claimOnly(scheduleStore, entry.id), deps);
  assert.equal(executions.length, 1);

  const outcome = await runActionOccurrence(await claimOnly(scheduleStore, entry.id), deps);
  assert.equal(outcome.kind, "proposed");
  assert.equal(outcome.kind === "proposed" && outcome.reason, "exhausted");
  assert.equal(executions.length, 1);
  assert.equal(proposals.length, 1);
});

test("an expired standing approval falls back to a proposal card", async () => {
  const { scheduleStore, entry, proposals, executions, deps } = await harness();
  await scheduleStore.grantStandingApproval(entry.id, futureGrant({ expiresAt: new Date(Date.now() + 3_600_000) }));

  const later = () => new Date(Date.now() + 2 * 3_600_000);
  const outcome = await runActionOccurrence(await claimOnly(scheduleStore, entry.id), { ...deps, now: later });
  assert.equal(outcome.kind, "proposed");
  assert.equal(outcome.kind === "proposed" && outcome.reason, "expired");
  assert.equal(executions.length, 0);
  assert.equal(proposals.length, 1);
});

test("a revoked standing approval falls back to a proposal card", async () => {
  const { scheduleStore, entry, proposals, executions, deps } = await harness();
  await scheduleStore.grantStandingApproval(entry.id, futureGrant());
  await scheduleStore.revokeStandingApproval(entry.id, "sam", "user-2");

  const outcome = await runActionOccurrence(await claimOnly(scheduleStore, entry.id), deps);
  assert.equal(outcome.kind, "proposed");
  assert.equal(outcome.kind === "proposed" && outcome.reason, "revoked");
  assert.equal(executions.length, 0);
  assert.equal(proposals.length, 1);
});

test("a review checkpoint forces the next occurrence back to a fresh approval", async () => {
  const { scheduleStore, entry, proposals, executions, deps } = await harness();
  await scheduleStore.grantStandingApproval(entry.id, futureGrant({ maxRuns: 10, reviewAfterRuns: 1 }));
  await runActionOccurrence(await claimOnly(scheduleStore, entry.id), deps);
  assert.equal(executions.length, 1);

  const outcome = await runActionOccurrence(await claimOnly(scheduleStore, entry.id), deps);
  assert.equal(outcome.kind, "proposed");
  assert.equal(outcome.kind === "proposed" && outcome.reason, "review-due");
  assert.equal(executions.length, 1);
  assert.equal(proposals.length, 1);
});

test("safe mode never executes and never consumes the standing budget", async () => {
  const { scheduleStore, entry, proposals, executions, deps } = await harness();
  await scheduleStore.grantStandingApproval(entry.id, futureGrant());

  const outcome = await runActionOccurrence(await claimOnly(scheduleStore, entry.id), { ...deps, safeMode: true });
  assert.equal(outcome.kind, "proposed");
  assert.equal(outcome.kind === "proposed" && outcome.reason, "safe-mode");
  assert.equal(executions.length, 0);
  assert.equal(proposals.length, 1);
  assert.equal((await scheduleStore.get(entry.id))?.standingApproval?.runsUsed, 0);
});

test("a failed standing run releases the lease without posting a proposal", async () => {
  const { scheduleStore, entry, proposals, deps } = await harness({
    executeStandingRun: async () => {
      throw new Error("worktree unavailable");
    }
  });
  await scheduleStore.grantStandingApproval(entry.id, futureGrant());

  const outcome = await runActionOccurrence(await claimOnly(scheduleStore, entry.id), deps);
  assert.equal(outcome.kind, "failed");
  assert.equal(proposals.length, 0);
  const updated = await scheduleStore.get(entry.id);
  assert.equal(updated?.running, false);
  assert.match(updated?.lastResult ?? "", /Failed: worktree unavailable/);
  assert.equal(updated?.standingApproval?.runsUsed, 1);
});

test("a failed proposal creation releases the lease and records the failure", async () => {
  const { scheduleStore, entry, deps } = await harness({
    createProposal: async () => {
      throw new Error("no private thread available");
    }
  });

  const outcome = await runActionOccurrence(await claimOnly(scheduleStore, entry.id), deps);
  assert.equal(outcome.kind, "failed");
  const updated = await scheduleStore.get(entry.id);
  assert.equal(updated?.running, false);
  assert.match(updated?.lastResult ?? "", /Failed: no private thread available/);
});
