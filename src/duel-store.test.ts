import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DuelStore } from "./duel-store.js";
import type { ResolvedDuelIssue } from "./duel.js";

async function newStore(): Promise<DuelStore> {
  const dir = await mkdtemp(path.join(tmpdir(), "devbot-duel-store-"));
  return new DuelStore(path.join(dir, "duels.json"));
}

const concededIssue: ResolvedDuelIssue = { id: "I1", severity: "high", claim: "real bug", status: "conceded", authorNote: "confirmed" };

test("start creates a running record; succeed and get round-trip the typed result", async () => {
  const store = await newStore();
  const started = await store.start({ id: "collab-1", taskId: "task-1", projectName: "webapp" });
  assert.equal(started.status, "running");

  await store.succeed("collab-1", {
    authorTier: "standard",
    reviewerTier: "deep",
    reviewerIndependence: "independent",
    evidence: { baseRevision: "abc", headRevision: "def", patchHash: "hash", fileCount: 1, includedFileCount: 1, truncated: false },
    overall: "request-changes",
    issues: [concededIssue]
  });

  const record = await store.get("collab-1");
  assert.equal(record?.status, "succeeded");
  assert.equal(record?.issues.length, 1);
  assert.equal(record?.evidence?.patchHash, "hash");
});

test("starting a new duel for the same task supersedes an earlier still-running one", async () => {
  const store = await newStore();
  await store.start({ id: "collab-1", taskId: "task-1", projectName: "webapp" });
  await store.start({ id: "collab-2", taskId: "task-1", projectName: "webapp" });

  const first = await store.get("collab-1");
  const second = await store.get("collab-2");
  assert.equal(first?.status, "failed");
  assert.match(first?.error ?? "", /Superseded/);
  assert.equal(second?.status, "running");
});

test("fail transitions a running duel and records the error", async () => {
  const store = await newStore();
  await store.start({ id: "collab-1", taskId: "task-1", projectName: "webapp" });
  await store.fail("collab-1", new Error("codex timed out"));
  const record = await store.get("collab-1");
  assert.equal(record?.status, "failed");
  assert.match(record?.error ?? "", /codex timed out/);
});

async function succeededStore(): Promise<DuelStore> {
  const store = await newStore();
  await store.start({ id: "collab-1", taskId: "task-1", projectName: "webapp" });
  await store.succeed("collab-1", {
    authorTier: "standard",
    reviewerTier: "deep",
    reviewerIndependence: "independent",
    evidence: { patchHash: "hash", fileCount: 1, includedFileCount: 1, truncated: false },
    overall: "request-changes",
    issues: [concededIssue]
  });
  return store;
}

test("concurrent accept attempts: only one claim succeeds even when both race past earlier checks", async () => {
  const store = await succeededStore();
  const [first, second] = await Promise.all([store.claimAcceptance("collab-1", "alice"), store.claimAcceptance("collab-1", "bob")]);
  const claims = [first.claimed, second.claimed];
  assert.deepEqual(claims.filter(Boolean).length, 1);
  const record = await store.get("collab-1");
  assert.equal(record?.acceptance.state, "claimed");
  assert.ok(record?.acceptance.actor === "alice" || record?.acceptance.actor === "bob");
});

test("a claim cannot be re-claimed, and dismiss is refused once accepted", async () => {
  const store = await succeededStore();
  await store.claimAcceptance("collab-1", "alice");
  const secondClaim = await store.claimAcceptance("collab-1", "bob");
  assert.equal(secondClaim.claimed, false);

  const dismissal = await store.dismiss("collab-1", "carol");
  assert.equal(dismissal.dismissed, false);
});

test("completeAcceptance records the resulting task id; failAcceptance makes the claim retryable", async () => {
  const store = await succeededStore();
  await store.claimAcceptance("collab-1", "alice");
  await store.completeAcceptance("collab-1", "task-fix-1");
  const completed = await store.get("collab-1");
  assert.equal(completed?.acceptance.state, "completed");
  assert.equal(completed?.acceptance.taskId, "task-fix-1");

  const store2 = await succeededStore();
  await store2.claimAcceptance("collab-1", "alice");
  await store2.failAcceptance("collab-1", "worktree resolution failed");
  const failed = await store2.get("collab-1");
  assert.equal(failed?.acceptance.state, "failed");
  const retried = await store2.claimAcceptance("collab-1", "dave");
  assert.equal(retried.claimed, true);
});

test("dismiss is exclusive with acceptance and cannot be re-dismissed", async () => {
  const store = await succeededStore();
  const first = await store.dismiss("collab-1", "alice");
  assert.equal(first.dismissed, true);
  const second = await store.dismiss("collab-1", "bob");
  assert.equal(second.dismissed, false);
  const claimAfterDismiss = await store.claimAcceptance("collab-1", "carol");
  assert.equal(claimAfterDismiss.claimed, false);
});

test("interruptRunning marks running duels as failed for restart-safe recovery", async () => {
  const store = await newStore();
  await store.start({ id: "collab-1", taskId: "task-1", projectName: "webapp" });
  const interrupted = await store.interruptRunning("Interrupted when Devbot restarted.");
  assert.equal(interrupted, 1);
  const record = await store.get("collab-1");
  assert.equal(record?.status, "failed");
});
