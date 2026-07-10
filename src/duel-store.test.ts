import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DuelStore } from "./duel-store.js";
import type { ResolvedDuelIssue } from "./duel.js";

async function newStorePath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "devbot-duel-store-"));
  return path.join(dir, "duels.json");
}

async function newStore(): Promise<DuelStore> {
  return new DuelStore(await newStorePath());
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
    evidence: { baseRevision: "abc", headRevision: "def", patchHash: "hash", fileCount: 1, includedFileCount: 1, omittedFileCount: 0, truncated: false },
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
    evidence: { patchHash: "hash", fileCount: 1, includedFileCount: 1, omittedFileCount: 0, truncated: false },
    overall: "request-changes",
    issues: [concededIssue]
  });
  return store;
}

test("concurrent dismissals: only the first submission wins, duplicates see already-decided", async () => {
  const store = await succeededStore();
  const [first, second] = await Promise.all([store.dismiss("collab-1", "alice"), store.dismiss("collab-1", "bob")]);
  assert.deepEqual([first.dismissed, second.dismissed].filter(Boolean).length, 1);
  const record = await store.get("collab-1");
  assert.equal(record?.dismissed, true);
  assert.ok(record?.dismissedBy === "alice" || record?.dismissedBy === "bob");
});

test("dismiss is refused for running or failed duels", async () => {
  const store = await newStore();
  await store.start({ id: "collab-1", taskId: "task-1", projectName: "webapp" });
  const whileRunning = await store.dismiss("collab-1", "alice");
  assert.equal(whileRunning.dismissed, false);
  await store.fail("collab-1", new Error("boom"));
  const afterFailure = await store.dismiss("collab-1", "alice");
  assert.equal(afterFailure.dismissed, false);
});

test("interruptRunning marks running duels as failed and returns their ids for reconciliation", async () => {
  const store = await newStore();
  await store.start({ id: "collab-1", taskId: "task-1", projectName: "webapp" });
  await store.start({ id: "collab-2", taskId: "task-2", projectName: "webapp" });
  await store.succeed("collab-2", {
    authorTier: "standard",
    reviewerTier: "deep",
    reviewerIndependence: "independent",
    evidence: { patchHash: "hash", fileCount: 0, includedFileCount: 0, omittedFileCount: 0, truncated: false },
    overall: "approve",
    issues: []
  });
  await store.start({ id: "collab-3", taskId: "task-3", projectName: "webapp" });

  const interrupted = await store.interruptRunning("Interrupted when Devbot restarted.");
  assert.deepEqual(interrupted.sort(), ["collab-1", "collab-3"]);
  assert.equal((await store.get("collab-1"))?.status, "failed");
  assert.equal((await store.get("collab-2"))?.status, "succeeded");
  assert.equal((await store.get("collab-3"))?.status, "failed");
});

test("interruptRunning returns an empty id list when nothing was running", async () => {
  const store = await newStore();
  const interrupted = await store.interruptRunning();
  assert.deepEqual(interrupted, []);
});

test("stored issues are bounded in count and per-field length, not stored verbatim", async () => {
  const store = await newStore();
  await store.start({ id: "collab-1", taskId: "task-1", projectName: "webapp" });
  const oversized: ResolvedDuelIssue[] = Array.from({ length: 150 }, (_, index) => ({
    id: `I${index + 1}`,
    severity: "low",
    claim: "c".repeat(5_000),
    status: "disputed",
    authorNote: "n".repeat(5_000)
  }));
  await store.succeed("collab-1", {
    authorTier: "standard",
    reviewerTier: "deep",
    reviewerIndependence: "independent",
    evidence: { patchHash: "hash", fileCount: 1, includedFileCount: 1, omittedFileCount: 0, truncated: false },
    overall: "request-changes",
    issues: oversized
  });
  const record = await store.get("collab-1");
  assert.equal(record?.issues.length, 100);
  assert.equal(record?.issues[0]?.claim.length, 2_000);
  assert.equal(record?.issues[0]?.authorNote.length, 2_000);
});

test("the store keeps a bounded number of duel records, dropping the oldest", async () => {
  const file = await newStorePath();
  const store = new DuelStore(file, 3);
  for (let index = 1; index <= 5; index += 1) {
    await store.start({ id: `collab-${index}`, taskId: `task-${index}`, projectName: "webapp" });
  }
  assert.equal(await store.get("collab-1"), undefined);
  assert.equal(await store.get("collab-2"), undefined);
  assert.equal((await store.get("collab-5"))?.status, "running");
});

test("malformed persisted records are dropped on load instead of being trusted", async () => {
  const file = await newStorePath();
  const seedStore = new DuelStore(file);
  await seedStore.start({ id: "collab-good", taskId: "task-1", projectName: "webapp" });

  const raw = JSON.parse(await readFile(file, "utf8")) as { version: number; duels: unknown[] };
  raw.duels.push({ id: "collab-bad", status: "totally-invalid" }, "not even an object", null);
  await writeFile(file, JSON.stringify(raw));

  const store = new DuelStore(file);
  assert.equal((await store.get("collab-good"))?.status, "running");
  assert.equal(await store.get("collab-bad"), undefined);
});

test("an unsupported state file version is refused instead of silently reinterpreted", async () => {
  const file = await newStorePath();
  await writeFile(file, JSON.stringify({ version: 2, duels: [] }));
  const store = new DuelStore(file);
  await assert.rejects(() => store.get("collab-1"), /Unsupported duel state version/);
});
