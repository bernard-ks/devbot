import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  formatQueueDigest,
  formatQueueList,
  groupQueueItemsByProject,
  isQueueItemId,
  nextQueuedItem,
  nextRunnableItem,
  pendingQueueCount,
  QueueStore,
  retainQueueItems,
  type QueueItem
} from "./queue-store.js";

async function tempStore(maxRecords?: number): Promise<QueueStore> {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-queue-store-"));
  return new QueueStore(path.join(root, "queue.json"), maxRecords);
}

function addInput(overrides: Partial<Parameters<QueueStore["add"]>[0]> = {}) {
  return { project: "web", taskText: "first", mode: "action" as const, addedBy: "tom", addedById: "user-1", ...overrides };
}

test("queue add/list preserves insertion order and position", async () => {
  const store = await tempStore();
  await store.add(addInput({ taskText: "first", mode: "action" }));
  await store.add(addInput({ taskText: "second", mode: "answer" }));
  const items = await store.list();
  assert.equal(items.length, 2);
  assert.equal(items[0]?.taskText, "first");
  assert.equal(items[1]?.taskText, "second");
  assert.equal(items[0]?.state, "queued");
  assert.ok(isQueueItemId(items[0]!.id));
});

test("queue survives reload from disk", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-queue-reload-"));
  const filePath = path.join(root, "queue.json");
  const store = new QueueStore(filePath);
  await store.add(addInput());

  const reloaded = new QueueStore(filePath);
  const items = await reloaded.list();
  assert.equal(items.length, 1);
  assert.equal(items[0]?.taskText, "first");
  assert.equal(items[0]?.addedById, "user-1");
});

test("queue drops malformed records and rejects an unsupported version on load", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-queue-invalid-"));
  const filePath = path.join(root, "queue.json");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    filePath,
    JSON.stringify({
      version: 1,
      items: [{ id: "not-a-valid-id", project: "web", taskText: "x", mode: "action", state: "queued", addedBy: "tom", addedAt: new Date().toISOString() }],
      runner: { running: false, stopOnFailure: false }
    })
  );
  const store = new QueueStore(filePath);
  assert.deepEqual(await store.list(), []);

  const badVersionFile = path.join(root, "bad-version.json");
  await writeFile(badVersionFile, JSON.stringify({ version: 99, items: [] }));
  await assert.rejects(() => new QueueStore(badVersionFile).list(), /Unsupported queue state version/);
});

test("queue state directory and file are owner-only", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-queue-perms-"));
  const dir = path.join(root, "state");
  const filePath = path.join(dir, "queue.json");
  const store = new QueueStore(filePath);
  await store.add(addInput());
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
});

test("queue redacts secrets and neutralizes mentions in stored text", async () => {
  const store = await tempStore();
  const item = await store.add(addInput({ taskText: "ping @everyone about sk-abcdefghijklmnopqrst" }));
  assert.doesNotMatch(item.taskText, /@everyone/);
  assert.match(item.taskText, /REDACTED API KEY/);
});

test("claimNext atomically transitions the next queued item to running", async () => {
  const store = await tempStore();
  await store.add(addInput({ taskText: "first" }));
  await store.add(addInput({ taskText: "second" }));
  const claimed = await store.claimNext();
  assert.equal(claimed?.taskText, "first");
  assert.equal(claimed?.state, "running");
  const items = await store.list();
  assert.equal(items[0]?.state, "running");
  assert.equal(items[1]?.state, "queued");
});

test("claimNext returns undefined once nothing is queued", async () => {
  const store = await tempStore();
  assert.equal(await store.claimNext(), undefined);
});

test("removeById rejects the currently running item and cannot be raced by a late claim", async () => {
  const store = await tempStore();
  await store.add(addInput());
  const claimed = await store.claimNext();
  await assert.rejects(() => store.removeById(claimed!.id), /cannot be removed/);
  // The item is already `running` from the atomic claim, so a concurrent remove sees that
  // state immediately -- there is no window where it still reads as `queued`.
  const current = await store.get(claimed!.id);
  assert.equal(current?.state, "running");
});

test("removeById marks a queued item as skipped without deleting history", async () => {
  const store = await tempStore();
  const first = await store.add(addInput({ taskText: "first" }));
  await store.add(addInput({ taskText: "second" }));
  const removed = await store.removeById(first.id);
  assert.equal(removed?.state, "skipped");
  const items = await store.list();
  assert.equal(items.length, 2);
  assert.equal(items[0]?.state, "skipped");
  assert.equal(items[1]?.state, "queued");
});

test("clear only skips queued items whose project is in the allowed set", async () => {
  const store = await tempStore();
  await store.add(addInput({ project: "web", taskText: "web-1" }));
  await store.add(addInput({ project: "secret", taskText: "secret-1" }));
  const cleared = await store.clear(new Set(["web"]));
  assert.equal(cleared, 1);
  const items = await store.list();
  assert.equal(items.find((entry) => entry.project === "web")?.state, "skipped");
  assert.equal(items.find((entry) => entry.project === "secret")?.state, "queued");
});

test("clear with an empty allowed set clears nothing", async () => {
  const store = await tempStore();
  await store.add(addInput());
  const cleared = await store.clear(new Set());
  assert.equal(cleared, 0);
});

test("attachTaskId requires the item to already be running", async () => {
  const store = await tempStore();
  const item = await store.add(addInput());
  await assert.rejects(() => store.attachTaskId(item.id, "task-1"), /not running/);
  await store.claimNext();
  await store.attachTaskId(item.id, "task-1");
  const current = await store.get(item.id);
  assert.equal(current?.taskId, "task-1");
});

test("markFinished requires the item to be running and records a summary", async () => {
  const store = await tempStore();
  const item = await store.add(addInput());
  await assert.rejects(() => store.markFinished(item.id, { state: "done", summary: "x" }), /not running/);
  await store.claimNext();
  await store.markFinished(item.id, { state: "done", summary: "Shipped the change." });
  const current = await store.get(item.id);
  assert.equal(current?.state, "done");
  assert.equal(current?.summary, "Shipped the change.");
  assert.ok(current?.finishedAt);
});

test("listUndigested returns finished items until markDigested is called, grouped by project", async () => {
  const store = await tempStore();
  const a = await store.add(addInput({ project: "web", taskText: "a" }));
  const b = await store.add(addInput({ project: "docs", taskText: "b" }));
  await store.claimNext();
  await store.markFinished(a.id, { state: "done", summary: "done a" });
  await store.claimNext();
  await store.markFinished(b.id, { state: "failed", summary: "failed b" });

  let undigested = await store.listUndigested();
  assert.equal(undigested.length, 2);
  const groups = groupQueueItemsByProject(undigested);
  assert.deepEqual([...groups.keys()].sort(), ["docs", "web"]);

  await store.markDigested([a.id]);
  undigested = await store.listUndigested();
  assert.equal(undigested.length, 1);
  assert.equal(undigested[0]?.id, b.id);

  // A second drain should never re-surface an already-digested item.
  await store.markDigested([b.id]);
  assert.deepEqual(await store.listUndigested(), []);
});

test("runner state start/stop persist", async () => {
  const store = await tempStore();
  let runner = await store.getRunner();
  assert.equal(runner.running, false);

  runner = await store.startRunner("tom", true);
  assert.equal(runner.running, true);
  assert.equal(runner.stopOnFailure, true);
  assert.equal(runner.startedBy, "tom");

  runner = await store.stopRunner();
  assert.equal(runner.running, false);
});

test("startRunner records the controller and control scope and survives a restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-queue-scope-"));
  const filePath = path.join(root, "queue.json");
  const store = new QueueStore(filePath);
  const runner = await store.startRunner("tom", false, { startedById: "user-1", scopeProjects: ["web", "web", "docs"] });
  assert.equal(runner.startedById, "user-1");
  assert.deepEqual([...(runner.scopeProjects ?? [])].sort(), ["docs", "web"]);

  // Reload from disk (a restart): the scope and starter must persist so the resumed runner
  // stays bounded to the same projects.
  const reloaded = new QueueStore(filePath);
  const persisted = await reloaded.getRunner();
  assert.equal(persisted.running, true);
  assert.equal(persisted.startedById, "user-1");
  assert.deepEqual([...(persisted.scopeProjects ?? [])].sort(), ["docs", "web"]);
});

test("claimNext only claims items on projects within the runner scope", async () => {
  const store = await tempStore();
  await store.add(addInput({ project: "secret", taskText: "hidden" }));
  await store.add(addInput({ project: "web", taskText: "visible" }));
  const claimed = await store.claimNext({ projects: new Set(["web"]) });
  assert.equal(claimed?.taskText, "visible");
  // The out-of-scope item stays queued rather than being started by a controller who cannot see it.
  const items = await store.list();
  assert.equal(items.find((entry) => entry.project === "secret")?.state, "queued");
});

test("claimNext leaves action-mode items queued when action mode is disallowed (safe mode)", async () => {
  const store = await tempStore();
  await store.add(addInput({ mode: "action", taskText: "write" }));
  await store.add(addInput({ mode: "answer", taskText: "read" }));
  const claimed = await store.claimNext({ allowActionMode: false });
  assert.equal(claimed?.taskText, "read");
  assert.equal(claimed?.mode, "answer");
  const items = await store.list();
  assert.equal(items.find((entry) => entry.taskText === "write")?.state, "queued");
  // With only the action item left and action mode still disallowed, nothing more is claimable.
  assert.equal(await store.claimNext({ allowActionMode: false }), undefined);
});

test("nextRunnableItem honors project scope and action-mode filters", () => {
  const items: QueueItem[] = [
    { ...item("a", "queued", "secret"), mode: "action" },
    { ...item("b", "queued", "web"), mode: "action" },
    { ...item("c", "queued", "web"), mode: "answer" }
  ];
  assert.equal(nextRunnableItem(items, { projects: new Set(["web"]) })?.id, "b");
  assert.equal(nextRunnableItem(items, { projects: new Set(["web"]), allowActionMode: false })?.id, "c");
  assert.equal(nextRunnableItem(items, { projects: new Set(["missing"]) }), undefined);
});

test("recoverInterrupted fails running items and returns them", async () => {
  const store = await tempStore();
  await store.add(addInput());
  await store.claimNext();
  const recovered = await store.recoverInterrupted("Interrupted when Devbot restarted.");
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.state, "failed");
  assert.equal(recovered[0]?.summary, "Interrupted when Devbot restarted.");
});

test("nextQueuedItem returns the first queued item, skipping running/done/skipped", () => {
  const items: QueueItem[] = [
    item("a", "done"),
    item("b", "skipped"),
    item("c", "queued"),
    item("d", "queued")
  ];
  assert.equal(nextQueuedItem(items)?.id, "c");
});

test("pendingQueueCount counts queued and running items only", () => {
  const items: QueueItem[] = [item("a", "done"), item("b", "queued"), item("c", "running"), item("d", "failed")];
  assert.equal(pendingQueueCount(items), 2);
});

test("retainQueueItems keeps all active items and trims oldest finished items first", () => {
  const items: QueueItem[] = [
    item("a", "done"),
    item("b", "done"),
    item("c", "queued"),
    item("d", "running")
  ];
  const kept = retainQueueItems(items, 3);
  assert.equal(kept.length, 3);
  assert.deepEqual(
    kept.map((entry) => entry.id),
    ["b", "c", "d"]
  );
});

test("formatQueueList renders a numbered list with state, id, and truncated task text", () => {
  const items: QueueItem[] = [item("a", "queued"), item("b", "done")];
  const text = formatQueueList(items);
  assert.match(text, /1\. \*\*queued\*\*/);
  assert.match(text, /2\. \*\*done\*\*/);
  assert.match(text, /`a`/);
});

test("formatQueueList reports an empty queue", () => {
  assert.match(formatQueueList([]), /empty/);
});

test("formatQueueDigest totals done/failed and links to the task message", () => {
  const items: QueueItem[] = [
    { ...item("a", "done"), messageId: "555", mode: "action" },
    item("b", "failed"),
    item("c", "skipped")
  ];
  const digest = formatQueueDigest(items, { guildId: "1", channelId: "2" });
  assert.match(digest, /1 done, 1 failed, 2 total/);
  assert.match(digest, /discord\.com\/channels\/1\/2\/555/);
  assert.doesNotMatch(digest, /skipped/);
});

test("groupQueueItemsByProject groups items and preserves per-group order", () => {
  const items: QueueItem[] = [
    item("a", "done", "web"),
    item("b", "done", "docs"),
    item("c", "failed", "web")
  ];
  const groups = groupQueueItemsByProject(items);
  assert.deepEqual(groups.get("web")?.map((entry) => entry.id), ["a", "c"]);
  assert.deepEqual(groups.get("docs")?.map((entry) => entry.id), ["b"]);
});

function item(id: string, state: QueueItem["state"], project = "web"): QueueItem {
  return {
    id,
    project,
    taskText: `task ${id}`,
    mode: "action",
    state,
    addedBy: "tom",
    addedById: "user-1",
    addedAt: new Date(0).toISOString()
  };
}
